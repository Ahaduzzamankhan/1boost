// @ts-check
// The experimental assistant (1.3.2). Three things this guards, because all
// three are the reason the feature is called experimental:
//
//   1. It stays behind a feature flag and an opt-in pref, so the shipped
//      binary never turns on something the user did not ask for.
//   2. It keeps telling the truth — labelled Experimental, discloses exactly
//      what is sent, and never claims Gemini usage is unlimited.
//   3. No credential is ever committed. These tests read the repository
//      itself, so a pasted cookie that slips into a source file fails CI.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODULES, modulesIn } from '../src/modules/registry'

const root = join(__dirname, '..')
/**
 * Reads a source file with line endings normalized to `\n`. The assertions
 * below are about which lines exist, and a Windows checkout of the repository
 * (the release job) has every file with CRLF endings — without this the same
 * test passes in Validate and fails in Release.
 */
const read = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n')

const settings = read('src/pages/SettingsPage.tsx')
const assistantPage = read('src/pages/AssistantPage.tsx')
const cargo = read('src-tauri/Cargo.toml')
const assistant = read('src-tauri/src/assistant.rs')
const context = read('src-tauri/src/assistant_context.rs')
const lib = read('src-tauri/src/lib.rs')

describe('feature flag', () => {
  it('is a cargo feature that is off unless a build asks for it', () => {
    expect(cargo).toMatch(/^\[features\]$/m)
    expect(cargo).toMatch(/^experimental-ai = \["dep:sha1"\]$/m)
  })

  it('gates the module, its commands and the dependency together', () => {
    // One cfg attribute per surface, so removing the feature really does
    // remove the code rather than half of it.
    expect(lib).toContain('#[cfg(feature = "experimental-ai")]')
    expect(lib).toMatch(/#\[cfg\(feature = "experimental-ai"\)\]\s+mod assistant;/)
    expect(lib).toMatch(/#\[cfg\(feature = "experimental-ai"\)\]\s+mod assistant_context;/)
    for (const command of ['ai_status', 'ai_ask', 'ai_save_session', 'ai_clear_session', 'ai_models']) {
      expect(lib).toContain(`#[cfg(feature = "experimental-ai")]\n            ${command},`)
    }
  })

  it('also needs the user to switch it on, in a pref that defaults to off', () => {
    const model = read('src-tauri/src/model.rs')
    expect(model).toMatch(/pub experimental_ai: bool/)
    expect(model).toMatch(/experimental_ai: false/)
    expect(lib).toContain('"experimentalAi" =>')
  })

  it('runs its Rust tests in CI with the feature on', () => {
    const validate = read('.github/workflows/validate.yml')
    const release = read('.github/workflows/release.yml')
    expect(validate).toContain('cargo test --lib --release --features experimental-ai')
    expect(release).toContain('cargo test --lib --release --features experimental-ai')
    // The shipped installer is the build that has it compiled in.
    expect(release).toMatch(/args: .*--features experimental-ai/)
  })
})

describe('the Assistant module', () => {
  const def = MODULES.find((m) => m.id === 'assistant')

  it('is registered and marked experimental', () => {
    expect(def).toBeDefined()
    expect(def?.experimentalAi).toBe(true)
  })

  it('stays out of the sidebar until the pref is on', () => {
    const off = modulesIn('utilities', false).map((m) => m.id)
    const on = modulesIn('utilities', true).map((m) => m.id)
    expect(off).not.toContain('assistant')
    expect(on).toContain('assistant')
    // Hiding it must not disturb the modules that were already there.
    expect(off).toEqual(['utilities', 'devtools', 'files'])
  })
})

describe('honest disclosure', () => {
  it('labels the feature Experimental wherever it appears', () => {
    expect(assistantPage).toContain('Experimental')
    expect(settings).toContain('Experimental AI')
  })

  it('never claims Gemini is unlimited', () => {
    for (const source of [assistantPage, settings, assistant]) {
      expect(source).not.toMatch(/unlimited (?:access|usage|gemini)/i)
    }
    // The opposite has to be stated, not implied.
    expect(assistantPage).toContain('not unlimited')
    expect(assistant).toContain('It is not unlimited')
  })

  it('says what actually leaves the machine, and what never does', () => {
    expect(settings).toMatch(/what leaves this machine/i)
    expect(settings).toMatch(/never included/i)
    // The context builder is the place that could leak, so it is pinned there
    // too rather than only in the prose.
    expect(context.replace(/\s+/g, ' ')).toContain('per-app paths')
  })

  it('warns that the feature can change or be removed', () => {
    expect(settings).toMatch(/may be changed, disabled or removed/)
    expect(assistantPage).toMatch(/Google can change or withdraw this at any time/)
  })

  it('never scrapes a browser profile for the session', () => {
    for (const source of [assistant, assistantPage, settings]) {
      expect(source).not.toMatch(/AppData.*Cookies|Local State|Login Data/i)
    }
  })
})

describe('no credential in the repository', () => {
  /** A cookie assignment with a real-looking value behind it. */
  const COOKIE = /(?:__Secure-1PSID|__Secure-1PSIDTS|SAPISID|SID|HSID|SSID)\s*[=:]\s*["']?[A-Za-z0-9_-]{16,}/

  it('has no session cookie values anywhere in the source tree', () => {
    const files = [
      'src/pages/AssistantPage.tsx',
      'src/pages/SettingsPage.tsx',
      'src/bridge.ts',
      'src-tauri/src/assistant.rs',
      'src-tauri/src/assistant_context.rs',
      'src-tauri/src/lib.rs',
      'src-tauri/Cargo.toml',
    ]
    for (const file of files) {
      expect(COOKIE.test(read(file)), `${file} looks like it contains a session cookie`).toBe(false)
    }
  })

  it('never puts the session in a Debug render', () => {
    // `#[derive(Debug)]` on the session type would make one stray `{:?}` in a
    // log line a credential leak.
    const structDef = assistant.slice(
      assistant.indexOf('pub struct Session'),
      assistant.indexOf('pub struct Session') + 400,
    )
    expect(structDef).not.toContain('derive(Debug')
  })

  it('logs neither the question nor the failure detail of a session', () => {
    expect(lib).toContain('assistant request failed: {e}')
    expect(lib).not.toMatch(/log::(info|warn|error)!\([^)]*\{question\}/)
  })
})
