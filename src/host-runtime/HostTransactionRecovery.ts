/**
 * Boot recovery of transactional persists (Independent Threads M4, slice
 * 14a).
 *
 * Decides every command the receipts or the transaction log know with
 * `decideHostTransactionRecovery`, then acts in RR-2's order, the order the
 * slice 10 crash harness proved kill point by kill point:
 *
 * 1. decide everything, before anything is written;
 * 2. every D3 (the manifest's `published` first, NH-1, then the receipt) and
 *    every D4 (an abort record, then the receipt failed `interrupted`);
 * 3. one generation reset, when a D1 needs it or the caller asks for one
 *    (an unclean restart, decision 2), then every D1 at the reset position;
 * 4. every indeterminate: the manifest's record, which makes it final, and
 *    the receipt marked while it is still pending;
 * 5. the delta anchors of commands that are now terminal (§15.6: a release
 *    is not journaled, so a crash brings anchors back);
 * 6. the artifacts of prepares that ended not committed, matched by their
 *    file identity (§20.2: a worker may leave one).
 *
 * It runs before any lane, gate or listener opens. A reset that fails is a
 * boot failure (SF-2): it throws once D3 and D4 are durable.
 */
import { lstatSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import type { HostCursorPosition } from '../shared/hostProtocol'
import type { HostCommandReceiptRecord, HostCommandReceiptStore } from './HostCommandReceiptStore'
import type { HostDeltaStore } from './HostDeltaStore'
import { HOST_PROFILE_CHATS_DIRECTORY } from './HostProfileDomainStore'
import { HOST_THREAD_RECORD_TRANSFER_DIRECTORY } from './HostThreadRecordTransfer'
import type { HostTransactionLog } from './HostTransactionLog'
import {
  decideHostTransactionRecovery,
  hostCommitWitness,
  type HostFileIdentity,
  type HostTransactionRecoveryAction,
  type HostTransactionRecoveryInput
} from './HostTransactionManifest'

const ARTIFACT_SUFFIX = '.record.json'

export interface HostTransactionRecoveryPorts {
  readonly receipts: Pick<HostCommandReceiptStore, 'list' | 'complete' | 'markIndeterminate'>
  readonly log: Pick<HostTransactionLog, 'get' | 'commandIds' | 'append'>
  readonly deltas: Pick<
    HostDeltaStore,
    'findGroup' | 'resetGeneration' | 'getPosition' | 'releaseGroup' | 'anchoredCommandIds'
  >
  readonly profilePath: string
  readonly now: () => number
}

export interface HostTransactionRecoveryOptions {
  /** `always` on an unclean restart with the transactional persist on (decision 2). */
  readonly reset: 'when-needed' | 'always'
}

export interface HostTransactionRecoveryReport {
  readonly decisions: ReadonlyMap<string, HostTransactionRecoveryAction>
  /** How many commands each action decided. */
  readonly counts: Readonly<Record<string, number>>
  /** The generation reset, when there was one. */
  readonly reset: HostCursorPosition | null
  readonly anchorsReleased: readonly string[]
  /** File names removed from the transfer directory. */
  readonly artifactsRemoved: readonly string[]
  /** Each indeterminate command and its reason. */
  readonly indeterminate: ReadonlyMap<string, string>
}

/** The chat file's identity, as the commit witness reads it; null when absent. */
function observeChatFile(profilePath: string, threadId: string): HostFileIdentity | null {
  try {
    const stat = lstatSync(join(profilePath, HOST_PROFILE_CHATS_DIRECTORY, `${threadId}.json`), {
      bigint: true
    })
    return { dev: stat.dev.toString(), ino: stat.ino.toString(), size: Number(stat.size) }
  } catch {
    return null
  }
}

function receiptInput(
  record: HostCommandReceiptRecord | undefined
): HostTransactionRecoveryInput['receipt'] {
  if (!record) return null
  return {
    status: record.status,
    recoveryState: record.recoveryState ?? null,
    commandClass: record.commandClass ?? 'legacy-observed',
    errorCode: record.errorCode ?? null
  }
}

async function appendDurable(
  log: HostTransactionRecoveryPorts['log'],
  record: unknown
): Promise<void> {
  const result = await log.append(record)
  if (result.kind !== 'durable' && result.kind !== 'duplicate') {
    throw new Error(`transaction recovery could not append to the manifest: ${result.kind}`)
  }
}

export async function recoverHostTransactions(
  ports: HostTransactionRecoveryPorts,
  options: HostTransactionRecoveryOptions
): Promise<HostTransactionRecoveryReport> {
  const { receipts, log, deltas, profilePath, now } = ports
  const receiptsById = (): Map<string, HostCommandReceiptRecord> =>
    new Map(receipts.list().map((record) => [record.commandId, record]))

  // 1. Decide everything before anything is written.
  const initial = receiptsById()
  const commandIds = new Set<string>([...initial.keys(), ...log.commandIds()])
  const decisions = new Map<string, HostTransactionRecoveryAction>()
  const observed = new Map<string, HostFileIdentity | null>()
  for (const commandId of commandIds) {
    const record = initial.get(commandId)
    const entry = log.get(commandId)
    const threadId = entry?.prepare?.threadId ?? record?.target.id
    const identity = threadId ? observeChatFile(profilePath, threadId) : null
    observed.set(commandId, identity)
    const group = deltas.findGroup(commandId)
    decisions.set(
      commandId,
      decideHostTransactionRecovery({
        receipt: receiptInput(record),
        prepare: entry?.prepare ?? null,
        terminal: entry?.terminal ?? null,
        observed: identity,
        group: group ? { count: group.count, setDigest: group.setDigest, end: group.end } : null
      })
    )
  }

  // 2. Every D3 and D4.
  for (const [commandId, decision] of decisions) {
    if (decision.action === 'complete_at_position') {
      if (decision.markPublished) {
        await appendDurable(log, {
          kind: 'published',
          commandId,
          position: decision.position,
          at: now()
        })
      }
      receipts.complete({ commandId, status: 'succeeded', position: decision.position })
    } else if (decision.action === 'mark_published') {
      await appendDurable(log, {
        kind: 'published',
        commandId,
        position: decision.position,
        at: now()
      })
    } else if (decision.action === 'fail_interrupted') {
      if (decision.writeAbort) {
        await appendDurable(log, { kind: 'abort', commandId, reason: 'interrupted', at: now() })
      }
      if (decision.completeReceipt) {
        receipts.complete({ commandId, status: 'failed', errorCode: 'interrupted' })
      }
    }
  }

  // 3. One reset, then every D1 at it.
  const resets = [...decisions]
    .filter(([, decision]) => decision.action === 'reset_and_complete')
    .map(([commandId]) => commandId)
  let reset: HostCursorPosition | null = null
  if (resets.length > 0 || options.reset === 'always') {
    const appended = deltas.resetGeneration('transaction recovery')
    if (appended.kind !== 'appended') {
      throw new Error(`transaction recovery could not reset the generation: ${appended.kind}`)
    }
    reset = appended.position
    for (const commandId of resets) {
      await appendDurable(log, { kind: 'published', commandId, position: reset, at: now() })
      receipts.complete({ commandId, status: 'succeeded', position: reset })
    }
  }

  // 4. Every indeterminate, made final.
  const indeterminate = new Map<string, string>()
  const pendingNow = receiptsById()
  for (const [commandId, decision] of decisions) {
    if (decision.action !== 'indeterminate') continue
    indeterminate.set(commandId, decision.reason)
    if (log.get(commandId)?.prepare) {
      await appendDurable(log, {
        kind: 'indeterminate',
        commandId,
        reason: decision.reason,
        at: now()
      })
    }
    if (pendingNow.get(commandId)?.status === 'pending') {
      receipts.markIndeterminate({
        commandId,
        position: deltas.getPosition(),
        errorCode: 'transaction_recovery_indeterminate'
      })
    }
  }

  // 5. Anchors of commands that are now terminal.
  const anchorsReleased: string[] = []
  const settled = receiptsById()
  for (const commandId of deltas.anchoredCommandIds()) {
    const record = settled.get(commandId)
    const release = record
      ? record.status === 'succeeded' || record.status === 'failed'
      : !log.get(commandId)?.prepare || log.get(commandId)?.terminal !== null
    if (release && deltas.releaseGroup(commandId)) anchorsReleased.push(commandId)
  }

  // 6. Artifacts of prepares that ended not committed.
  const stranded: HostFileIdentity[] = []
  for (const commandId of commandIds) {
    const entry = log.get(commandId)
    const prepare = entry?.prepare
    if (!prepare) continue
    const decision = decisions.get(commandId)
    const notCommitted =
      // Read after step 2, so a D4 with a prepare has its abort record by now.
      entry.terminal?.kind === 'abort' ||
      (decision?.action === 'indeterminate' &&
        hostCommitWitness(prepare, observed.get(commandId) ?? null) === 'not_committed')
    if (notCommitted) stranded.push(prepare.resulting)
  }
  const artifactsRemoved = removeStrandedArtifacts(profilePath, stranded)

  const counts: Record<string, number> = {}
  for (const decision of decisions.values()) {
    counts[decision.action] = (counts[decision.action] ?? 0) + 1
  }
  return { decisions, counts, reset, anchorsReleased, artifactsRemoved, indeterminate }
}

/** Remove each transfer artifact that is one of `stranded`, by dev, inode and size. */
function removeStrandedArtifacts(
  profilePath: string,
  stranded: readonly HostFileIdentity[]
): string[] {
  if (stranded.length === 0) return []
  const directory = join(profilePath, HOST_THREAD_RECORD_TRANSFER_DIRECTORY)
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names) {
    if (!name.endsWith(ARTIFACT_SUFFIX)) continue
    const path = join(directory, name)
    try {
      const stat = lstatSync(path, { bigint: true })
      if (!stat.isFile()) continue
      const dev = stat.dev.toString()
      const ino = stat.ino.toString()
      const size = Number(stat.size)
      if (
        !stranded.some(
          (identity) => identity.dev === dev && identity.ino === ino && identity.size === size
        )
      ) {
        continue
      }
      unlinkSync(path)
      removed.push(name)
    } catch {
      // An artifact that cannot be read or removed stays, owner-only.
    }
  }
  return removed
}
