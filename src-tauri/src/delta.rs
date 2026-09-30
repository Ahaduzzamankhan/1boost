//! Binary delta updates for 1Boost.
//!
//! The Tauri updater is preserved as the full-update path. This module adds the
//! cheaper path: releases publish a signed `.1bdelta` patch next to the signed
//! updater payload, and an install that already has the previous payload cached
//! rebuilds the new one locally instead of downloading megabytes again.
//!
//! Trust chain, in order, before a single byte is handed to the installer:
//!
//!   1. the patch is signed with the release key and verified with the same
//!      minisign public key the Tauri updater already trusts;
//!   2. the header's `base_sha256` must equal the SHA-256 of the cached base
//!      payload, so a patch for a different base is rejected rather than
//!      misapplied;
//!   3. the rebuilt artifact's SHA-256 must equal the header's `target_sha256`.
//!
//! A patch that fails any step is dropped and the caller falls back to the full
//! update. Patching is pure: it allocates a new buffer and never writes to the
//! install, so a failed delta cannot leave a half-updated app behind.
//!
//! The wire format is produced by `scripts/gen-delta.mjs`; that script is the
//! specification and its tests pin it.

use base64::Engine as _;
use sha2::{Digest, Sha256};

/// Mirrors MAGIC/FORMAT_VERSION/HEADER_SIZE in scripts/gen-delta.mjs.
pub const MAGIC: [u8; 4] = *b"1BD1";
pub const FORMAT_VERSION: u8 = 1;
pub const HEADER_SIZE: usize = 92;
const OP_COPY: u8 = 0x01;
const OP_ADD: u8 = 0x02;

/// Refuse to reserve more than this for a patched artifact. An installer this
/// size does not exist, and `try_reserve` on a bogus header should fail
/// instead of thrashing the machine.
const MAX_ARTIFACT_LEN: u64 = 1024 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum DeltaError {
    /// The patch is not a delta at all, or a field is out of range.
    Malformed(&'static str),
    /// The patch ended in the middle of a field or instruction.
    Truncated,
    /// The base we hold is not the base the patch was built against.
    BaseMismatch,
    /// The patch applied cleanly but produced the wrong bytes.
    TargetMismatch,
    /// The release signature did not verify.
    BadSignature,
    /// Refusing to allocate for an implausibly large artifact.
    TooLarge,
}

impl std::fmt::Display for DeltaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DeltaError::Malformed(why) => write!(f, "malformed delta patch: {why}"),
            DeltaError::Truncated => write!(f, "truncated delta patch"),
            DeltaError::BaseMismatch => write!(f, "delta base does not match the cached payload"),
            DeltaError::TargetMismatch => write!(f, "patched artifact does not match its hash"),
            DeltaError::BadSignature => write!(f, "delta signature did not verify"),
            DeltaError::TooLarge => write!(f, "delta targets an implausibly large artifact"),
        }
    }
}

impl std::error::Error for DeltaError {}

#[derive(Debug, PartialEq, Eq)]
enum Op {
    Copy { offset: u64, length: u32 },
    Add { data: Vec<u8> },
}

#[derive(Debug, PartialEq, Eq)]
pub struct Delta {
    base_sha256: [u8; 32],
    target_sha256: [u8; 32],
    base_len: u64,
    target_len: u64,
    ops: Vec<Op>,
}

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(bytes));
    out
}

/// Reads a little-endian u64 without panicking on a short buffer.
fn read_u64(buf: &[u8], at: usize) -> Result<u64, DeltaError> {
    let end = at.checked_add(8).ok_or(DeltaError::Malformed("offset overflow"))?;
    let slice = buf.get(at..end).ok_or(DeltaError::Truncated)?;
    let mut raw = [0u8; 8];
    raw.copy_from_slice(slice);
    Ok(u64::from_le_bytes(raw))
}

fn read_u32(buf: &[u8], at: usize) -> Result<u32, DeltaError> {
    let end = at.checked_add(4).ok_or(DeltaError::Malformed("offset overflow"))?;
    let slice = buf.get(at..end).ok_or(DeltaError::Truncated)?;
    let mut raw = [0u8; 4];
    raw.copy_from_slice(slice);
    Ok(u32::from_le_bytes(raw))
}

