import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readTuiSettings, tuiSettingsPath, writeTuiSettings } from './settings'

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), 'taskwraith-tui-settings-')), 'tui.json')
}

describe('TaskWraith TUI settings', () => {
  it('resolves an XDG path, and lets the environment override it outright', () => {
    expect(tuiSettingsPath({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/taskwraith/tui.json')
    expect(tuiSettingsPath({ HOME: '/home/x' })).toBe('/home/x/.config/taskwraith/tui.json')
    expect(tuiSettingsPath({ TASKWRAITH_TUI_CONFIG: '/tmp/o.json', XDG_CONFIG_HOME: '/xdg' })).toBe(
      '/tmp/o.json'
    )
  })

  it('round-trips a theme through a path that does not exist yet', () => {
    const path = scratch()
    expect(readTuiSettings(path)).toEqual({})
    expect(writeTuiSettings({ theme: 'tokyo-night' }, path)).toBe(true)
    expect(readTuiSettings(path)).toEqual({ theme: 'tokyo-night' })
  })

  it('keeps keys it does not understand', () => {
    // Two versions of this CLI share one file on the same machine. An older
    // client writing a theme must not delete a newer client's settings.
    const path = scratch()
    writeFileSync(path, JSON.stringify({ theme: 'nord', futureSetting: { depth: 3 } }), 'utf8')
    writeTuiSettings({ theme: 'wraith-day' }, path)
    expect(readTuiSettings(path)).toEqual({ theme: 'wraith-day', futureSetting: { depth: 3 } })
  })

  it('treats every unreadable shape as no preferences rather than an error', () => {
    // A settings file must never be able to stop the client from starting.
    const path = scratch()
    for (const junk of ['not json at all', '[1,2,3]', 'null', '"a string"', '']) {
      writeFileSync(path, junk, 'utf8')
      expect(readTuiSettings(path), `parsing ${JSON.stringify(junk)}`).toEqual({})
    }
    expect(readTuiSettings(join(scratch(), 'missing', 'tui.json'))).toEqual({})
  })

  it('reports a failed write instead of throwing', () => {
    // The path is a directory, so the write cannot land. The session continues.
    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-tui-settings-dir-'))
    mkdirSync(join(directory, 'tui.json'))
    expect(writeTuiSettings({ theme: 'wraith-night' }, join(directory, 'tui.json'))).toBe(false)
  })

  it('leaves the previous settings intact when a write cannot complete', () => {
    const path = scratch()
    writeTuiSettings({ theme: 'tokyo-night' }, path)
    // `${path}.tmp` is a directory, so the temporary write fails before the
    // rename can clobber anything.
    mkdirSync(`${path}.tmp`)
    expect(writeTuiSettings({ theme: 'wraith-day' }, path)).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ theme: 'tokyo-night' })
  })
})
