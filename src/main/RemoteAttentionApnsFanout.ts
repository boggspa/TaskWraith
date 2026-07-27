import type { BridgeApnsPushResult, BridgeRemoteAttentionPushPayload } from './BridgeApnsPusher'
import type { BridgeApnsTokenStore } from './BridgeApnsTokenStore'
import { sealPush } from '../shared/e2ee/pushSeal'
import { buildCompletionPushPlaintext, type CompletionPushContent } from './CompletionPushContent'
import { buildQuestionPushPlaintext, type QuestionPushContent } from './QuestionPushContent'
import {
  isRemoteNotificationReason,
  type RemoteNotificationReason
} from './RemoteNotificationPolicy'

export interface RemoteAttentionApnsFanoutDeps {
  getTokenStore: () => BridgeApnsTokenStore | null
  getPusher: () => unknown
  isUserAtDesktop: () => boolean
  /** The Mac's 32-byte identity seed, used to seal per-device ENCRYPTED rich
   * push content. When absent (or a device registered no agreement key), pushes
   * ship without the blob and the device shows the generic alert. */
  getMacIdentitySeed?: () => Buffer | null
  log?: (line: string) => void
  now?: () => number
  coalesceMs?: number
}

type Pushable = {
  pushRemoteAttentionToToken?: (
    deviceTokenHex: string,
    env: 'production' | 'sandbox',
    payload: BridgeRemoteAttentionPushPayload
  ) => Promise<BridgeApnsPushResult>
  pushSilentToToken?: (
    deviceTokenHex: string,
    env: 'production' | 'sandbox',
    payload?: Omit<BridgeRemoteAttentionPushPayload, 'pairID'>
  ) => Promise<BridgeApnsPushResult>
}

const DEFAULT_COALESCE_MS = 30_000

export class RemoteAttentionApnsFanout {
  private readonly deps: RemoteAttentionApnsFanoutDeps
  private readonly log: (line: string) => void
  private readonly now: () => number
  private readonly coalesceMs: number
  private readonly lastPushByKey = new Map<string, number>()

  constructor(deps: RemoteAttentionApnsFanoutDeps) {
    this.deps = deps
    this.log = deps.log ?? (() => {})
    this.now = deps.now ?? (() => Date.now())
    this.coalesceMs = deps.coalesceMs ?? DEFAULT_COALESCE_MS
  }

