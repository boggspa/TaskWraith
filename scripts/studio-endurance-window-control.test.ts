import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const helperPath = resolve('scripts/studio-endurance-window-control.swift')
const helperSource = readFileSync(helperPath, 'utf8')

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'taskwraith-studio-endurance-window-control-request',
    expectedPid: process.pid,
    expectedPgid: process.pid,
    expectedExecutablePath:
      '/Applications/TaskWraith.app/Contents/Resources/studio/' +
      'TaskWraith Studio.app/Contents/MacOS/TaskWraithStudioCompanion',
    windowId: 1,
    windowTitle: 'TaskWraith Studio',
    timeoutMilliseconds: 5_000,
    ...overrides
  }
}

describe('Studio endurance window control', () => {
  it('uses exact background AX close and refuses the installed owner target', () => {
    expect(helperSource).toContain('kAXCloseButtonAttribute')
    expect(helperSource).toContain('AXUIElementPerformAction(close, kAXPressAction')
    expect(helperSource).toContain('getpgid(pid_t(request.expectedPid))')
    expect(helperSource).toContain('validateFocusIsolation(')
    expect(helperSource).toContain('cursorPreserved: cursorPreserved')
    expect(helperSource).toContain('CFGetTypeID(rawClose) == AXUIElementGetTypeID()')
    expect(helperSource).not.toContain('rawClose as! AXUIElement')
    expect(helperSource).toContain('!executable.path.hasPrefix("/Applications/TaskWraith.app/")')
    expect(helperSource).not.toContain('CGEvent(')
    expect(helperSource).not.toContain('.activate(')

    const directory = mkdtempSync(join(tmpdir(), 'studio-endurance-window-control-'))
    try {
      const requestPath = join(directory, 'request.json')
      writeFileSync(requestPath, JSON.stringify(request()), { mode: 0o600 })
      const result = spawnSync('/usr/bin/swift', [helperPath, requestPath], {
        encoding: 'utf8',
        timeout: 30_000
      })
      expect(result.status).toBe(2)
      expect(result.stderr).toMatch(/installed or inexact Companion is never a target/)
      expect(result.stdout).toBe('')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects extra request authority before inspecting a process or window', () => {
    const directory = mkdtempSync(join(tmpdir(), 'studio-endurance-window-control-'))
    try {
      const requestPath = join(directory, 'request.json')
      writeFileSync(requestPath, JSON.stringify(request({ forged: true })), { mode: 0o600 })
      const result = spawnSync('/usr/bin/swift', [helperPath, requestPath], {
        encoding: 'utf8',
        timeout: 30_000
      })
      expect(result.status).toBe(2)
      expect(result.stderr).toMatch(/missing or extra top-level keys/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
