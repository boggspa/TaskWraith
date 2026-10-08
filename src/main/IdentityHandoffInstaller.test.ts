import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { launchIdentityHandoffInstaller } from './IdentityHandoffInstaller'
import type { IdentityHandoffArtifact } from './IdentityHandoffService'

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function target(launchKind: IdentityHandoffArtifact['launchKind']): IdentityHandoffArtifact {
  return { launchKind } as IdentityHandoffArtifact
}

function childProcess() {
  const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
  const create = vi.fn(() => child)
  return { child, create, spawn: create as unknown as typeof spawn }
}

describe('identity handoff OS launch', () => {
  it('schedules the Linux executable after beta exit rather than spawning into its profile lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-relaunch-'))
    roots.push(root)
    const executable = join(root, 'TaskWraith.AppImage')
    writeFileSync(executable, 'fixture', { mode: 0o600 })
    const child = childProcess()
    const relaunch = vi.fn()
    await expect(
      launchIdentityHandoffInstaller(executable, target('appimage'), {
        relaunch,
        spawn: child.spawn
      })
    ).resolves.toEqual({ ok: true })
    expect(relaunch).toHaveBeenCalledExactlyOnceWith({ execPath: executable, args: [] })
    expect(child.create).not.toHaveBeenCalled()
    if (process.platform !== 'win32') expect(statSync(executable).mode & 0o777).toBe(0o700)
  })

  it('keeps beta available if no safe Linux relaunch service is wired', async () => {
    const child = childProcess()
    await expect(
      launchIdentityHandoffInstaller('/not-launched', target('appimage'), {
        spawn: child.spawn
      })
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('restart service') })
    expect(child.create).not.toHaveBeenCalled()
  })

  it.each(['', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(65), '../profile'])(
    'refuses an invalid isolated selector %j without restarting into production',
    async (isolatedInstanceId) => {
      const relaunch = vi.fn()
      await expect(
        launchIdentityHandoffInstaller('/not-launched', target('appimage'), {
          relaunch,
          isolatedInstanceId
        })
      ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('selector is invalid') })
      expect(relaunch).not.toHaveBeenCalled()
    }
  )

  it('waits for OS process creation before accepting a Windows installer launch', async () => {
    const child = childProcess()
    let finished = false
    const launched = launchIdentityHandoffInstaller('C:\\candidate.exe', target('nsis'), {
      spawn: child.spawn
    }).then((result) => {
      finished = true
      return result
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    child.child.emit('spawn')
    await expect(launched).resolves.toEqual({ ok: true })
    expect(child.child.unref).toHaveBeenCalledOnce()
    expect(child.create).toHaveBeenCalledWith('C:\\candidate.exe', [], {
      detached: true,
      stdio: 'ignore',
      shell: false
    })
  })

  it('reports a real asynchronous spawn failure rather than claiming launch succeeded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'handoff-missing-executable-'))
    roots.push(root)
    await expect(
      launchIdentityHandoffInstaller(join(root, 'missing.exe'), target('nsis'))
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('ENOENT') })
  })

  it('requires open to accept a disk image, not merely to start', async () => {
    const child = childProcess()
    let finished = false
    const launched = launchIdentityHandoffInstaller('/candidate.dmg', target('dmg'), {
      spawn: child.spawn
    }).then((result) => {
      finished = true
      return result
    })
    child.child.emit('spawn')
    await Promise.resolve()
    expect(finished).toBe(false)
    child.child.emit('exit', 1)
    await expect(launched).resolves.toMatchObject({ ok: false })
  })

  it('accepts a disk image only after open succeeds', async () => {
    const child = childProcess()
    const launched = launchIdentityHandoffInstaller('/candidate.dmg', target('dmg'), {
      spawn: child.spawn
    })
    child.child.emit('spawn')
    child.child.emit('exit', 0)
    await expect(launched).resolves.toEqual({ ok: true })
  })
})
