import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppSettings, CommandRule } from '../store/types'
import {
  CommandRuleError,
  CommandRuleService,
  createCommandRuleHmacSigningAuthority
} from './CommandRuleService'

const tempPaths: string[] = []

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

async function createFixture(): Promise<{
  root: string
  workspace: string
  app: string
  bin: string
  executable: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'taskwraith-command-rules-'))
  tempPaths.push(root)
  const workspace = join(root, 'workspace')
  const app = join(workspace, 'app')
  const bin = join(root, 'bin')
  const executable = join(bin, 'taskwraith-test')
  await Promise.all([mkdir(app, { recursive: true }), mkdir(bin, { recursive: true })])
  await writeFile(executable, '#!/bin/sh\nexit 0\n')
  await chmod(executable, 0o755)
  return { root, workspace, app, bin, executable }
}

function createService(rules: CommandRule[] = []): {
  service: CommandRuleService
  settings: Pick<AppSettings, 'commandRules'>
} {
  const settings: Pick<AppSettings, 'commandRules'> = { commandRules: rules }
  return {
    settings,
    service: new CommandRuleService({
      getSettings: () => settings,
      updateSettings: (partial) => {
        settings.commandRules = partial.commandRules
      },
      signingAuthority: createCommandRuleHmacSigningAuthority(
        'test-command-rule-secret-32-bytes!!'
      ),
      now: () => new Date('2026-08-31T13:20:00.000Z'),
      createId: () => 'rule-1'
    })
  }
}

