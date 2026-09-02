import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { ProviderId } from '../store/types'
import type { CommandRuleListItem, ExactCommandRuleOfferView } from '../../shared/commandRules'
import {
  CommandRuleService,
  type CommandRuleCandidate,
  type CommandRuleMatch
} from './CommandRuleService'
import { parseStaticShellArgv } from './StaticShellArgv'

const COMMAND_RULE_OFFER_TTL_MS = 10 * 60 * 1_000
const COMMAND_RULE_OFFER_MAX_ENTRIES = 128

export interface BrokeredCommandRuleInput {
  provider: ProviderId
  runId: string
  chatId: string
  toolName: 'run_shell_command'
  command: unknown
  requestedCwd?: unknown
  resolvedCwd: string
  workspaceId: string
  primaryWorkspacePath: string
  effectiveWorkspacePath: string
  pathEnvironment?: string
  laneId?: string
  networkAccessDenied: boolean
  shellCommandsDenied: boolean
}

export interface CommandRuleApprovalFlowOptions {
  service: CommandRuleService
  resolveLiveInput: (issued: Readonly<BrokeredCommandRuleInput>) => BrokeredCommandRuleInput | null
  now?: () => number
  createOfferId?: () => string
  createReservationId?: () => string
}

export type CommandRuleOfferAcceptResult =
  | { ok: false; error: string }
  | {
      ok: true
      receipt: CommandRuleOfferReceipt
      match: CommandRuleMatch
    }

export interface CommandRuleOfferReceipt {
  approvalId: string
  offerId: string
  reservationId: string
  created: boolean
  rule: ReturnType<CommandRuleService['upsert']>['rule']
}

interface StoredCommandRuleOffer {
  approvalId: string
  offerId: string
  issuedAt: number
  expiresAt: number
  input: BrokeredCommandRuleInput
  candidate: CommandRuleCandidate
  state: 'pending' | 'reserved'
  reservationId?: string
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function sameIssuedIdentity(
  issued: BrokeredCommandRuleInput,
  live: BrokeredCommandRuleInput
): boolean {
  return (
    issued.provider === live.provider &&
    issued.runId === live.runId &&
    issued.chatId === live.chatId &&
    issued.toolName === live.toolName &&
    issued.command === live.command &&
    issued.requestedCwd === live.requestedCwd &&
    issued.workspaceId === live.workspaceId &&
    issued.laneId === live.laneId &&
    issued.networkAccessDenied === live.networkAccessDenied &&
    issued.shellCommandsDenied === live.shellCommandsDenied
  )
}

function compileInput(
  service: CommandRuleService,
  input: BrokeredCommandRuleInput,
  approvalId?: string
): ReturnType<CommandRuleService['compileCandidate']> {
  let primaryRealPath: string
  let effectiveRealPath: string
  let resolvedCwd: string
  try {
    primaryRealPath = fs.realpathSync(path.resolve(input.primaryWorkspacePath))
    effectiveRealPath = fs.realpathSync(path.resolve(input.effectiveWorkspacePath))
    resolvedCwd = fs.realpathSync(path.resolve(input.resolvedCwd))
  } catch {
    return { ok: false, reason: 'workspace_not_directory' }
  }
  if (nonEmpty(input.laneId)) return { ok: false, reason: 'invalid_candidate' }
  if (input.networkAccessDenied) return { ok: false, reason: 'invalid_candidate' }
  if (input.shellCommandsDenied) return { ok: false, reason: 'invalid_candidate' }
  // V1 binds one primary checkout. A runtime worktree needs a future schema
  // field of its own; silently treating it as the primary would mis-scope a
  // durable rule.
  if (primaryRealPath !== effectiveRealPath) {
    return { ok: false, reason: 'cwd_outside_workspace' }
  }
  const compiled = service.compileCandidate({
    toolName: input.toolName,
    command: input.command,
    cwd: input.requestedCwd,
    workspacePath: input.primaryWorkspacePath,
    workspaceId: input.workspaceId,
    ...(approvalId ? { approvalId } : {}),
    environment: { PATH: input.pathEnvironment }
  })
  if (!compiled.ok) return compiled
  if (compiled.candidate.resolvedCwd !== resolvedCwd) {
    return { ok: false, reason: 'cwd_outside_workspace' }
  }
  if (
    compiled.candidate.cwdRelativePath !== '.' ||
    compiled.candidate.resolvedCwd !== compiled.candidate.primaryWorkspaceRealPath ||
    isInside(compiled.candidate.primaryWorkspaceRealPath, compiled.candidate.executableRealPath) ||
    !argvStaysWithinWorkspace(compiled.candidate) ||
    !hasV1NonFilesystemArgumentGrammar(input.command, compiled.candidate.argv)
  ) {
    return { ok: false, reason: 'invalid_candidate' }
  }
  return compiled
}

const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/

/**
 * V1 keeps filesystem operands out of durable automatic rules altogether.
 * Zero-argument tools and a small task-runner grammar remain useful without
 * consenting to a path that another writer could symlink-swap before spawn.
 */
function hasV1NonFilesystemArgumentGrammar(command: unknown, argv: readonly string[]): boolean {
  const parsed = parseStaticShellArgv(command)
  if (!parsed.ok) return false
  if (argv.length === 0) return true
  const executableName = path.basename(parsed.value.executable)
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executableName)) {
    return (
      (argv.length === 1 && argv[0] === 'test') ||
      (argv.length === 2 && argv[0] === 'run' && TASK_NAME.test(argv[1]))
    )
  }
  if (executableName === 'cargo' || executableName === 'swift') {
    return argv.length === 1 && ['build', 'check', 'test'].includes(argv[0])
  }
  if (['make', 'just', 'task'].includes(executableName)) {
    return argv.length === 1 && TASK_NAME.test(argv[0])
  }
  return false
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
}