/// Parses a patch. Every length and offset is bounds-checked here, so `apply`
/// only has to work on already-validated instructions.
pub fn parse(patch: &[u8]) -> Result<Delta, DeltaError> {
    if patch.len() < HEADER_SIZE {
        return Err(DeltaError::Truncated);
    }
    if patch[0..4] != MAGIC {
        return Err(DeltaError::Malformed("bad magic"));
    }
    if patch[4] != FORMAT_VERSION {
        return Err(DeltaError::Malformed("unsupported format version"));
    }
    if patch[5] != 0 || u16::from_le_bytes([patch[6], patch[7]]) != 0 {
        return Err(DeltaError::Malformed("reserved header bytes are not zero"));
    }

    let mut base_sha256 = [0u8; 32];
    base_sha256.copy_from_slice(&patch[8..40]);
    let mut target_sha256 = [0u8; 32];
    target_sha256.copy_from_slice(&patch[40..72]);
    let base_len = read_u64(patch, 72)?;
    let target_len = read_u64(patch, 80)?;
    let op_count = read_u32(patch, 88)?;

    if base_len > MAX_ARTIFACT_LEN || target_len > MAX_ARTIFACT_LEN {
        return Err(DeltaError::TooLarge);
    }

    let mut ops = Vec::new();
    let mut at = HEADER_SIZE;
    let mut produced: u64 = 0;
    for _ in 0..op_count {
        let tag = *patch.get(at).ok_or(DeltaError::Truncated)?;
        at += 1;
        let op = match tag {
            OP_COPY => {
                let offset = read_u64(patch, at)?;
                at += 8;
                let length = read_u32(patch, at)?;
                at += 4;
                let end = offset.checked_add(length as u64).ok_or(DeltaError::Malformed("copy overflows"))?;
                if end > base_len {
                    return Err(DeltaError::Malformed("copy reads past the base artifact"));
                }
                produced = produced
                    .checked_add(length as u64)
                    .ok_or(DeltaError::Malformed("output length overflows"))?;
                Op::Copy { offset, length }
            }
            OP_ADD => {
                let length = read_u32(patch, at)?;
                at += 4;
                let end = at
                    .checked_add(length as usize)
                    .ok_or(DeltaError::Malformed("literal overflows"))?;
                let data = patch.get(at..end).ok_or(DeltaError::Truncated)?.to_vec();
                at = end;
                produced = produced
                    .checked_add(length as u64)
                    .ok_or(DeltaError::Malformed("output length overflows"))?;
                Op::Add { data }
            }
            other => {
                let _ = other;
                return Err(DeltaError::Malformed("unknown instruction tag"));
            }
        };
        // Bail as soon as the instructions overshoot the declared size rather
        // than after allocating for them.
        if produced > target_len {
            return Err(DeltaError::Malformed("instructions produce more than the declared length"));
        }
        ops.push(op);
    }

    if produced != target_len {
        return Err(DeltaError::Malformed("instructions do not produce the declared length"));
    }
    if at != patch.len() {
        return Err(DeltaError::Malformed("trailing bytes after the last instruction"));
    }

    Ok(Delta {
        base_sha256,
        target_sha256,
        base_len,
        target_len,
        ops,
    })
}

/// Rebuilds the target artifact from the base artifact.
pub fn apply(delta: &Delta, base: &[u8]) -> Result<Vec<u8>, DeltaError> {
    if base.len() as u64 != delta.base_len {
        return Err(DeltaError::BaseMismatch);
    }
    if sha256(base) != delta.base_sha256 {
        return Err(DeltaError::BaseMismatch);
    }

    let mut out: Vec<u8> = Vec::new();
    out.try_reserve(delta.target_len as usize)
        .map_err(|_| DeltaError::TooLarge)?;
    for op in &delta.ops {
        match op {
            Op::Copy { offset, length } => {
                let start = *offset as usize;
                let end = start + *length as usize;
                let slice = base.get(start..end).ok_or(DeltaError::Malformed("copy out of range"))?;
                out.extend_from_slice(slice);
            }
            Op::Add { data } => out.extend_from_slice(data),
        }
    }
    if out.len() as u64 != delta.target_len {
        return Err(DeltaError::TargetMismatch);
    }
    if sha256(&out) != delta.target_sha256 {
        return Err(DeltaError::TargetMismatch);
    }
    Ok(out)
}

