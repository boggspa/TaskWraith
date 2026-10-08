import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  prepare,
  isolatedEnvironment,
  mainSource
} = require('./main-durability-electron-qualification.cjs')
const asar = require('@electron/asar')
const { execute } = require('./main-durability-electron-qualification.cjs')

describe('durability Electron qualification preparation', () => {
  it('keeps watchdog active after child error with a PID until closure is confirmed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-child-error-'))
    try {
      const prepared = await prepare(root)
      const child = Object.assign(new EventEmitter(), { pid: 123 })
      const pending = execute(prepared, {
        binary: 'unused',
        spawn: () => {
          setTimeout(() => child.emit('error', new Error('live error')), 1)
          return child
        },
        kill: () => {
          throw new Error('cannot kill')
        },
        deadlineMs: 5,
        confirmMs: 5
      })
      const result = await pending
      expect(result.closureConfirmed).toBe(false)
      expect(result.unresolvedCleanup).toBe(true)
      expect(result.killError).toContain('cannot kill')
      expect(result.childError).toContain('live error')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
  it('records spawn failure and bounded unresolved kill failure without launching Electron', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-qualification-failure-'))
    try {
      const prepared = await prepare(root)
      const failed = await execute(prepared, {
        binary: 'unused',
        spawn: () => {
          throw new Error('spawn failed')
        }
      })
      expect(failed.spawnError).toContain('spawn failed')
      expect(fs.existsSync(path.join(root, 'receipt.json'))).toBe(true)
      const unresolved = await execute(prepared, {
        binary: 'unused',
        spawn: () => Object.assign(new EventEmitter(), { pid: 123 }),
        kill: () => {
          throw new Error('kill failed')
        },
        deadlineMs: 5,
        confirmMs: 5
      })
      expect(unresolved.closureConfirmed).toBe(false)
      expect(unresolved.unresolvedCleanup).toBe(true)
      expect(unresolved.killError).toContain('kill failed')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('builds standalone Node22 entries in a disposable ASAR without launching Electron', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-qualification-build-'))
    try {
      const result = await prepare(root)
      const entries = asar
        .listPackage(result.archive)
        .map((entry) => entry.split(path.sep).join('/'))
      expect(entries).toContain('/out/worker.cjs')
      expect(entries).toContain('/out/adapter.cjs')
      expect(entries).toContain('/out/flusher.cjs')
      expect(entries).toContain('/out/main.cjs')
      expect(Object.keys(result.sourceSha256)).toHaveLength(3)
      expect(result.env.TW_DURABILITY_QUALIFICATION_STATE).toBe(path.join(root, 'state'))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not forward credential or production profile environment', () => {
    const env = isolatedEnvironment('/tmp/disposable-qualification')
    expect(Object.keys(env).sort()).toEqual(
      Object.keys(env)
        .filter((key) =>
          [
            'PATH',
            'SystemRoot',
            'WINDIR',
            'LANG',
            'LC_ALL',
            'TMPDIR',
            'HOME',
            'USERPROFILE',
            'XDG_CONFIG_HOME',
            'XDG_CACHE_HOME',
            'TW_DURABILITY_QUALIFICATION_STATE'
          ].includes(key)
        )
        .sort()
    )
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.HOME).toContain('disposable-qualification')
  })

  it('qualifies the actual browser process and ASAR worker without constructing windows', () => {
    expect(mainSource()).toContain("assert.equal(process.type, 'browser')")
    expect(mainSource()).toContain("process.versions.electron.split('.')[0], '41'")
    expect(mainSource()).not.toContain('new BrowserWindow')
    expect(mainSource()).not.toContain('app.whenReady')
  })
})