function possiblePathValue(token: string): string {
  if (token.startsWith('file://')) return token
  if (token.startsWith('@')) return token.slice(1)
  const marker = token.search(/[=:]/)
  return marker >= 0 && marker < token.length - 1 ? token.slice(marker + 1) : token
}

/**
 * V1 lexical/realpath floor for user-authored exact rules. This is not a claim
 * that an arbitrary program is sandboxed; the risk class remains explicit.
 * It prevents the durable authority itself from naming external, parent, or
 * symlink-escaped operands.
 */
function argvStaysWithinWorkspace(candidate: CommandRuleCandidate): boolean {
  for (const token of candidate.argv) {
    const value = possiblePathValue(token)
    if (value.startsWith('file://') || value.startsWith('~')) return false
    if (value.split(/[\\/]/).includes('..')) return false
    if (path.isAbsolute(value)) {
      if (!isInside(candidate.primaryWorkspaceRealPath, path.resolve(value))) return false
      try {
        if (!isInside(candidate.primaryWorkspaceRealPath, fs.realpathSync(value))) return false
      } catch {
        // A non-existent absolute target is still lexically contained above.
      }
      continue
    }
    const lexical = path.resolve(candidate.resolvedCwd, value)
    if (!fs.existsSync(lexical)) continue
    try {
      if (!isInside(candidate.primaryWorkspaceRealPath, fs.realpathSync(lexical))) return false
    } catch {
      return false
    }
  }
  return true
}

export function commandRuleListItem(
  rule: ReturnType<CommandRuleService['list']>[number]
): CommandRuleListItem {
  return {
    id: rule.id,
    workspaceId: rule.workspaceId,
    workspacePath: rule.primaryWorkspacePath,
    cwdRelativePath: rule.cwdRelativePath,
    executablePath: rule.executableRealPath,
    argv: [...rule.argv],
    fingerprint: rule.fingerprint,
    riskClass: rule.riskClass,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt
  }
}

export class CommandRuleApprovalFlow {
  private readonly offers = new Map<string, StoredCommandRuleOffer>()
  private readonly now: () => number
  private readonly createOfferId: () => string
  private readonly createReservationId: () => string

  constructor(private readonly options: CommandRuleApprovalFlowOptions) {
    this.now = options.now ?? (() => Date.now())
    this.createOfferId = options.createOfferId ?? (() => `twcr_${randomUUID()}`)
    this.createReservationId = options.createReservationId ?? (() => `twcrr_${randomUUID()}`)
  }

  match(input: BrokeredCommandRuleInput): CommandRuleMatch | null {
    const compiled = compileInput(this.options.service, input)
    if (!compiled.ok) return null
    return this.options.service.match({
      toolName: input.toolName,
      command: input.command,
      cwd: input.requestedCwd,
      workspacePath: input.primaryWorkspacePath,
      workspaceId: input.workspaceId,
      environment: { PATH: input.pathEnvironment }
    })
  }

  matchLive(issued: BrokeredCommandRuleInput): CommandRuleMatch | null {
    const live = this.options.resolveLiveInput(issued)
    if (!live || !sameIssuedIdentity(issued, live)) return null
    return this.match(live)
  }

