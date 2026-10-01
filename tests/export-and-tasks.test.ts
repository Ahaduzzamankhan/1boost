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
  // The dialog + write path is shared by the usage export and the workspace
  // export, so it is pinned once here rather than twice.
  const picker = body(lib, 'fn write_via_picker', '/// Opens the open picker.')
  const exportFn = body(lib, 'async fn export_json', '/// Where the export picker opens')

  it('asks where to save instead of silently writing into the app folder', () => {
    expect(picker).toContain('.blocking_save_file()')
    expect(picker).toContain('.add_filter("JSON", &["json"])')
    expect(picker).toContain('.set_file_name(&name)')
    // Nothing may be written before the user has chosen a destination.
    expect(picker.indexOf('blocking_save_file')).toBeLessThan(picker.indexOf('std::fs::write'))
  })

  it('reports a canceled picker instead of claiming success', () => {
    expect(picker).toMatch(/let Some\(target\) = chosen else \{[\s\S]*?canceled: true/)
  })

  it('does not hold the storage lock across the file write', () => {
    // The tracking loop writes through this mutex; blocking it on a disk
    // write (or on a dialog) stalls tracking.
    const serializeAt = exportFn.indexOf('serde_json::to_string_pretty')
    const lockAt = exportFn.indexOf('.lock()')
    expect(lockAt).toBeLessThan(serializeAt)
    // The guard is dropped at the end of the block that serializes, before
    // the (blocking) picker is ever opened.
    expect(exportFn.slice(serializeAt)).toContain('};')
    expect(exportFn.indexOf('write_via_picker')).toBeGreaterThan(lockAt)
  })

  it('runs off the main thread, which the blocking dialog requires', () => {
    expect(lib).toMatch(/#\[tauri::command\]\s*\nasync fn export_json/)
    expect(lib).toMatch(/#\[tauri::command\]\s*\nasync fn export_workspace/)
    expect(lib).toMatch(/#\[tauri::command\]\s*\nasync fn import_workspace/)
  })

  it('creates the chosen directory and explains any failure', () => {
    expect(picker).toContain('std::fs::create_dir_all(dir)')
    expect(picker).toContain('could not write')
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

describe('workspace backup and restore', () => {
  it('imports by merging, so a wrong file can never delete work', () => {
    const vault = read('src-tauri/src/vault.rs')
    const imp = body(vault, 'pub fn import(', 'pub fn files(')
    // Additive only: nothing is removed or overwritten.
    expect(imp).not.toMatch(/\.retain\(/)
    expect(imp).not.toContain('= payload.pages')
    expect(imp).toContain('summary.skipped += 1')
    expect(imp).toContain('task.project_id.clear()')
  })

  it('keeps the previous generation of every collection as a backup', () => {
    const vault = read('src-tauri/src/vault.rs')
    const write = body(vault, 'fn write_json<T: Serialize>', '// ------')
    expect(write).toContain('fs::rename(path, &bak)')
    expect(vault).toContain('fn backup_path')
    // A file that cannot be parsed falls back rather than silently becoming
    // empty and then being overwritten by the next save.
    expect(vault).toMatch(/fn read_json[\s\S]*?read_backup\(path\)/)
  })

  it('tells the renderer its cache is stale after an import', () => {
    expect(lib).toContain('oneboost://workspace-changed')
    expect(lib).toContain('export_workspace,')
    expect(lib).toContain('import_workspace,')
  })

  it('never deletes the workspace when usage data is cleared', () => {
    // "Delete all data" is about telemetry. The user's own pages live in
    // their own files and must survive it.
    const clear = body(lib, 'fn clear_data', 'fn open_data_folder')
    expect(clear).not.toContain('vault')
    const page = read('src/pages/SettingsPage.tsx')
    expect(page).toMatch(/pages, projects, tasks and clipboard\s*history are kept/)
  })
})

describe('new task button', () => {
  const tasks = read('src/pages/TasksPage.tsx')
  const add = body(tasks, 'const add = async () => {', 'const allTags = useMemo')

  it('never fails silently', () => {
    expect(add).toMatch(/catch \(e\) \{/)
    expect(add).toContain('setLocalError(')
    expect(tasks).toContain('role="alert"')
  })

  it('cannot be double-submitted into duplicate tasks', () => {
    expect(add).toMatch(/if \(!title \|\| saving\) return/)
    expect(tasks).toMatch(/disabled=\{!draft\.trim\(\) \|\| saving\}/)
  })

  it('does not let Enter submit twice', () => {
    expect(tasks).toMatch(/if \(e\.key !== 'Enter'\) return[\s\S]*?e\.preventDefault\(\)/)
  })

  it('surfaces a failed reload instead of showing an empty screen', () => {
    // The list now comes from the shared store, so the equivalent guarantee is
    // that the store reports its own load failure rather than silently
    // resolving to an empty array.
    const store = read('src/workspace/store.ts')
    expect(store).toMatch(/const reload = useCallback[\s\S]*?setError\(/)
    expect(tasks).toMatch(/error && !tasks/)
    expect(add).toContain('setLocalError(')
  })

  it('surfaces toggle failures too', () => {
    // The toggle moved into the shared workspace store, so that is where the
    // failure handling has to live — otherwise one module's rollback would
    // leave every other module showing a task as done when it is not.
    const store = read('src/workspace/store.ts')
    const toggle = body(store, 'const toggleTask = useCallback', 'const deleteTask = useCallback')
    expect(toggle).toMatch(/catch \(e\) \{/)
    expect(toggle).toContain('upsert(cur ?? [], before)')
  })

  it('keeps the legacy task commands the bridge still calls', () => {
    // The bridge method names did not change, so the registered command names
    // must not either.
    for (const command of ['task_save', 'tasks_list', 'task_toggle', 'task_delete', 'tasks_clear_done']) {
      expect(new RegExp(`^\\s+${command},$`, 'm').test(lib), `${command} is not registered`).toBe(true)
    }
    expect(new RegExp('^\\s+pages_list,$', 'm').test(lib)).toBe(true)
    expect(new RegExp('^\\s+page_save,$', 'm').test(lib)).toBe(true)
    expect(new RegExp('^\\s+page_delete,$', 'm').test(lib)).toBe(true)
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

  it('still registers export_json', () => {
    expect(new RegExp(`^\\s+export_json,$`, 'm').test(lib)).toBe(true)
  })
})
