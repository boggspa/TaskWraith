import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AGY_READ_ONLY_SHELL_PROJECTION_RULES,
  AntigravityPermissionLeaseAbortedError,
  AntigravityPermissionLeaseCoordinator,
  recoverInterruptedAntigravityHookLease,
  recoverInterruptedAntigravityMcpLease,
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

/** Resolves only if `pending` settles on its own — a FIFO would park it. */
async function settleWithin<T>(pending: Promise<T>, ms: number): Promise<T> {
  const sentinel = Symbol('still-pending')
  const outcome = await Promise.race([
    pending,
    new Promise<typeof sentinel>((resolveRace) => setTimeout(() => resolveRace(sentinel), ms))
  ])
  if (outcome === sentinel) {
    throw new Error(`acquire did not settle within ${ms}ms — a FIFO is serializing leases`)
  }
  return outcome
}

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
      'date',
      'sed'
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

  /**
   * 2026-08-19, direct user directive: the coordinator's run-length FIFO is
   * DELETED. Whether parallel agy lanes are safe is the user's composer-level
   * decision (isolation / parallel dispatch) — nothing in this module may make
   * one run wait for another run to finish. What remains is refcounted
   * bookkeeping only: the first holder installs and captures the user's
   * original bytes, joiners union in whatever is missing, releases shrink to
   * what the survivors still need, and the LAST holder restores.
   */
  it('grants concurrent leases for different workspaces without queueing', async () => {
    const { directory, settingsPath, original } = await makeSettings({
      model: 'gemini-3.1-pro-high'
    })
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const firstWorkspacePath = resolve('/Users/test/First')
    const secondWorkspacePath = resolve('/Users/test/Second')
    const first = await coordinator.acquire({
      settingsPath,
      workspacePath: firstWorkspacePath,
      allowShell: true,
      allowWrite: false
    })
    const second = await settleWithin(
      coordinator.acquire({
        settingsPath,
        workspacePath: secondWorkspacePath,
        allowShell: false,
        allowWrite: false
      }),
      400
    )

    const union = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(union.permissions.allow).toContain(`read_file(${firstWorkspacePath})`)
    expect(union.permissions.allow).toContain(`read_file(${secondWorkspacePath})`)

    // An early release shrinks the document to what the survivor still needs.
    await first.release()
    const shrunk = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(shrunk.permissions.allow).toContain(`read_file(${secondWorkspacePath})`)
    expect(shrunk.permissions.allow).not.toContain(`read_file(${firstWorkspacePath})`)
    expect(shrunk.permissions.allow).not.toContain('command(*)')
    expect(shrunk).not.toHaveProperty('toolPermission')

    await second.release()
    expect(await readFile(settingsPath, 'utf8')).toBe(original)
    await expect(
      readFile(join(directory, '.taskwraith-permission-lease.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('shares one install between same-workspace holders and restores on the last release', async () => {
    const { settingsPath, original } = await makeSettings({ model: 'gemini-3.1-pro-high' })
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const workspacePath = resolve('/Users/test/Shared')
    const input = { settingsPath, workspacePath, allowShell: true, allowWrite: true }
    const first = await coordinator.acquire(input)
    const afterFirst = await readFile(settingsPath, 'utf8')

    const second = await settleWithin(coordinator.acquire(input), 400)
    expect(await readFile(settingsPath, 'utf8')).toBe(afterFirst)

    // The joiner still holds the identical grant — nothing narrows under it.
    await first.release()
    expect(await readFile(settingsPath, 'utf8')).toBe(afterFirst)

    await second.release()
    expect(await readFile(settingsPath, 'utf8')).toBe(original)
  })

  it('hands the shared hook entry to a surviving holder on early release', async () => {
    const { directory, settingsPath } = await makeSettings({ model: 'gemini-3.1-pro-high' })
    const hooksPath = join(directory, 'hooks.json')
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const workspacePath = resolve('/Users/test/Shared')
    const overlayFor = (token: string) => ({
      hooksPath,
      hookName: 'taskwraith-agy-approval',
      namedHook: { hooks: [{ command: `curl --token ${token}` }] }
    })
    const readHook = async (): Promise<string> =>
      JSON.parse(await readFile(hooksPath, 'utf8'))['taskwraith-agy-approval'].hooks[0].command

    const first = await coordinator.acquire({
      settingsPath,
      workspacePath,
      allowShell: true,
      allowWrite: true,
      hookOverlay: overlayFor('token-aaaa')
    })
    const second = await settleWithin(
      coordinator.acquire({
        settingsPath,
        workspacePath,
        allowShell: true,
        allowWrite: true,
        hookOverlay: overlayFor('token-bbbb')
      }),
      400
    )

    // One live entry: the first holder's token, while it runs.
    expect(await readHook()).toContain('token-aaaa')

    // The owner leaving early hands the entry to a survivor whose bridge
    // registration is still alive — an unknown token at the bridge is a
    // fail-closed deny, so a dead token must never be left installed.
    await first.release()
    expect(await readHook()).toContain('token-bbbb')

    await second.release()
    await expect(readFile(hooksPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('AntigravityPermissionLeaseCoordinator MCP overlay', () => {
  const registration = {
    command: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
    args: ['--taskwraith-gemini-mcp-bridge', '--taskwraith-mcp-route-from-env']
  }

  async function makeLaneFixture(mcpContent: string | null): Promise<{
    settingsPath: string
    configPath: string
  }> {
    const directory = await mkdtemp(join(tmpdir(), 'taskwraith-agy-mcp-'))
    tempDirectories.push(directory)
    const settingsPath = join(directory, 'settings.json')
    await writeFile(settingsPath, `${JSON.stringify({ model: 'gemini-3.1-pro-high' }, null, 2)}\n`)
    const configDirectory = join(directory, 'config')
    await mkdir(configDirectory, { recursive: true })
    const configPath = join(configDirectory, 'mcp_config.json')
    if (mcpContent !== null) await writeFile(configPath, mcpContent, 'utf8')
    return { settingsPath, configPath }
  }

  function acquire(
    coordinator: AntigravityPermissionLeaseCoordinator,
    settingsPath: string,
    configPath: string
  ) {
    return coordinator.acquire({
      settingsPath,
      workspacePath: resolve('/Users/test/Project'),
      allowShell: false,
      allowWrite: false,
      mcpOverlay: { configPath, registration }
    })
  }

  it('registers into the byte-empty file agy ships and restores it empty', async () => {
    // The measured real-world state: agy creates mcp_config.json 0-byte at
    // migration. If that did not install, the fix would miss exactly the
    // machines that need it.
    const { settingsPath, configPath } = await makeLaneFixture('')
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const lease = await acquire(coordinator, settingsPath, configPath)

    expect(lease.mcpRegistered).toBe(true)
    const installed = JSON.parse(await readFile(configPath, 'utf8'))
    expect(installed.mcpServers.TaskWraith).toMatchObject({ command: registration.command })
    expect(installed.mcpServers.TaskWraith.env).toEqual({
      TASKWRAITH_PARENT_PROVIDER: 'antigravity'
    })

    await lease.release()
    expect(await readFile(configPath, 'utf8')).toBe('')
  })

  it('keeps the user own servers through install and release', async () => {
    const { settingsPath, configPath } = await makeLaneFixture(
      `${JSON.stringify({ mcpServers: { 'sqlite-helper': { command: 'sqlite-mcp-server' } } }, null, 2)}\n`
    )
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const lease = await acquire(coordinator, settingsPath, configPath)

    const installed = JSON.parse(await readFile(configPath, 'utf8'))
    expect(Object.keys(installed.mcpServers)).toEqual(['sqlite-helper', 'TaskWraith'])

    await lease.release()
    const restored = JSON.parse(await readFile(configPath, 'utf8'))
    expect(restored.mcpServers).toEqual({ 'sqlite-helper': { command: 'sqlite-mcp-server' } })
  })

  it('declines an unreadable config instead of clobbering it, and still launches', async () => {
    const unreadable = '{ this is not json'
    const { settingsPath, configPath } = await makeLaneFixture(unreadable)
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const lease = await acquire(coordinator, settingsPath, configPath)

    // The run proceeds with no TaskWraith tools — exactly the posture every
    // agy run had before this existed — and the user's bytes are untouched.
    expect(lease.mcpRegistered).toBe(false)
    expect(await readFile(configPath, 'utf8')).toBe(unreadable)
    await lease.release()
    expect(await readFile(configPath, 'utf8')).toBe(unreadable)
  })

  it('opens agy layer-1 for MCP only alongside the registration AND the hook', async () => {
    // Live-measured 2026-08-19: agy headless auto-denies call_mcp_tool with no
    // allow rule, stranding the whole registered TaskWraith surface. mcp(*) is
    // the only spelling the binary carries; the hook is the per-call gate, so
    // the rule must never install without it.
    const { settingsPath, configPath } = await makeLaneFixture('')
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const withHook = await coordinator.acquire({
      settingsPath,
      workspacePath: resolve('/Users/test/Project'),
      allowShell: false,
      allowWrite: false,
      hookOverlay: {
        hooksPath: join(dirname(settingsPath), 'hooks.json'),
        hookName: 'taskwraith-approval-bridge',
        namedHook: { PreToolUse: [] }
      },
      mcpOverlay: { configPath, registration }
    })
    const installed = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(installed.permissions.allow).toContain('mcp(*)')
    await withHook.release()
    const restored = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(JSON.stringify(restored)).not.toContain('mcp(*)')

    // Registration without the arbitrating hook: tools stay dark, layer-1
    // stays shut — the run is exactly as capable as before the feature.
    const withoutHook = await coordinator.acquire({
      settingsPath,
      workspacePath: resolve('/Users/test/Project'),
      allowShell: false,
      allowWrite: false,
      mcpOverlay: { configPath, registration }
    })
    const bare = JSON.parse(await readFile(settingsPath, 'utf8'))
    expect(JSON.stringify(bare.permissions?.allow ?? [])).not.toContain('mcp(*)')
    await withoutHook.release()
  })

  it('installs once for concurrent holders and withdraws with the last', async () => {
    const { settingsPath, configPath } = await makeLaneFixture('')
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const first = await acquire(coordinator, settingsPath, configPath)
    const second = await settleWithin(
      coordinator.acquire({
        settingsPath,
        workspacePath: resolve('/Users/test/OtherProject'),
        allowShell: false,
        allowWrite: false,
        mcpOverlay: { configPath, registration }
      }),
      400
    )

    expect(first.mcpRegistered).toBe(true)
    expect(second.mcpRegistered).toBe(true)

    await first.release()
    const held = JSON.parse(await readFile(configPath, 'utf8'))
    expect(held.mcpServers.TaskWraith).toMatchObject({ command: registration.command })

    await second.release()
    expect(await readFile(configPath, 'utf8')).toBe('')
  })

  it('honours an identical user-owned registration without taking it away on release', async () => {
    const userOwned = `${JSON.stringify(
      {
        mcpServers: {
          TaskWraith: {
            command: registration.command,
            args: registration.args,
            env: { TASKWRAITH_PARENT_PROVIDER: 'antigravity' }
          }
        }
      },
      null,
      2
    )}\n`
    const { settingsPath, configPath } = await makeLaneFixture(userOwned)
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const lease = await acquire(coordinator, settingsPath, configPath)

    expect(lease.mcpRegistered).toBe(true)
    await lease.release()
    const after = JSON.parse(await readFile(configPath, 'utf8'))
    expect(after.mcpServers.TaskWraith).toMatchObject({ command: registration.command })
  })

  it('withdraws only its own key when the document changed mid-run', async () => {
    const { settingsPath, configPath } = await makeLaneFixture('')
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const lease = await acquire(coordinator, settingsPath, configPath)

    const live = JSON.parse(await readFile(configPath, 'utf8'))
    live.mcpServers['added-during-run'] = { serverUrl: 'https://mcp.example.com/sse' }
    await writeFile(configPath, `${JSON.stringify(live, null, 2)}\n`, 'utf8')

    await lease.release()
    const restored = JSON.parse(await readFile(configPath, 'utf8'))
    expect(restored.mcpServers).toEqual({
      'added-during-run': { serverUrl: 'https://mcp.example.com/sse' }
    })
  })

  it('recovers a registration stranded by a crash before the next run', async () => {
    const { settingsPath, configPath } = await makeLaneFixture('')
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    await acquire(coordinator, settingsPath, configPath)
    // No release: simulate the process dying mid-run.

    expect(await recoverInterruptedAntigravityMcpLease(configPath)).toBe(true)
    expect(await readFile(configPath, 'utf8')).toBe('')
    expect(await recoverInterruptedAntigravityMcpLease(configPath)).toBe(false)
  })

  it('leaves the config alone entirely when no overlay is requested', async () => {
    const { settingsPath, configPath } = await makeLaneFixture('')
    const coordinator = new AntigravityPermissionLeaseCoordinator()
    const lease = await coordinator.acquire({
      settingsPath,
      workspacePath: resolve('/Users/test/Project'),
      allowShell: false,
      allowWrite: false
    })

    expect(lease.mcpRegistered).toBe(false)
    expect(await readFile(configPath, 'utf8')).toBe('')
    await lease.release()
  })
})

// agy's MCP map is ONE machine-global file, but the coordinator's refcount and
// its per-file op chain are per-PROCESS. A dev build beside a release build (or
// two isolated profiles) therefore meet only at the receipt, which is why the
// receipt has to say who owns it.
describe('AntigravityPermissionLeaseCoordinator MCP overlay — sibling instances', () => {
  const registration = {
    command: '/Applications/TaskWraith.app/Contents/MacOS/TaskWraith',
    args: ['--taskwraith-gemini-mcp-bridge', '--taskwraith-mcp-route-from-env']
  }

  async function installedLane(): Promise<{
    configPath: string
    receiptPath: string
    lease: { mcpRegistered: boolean; release: () => Promise<void> }
    installed: string
  }> {
    const directory = await mkdtemp(join(tmpdir(), 'taskwraith-agy-mcp-sibling-'))
    tempDirectories.push(directory)
    const settingsPath = join(directory, 'settings.json')
    await writeFile(settingsPath, `${JSON.stringify({ model: 'x' }, null, 2)}\n`, 'utf8')
    const configDirectory = join(directory, 'config')
    await mkdir(configDirectory, { recursive: true })
    const configPath = join(configDirectory, 'mcp_config.json')
    await writeFile(configPath, '', 'utf8')
    const lease = await new AntigravityPermissionLeaseCoordinator().acquire({
      settingsPath,
      workspacePath: resolve('/Users/test/Project'),
      allowShell: false,
      allowWrite: false,
      mcpOverlay: { configPath, registration }
    })
    expect(lease.mcpRegistered).toBe(true)
    return {
      configPath,
      receiptPath: join(dirname(configPath), '.taskwraith-mcp-lease.json'),
      lease,
      installed: await readFile(configPath, 'utf8')
    }
  }

  async function reassignReceipt(
    receiptPath: string,
    owner: { ownerId?: string; ownerPid?: number; installedAt?: string }
  ): Promise<void> {
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    delete receipt.ownerId
    delete receipt.ownerPid
    await writeFile(receiptPath, `${JSON.stringify({ ...receipt, ...owner }, null, 2)}\n`, 'utf8')
  }

  function deadPid(): number {
    const finished = spawnSync(process.execPath, ['-e', ''])
    if (typeof finished.pid !== 'number') throw new Error('could not source a reaped pid')
    return finished.pid
  }

  it('stamps the owning instance onto the receipt', async () => {
    const { receiptPath, lease } = await installedLane()

    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    expect(typeof receipt.ownerId).toBe('string')
    expect(receipt.ownerId).not.toBe('')
    expect(receipt.ownerPid).toBe(process.pid)

    await lease.release()
  })

  it('does NOT roll back a live sibling instance registration', async () => {
    const { configPath, receiptPath, installed, lease } = await installedLane()
    await reassignReceipt(receiptPath, { ownerId: 'sibling-instance', ownerPid: process.pid })

    const recovered = await recoverInterruptedAntigravityMcpLease(configPath)

    expect(recovered).toBe(false)
    expect(await readFile(configPath, 'utf8')).toBe(installed)
    await lease.release()
  })

  it('leaves the document alone on release once a sibling owns the receipt', async () => {
    const { configPath, receiptPath, installed, lease } = await installedLane()
    await reassignReceipt(receiptPath, { ownerId: 'sibling-instance', ownerPid: process.pid })

    await lease.release()

    // The sibling is still running against this registration; restoring our
    // original here is what silently strips a live run's TaskWraith tools.
    expect(await readFile(configPath, 'utf8')).toBe(installed)
    await expect(readFile(receiptPath, 'utf8')).resolves.toContain('sibling-instance')
  })

  it('recovers a receipt whose owning process is gone', async () => {
    const { configPath, receiptPath, lease } = await installedLane()
    await reassignReceipt(receiptPath, { ownerId: 'crashed-instance', ownerPid: deadPid() })

    const recovered = await recoverInterruptedAntigravityMcpLease(configPath)

    expect(recovered).toBe(true)
    expect(await readFile(configPath, 'utf8')).toBe('')
    await lease.release()
  })

  it('recovers a legacy receipt that names no owner at all', async () => {
    const { configPath, receiptPath, lease } = await installedLane()
    await reassignReceipt(receiptPath, {})

    const recovered = await recoverInterruptedAntigravityMcpLease(configPath)

    expect(recovered).toBe(true)
    expect(await readFile(configPath, 'utf8')).toBe('')
    await lease.release()
  })

  // A recycled pid would otherwise read as a live owner forever, and the
  // registration would then never leave the user's global agy config.
  it('recovers a receipt whose owner looks alive but whose stamp is far too old', async () => {
    const { configPath, receiptPath, lease } = await installedLane()
    await reassignReceipt(receiptPath, {
      ownerId: 'recycled-pid-instance',
      ownerPid: process.pid,
      installedAt: new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
    })

    const recovered = await recoverInterruptedAntigravityMcpLease(configPath)

    expect(recovered).toBe(true)
    expect(await readFile(configPath, 'utf8')).toBe('')
    await lease.release()
  })
})
