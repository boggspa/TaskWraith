/**
 * Run-owned Simulator Canvas controller tokens (hybrid ownership fork 2C).
 *
 * Chat keeps the session/preview; mutating control requires a controller token
 * bound to {chatId, runId, ownerParticipantId?}. Tokens persist across seat
 * yields inside the same run, transfer to Boss/Captain/solo authority, and
 * release on run terminal unless transferred away.
 *
 * Wire `releaseForRun(runId)` from the composition-root run-terminal path
 * (same seam as NativeWindowCoordinator.onRunTerminal) — do not grow index.ts
 * beyond a one-line registration.
 */
import {
  resolveAppDriveEnsembleAuthority,
  type AppDriveEnsembleRoster
} from '../appDrive/AppDriveEnsembleAuthority'
import { randomUUID } from 'crypto'

/** Synthetic run id for human dock control — user is always authoritative. */
export const SIMULATOR_HUMAN_CONTROLLER_RUN_ID = '__human__' as const

export type SimulatorControllerKind = 'human' | 'run'

export interface SimulatorControllerToken {
  tokenId: string
  chatId: string
  runId: string
  kind: SimulatorControllerKind
  ownerParticipantId?: string
  mintedAt: number
  updatedAt: number
}

export type SimulatorControllerErrorCode =
  | 'invalid_input'
  | 'conflict'
  | 'not_holder'
  | 'not_found'
  | 'authority_denied'

export type SimulatorControllerResult =
  | { ok: true; token: SimulatorControllerToken }
  | {
      ok: false
      code: SimulatorControllerErrorCode
      error: string
      holder?: SimulatorControllerToken
    }

export interface SimulatorControllerLeaseDeps {
  now?: () => number
  createId?: () => string
}

export interface SimulatorControllerMintInput {
  chatId: string
  runId: string
  ownerParticipantId?: string
  kind?: SimulatorControllerKind
}

export interface SimulatorControllerTransferInput {
  chatId: string
  fromRunId: string
  toRunId: string
  toOwnerParticipantId?: string
  /** When set, target must be Boss/Captain (solo/null ensemble always allowed). */
  ensemble?: AppDriveEnsembleRoster | null
}

function requireId(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) return null
  return value
}

function cloneToken(token: SimulatorControllerToken): SimulatorControllerToken {
  return { ...token }
}

function fail(
  code: SimulatorControllerErrorCode,
  error: string,
  holder?: SimulatorControllerToken
): SimulatorControllerResult {
  return holder
    ? { ok: false, code, error, holder: cloneToken(holder) }
    : { ok: false, code, error }
}

export class SimulatorControllerLease {
  private readonly now: () => number
  private readonly createId: () => string
  private readonly byChat = new Map<string, SimulatorControllerToken>()

  constructor(deps: SimulatorControllerLeaseDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.createId = deps.createId ?? (() => randomUUID())
  }

  peek(chatId: string): SimulatorControllerToken | null {
    const id = requireId(chatId)
    if (!id) return null
    const token = this.byChat.get(id)
    return token ? cloneToken(token) : null
  }

  isValid(input: { chatId: string; tokenId: string; runId?: string }): boolean {
    const chatId = requireId(input.chatId)
    const tokenId = requireId(input.tokenId)
    if (!chatId || !tokenId) return false
    const holder = this.byChat.get(chatId)
    if (!holder || holder.tokenId !== tokenId) return false
    if (input.runId !== undefined) {
      const runId = requireId(input.runId)
      if (!runId || holder.runId !== runId) return false
    }
    return true
  }

  /**
   * Mint for a run when the chat is free, or return the existing token when the
   * same run already holds control (seat yields). Conflicts if another run holds it.
   */
  mint(input: SimulatorControllerMintInput): SimulatorControllerResult {
    const chatId = requireId(input.chatId)
    const runId = requireId(input.runId)
    if (!chatId || !runId) {
      return fail('invalid_input', 'Simulator controller mint requires chatId and runId.')
    }
    const kind: SimulatorControllerKind =
      input.kind ?? (runId === SIMULATOR_HUMAN_CONTROLLER_RUN_ID ? 'human' : 'run')
    if (kind === 'human' && runId !== SIMULATOR_HUMAN_CONTROLLER_RUN_ID) {
      return fail(
        'invalid_input',
        `Human controller mint must use runId ${SIMULATOR_HUMAN_CONTROLLER_RUN_ID}.`
      )
    }
    const ownerParticipantId = requireId(input.ownerParticipantId) ?? undefined
    const existing = this.byChat.get(chatId)
    if (existing) {
      if (existing.runId === runId) {
        const next: SimulatorControllerToken = {
          ...existing,
          ...(ownerParticipantId ? { ownerParticipantId } : {}),
          updatedAt: this.now()
        }
        this.byChat.set(chatId, next)
        return { ok: true, token: cloneToken(next) }
      }
      return fail(
        'conflict',
        `Simulator control for this chat is held by another run (${existing.runId}).`,
        existing
      )
    }
    const at = this.now()
    const token: SimulatorControllerToken = {
      tokenId: this.createId(),
      chatId,
      runId,
      kind,
      ...(ownerParticipantId ? { ownerParticipantId } : {}),
      mintedAt: at,
      updatedAt: at
    }
    this.byChat.set(chatId, token)
    return { ok: true, token: cloneToken(token) }
  }