  register(
    approvalIdValue: unknown,
    input: BrokeredCommandRuleInput
  ): ExactCommandRuleOfferView | null {
    const approvalId = nonEmpty(approvalIdValue)
    if (!approvalId) return null
    this.prune()
    const compiled = compileInput(this.options.service, input, approvalId)
    if (!compiled.ok) return null
    const existing = this.offers.get(approvalId)
    if (existing) return this.view(existing)
    if (this.offers.size >= COMMAND_RULE_OFFER_MAX_ENTRIES) return null
    const now = this.now()
    const offer: StoredCommandRuleOffer = {
      approvalId,
      offerId: this.createOfferId(),
      issuedAt: now,
      expiresAt: now + COMMAND_RULE_OFFER_TTL_MS,
      input: { ...input },
      candidate: compiled.candidate,
      state: 'pending'
    }
    this.offers.set(approvalId, offer)
    return this.view(offer)
  }

  accept(approvalIdValue: unknown, offerIdValue: unknown): CommandRuleOfferAcceptResult {
    const approvalId = nonEmpty(approvalIdValue)
    const offerId = nonEmpty(offerIdValue)
    if (!approvalId || !offerId) return { ok: false, error: 'Command-rule offer is invalid.' }
    this.prune()
    const offer = this.offers.get(approvalId)
    if (!offer || offer.offerId !== offerId || offer.state !== 'pending') {
      return { ok: false, error: 'Command-rule offer is unavailable or already being accepted.' }
    }
    const reservationId = this.createReservationId()
    offer.state = 'reserved'
    offer.reservationId = reservationId
    try {
      const live = this.options.resolveLiveInput(offer.input)
      if (!live || !sameIssuedIdentity(offer.input, live)) {
        throw new Error('The run, chat, or workspace changed while the offer was open.')
      }
      const recompiled = compileInput(this.options.service, live, approvalId)
      if (!recompiled.ok || recompiled.candidate.fingerprint !== offer.candidate.fingerprint) {
        throw new Error(
          'The command, executable, cwd, or workspace changed while the offer was open.'
        )
      }
      const upserted = this.options.service.upsert(recompiled.candidate)
      const match = this.match(live)
      if (!match || match.rule.id !== upserted.rule.id) {
        if (upserted.created) {
          this.options.service.remove({
            id: upserted.rule.id,
            workspaceId: upserted.rule.workspaceId,
            workspacePath: upserted.rule.primaryWorkspaceRealPath
          })
        }
        throw new Error('The signed command rule could not be revalidated after persistence.')
      }
      return {
        ok: true,
        receipt: {
          approvalId,
          offerId,
          reservationId,
          created: upserted.created,
          rule: upserted.rule
        },
        match
      }
    } catch (error) {
      offer.state = 'pending'
      delete offer.reservationId
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Command-rule acceptance failed.'
      }
    }
  }

  commit(receipt: CommandRuleOfferReceipt): boolean {
    const offer = this.offers.get(receipt.approvalId)
    if (
      !offer ||
      offer.offerId !== receipt.offerId ||
      offer.reservationId !== receipt.reservationId
    ) {
      return false
    }
    this.offers.delete(receipt.approvalId)
    return true
  }

  rollback(receipt: CommandRuleOfferReceipt): void {
    if (receipt.created) {
      this.options.service.remove({
        id: receipt.rule.id,
        workspaceId: receipt.rule.workspaceId,
        workspacePath: receipt.rule.primaryWorkspaceRealPath
      })
    }
    const offer = this.offers.get(receipt.approvalId)
    if (offer?.reservationId === receipt.reservationId) {
      offer.state = 'pending'
      delete offer.reservationId
    }
  }

  clear(approvalIdValue: unknown): boolean {
    const approvalId = nonEmpty(approvalIdValue)
    if (!approvalId) return false
    const offer = this.offers.get(approvalId)
    if (!offer || offer.state === 'reserved') return false
    return this.offers.delete(approvalId)
  }

  clearForRun(runIdValue: unknown): number {
    const runId = nonEmpty(runIdValue)
    if (!runId) return 0
    let removed = 0
    for (const [approvalId, offer] of this.offers) {
      if (offer.input.runId !== runId) continue
      this.offers.delete(approvalId)
      removed += 1
    }
    return removed
  }

  private prune(): void {
    const now = this.now()
    for (const [approvalId, offer] of this.offers) {
      if (now >= offer.expiresAt) this.offers.delete(approvalId)
    }
  }

  private view(offer: StoredCommandRuleOffer): ExactCommandRuleOfferView {
    return {
      offerId: offer.offerId,
      kind: offer.candidate.kind,
      fingerprint: offer.candidate.fingerprint,
      cwdRelativePath: offer.candidate.cwdRelativePath,
      executableName: path.basename(offer.candidate.executableRealPath),
      riskClass: offer.candidate.riskClass,
      scope: 'one_workspace_exact_argv'
    }
  }
}
