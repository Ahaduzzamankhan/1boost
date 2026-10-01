// @ts-check
// "Export JSON does nothing" and "the new task button does nothing" were both
// the same class of bug: the work happened, or failed, somewhere the renderer
// never looked. These pin the fixes at the seams that were broken.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const lib = read('src-tauri/src/lib.rs')

function body(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  expect(start, `could not find ${from}`).toBeGreaterThan(-1)
  const end = source.indexOf(to, start)
  expect(end, `could not find ${to}`).toBeGreaterThan(-1)
  return source.slice(start, end)
}

describe('export JSON', () => {
  const exportFn = body(lib, 'async fn export_json', '/// Where the export picker opens')

  it('asks where to save instead of silently writing into the app folder', () => {
    expect(exportFn).toContain('.blocking_save_file()')
    expect(exportFn).toContain('.add_filter("JSON", &["json"])')
    expect(exportFn).toContain('.set_file_name(&name)')
    // Nothing may be written before the user has chosen a destination.
    expect(exportFn.indexOf('blocking_save_file')).toBeLessThan(exportFn.indexOf('std::fs::write'))
  })

  it('reports a canceled picker instead of claiming success', () => {
    expect(exportFn).toMatch(/let Some\(target\) = chosen else \{[\s\S]*?canceled: true/)
  })

  it('does not hold the storage lock across the file write', () => {
    // The tracking loop writes through this mutex; blocking it on a disk
    // write (or on a dialog) stalls tracking.
    const serializeAt = exportFn.indexOf('serde_json::to_string_pretty')
    const lockAt = exportFn.indexOf('.lock()')
    const writeAt = exportFn.indexOf('std::fs::write')
    expect(lockAt).toBeLessThan(serializeAt)
    // The guard is dropped at the end of the block that serializes.
    expect(exportFn.slice(serializeAt, writeAt)).toContain('};')
  })

  it('runs off the main thread, which the blocking dialog requires', () => {
    expect(lib).toMatch(/#\[tauri::command\]\s*\nasync fn export_json/)
  })

  it('creates the chosen directory and explains any failure', () => {
    expect(exportFn).toContain('std::fs::create_dir_all(dir)')
    expect(exportFn).toContain('could not write')
  })

  it('opens the picker in Documents rather than %APPDATA%', () => {
    expect(lib).toContain('fn default_export_dir()')
    expect(lib).toMatch(/\.join\("Documents"\)/)
  })

  it('surfaces the result in Settings instead of dropping it', () => {
    const page = read('src/pages/SettingsPage.tsx')
    expect(page).toMatch(/const res = await bridge\.exportJson\(\)\s*\n\s*setExportResult\(res\)/)
    expect(page).toContain('exportResult.canceled')
    expect(page).toContain('exportResult.error')
    expect(page).toContain('Exported to')
    // A button with no label change and no output is what we just fixed.
    expect(page).toMatch(/exporting \? 'Exporting…' : 'Export JSON'/)
  })
})

describe('new task button', () => {
  const tasks = read('src/pages/TasksPage.tsx')
  const add = body(tasks, 'const add = async () => {', 'const toggle = async (id: string)')

  it('never fails silently', () => {
    expect(add).toMatch(/catch \(e\) \{/)
    expect(add).toContain('setError(')
    expect(tasks).toContain('role="alert"')
  })

  it('cannot be double-submitted into duplicate tasks', () => {
    expect(add).toMatch(/if \(!title \|\| saving\) return/)
    expect(tasks).toMatch(/disabled=\{!draft\.trim\(\) \|\| saving\}/)
  })

  it('does not let Enter submit twice', () => {
    expect(tasks).toMatch(/if \(e\.key !== 'Enter'\) return[\s\S]*?e\.preventDefault\(\)/)
  })

  it('tells the user when a save worked but the list could not refresh', () => {
    expect(add).toContain('if (!(await load()))')
    expect(add).toContain('setError(')
  })

  it('surfaces toggle failures too', () => {
    const toggle = body(tasks, 'const toggle = async (id: string)', 'const setPriority')
    expect(toggle).toMatch(/catch \(e\) \{/)
  })

  it('keeps the vault alive after one panicking thread', () => {
    const vault = read('src-tauri/src/vault.rs')
    // A poisoned mutex used to make every task, note and clip button stop
    // responding for the rest of the session. The test module is excluded on
    // purpose: its whole job is to poison a lock the old way.
    const production = vault.slice(0, vault.indexOf('#[cfg(test)]'))
    expect(production).not.toContain('.lock().unwrap()')
    expect(vault).toContain('use crate::util::LockOk;')
    expect(vault).toContain('fn a_panicking_writer_does_not_permanently_break_the_vault')

    const util = read('src-tauri/src/util.rs')
    expect(util).toMatch(/pub trait LockOk<T>/)
    expect(util).toContain('self.lock().unwrap_or_else(|e| e.into_inner())')
  })
})

describe('the bridge still matches the renderer', () => {
  it('exports an ExportResult shape both sides agree on', () => {
    expect(lib).toMatch(/struct ExportResult \{[\s\S]*?ok: bool,[\s\S]*?canceled: bool/)
    const types = read('shared/types.ts')
    expect(types).toMatch(
      /exportJson: \(\) => Promise<\{ ok: boolean; path\?: string; canceled\?: boolean; error\?: string \}>/,
    )
  })

  it('still registers export_json and the task commands', () => {
    for (const command of ['export_json', 'task_save', 'tasks_list', 'task_toggle']) {
      expect(new RegExp(`^\\s+${command},$`, 'm').test(lib), `${command} is not registered`).toBe(true)
    }
  })
})