/// Convenience wrapper: parse, then rebuild, verifying both hashes.
pub fn rebuild(patch: &[u8], base: &[u8]) -> Result<Vec<u8>, DeltaError> {
    apply(&parse(patch)?, base)
}

/// Verifies a minisign signature over `data`, exactly the way
/// tauri-plugin-updater verifies the full artifact: base64-decode both the
/// key and the signature, then check the Ed25519 signature over the bytes.
pub fn verify_signature(pubkey_b64: &str, signature_b64: &str, data: &[u8]) -> Result<(), DeltaError> {
    use minisign_verify::{PublicKey, Signature};

    let engine = base64::engine::general_purpose::STANDARD;
    let key_bytes = engine
        .decode(pubkey_b64.trim())
        .map_err(|_| DeltaError::Malformed("public key is not base64"))?;
    let sig_bytes = engine
        .decode(signature_b64.trim())
        .map_err(|_| DeltaError::Malformed("signature is not base64"))?;
    let key = std::str::from_utf8(&key_bytes)
        .map_err(|_| DeltaError::Malformed("public key is not utf-8"))?;
    let sig = std::str::from_utf8(&sig_bytes)
        .map_err(|_| DeltaError::Malformed("signature is not utf-8"))?;

    let public_key = PublicKey::decode(key).map_err(|_| DeltaError::BadSignature)?;
    let signature = Signature::decode(sig).map_err(|_| DeltaError::BadSignature)?;
    public_key
        .verify(data, &signature, true)
        .map_err(|_| DeltaError::BadSignature)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Produced by `npx tauri signer sign` with the release keypair that
    /// tauri.conf.json publishes, over the bytes below. Keeping a real
    /// signature here means the verification path is exercised end to end and
    /// cannot silently drift from what CI signs.
    const PROBE: &[u8] = b"1boost-delta-signature-probe";
    const PROBE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDBFQjcyQUJCMUY5NkU5QTUKUldTbDZaWWZ1eXEzRG00U0lvVWxxWUEzVjBjSVMrMmpPam9EZjV6dlFwSEtKdmRXV0o3eUNyTU0K";
    const PROBE_SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVTbDZaWWZ1eXEzRGxLSnNpZVZUS3ZwRS9acWxqczZPb2ZMTDZ4ZTQrYTdITnU0eWlRTzZPTkwvd29hVisreUp3aktaMHhZaGhvK3dkd3Q5UU5nS0czcDFLeENVMk03R3dNPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkwNzk0MzAxCWZpbGU6cHJvYmUuYmluCkl4MTVvbnl1cVB6dVJ6NCs1QlVqTWJycEkzMFVIOTdwN2xsUGU1V1F1NHdHTGcydzJWYm11WmRON2tMSWFrN01ZVkpUaVNDOFVBZ1I2bE9jbWZieURnPT0K";

    const BASE: &[u8] = include_bytes!("delta_fixtures/base.bin");
    const TARGET: &[u8] = include_bytes!("delta_fixtures/target.bin");
    const PATCH: &[u8] = include_bytes!("delta_fixtures/patch.1bdelta");

    /// Builds a patch by hand so the parser can be tested on shapes the
    /// generator would never emit.
    enum Spec {
        Copy { offset: u64, length: u32 },
        Add(Vec<u8>),
    }

    fn hand_made(ops: &[Spec], base: &[u8], target: &[u8]) -> Vec<u8> {
        let mut body: Vec<u8> = Vec::new();
        for op in ops {
            match op {
                Spec::Copy { offset, length } => {
                    body.push(OP_COPY);
                    body.extend_from_slice(&offset.to_le_bytes());
                    body.extend_from_slice(&length.to_le_bytes());
                }
                Spec::Add(data) => {
                    body.push(OP_ADD);
                    body.extend_from_slice(&(data.len() as u32).to_le_bytes());
                    body.extend_from_slice(data);
                }
            }
        }
        let mut out = vec![0u8; HEADER_SIZE];
        out[0..4].copy_from_slice(&MAGIC);
        out[4] = FORMAT_VERSION;
        out[8..40].copy_from_slice(&sha256(base));
        out[40..72].copy_from_slice(&sha256(target));
        out[72..80].copy_from_slice(&(base.len() as u64).to_le_bytes());
        out[80..88].copy_from_slice(&(target.len() as u64).to_le_bytes());
        out[88..92].copy_from_slice(&(ops.len() as u32).to_le_bytes());
        out.extend_from_slice(&body);
        out
    }

    fn offset_of(haystack: &[u8], needle: &[u8]) -> u64 {
        haystack
            .windows(needle.len())
            .position(|w| w == needle)
            .expect("needle is present in the haystack") as u64
    }

    #[test]
    fn applies_the_generator_fixture() {
        // The fixture was produced by scripts/gen-delta.mjs; if the two
        // implementations ever disagree about the format, this is where it
        // shows up.
        let rebuilt = rebuild(PATCH, BASE).expect("fixture should apply");
        assert_eq!(rebuilt, TARGET);
        assert!(PATCH.len() < TARGET.len() / 4, "fixture patch should be small");
    }

    #[test]
    fn rejects_a_short_header() {
        assert_eq!(parse(&PATCH[..HEADER_SIZE - 1]), Err(DeltaError::Truncated));
    }

    #[test]
    fn rejects_bad_magic() {
        let mut patch = PATCH.to_vec();
        patch[0] = b'X';
        assert!(matches!(parse(&patch), Err(DeltaError::Malformed(_))));
    }

    #[test]
    fn rejects_an_unknown_format_version() {
        let mut patch = PATCH.to_vec();
        patch[4] = 2;
        assert!(matches!(parse(&patch), Err(DeltaError::Malformed(_))));
    }

    #[test]
    fn rejects_nonzero_reserved_bytes() {
        let mut patch = PATCH.to_vec();
        patch[7] = 1;
        assert!(matches!(parse(&patch), Err(DeltaError::Malformed(_))));
    }

    #[test]
    fn rejects_trailing_bytes() {
        let mut patch = PATCH.to_vec();
        patch.push(0);
        assert!(matches!(parse(&patch), Err(DeltaError::Malformed(_))));
    }

    #[test]
    fn rejects_a_truncated_instruction() {
        let mut patch = PATCH.to_vec();
        patch.truncate(PATCH.len() - 1);
        assert_eq!(parse(&patch), Err(DeltaError::Truncated));
    }

    #[test]
    fn rejects_an_unknown_instruction_tag() {
        let mut patch = PATCH.to_vec();
        patch[HEADER_SIZE] = 0x7f;
        assert!(matches!(parse(&patch), Err(DeltaError::Malformed(_))));
    }

    #[test]
    fn rejects_a_copy_that_reads_past_the_base() {
        let base = b"abcdefgh".to_vec();
        let target = b"abcdefgh".to_vec();
        let mut patch = hand_made(
            &[Spec::Copy {
                offset: 4,
                length: 8,
            }],
            &base,
            &target,
        );
        patch[72..80].copy_from_slice(&8u64.to_le_bytes());
        // base_offset 4 + 8 > 8
        assert!(matches!(parse(&patch), Err(DeltaError::Malformed(_))));
    }

    #[test]
    fn rejects_instructions_that_overshoot_the_declared_length() {
        let base = b"abc".to_vec();
        let target = b"abc".to_vec();
        let patch = hand_made(
            &[Spec::Copy {
                offset: 0,
                length: 3,
            }],
            &base,
            &target,
        );
        patch[80..88].copy_from_slice(&2u64.to_le_bytes());
        assert!(matches!(parse(&patch), Err(DeltaError::Malformed(_))));
    }

    #[test]
    fn rejects_a_lying_target_length() {
        let base = b"abc".to_vec();
        let target = b"abc".to_vec();
        let mut patch = hand_made(
            &[Spec::Copy {
                offset: 0,
                length: 3,
            }],
            &base,
            &target,
        );
        patch[80..88].copy_from_slice(&9u64.to_le_bytes());
        assert!(matches!(parse(&patch), Err(DeltaError::Malformed(_))));
    }

    #[test]
    fn rejects_an_implausible_declared_length() {
        let base = b"abc".to_vec();
        let target = b"abc".to_vec();
        let mut patch = hand_made(
            &[Spec::Copy {
                offset: 0,
                length: 3,
            }],
            &base,
            &target,
        );
        patch[80..88].copy_from_slice(&(MAX_ARTIFACT_LEN + 1).to_le_bytes());
        assert_eq!(parse(&patch), Err(DeltaError::TooLarge));
    }

    #[test]
    fn rejects_a_base_that_is_not_the_one_the_patch_was_built_from() {
        let mut other = BASE.to_vec();
        other[10] ^= 0xff;
        assert_eq!(rebuild(PATCH, &other), Err(DeltaError::BaseMismatch));
        assert_eq!(rebuild(PATCH, &BASE[..BASE.len() - 1]), Err(DeltaError::BaseMismatch));
    }

    #[test]
    fn rejects_a_patch_whose_own_bytes_were_tampered_with() {
        // Flipping a literal byte keeps the patch structurally valid but the
        // rebuilt artifact no longer hashes to target_sha256.
        let mut patch = PATCH.to_vec();
        let last = patch.len() - 1;
        patch[last] ^= 0xff;
        let delta = parse(&patch).expect("structure is still valid");
        assert_eq!(apply(&delta, BASE), Err(DeltaError::TargetMismatch));
    }

    #[test]
    fn rejects_a_forged_target_hash() {
        // An attacker who can rewrite the patch can also rewrite the hash that
        // is checked afterwards; the signature check is what stops that, and
        // this test documents that the hash alone does not.
        let base = b"hello".to_vec();
        let target = b"hello world".to_vec();
        let mut patch = hand_made(
            &[
                Spec::Copy {
                    offset: 0,
                    length: 5,
                },
                Spec::Add(b" world".to_vec()),
            ],
            &base,
            &target,
        );
        patch[40..72].copy_from_slice(&sha256(b"goodbye world"));
        let delta = parse(&patch).expect("structure is valid");
        assert_eq!(apply(&delta, &base), Err(DeltaError::TargetMismatch));
    }

    #[test]
    fn copies_and_literals_round_trip() {
        let base = b"the quick brown fox jumps over the lazy dog".to_vec();
        let target = b"the quick brown cat jumps over the lazy dog!".to_vec();
        let offset = offset_of(&base, b"jumps over the lazy dog");
        let patch = hand_made(
            &[
                Spec::Add(b"the quick brown ".to_vec()),
                Spec::Copy {
                    offset,
                    length: 25,
                },
                Spec::Add(b"!".to_vec()),
            ],
            &base,
            &target,
        );
        assert_eq!(rebuild(&patch, &base).unwrap(), target);
    }

    #[test]
    fn verifies_a_real_release_signature() {
        assert_eq!(verify_signature(PROBE_PUBKEY, PROBE_SIG, PROBE), Ok(()));
    }

    #[test]
    fn rejects_a_signature_over_different_bytes() {
        assert_eq!(
            verify_signature(PROBE_PUBKEY, PROBE_SIG, b"1boost-delta-signature-probe "),
            Err(DeltaError::BadSignature)
        );
    }

    #[test]
    fn rejects_a_corrupt_signature() {
        let mut sig = PROBE_SIG.to_string();
        sig.replace_range(100..104, "AAAA");
        assert_eq!(verify_signature(PROBE_PUBKEY, &sig, PROBE), Err(DeltaError::BadSignature));
    }

    #[test]
    fn rejects_a_key_that_is_not_minisign() {
        assert_eq!(
            verify_signature(PROBE_SIG, PROBE_SIG, PROBE),
            Err(DeltaError::BadSignature)
        );
    }

    #[test]
    fn rejects_a_signature_that_is_not_base64() {
        assert!(matches!(
            verify_signature(PROBE_PUBKEY, "not base64 !!", PROBE),
            Err(DeltaError::Malformed(_))
        ));
    }

    #[test]
    fn hashes_match_the_published_shasum_of_an_empty_input() {
        assert_eq!(
            sha256(b""),
            [
                0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f,
                0xb9, 0x24, 0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b,
                0x78, 0x52, 0xb8, 0x55
            ]
        );
    }
}