  /**
   * Human dock claim — always authoritative; takes over any run holder.
   * Always mints a fresh tokenId so a previous agent (or prior human) token
   * cannot continue to assert control after the dock claims.
   */
  claimHuman(chatId: string): SimulatorControllerResult {
    const id = requireId(chatId)
    if (!id) return fail('invalid_input', 'Simulator human claim requires chatId.')
    const at = this.now()
    const token: SimulatorControllerToken = {
      tokenId: this.createId(),
      chatId: id,
      runId: SIMULATOR_HUMAN_CONTROLLER_RUN_ID,
      kind: 'human',
      mintedAt: at,
      updatedAt: at
    }
    this.byChat.set(id, token)
    return { ok: true, token: cloneToken(token) }
  }

  /**
   * Transfer control to another run. Target must be Boss/Captain when an
   * Ensemble roster is supplied (mirrors App Drive / fan-out authority).
   * Solo parent (null/absent ensemble) always allowed.
   */
  transfer(input: SimulatorControllerTransferInput): SimulatorControllerResult {
    const chatId = requireId(input.chatId)
    const fromRunId = requireId(input.fromRunId)
    const toRunId = requireId(input.toRunId)
    if (!chatId || !fromRunId || !toRunId) {
      return fail(
        'invalid_input',
        'Simulator controller transfer requires chatId, fromRunId, toRunId.'
      )
    }
    if (fromRunId === toRunId) {
      return fail('invalid_input', 'Simulator controller transfer requires a different toRunId.')
    }
    const holder = this.byChat.get(chatId)
    if (!holder) return fail('not_found', 'No Simulator controller is held for this chat.')
    if (holder.runId !== fromRunId) {
      return fail('not_holder', 'Only the holding run may transfer Simulator control.', holder)
    }

    const toOwnerParticipantId = requireId(input.toOwnerParticipantId) ?? undefined
    const authority = resolveAppDriveEnsembleAuthority({
      ensemble: input.ensemble,
      callerParticipantId: toOwnerParticipantId
    })
    if (!authority.ok) {
      return fail(
        'authority_denied',
        authority.reason.replace(/App Drive/gi, 'Simulator Canvas'),
        holder
      )
    }

    const next: SimulatorControllerToken = {
      ...holder,
      runId: toRunId,
      kind: toRunId === SIMULATOR_HUMAN_CONTROLLER_RUN_ID ? 'human' : 'run',
      ...(toOwnerParticipantId
        ? { ownerParticipantId: toOwnerParticipantId }
        : { ownerParticipantId: undefined }),
      updatedAt: this.now()
    }
    // Drop undefined owner so peek clones stay tidy.
    if (!toOwnerParticipantId) delete next.ownerParticipantId
    this.byChat.set(chatId, next)
    return { ok: true, token: cloneToken(next) }
  }

  release(input: { chatId: string; runId: string }): SimulatorControllerResult {
    const chatId = requireId(input.chatId)
    const runId = requireId(input.runId)
    if (!chatId || !runId) {
      return fail('invalid_input', 'Simulator controller release requires chatId and runId.')
    }
    const holder = this.byChat.get(chatId)
    if (!holder) return fail('not_found', 'No Simulator controller is held for this chat.')
    if (holder.runId !== runId) {
      return fail('not_holder', 'Only the holding run may release Simulator control.', holder)
    }
    this.byChat.delete(chatId)
    return { ok: true, token: cloneToken(holder) }
  }

  /** Release every chat still held by this run (run-terminal path). */
  releaseForRun(runId: string): SimulatorControllerToken[] {
    const id = requireId(runId)
    if (!id) return []
    const released: SimulatorControllerToken[] = []
    for (const [chatId, token] of this.byChat) {
      if (token.runId === id) {
        released.push(cloneToken(token))
        this.byChat.delete(chatId)
      }
    }
    return released
  }
}