  notify(
    input: Omit<BridgeRemoteAttentionPushPayload, 'pairID' | 'reason'> & {
      reason: RemoteNotificationReason
      rich?: CompletionPushContent
      question?: QuestionPushContent
    }
  ): void {
    // Runtime guard as well as the narrowed TypeScript input: legacy sessions,
    // plugins, or tests can still hand us a wider transport reason.
    if (!isRemoteNotificationReason(input.reason)) {
      this.log(`[APNs] suppressed non-actionable notification reason=${input.reason}`)
      return
    }
    const tokenStore = this.deps.getTokenStore()
    const pusher = this.deps.getPusher() as Pushable | null
    if (!tokenStore || !pusher) return
    const tokens = tokenStore.list()
    if (tokens.length === 0) return
    if (this.deps.isUserAtDesktop()) {
      this.log(`[APNs] skipping remote attention push reason=${input.reason} — user is at desktop`)
      return
    }
    const canPushAttention = typeof pusher.pushRemoteAttentionToToken === 'function'
    if (!canPushAttention) return

    for (const entry of tokens) {
      const key = coalesceKey(entry.pairID, input)
      const now = this.now()
      const last = this.lastPushByKey.get(key)
      if (last !== undefined && now - last < this.coalesceMs) {
        this.log(`[APNs] coalesced remote attention push key=${key}`)
        continue
      }
      this.lastPushByKey.set(key, now)
      void (async () => {
        try {
          const payload = sanitizePayload(entry.pairID, input)
          // Per-device: seal the rich content to THIS device's agreement key, if
          // it registered one and we hold the Mac seed. Non-fatal — on failure
          // the push still ships with its generic alert (the NSE just has nothing
          // to decrypt). Each device gets a distinct key, so this is per-iteration.
          const macSeed = this.deps.getMacIdentitySeed?.() ?? null
          const richPlaintext = input.rich
            ? buildCompletionPushPlaintext(input.rich)
            : input.question
              ? buildQuestionPushPlaintext(input.question)
              : null
          if (richPlaintext && entry.agreePubRaw && macSeed) {
            try {
              payload.twpush = sealPush({
                senderIdentitySeed: macSeed,
                recipientAgreePubRaw: Buffer.from(entry.agreePubRaw, 'base64'),
                pairId: entry.pairID,
                plaintext: richPlaintext
              })
            } catch (err) {
              this.log(
                `[APNs] rich push seal failed for pairID=${entry.pairID}: ${err instanceof Error ? err.message : String(err)}`
              )
            }
          }
          const result = await pusher.pushRemoteAttentionToToken!(
            entry.deviceToken,
            entry.env,
            payload
          )
          // Any reason that BLOCKS the agent (waiting on the user) needs the
          // silent background supplement so a closed/locked app gets CPU to
          // reconnect-and-hydrate — not just approvals.
          const blocksOnUser =
            payload.reason === 'approval' || payload.reason === 'question'
          if (blocksOnUser && typeof pusher.pushSilentToToken === 'function') {
            try {
              const wakeResult = await pusher.pushSilentToToken(
                entry.deviceToken,
                entry.env,
                withoutPairID(payload)
              )
              if (!wakeResult.delivered && isDeadTokenReason(wakeResult.reason)) {
                this.log(
                  `[APNs] pruning dead token for pairID=${entry.pairID}: ${wakeResult.reason}`
                )
                tokenStore.remove(entry.pairID)
              }
            } catch (err) {
              this.log(
                `[APNs] silent approval wake threw for pairID=${entry.pairID}: ${err instanceof Error ? err.message : String(err)}`
              )
            }
          }
          if (!result.delivered) {
            const reason = result.reason ?? ''
            if (isDeadTokenReason(reason)) {
              this.log(`[APNs] pruning dead token for pairID=${entry.pairID}: ${reason}`)
              tokenStore.remove(entry.pairID)
            } else if (/^BadDeviceToken$/i.test(reason)) {
              // Kept, not pruned — see isDeadTokenReason. Name the likely cause
              // so this isn't a silent dead-end when push "just stops working".
              this.log(
                `[APNs] BadDeviceToken for pairID=${entry.pairID} (registered env=${entry.env}) — ` +
                  `token KEPT. Usually an APNs environment mismatch: a ${entry.env} token was sent ` +
                  `to the other gateway. Check TASKWRAITH_BRIDGE_APNS and the app build's aps-environment.`
              )
            } else if (reason && reason !== 'noop') {
              this.log(
                `[APNs] remote attention push not delivered to pairID=${entry.pairID}: ${reason}`
              )
            }
          }
        } catch (err) {
          this.log(
            `[APNs] remote attention push threw for pairID=${entry.pairID}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      })()
    }
  }
}

/** Apple's ONLY authoritative "this token is dead" signal is 410 Unregistered.
 *
 * BadDeviceToken deliberately does NOT belong here: the production and sandbox
 * gateways each answer BadDeviceToken for a token minted by the *other* one, so
 * an environment mismatch (a Debug/sandbox build reached by a pusher forced to
 * production, or vice versa) returns it for a perfectly live token. Reaping on
 * it deletes a good registration and pushes stay dead until the app happens to
 * re-register — a silent, self-inflicted outage with no error surfaced anywhere.
 * Http2ApnsPusher documents the same rule; this fanout previously diverged.
 */
function isDeadTokenReason(reason: string | undefined): boolean {
  return /^Unregistered$/i.test(reason ?? '')
}

function coalesceKey(
  pairID: string,
  input: Omit<BridgeRemoteAttentionPushPayload, 'pairID'>
): string {
  const blockingId =
    input.reason === 'approval'
      ? input.approvalId
      : input.reason === 'question'
        ? input.questionId
        : undefined
  return [pairID, input.threadId ?? '', input.reason, blockingId ?? ''].join('\u0000')
}

function sanitizePayload(
  pairID: string,
  input: Omit<BridgeRemoteAttentionPushPayload, 'pairID'>
): BridgeRemoteAttentionPushPayload {
  return {
    pairID,
    reason: input.reason,
    workspaceId: privacySafeWorkspaceId(input.workspaceId),
    threadId: input.threadId,
    runId: input.runId,
    approvalId: input.approvalId,
    questionId: input.questionId,
    wakeupId: input.wakeupId,
    taskId: input.taskId,
    projectionKind: input.projectionKind,
    generatedAt: input.generatedAt,
    failureKind: input.failureKind,
    diffAdditions: input.diffAdditions,
    diffDeletions: input.diffDeletions
  }
}

function withoutPairID(
  payload: BridgeRemoteAttentionPushPayload
): Omit<BridgeRemoteAttentionPushPayload, 'pairID'> {
  const { pairID: _pairID, ...rest } = payload
  return rest
}

function privacySafeWorkspaceId(workspaceId: string | null | undefined): string | null | undefined {
  if (workspaceId === null || workspaceId === undefined) return workspaceId
  const trimmed = workspaceId.trim()
  if (!trimmed || /[/\\]/.test(trimmed) || trimmed.startsWith('~') || /^[A-Za-z]:/.test(trimmed)) {
    return null
  }
  return trimmed
}
