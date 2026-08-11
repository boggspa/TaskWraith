import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGY_READ_ONLY_SHELL_PROJECTION_RULES,
  AntigravityPermissionLeaseAbortedError,
  AntigravityPermissionLeaseCoordinator,
  recoverInterruptedAntigravityHookLease,
  recoverInterruptedAntigravityPermissionLease
} from './AntigravityPermissionLease'
import { isReadOnlyGitShellCommand } from '../ReadOnlyGitShellCommand'
import { isInspectionShellCommand } from '../ShellCommandTierPolicy'

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
    const workspacePath = resolve('/Users/test/Project')
    const lease = await coordinator.acquire({
      settingsPath,
      workspacePath,
      allowShell: true,
      allowWrite: true
    })

    const installed = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(installed.permissions).toEqual({
      allow: [
        'command(git status)',
        `read_file(${workspacePath})`,
        ...AGY_READ_ONLY_SHELL_PROJECTION_RULES.filter((rule) => rule !== 'command(git status)'),
        `write_file(${workspacePath})`,
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

  it('installs the read-only shell projection under a fully read-only posture without shell or write widening', async () => {
    const { settingsPath, original } = await makeSettings({ model: 'gemini-3.1-pro-high' })
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const workspacePath = resolve('/Users/test/Project')
    const lease = await coordinator.acquire({
      settingsPath,
      workspacePath,
      allowShell: false,
      allowWrite: false
    })

    const installed = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(installed.permissions.allow).toEqual([
      `read_file(${workspacePath})`,
      ...AGY_READ_ONLY_SHELL_PROJECTION_RULES
    ])
    expect(installed.permissions.allow).toContain('command(git log)')
    expect(installed.permissions.allow).toContain('unsandboxed(git status --porcelain)')
    expect(installed.permissions.allow).not.toContain('command(*)')
    expect(installed.permissions.allow).not.toContain('write_file(/Users/test/Project)')
    expect(installed).not.toHaveProperty('toolPermission')
    expect(installed).not.toHaveProperty('artifactReviewPolicy')

    await lease.release()
    expect(await readFile(settingsPath, 'utf8')).toBe(original)
  })

  it('projects only command prefixes the universal read-only fast path classifiers accept', () => {
    for (const rule of AGY_READ_ONLY_SHELL_PROJECTION_RULES) {
      const match = rule.match(/^(command|unsandboxed)\((.+)\)$/)
      expect(match, `rule shape: ${rule}`).not.toBeNull()
      const target = match![2]
      expect(target, `wildcard leaked into projection: ${rule}`).not.toBe('*')
      if (target.startsWith('git')) {
        // agy prefix-matches binary+subcommand, so the projected git prefixes
        // must be forms the read-only git classifier itself accepts.
        expect(isReadOnlyGitShellCommand(target), `not read-only git: ${target}`).toBe(true)
      } else {
        expect(isInspectionShellCommand(target), `not inspection-safe: ${target}`).toBe(true)
      }
    }
    // Prefix rules cannot express per-token screening, so the heads the
    // classifier admits only conditionally must never be projected.
    for (const conditionalHead of [
      'rg',
      'env',
      'sort',
      'uniq',
      'tree',
      'file',
      'hostname',
      'date'
    ]) {
      expect(AGY_READ_ONLY_SHELL_PROJECTION_RULES).not.toContain(`command(${conditionalHead})`)
    }
    // Guard the invariant mechanically: a bare projected head must stay
    // classifier-accepted even when followed by an arbitrary unknown flag,
    // i.e. the head's classifier admission is genuinely unconditional.
    for (const rule of AGY_READ_ONLY_SHELL_PROJECTION_RULES) {
      const match = rule.match(/^command\(([a-z]+)\)$/)
      if (!match) continue
      expect(
        isInspectionShellCommand(`${match[1]} -o probe.txt probe2.txt`),
        `flag-conditional head projected: ${match[1]}`
      ).toBe(true)
    }
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

  it('installs and cleanly removes the hook-bridge overlay alongside the settings lease', async () => {
    const { settingsPath, original } = await makeSettings({ model: 'gemini-3.1-pro-high' })
    const workspace = await mkdtemp(join(tmpdir(), 'taskwraith-agy-hooks-ws-'))
    tempDirectories.push(workspace)
    const hooksPath = join(workspace, '.agents', 'hooks.json')
    await writeFile(
      join(workspace, 'placeholder.txt'),
      'workspace exists before the .agents dir does\n',
      'utf8'
    )
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const namedHook = {
      PreToolUse: [
        {
          matcher: 'run_command',
          hooks: [{ type: 'command', command: '/usr/bin/curl …', timeout: 600 }]
        }
      ]
    }
    const lease = await coordinator.acquire({
      settingsPath,
      workspacePath: workspace,
      allowShell: false,
      allowWrite: false,
      hookOverlay: { hooksPath, hookName: 'taskwraith-approval-bridge', namedHook }
    })

    const installed = JSON.parse(await readFile(hooksPath, 'utf8'))
    expect(installed['taskwraith-approval-bridge']).toEqual(namedHook)
    const installedSettings = JSON.parse(await readFile(settingsPath, 'utf8'))
    // Ask/Plan still routes every command through TaskWraith's live hook gate.
    // The agy settings layer must make an explicitly approved command possible
    // or headless mode auto-denies it after the user presses Allow.
    expect(installedSettings.permissions.allow).toContain('command(*)')
    expect(installedSettings.toolPermission).toBe('proceed-in-sandbox')
    expect(installedSettings.permissions.allow).not.toContain(`write_file(${workspace})`)

    await lease.release()
    // hooks.json did not exist before → removed outright; settings byte-exact.
    await expect(readFile(hooksPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(settingsPath, 'utf8')).toBe(original)
  })

  it('preserves user hooks edited mid-run and removes only the TaskWraith key', async () => {
    const { settingsPath } = await makeSettings({ model: 'gemini-3.1-pro-high' })
    const workspace = await mkdtemp(join(tmpdir(), 'taskwraith-agy-hooks-ws-'))
    tempDirectories.push(workspace)
    const hooksPath = join(workspace, '.agents', 'hooks.json')
    await mkdir(join(workspace, '.agents'), { recursive: true })
    await writeFile(
      hooksPath,
      `${JSON.stringify({ 'user-linter': { PostToolUse: [] } }, null, 2)}\n`,
      'utf8'
    )
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const lease = await coordinator.acquire({
      settingsPath,
      workspacePath: workspace,
      allowShell: false,
      allowWrite: false,
      hookOverlay: {
        hooksPath,
        hookName: 'taskwraith-approval-bridge',
        namedHook: { PreToolUse: [] }
      }
    })
    // The user adds another hook while the run is live.
    const during = JSON.parse(await readFile(hooksPath, 'utf8'))
    during['user-formatter'] = { PostToolUse: [] }
    await writeFile(hooksPath, `${JSON.stringify(during, null, 2)}\n`, 'utf8')

    await lease.release()
    const restored = JSON.parse(await readFile(hooksPath, 'utf8'))
    expect(restored).toEqual({
      'user-linter': { PostToolUse: [] },
      'user-formatter': { PostToolUse: [] }
    })
  })

  it('recovers an interrupted hook overlay from its durable receipt', async () => {
    const { settingsPath } = await makeSettings({ model: 'gemini-3.1-pro-high' })
    const workspace = await mkdtemp(join(tmpdir(), 'taskwraith-agy-hooks-ws-'))
    tempDirectories.push(workspace)
    const hooksPath = join(workspace, '.agents', 'hooks.json')
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    await coordinator.acquire({
      settingsPath,
      workspacePath: workspace,
      allowShell: false,
      allowWrite: false,
      hookOverlay: {
        hooksPath,
        hookName: 'taskwraith-approval-bridge',
        namedHook: { PreToolUse: [] }
      }
    })

    await expect(recoverInterruptedAntigravityHookLease(hooksPath)).resolves.toBe(true)
    await expect(readFile(hooksPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(recoverInterruptedAntigravityHookLease(hooksPath)).resolves.toBe(false)
    await recoverInterruptedAntigravityPermissionLease(settingsPath)
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

  it('cleans the published settings receipt when cancellation arrives during setup', async () => {
    const { directory, settingsPath, original } = await makeSettings({
      model: 'gemini-3.1-pro-high'
    })
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const controller = new AbortController()
    const input = {
      settingsPath,
      workspacePath: '/Users/test/Cancelled',
      allowShell: true,
      allowWrite: false
    } as Parameters<AntigravityPermissionLeaseCoordinator['acquire']>[0]
    // The sixth read is immediately before the settings replacement: the
    // receipt has been published, but no child can exist yet. The cancellation
    // must restore that receipt instead of leaving the next run serialized on
    // a stale global permission overlay.
    let signalReads = 0
    Object.defineProperty(input, 'signal', {
      enumerable: true,
      get: () => {
        signalReads += 1
        if (signalReads >= 6) controller.abort()
        return controller.signal
      }
    })

    await expect(coordinator.acquire(input)).rejects.toBeInstanceOf(
      AntigravityPermissionLeaseAbortedError
    )
    expect(await readFile(settingsPath, 'utf8')).toBe(original)
    await expect(
      readFile(join(directory, '.taskwraith-permission-lease.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('serializes incompatible global overlays and lets a queued cancellation leave cleanly', async () => {
    const { settingsPath } = await makeSettings({ model: 'gemini-3.1-pro-high' })
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const firstWorkspacePath = resolve('/Users/test/First')
    const secondWorkspacePath = resolve('/Users/test/Second')
    const first = await coordinator.acquire({
      settingsPath,
      workspacePath: firstWorkspacePath,
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
        workspacePath: secondWorkspacePath,
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
    expect(installed.permissions.allow).toContain(`read_file(${secondWorkspacePath})`)
    expect(installed.permissions.allow).not.toContain(`read_file(${firstWorkspacePath})`)
    expect(installed.permissions.allow).not.toContain('command(*)')
    expect(installed).not.toHaveProperty('toolPermission')
    await second.release()
  })
})
