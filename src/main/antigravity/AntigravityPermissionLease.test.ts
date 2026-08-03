import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AntigravityPermissionLeaseAbortedError,
  AntigravityPermissionLeaseCoordinator,
  recoverInterruptedAntigravityPermissionLease
} from './AntigravityPermissionLease'

const tempDirectories: string[] = []

async function makeSettings(content: Record<string, unknown>): Promise<{
  directory: string
  settingsPath: string
  original: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'taskwraith-agy-permissions-'))
  tempDirectories.push(directory)
  const settingsPath = join(directory, 'settings.json')
  const original = `${JSON.stringify(content, null, 4)}\n`
  await writeFile(settingsPath, original, 'utf8')
  return { directory, settingsPath, original }
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('AntigravityPermissionLeaseCoordinator', () => {
  it('installs only signed workspace rules and restores the exact original bytes', async () => {
    const { settingsPath, original } = await makeSettings({
      model: 'gemini-3.1-pro-high',
      permissions: {
        allow: ['command(git status)'],
        ask: ['command(rm)'],
        deny: ['read_file(/secrets/**)']
      },
      toolPermission: 'request-review'
    })
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const lease = await coordinator.acquire({
      settingsPath,
      workspacePath: '/Users/test/Project',
      allowShell: true,
      allowWrite: true
    })

    const installed = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(installed.permissions).toEqual({
      allow: [
        'command(git status)',
        'read_file(/Users/test/Project)',
        'read_file(/Users/test/Project/**)',
        'write_file(/Users/test/Project)',
        'write_file(/Users/test/Project/**)',
        'command(*)'
      ],
      ask: ['command(rm)'],
      deny: ['read_file(/secrets/**)']
    })
    expect(installed.toolPermission).toBe('proceed-in-sandbox')
    expect(installed.artifactReviewPolicy).toBe('always-proceed')

    await lease.release()
    expect(await readFile(settingsPath, 'utf8')).toBe(original)
  })

  it('preserves user edits made during a run while removing only its temporary overlay', async () => {
    const { settingsPath } = await makeSettings({
      model: 'gemini-3.1-pro-high',
      permissions: { allow: ['command(git status)'] },
      toolPermission: 'request-review'
    })
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const lease = await coordinator.acquire({
      settingsPath,
      workspacePath: '/Users/test/Project',
      allowShell: true,
      allowWrite: false
    })
    const changed = JSON.parse(await readFile(settingsPath, 'utf8'))
    changed.theme = 'light'
    changed.toolPermission = 'strict'
    changed.permissions.deny = ['command(rm)']
    await writeFile(settingsPath, `${JSON.stringify(changed, null, 2)}\n`, 'utf8')

    await lease.release()
    const restored = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(restored).toEqual({
      model: 'gemini-3.1-pro-high',
      permissions: {
        allow: ['command(git status)'],
        deny: ['command(rm)']
      },
      toolPermission: 'strict',
      theme: 'light'
    })
  })

  it('recovers an interrupted overlay from its durable receipt', async () => {
    const { settingsPath, original } = await makeSettings({ model: 'gemini-3.1-pro-high' })
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    await coordinator.acquire({
      settingsPath,
      workspacePath: '/Users/test/Project',
      allowShell: true,
      allowWrite: false
    })

    await expect(recoverInterruptedAntigravityPermissionLease(settingsPath)).resolves.toBe(true)
    expect(await readFile(settingsPath, 'utf8')).toBe(original)
    await expect(recoverInterruptedAntigravityPermissionLease(settingsPath)).resolves.toBe(false)
  })

  it('serializes incompatible global overlays and lets a queued cancellation leave cleanly', async () => {
    const { settingsPath } = await makeSettings({ model: 'gemini-3.1-pro-high' })
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const first = await coordinator.acquire({
      settingsPath,
      workspacePath: '/Users/test/First',
      allowShell: true,
      allowWrite: false
    })
    const controller = new AbortController()
    const cancelled = coordinator.acquire({
      settingsPath,
      workspacePath: '/Users/test/Cancelled',
      allowShell: true,
      allowWrite: false,
      signal: controller.signal
    })
    controller.abort()
    await expect(cancelled).rejects.toBeInstanceOf(AntigravityPermissionLeaseAbortedError)

    let secondSettled = false
    const secondPending = coordinator
      .acquire({
        settingsPath,
        workspacePath: '/Users/test/Second',
        allowShell: false,
        allowWrite: false
      })
      .then((lease) => {
        secondSettled = true
        return lease
      })
    await Promise.resolve()
    expect(secondSettled).toBe(false)

    await first.release()
    const second = await secondPending
    const installed = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(installed.permissions.allow).toContain('read_file(/Users/test/Second/**)')
    expect(installed.permissions.allow).not.toContain('read_file(/Users/test/First/**)')
    expect(installed).not.toHaveProperty('toolPermission')
    await second.release()
  })
})
