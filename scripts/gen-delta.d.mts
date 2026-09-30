// Types for gen-delta.mjs, which is plain JavaScript so CI can run it with
// `node` and no build step.

export const MAGIC: Buffer
export const FORMAT_VERSION: number
export const HEADER_SIZE: number
export const OP_COPY: number
export const OP_ADD: number

export type DeltaOp =
  | { kind: typeof OP_COPY; offset: number; length: number }
  | { kind: typeof OP_ADD; data: Buffer }

export function sha256(bytes: Buffer): Buffer
export function buildOps(base: Buffer, target: Buffer): DeltaOp[]
export function applyDelta(base: Buffer, patch: Buffer): Buffer
export function buildDelta(
  base: Buffer,
  target: Buffer,
): { patch: Buffer; ops: DeltaOp[]; literal: number }