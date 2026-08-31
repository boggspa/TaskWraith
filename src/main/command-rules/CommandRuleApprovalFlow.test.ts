import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { AppSettings, CommandRule } from '../store/types'
import {
  CommandRuleService,
  createCommandRuleHmacSigningAuthority
} from './CommandRuleService'
import {
  CommandRuleApprovalFlow,
  type BrokeredCommandRuleInput
} from './CommandRuleApprovalFlow'

const tempPaths: string[] = []

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'taskwraith-command-offer-'))
  tempPaths.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await mkdir(join(workspace, 'src'))
  const executable = join(root, 'inspect-tool')
  await writeFile(executable, '#!/bin/sh\nprintf inspected\n')
  await chmod(executable, 0o700)
  const settings: Pick<AppSettings, 'commandRules'> = { commandRules: [] }
  const service = new CommandRuleService({
    getSettings: () => settings,
    updateSettings: (partial) => {
      settings.commandRules = partial.commandRules
    },
    signingAuthority: createCommandRuleHmacSigningAuthority('s'.repeat(32)),
    createId: () => 'rule-1'
  })
  const input: BrokeredCommandRuleInput = {
    provider: 'codex',
    runId: 'run-1',
    chatId: 'chat-1',
    toolName: 'run_shell_command',
    command: executable,
    requestedCwd: '.',
    resolvedCwd: workspace,
    workspaceId: 'workspace-1',
    primaryWorkspacePath: workspace,
    effectiveWorkspacePath: workspace,
    pathEnvironment: process.env.PATH,
    networkAccessDenied: false,
    shellCommandsDenied: false
  }
  return { workspace, executable, settings, service, input }
}

describe('CommandRuleApprovalFlow', () => {
  it('offers, revalidates, signs, matches, and commits one exact direct argv rule', async () => {
    const { service, settings, input } = await fixture()
    let liveInput = { ...input }
    const flow = new CommandRuleApprovalFlow({
      service,
      resolveLiveInput: () => liveInput,
      createOfferId: () => 'offer-1',
      createReservationId: () => 'reservation-1'
    })

    expect(flow.match(input)).toBeNull()
    expect(flow.register('approval-1', input)).toMatchObject({
      offerId: 'offer-1',
      executableName: 'inspect-tool',
      riskClass: 'host_exact_unsandboxed'
    })
    const accepted = flow.accept('approval-1', 'offer-1')
    expect(accepted).toMatchObject({
      ok: true,
      receipt: { created: true, rule: { id: 'rule-1' } },
      match: { argv: [] }
    })
    if (!accepted.ok) throw new Error(accepted.error)
    expect(settings.commandRules).toHaveLength(1)
    expect(flow.commit(accepted.receipt)).toBe(true)
    expect(flow.match(input)).toMatchObject({ rule: { id: 'rule-1' } })
    liveInput = { ...input, networkAccessDenied: true }
    expect(flow.matchLive(input)).toBeNull()
    liveInput = { ...input, shellCommandsDenied: true }
    expect(flow.matchLive(input)).toBeNull()
  })

  it('suppresses V1 offers for runtime worktrees or a resolved cwd mismatch', async () => {
    const { workspace, service, input } = await fixture()
    const worktree = join(workspace, 'worktree')
    await mkdir(worktree)
    const flow = new CommandRuleApprovalFlow({ service, resolveLiveInput: () => input })

    expect(
      flow.register('approval-worktree', { ...input, effectiveWorkspacePath: worktree })
    ).toBeNull()
    expect(
      flow.register('approval-cwd', { ...input, requestedCwd: 'src', resolvedCwd: workspace })
    ).toBeNull()
    expect(flow.register('approval-lane', { ...input, laneId: 'lane-1' })).toBeNull()
    expect(
      flow.register('approval-network-denied', { ...input, networkAccessDenied: true })
    ).toBeNull()
    expect(
      flow.register('approval-shell-denied', { ...input, shellCommandsDenied: true })
    ).toBeNull()
  })

  it('leaves the approval pending and persists nothing after live binding or executable drift', async () => {
    const { executable, service, settings, input } = await fixture()
    let live: BrokeredCommandRuleInput | null = null
    const flow = new CommandRuleApprovalFlow({
      service,
      resolveLiveInput: () => live,
      createOfferId: () => 'offer-stale'
    })
    expect(flow.register('approval-stale', input)).not.toBeNull()
    expect(flow.accept('approval-stale', 'offer-stale')).toMatchObject({ ok: false })
    live = { ...input }
    await writeFile(executable, '#!/bin/sh\nprintf changed\n')
    await chmod(executable, 0o700)
    expect(flow.accept('approval-stale', 'offer-stale')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/changed/)
    })
    expect(settings.commandRules).toEqual([])
  })

  it('rejects external, parent, symlink-escaped operands and workspace-owned executables', async () => {
    const { workspace, executable, service, input } = await fixture()
    const flow = new CommandRuleApprovalFlow({ service, resolveLiveInput: () => input })
    const external = join(workspace, '..', 'outside.txt')
    await writeFile(external, 'outside')
    const escapedLink = join(workspace, 'escaped-link')
    await symlink(external, escapedLink)

    for (const [approvalId, command] of [
      ['absolute', `${executable} ${external}`],
      ['parent', `${executable} ../outside.txt`],
      ['option-parent', `${executable} --config=../outside.txt`],
      ['symlink', `${executable} escaped-link`],
      ['response-file', `${executable} @${external}`],
      ['relative-response-file', `${executable} @../outside.txt`]
    ]) {
      expect(flow.register(`approval-${approvalId}`, { ...input, command }), approvalId).toBeNull()
    }

    const workspaceExecutable = join(workspace, 'workspace-tool')
    await writeFile(workspaceExecutable, '#!/bin/sh\nprintf unsafe\n')
    await chmod(workspaceExecutable, 0o700)
    expect(
      flow.register('approval-workspace-executable', {
        ...input,
        command: './workspace-tool'
      })
    ).toBeNull()
  })

  it('rolls back a newly-created rule but retains a pre-existing duplicate', async () => {
    const { service, settings, input } = await fixture()
    const flow = new CommandRuleApprovalFlow({
      service,
      resolveLiveInput: () => input,
      createOfferId: () => 'offer-new',
      createReservationId: () => 'reservation-new'
    })
    flow.register('approval-new', input)
    const created = flow.accept('approval-new', 'offer-new')
    if (!created.ok) throw new Error(created.error)
    flow.rollback(created.receipt)
    expect(settings.commandRules).toEqual([])

    const candidate = service.compileCandidate({
      toolName: 'run_shell_command',
      command: input.command,
      cwd: input.requestedCwd,
      workspacePath: input.primaryWorkspacePath,
      workspaceId: input.workspaceId,
      environment: { PATH: input.pathEnvironment }
    })
    if (!candidate.ok) throw new Error(candidate.reason)
    service.upsert(candidate.candidate)
    const original = (settings.commandRules as CommandRule[])[0]

    const duplicateFlow = new CommandRuleApprovalFlow({
      service,
      resolveLiveInput: () => input,
      createOfferId: () => 'offer-existing'
    })
    duplicateFlow.register('approval-existing', input)
    const existing = duplicateFlow.accept('approval-existing', 'offer-existing')
    if (!existing.ok) throw new Error(existing.error)
    expect(existing.receipt.created).toBe(false)
    duplicateFlow.rollback(existing.receipt)
    expect(settings.commandRules).toEqual([original])
  })
})