describe('CommandRuleService', () => {
  it('rejects a weak main signing secret', () => {
    expect(() => createCommandRuleHmacSigningAuthority('too-short')).toThrow(/32 bytes/)
  })

  it('requires a non-empty workspace id before compiling a V1 rule candidate', async () => {
    const { workspace, bin } = await createFixture()
    const { service } = createService()

    expect(
      service.compileCandidate({
        toolName: 'run_shell_command',
        command: 'taskwraith-test --check',
        workspacePath: workspace,
        workspaceId: '',
        environment: { PATH: bin }
      })
    ).toEqual({ ok: false, reason: 'workspace_id_required' })
  })

  it('rejects an argv shape that cannot be persisted as an exact rule', async () => {
    const { workspace, bin } = await createFixture()
    const { service } = createService()
    expect(
      service.compileCandidate({
        toolName: 'run_shell_command',
        command: `taskwraith-test ${Array.from({ length: 65 }, () => 'arg').join(' ')}`,
        workspacePath: workspace,
        workspaceId: 'workspace-1',
        environment: { PATH: bin }
      })
    ).toEqual({ ok: false, reason: 'invalid_candidate' })
  })

  it('compiles, persists, and matches one exact brokered argv invocation', async () => {
    const { workspace, app, bin, executable } = await createFixture()
    const { service, settings } = createService()
    const input = {
      toolName: 'run_shell_command' as const,
      command: 'taskwraith-test --check "two words"',
      cwd: 'app',
      workspacePath: workspace,
      workspaceId: 'workspace-1',
      approvalId: 'approval-1',
      environment: { PATH: bin }
    }

    const compiled = service.compileCandidate(input)
    expect(compiled).toMatchObject({ ok: true })
    if (!compiled.ok) return
    expect(compiled.candidate).toMatchObject({
      primaryWorkspaceRealPath: realpathSync(workspace),
      resolvedCwd: realpathSync(app),
      executableRealPath: realpathSync(executable),
      argv: ['--check', 'two words'],
      riskClass: 'host_exact_unsandboxed',
      approvalId: 'approval-1'
    })

    expect(service.upsert(compiled.candidate)).toMatchObject({
      created: true,
      rule: {
        signatureVersion: 'hmac-sha256-v1',
        signature: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })
    expect(settings.commandRules).toHaveLength(1)
    expect(service.upsert(compiled.candidate)).toMatchObject({ created: false })

    expect(service.match(input)).toMatchObject({
      cwd: realpathSync(app),
      executableRealPath: realpathSync(executable),
      argv: ['--check', 'two words']
    })
    expect(service.match({ ...input, command: 'taskwraith-test --check changed' })).toBeNull()
    expect(service.match({ ...input, cwd: '.' })).toBeNull()
  })

  it('revalidates executable content before matching a persisted rule', async () => {
    const { workspace, bin, executable } = await createFixture()
    const { service } = createService()
    const input = {
      toolName: 'run_shell_command' as const,
      command: 'taskwraith-test --check',
      workspacePath: workspace,
      workspaceId: 'workspace-1',
      environment: { PATH: bin }
    }
    const compiled = service.compileCandidate(input)
    if (!compiled.ok) throw new Error(compiled.reason)
    service.upsert(compiled.candidate)
    await writeFile(executable, '#!/bin/sh\necho changed\n')
    await chmod(executable, 0o755)

    expect(service.match(input)).toBeNull()
  })

  it('refuses a candidate whose persisted identity no longer matches its compiled facts', async () => {
    const { workspace, bin } = await createFixture()
    const { service, settings } = createService()
    const compiled = service.compileCandidate({
      toolName: 'run_shell_command',
      command: 'taskwraith-test --check',
      workspacePath: workspace,
      workspaceId: 'workspace-1',
      environment: { PATH: bin }
    })
    if (!compiled.ok) throw new Error(compiled.reason)

    expect(() => service.upsert({ ...compiled.candidate, argv: ['--different'] })).toThrow(
      CommandRuleError
    )
    expect(settings.commandRules).toEqual([])
  })

  it('rejects a forged persisted rule even when its public fingerprint was recomputed', async () => {
    const { workspace, bin } = await createFixture()
    const { service, settings } = createService()
    const initialInput = {
      toolName: 'run_shell_command' as const,
      command: 'taskwraith-test --check',
      workspacePath: workspace,
      workspaceId: 'workspace-1',
      environment: { PATH: bin }
    }
    const initial = service.compileCandidate(initialInput)
    if (!initial.ok) throw new Error(initial.reason)
    const saved = service.upsert(initial.candidate).rule

    const changedInput = { ...initialInput, command: 'taskwraith-test --different' }
    const changed = service.compileCandidate(changedInput)
    if (!changed.ok) throw new Error(changed.reason)
    // An attacker can recompute all public SHA-256 fields, but does not have
    // the injected main HMAC secret needed to bind this changed argv.
    settings.commandRules = [
      {
        ...saved,
        argv: [...changed.candidate.argv],
        fingerprint: changed.candidate.fingerprint
      }
    ]

    expect(service.match(changedInput)).toBeNull()
  })

  it('verifies signatures before a forged duplicate can crowd out a valid rule', async () => {
    const { workspace, bin } = await createFixture()
    const { service, settings } = createService()
    const input = {
      toolName: 'run_shell_command' as const,
      command: 'taskwraith-test --check',
      workspacePath: workspace,
      workspaceId: 'workspace-1',
      environment: { PATH: bin }
    }
    const compiled = service.compileCandidate(input)
    if (!compiled.ok) throw new Error(compiled.reason)
    const saved = service.upsert(compiled.candidate).rule
    settings.commandRules = [
      saved,
      {
        ...saved,
        id: 'forged-newer-rule',
        updatedAt: '2099-01-01T00:00:00.000Z',
        signature: '0'.repeat(64)
      }
    ]

    expect(service.match(input)).toMatchObject({ rule: { id: saved.id } })
  })

  it('rejects a cwd symlink that resolves outside the workspace', async () => {
    const { root, workspace, bin } = await createFixture()
    const outside = join(root, 'outside')
    const escaped = join(workspace, 'escaped')
    await mkdir(outside, { recursive: true })
    await symlink(outside, escaped)
    const { service } = createService()

    expect(
      service.compileCandidate({
        toolName: 'run_shell_command',
        command: 'taskwraith-test --check',
        cwd: 'escaped',
        workspacePath: workspace,
        workspaceId: 'workspace-1',
        environment: { PATH: bin }
      })
    ).toEqual({ ok: false, reason: 'cwd_outside_workspace' })
  })

  it('rejects a relative executable that escapes the workspace and removes only a bound rule', async () => {
    const { root, workspace, bin } = await createFixture()
    const { service } = createService()
    const outsideExecutable = join(root, 'outside-tool')
    await writeFile(outsideExecutable, '#!/bin/sh\nexit 0\n')
    await chmod(outsideExecutable, 0o755)

    expect(
      service.compileCandidate({
        toolName: 'run_shell_command',
        command: '../outside-tool',
        workspacePath: workspace,
        workspaceId: 'workspace-1',
        environment: { PATH: bin }
      })
    ).toEqual({ ok: false, reason: 'relative_executable_outside_workspace' })

    await symlink(outsideExecutable, join(workspace, 'linked-tool'))
    expect(
      service.compileCandidate({
        toolName: 'run_shell_command',
        command: './linked-tool',
        workspacePath: workspace,
        workspaceId: 'workspace-1',
        environment: { PATH: bin }
      })
    ).toEqual({ ok: false, reason: 'relative_executable_outside_workspace' })

    const compiled = service.compileCandidate({
      toolName: 'run_shell_command',
      command: 'taskwraith-test',
      workspacePath: workspace,
      workspaceId: 'workspace-1',
      environment: { PATH: bin }
    })
    if (!compiled.ok) throw new Error(compiled.reason)
    const { rule } = service.upsert(compiled.candidate)
    expect(
      service.remove({
        id: rule.id,
        workspacePath: '/another-workspace',
        workspaceId: 'workspace-1'
      })
    ).toBe(false)
    expect(
      service.remove({
        id: rule.id,
        workspacePath: realpathSync(workspace),
        workspaceId: 'workspace-2'
      })
    ).toBe(false)
    expect(
      service.remove({
        id: rule.id,
        workspacePath: `${realpathSync(workspace)}/.`,
        workspaceId: 'workspace-1'
      })
    ).toBe(false)
    expect(
      service.remove({
        id: rule.id,
        workspacePath: realpathSync(workspace),
        workspaceId: 'workspace-1'
      })
    ).toBe(true)
    expect(service.list()).toEqual([])
  })
})
