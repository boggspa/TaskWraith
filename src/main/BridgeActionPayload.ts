/**
 * BridgeActionPayload — typed schema for the bytes inside `bridge.requestActionAck`.
 *
 * Today's wire format (Phase C-late slice 1):
 *   - iOS device serializes a `BridgeActionPayload` as UTF-8 JSON.
 *   - Swift bridge daemon base64-encodes those bytes in
 *     `bridge.requestActionAck`'s `payloadBase64` field.
 *   - Electron decodes base64 → UTF-8 → JSON → typed payload via
 *     `decodeBridgeActionPayload(...)`.
 *
 * Why typed (not opaque)?
 *   - Phase C4 gave us `RemoteWorkspaceAllowlist`, but
 *     `handleActionAck` couldn't consult it: opaque bytes carry no
 *     `workspaceId`. Every action variant in this schema embeds a
 *     `workspaceId` so the router can workspace-gate.
 *   - The Swift side stays untouched. The daemon does not decode
 *     payloads — it relays bytes. All payload-level semantics live in
 *     Electron, where RunService/ApprovalService/ChatService are.
 *   - Versioning by `kind` field rather than a top-level `v`: adding a
 *     new action variant is a new `kind`, and unknown `kind`s decode to
 *     `BridgeUnknownAction` so future iOS clients targeting newer
 *     Electron versions get a structured deny instead of a hard parse error.
 *
 * Variant catalog (covers Lunel's permissionReply + questionReply + prompt
 * model, plus cancel; matches our plan's iOS-minimal action set):
 *   - `approvalReply`    — user tapped accept/acceptForSession/decline
 *                          on a pending tool-call approval prompt.
 *   - `questionReply`    — user typed an answer to a tool-driven question.
 *   - `questionReject`   — user explicitly rejected a question without
 *                          providing an answer.
 *   - `composerPrompt`   — user sent a new message to an existing thread
 *                          via the iOS composer.
 *   - `cancelRun`        — user tapped "cancel" on an in-flight run.
 *   - `ensemble*`        — remote task-console controls for ensemble rounds,
 *                          wakeups, queued prompts, and steering.
 *
 * Workspace-bound payloads MUST carry `workspaceId`. The router relies on
 * this for allowlist evaluation; a workspace-bound payload missing it decodes
 * as `BridgeUnknownAction` (deny). Device-level system payloads such as
 * `registerApnsToken` are pair-scoped instead.
 */

export type BridgeApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'acceptForWorkspace'
  | 'decline'
  | 'cancel'

export interface BridgeActionMetadata {
  /** Client-generated id for stale/replay protection. Optional so older
   * companion builds keep working; when present it must be unique per pair. */
  actionId?: string
  /** Client issuance timestamp (ms since epoch). Informational for now. */
  issuedAt?: number
  /** Client expiry timestamp (ms since epoch). Router denies when stale. */
  expiresAt?: number
}

const BRIDGE_QUESTION_ANSWER_MAX_CHARS = 8000
const BRIDGE_QUESTION_REJECT_MESSAGE_MAX_CHARS = 1000
const BRIDGE_THREAD_ROW_ID_MAX_CHARS = 4096
const BRIDGE_WORKSPACE_FILE_PATH_MAX_CHARS = 4096
const BRIDGE_WORKSPACE_FILE_WRITE_MAX_CHARS = 1_600_000
const BRIDGE_GOAL_OBJECTIVE_MAX_CHARS = 4000
const BRIDGE_GOAL_REASON_MAX_CHARS = 800

export interface BridgeApprovalReplyAction extends BridgeActionMetadata {
  kind: 'approvalReply'
  workspaceId: string
  threadId: string
  toolCallId: string
  decision: BridgeApprovalDecision
  /** Optional human-readable note (e.g. "approved from iPhone"). */
  message?: string
}

export interface BridgeQuestionReplyAction extends BridgeActionMetadata {
  kind: 'questionReply'
  workspaceId: string
  threadId: string
  runId?: string
  promptId: string
  answer: string
}

export interface BridgeQuestionRejectAction extends BridgeActionMetadata {
  kind: 'questionReject'
  workspaceId: string
  threadId: string
  runId?: string
  promptId: string
  /** Optional rejection reason surfaced back into the chat as a system note. */
  message?: string
}

export interface BridgeComposerPromptAction extends BridgeActionMetadata {
  kind: 'composerPrompt'
  workspaceId: string
  threadId: string
  text: string
  /** Provider id. Required so the dispatcher can route to the right
   * provider adapter without inferring from the thread. Allowlist will
   * reject if not in the workspace's allowed-providers set. */
  provider: string
  /** Optional approval-mode override; allowlist will reject if not allowed. */
  approvalMode?: string
  /** Optional model override (provider-specific). */
  model?: string
  /** Codex/Grok-style reasoning effort override. */
  reasoningEffort?: string | null
  /** Claude-specific reasoning effort override. */
  claudeReasoningEffort?: string | null
  /** Optional context-turn count (0–20 per the plan's standard payload). */
  contextTurns?: number
  /** Phone-attached images (downscaled JPEG/PNG, base64). The executor
   * writes them to temp files and forwards as AgentRunPayload.imagePaths
   * — the same attachment lane the desktop composer uses. Capped at 2
   * images / ~900KB combined base64 to respect the relay frame budget. */
  imageAttachments?: BridgeImageAttachment[]
  /** Additional allowlisted workspaces granted to this run (the desktop's
   * secondary-workspace picker). The executor validates each against the
   * allowlist and resolves them to AgentRunPayload.externalPathGrants. */
  extraWorkspaceIds?: string[]
  /** Set ONLY by the iOS proposed-plan Approve flow — the id of the plan
   * message this run implements. The executor flips that plan's status to
   * 'approved' and dispatches ATOMICALLY, and refuses if the plan is no longer
   * pending, so a second device tapping Approve in the projection-latency
   * window cannot fire a duplicate write-capable implement run. */
  proposedPlanImplementOf?: string
}

export interface BridgeComposerQueuePromptAction
  extends Omit<BridgeComposerPromptAction, 'kind'> {
  kind: 'composerQueuePrompt'
}

export interface BridgeComposerQueueItemAction extends BridgeActionMetadata {
  kind: 'composerQueueItem'
  workspaceId: string
  threadId: string
  queueId: string
  textPrefix?: string
  op: 'steerNow' | 'remove'
}

export interface BridgeImageAttachment {
  /** Display name, e.g. "IMG_0123.jpg". */
  name?: string
  mimeType: string
  dataBase64: string
}

/** On-demand bounded transcript window for one thread. The phone sends
 * this when opening a chat outside the recent-N snapshot window (the
 * periodic snapshot only ships threadSnapshots for the most-recent few —
 * relay frame budget). Gated by the `monitor` capability. */
export interface BridgeThreadSnapshotRequestAction extends BridgeActionMetadata {
  kind: 'threadSnapshotRequest'
  workspaceId: string
  threadId: string
  /** Requested row-window size; the executor clamps to 1–100 (default 40). */
  limit?: number
  /** Fetch rows immediately before this desktop message id. */
  beforeRowId?: string
}

/** Expand one clipped transcript row to (near) full text. Read-only —
 * the ack returns the re-projected row; nothing is broadcast. */
export interface BridgeThreadRowExpandAction extends BridgeActionMetadata {
  kind: 'threadRowExpand'
  workspaceId: string
  threadId: string
  /** Desktop `message.id` for the row to expand. */
  rowId: string
  /** Preview char ceiling (executor clamps 400–32000, default 32000). */
  maxChars?: number
}

/** Fetch bounded bytes for one transcript media item. The router gates this
 * like other transcript reads; the executor callback must still validate the
 * media id against the requested thread + row before returning bytes. */
export interface BridgeThreadMediaFetchAction extends BridgeActionMetadata {
  kind: 'threadMediaFetch'
  workspaceId: string
  threadId: string
  rowId: string
  mediaId: string
  variant?: 'thumbnail' | 'full'
  maxBytes?: number
  /** RANGE MODE (sha-addressed sources only): byte offset into the asset. Both
   * `offset` and `length` must be present together — see `isThreadMediaFetch`. */
  offset?: number
  /** RANGE MODE: requested byte count for this slice (server hard-clamps to
   * `THREAD_MEDIA_CHUNK_MAX_BYTES`). */
  length?: number
}

export interface BridgeWorkspaceFileListAction extends BridgeActionMetadata {
  kind: 'workspaceFileList'
  workspaceId: string
  /** Directory path relative to the workspace. Empty / omitted = root. */
  path?: string
  /** Optional bounded server-side path search. Does not read file contents. */
  query?: string
  /** Entry cap for directory/search responses; executor clamps defensively. */
  limit?: number
}

export interface BridgeWorkspaceFileReadAction extends BridgeActionMetadata {
  kind: 'workspaceFileRead'
  workspaceId: string
  path: string
}

export interface BridgeWorkspaceFileWriteAction extends BridgeActionMetadata {
  kind: 'workspaceFileWrite'
  workspaceId: string
  path: string
  content: string
  baseEtag: string
}

export interface BridgeWorkspaceFileDeleteAction extends BridgeActionMetadata {
  kind: 'workspaceFileDelete'
  workspaceId: string
  path: string
}

/** On-demand bounded workspace diff (the iOS Diff Studio). Read-only —
 * the executor returns the bounded diff (files + hunks, hard-capped) in
 * the ack's data; nothing is broadcast. Gated by `diffReview`. */
export interface BridgeWorkspaceDiffAction extends BridgeActionMetadata {
  kind: 'workspaceDiff'
  workspaceId: string
}

/** Read-only git status for an allowlisted workspace — branch, ahead/behind,
 * change counts, capped file list. Returned in the ack's data. By default the
 * Mac also refreshes the remote git projection; callers that only need a local
 * response can set `publish: false`. Gated by `diffReview` (same read tier as
 * `workspaceDiff`). */
export interface BridgeGitSnapshotAction extends BridgeActionMetadata {
  kind: 'gitSnapshot'
  workspaceId: string
  publish?: boolean
}

/** `git add -A` for the workspace repo. Mutating — gated by `fileWrite`. */
export interface BridgeGitStageAllAction extends BridgeActionMetadata {
  kind: 'gitStageAll'
  workspaceId: string
}

/** `git add -- <paths>` for selected workspace-relative file paths.
 * Mutating — gated by `fileWrite`. */
export interface BridgeGitStagePathsAction extends BridgeActionMetadata {
  kind: 'gitStagePaths'
  workspaceId: string
  paths: string[]
}

/** `git reset -- <paths>` for selected workspace-relative file paths.
 * Mutating — gated by `fileWrite`. */
export interface BridgeGitUnstagePathsAction extends BridgeActionMetadata {
  kind: 'gitUnstagePaths'
  workspaceId: string
  paths: string[]
}

/** Commit staged changes with a user-entered message. The message must come
 * from an explicit phone UI field — never synthesized from agent prompt
 * text. Mutating — gated by `fileWrite`. */
export interface BridgeGitCommitAction extends BridgeActionMetadata {
  kind: 'gitCommit'
  workspaceId: string
  message: string
  /** Stage everything first (the phone's single "Stage all & Commit"
   * button — one round-trip instead of gitStageAll + gitCommit). */
  stageAll?: boolean
}

/** Push the current branch; `setUpstream` publishes a branch with no
 * upstream yet. Mutating — gated by `fileWrite`. */
export interface BridgeGitPushAction extends BridgeActionMetadata {
  kind: 'gitPush'
  workspaceId: string
  setUpstream?: boolean
}

/** Read-only `gh pr view` summary for the current branch. Gated by
 * `diffReview`. */
export interface BridgeGithubPrStatusAction extends BridgeActionMetadata {
  kind: 'githubPrStatus'
  workspaceId: string
}

/** Read-only PR-readiness probe (can a PR be created, should we push
 * first, why not). Gated by `diffReview`. */
export interface BridgeGithubPrReadinessAction extends BridgeActionMetadata {
  kind: 'githubPrReadiness'
  workspaceId: string
}

/** Create a GitHub PR via `gh pr create`. Mutating — gated by `fileWrite`. */
export interface BridgeGithubCreatePrAction extends BridgeActionMetadata {
  kind: 'githubCreatePr'
  workspaceId: string
  title?: string
  body?: string
  draft?: boolean
}

/** Create an empty chat thread without starting a run. Used by the iOS
 * "New chat / New ensemble / New global" flows so the phone can land on
 * a welcome surface before the first prompt. */
export interface BridgeCreateThreadParticipant {
  provider: string
  /** Provider-specific model id ('cli-default' when omitted). */
  model?: string
  /** Role label; defaults to the Mac's default role for that provider. */
  role?: string
}

export interface BridgeCreateThreadAction extends BridgeActionMetadata {
  kind: 'createThread'
  workspaceId: string
  variant: 'workspace' | 'single' | 'ensemble' | 'global'
  /** Optional client-minted id (e.g. `ios-<uuid>`). When omitted the Mac
   * generates one. */
  threadId?: string
  /** Solo-chat provider when `variant` is `workspace`. */
  provider?: string
  /** Optional display title seed. */
  title?: string
  /** Ensemble roster override (variant 'ensemble'), in speaking order.
   * Omitted → the Mac's default roster. Capped at 12 (the panel ceiling);
   * role/instructions default per provider from the Mac's role seeds. */
  participants?: BridgeCreateThreadParticipant[]
}

export interface BridgeRegisterApnsTokenAction extends BridgeActionMetadata {
  kind: 'registerApnsToken'
  /** Pair identifier this device token belongs to. iOS knows it from the
   * completed pairing exchange. */
  pairID: string
  /** Apple-issued push token (hex string). Rotates routinely per OS
   * behavior; iOS re-registers on each new token. */
  deviceToken: string
  /** Targeted APNs gateway. `sandbox` for DEBUG/device builds,
   * `production` for TestFlight/App Store builds. The desktop uses this
   * to pick the right gateway when sending pushes. */
  env: 'production' | 'sandbox'
  /** base64 raw X25519 push-agreement public key, derived on-device from the
   * identity seed. Optional (older app builds omit it); when present the Mac can
   * seal ENCRYPTED rich content for this device's pushes (see pushSeal.ts). */
  agreePub?: string
}

/** Save or delete an ensemble roster preset from a paired device (iOS Roster
 * page). GLOBAL — the preset store is renderer-local (localStorage), not
 * workspace-bound. The host forwards the mutation to the renderer (the source
 * of truth), which persists it and re-syncs the projected list. */
export interface BridgeEnsemblePresetMutateAction extends BridgeActionMetadata {
  kind: 'ensemblePresetMutate'
  op: 'save' | 'delete'
  /** save: the preset name. */
  name?: string
  /** save: participants in speaking order (reuses the roster-update shape). */
  participants?: BridgeRosterParticipant[]
  /** delete: the preset id to remove. */
  presetId?: string
}

/** QR-optional multi-host discovery (Slice 5e). An already-paired phone asks
 * THIS host (the "oracle") to enumerate the tailnet with its stored OAuth
 * credential and report which machines run TaskWraith. No parameters: the host
 * knows itself (own identity) and its paired devices, and drops both from the
 * result. Paired-device-level (like `registerApnsToken`) — not workspace-scoped
 * — and read-only (no desktop state changes). The result comes back UNICAST in
 * the action ack, not via a broadcast. */
export interface BridgeDiscoverTailnetHostsAction extends BridgeActionMetadata {
  kind: 'discoverTailnetHosts'
}

export interface BridgeCancelRunAction extends BridgeActionMetadata {
  kind: 'cancelRun'
  workspaceId: string
  threadId: string
  /** Provider id (e.g. `'gemini'`, `'codex'`, `'claude'`, `'kimi'`). Required
   * so the executor can route to the right provider adapter without
   * scanning all of them. iOS knows the provider because it received it
   * with the run record. */
  provider: string
  runId: string
  /** Optional rationale; surfaces in audit logs. */
  message?: string
}

export interface BridgeEnsembleCancelRoundAction extends BridgeActionMetadata {
  kind: 'ensembleCancelRound'
  workspaceId: string
  threadId: string
  roundId?: string
  message?: string
}

export interface BridgeEnsembleSkipActiveParticipantAction extends BridgeActionMetadata {
  kind: 'ensembleSkipActiveParticipant'
  workspaceId: string
  threadId: string
  roundId?: string
  participantId?: string
  message?: string
}

export interface BridgeEnsembleWakeNowAction extends BridgeActionMetadata {
  kind: 'ensembleWakeNow'
  workspaceId: string
  threadId: string
  wakeupId: string
  message?: string
}

export interface BridgeEnsembleCancelWakeupAction extends BridgeActionMetadata {
  kind: 'ensembleCancelWakeup'
  workspaceId: string
  threadId: string
  wakeupId: string
  message?: string
}

export interface BridgeEnsembleQueuePromptAction extends BridgeActionMetadata {
  kind: 'ensembleQueuePrompt'
  workspaceId: string
  threadId: string
  roundId?: string
  text: string
  message?: string
}

/** One desired roster entry for ensembleRosterUpdate. Array order IS the
 * speaking order. `id` matches an existing participant (preserving its
 * runtime profile / permission / session fields); absent or unknown ids
 * mint a new participant seeded from the Mac's same-provider defaults. */
export interface BridgeRosterParticipant {
  id?: string
  provider: string
  model?: string
  role?: string
  /** Goal/brief — maps to the participant's instructions. */
  brief?: string
  enabled?: boolean
  /** Per-participant approval preset (read_only | default | workspace_write | …) —
   * lets remote clients set plan/default/full permission per participant. */
  permissionPresetId?: string
  /** Per-participant reasoning effort (generic; provider-interpreted: Codex/Grok
   * effort, Claude effort). */
  reasoningEffort?: string
  /** Codex serviceTier=fast / Claude fast mode. */
  fastModeEnabled?: boolean
  /** Kimi K2 thinking toggle. */
  thinkingEnabled?: boolean
  /** Optional per-roster marker. Exactly one true value assigns Bossman. */
  isBossman?: boolean
}

export interface BridgeSetThreadNotesAction extends BridgeActionMetadata {
  kind: 'setThreadNotes'
  workspaceId: string
  threadId: string
  /** Markdown thread notes; empty string clears. */
  notes: string
}

export type BridgeGoalUpdateOperation =
  | 'set'
  | 'edit'
  | 'clear'
  | 'pause'
  | 'resume'
  | 'complete'
  | 'block'

export interface BridgeGoalUpdateAction extends BridgeActionMetadata {
  kind: 'goalUpdate'
  workspaceId: string
  threadId: string
  op: BridgeGoalUpdateOperation
  objective?: string
  reason?: string
}

export interface BridgeToggleMessagePinAction extends BridgeActionMetadata {
  kind: 'toggleMessagePin'
  workspaceId: string
  threadId: string
  messageId: string
  pinned: boolean
}

export interface BridgeProposedPlanDecisionAction extends BridgeActionMetadata {
  kind: 'proposedPlanDecision'
  workspaceId: string
  threadId: string
  /** Id of the assistant message the plan card anchors to (row.id). */
  messageId: string
  /** Status to stamp onto metadata.proposedPlan.status. Only 'dismissed' — the
   * Respond/Dismiss path. APPROVE no longer rides this action: it flips status to
   * 'approved' ATOMICALLY with the implement run inside composerPromptFn (via the
   * proposedPlanImplementOf marker), so there is no 'status flips with no run'
   * channel. The phone never sends a body — the Mac re-reads its canonical plan. */
  decision: 'dismissed'
}

/** Phone write-action on an open Canvas preview (P3): close it or reload its page.
 * The Mac owns the canvas by chatId; `threadId` (== app chat id) flows into the
 * CanvasService ownership ctx, so a phone can only act on its own chat's canvas. */
export interface BridgeCanvasActionAction extends BridgeActionMetadata {
  kind: 'canvasAction'
  workspaceId: string
  threadId: string
  canvasId: string
  action: 'close' | 'reload'
}

export interface BridgeSetGuestParticipantAction extends BridgeActionMetadata {
  kind: 'setGuestParticipant'
  workspaceId: string
  threadId: string
  provider: string
  model?: string
  codexReasoningEffort?: string | null
  claudeReasoningEffort?: string | null
}

export interface BridgeRemoveGuestParticipantAction extends BridgeActionMetadata {
  kind: 'removeGuestParticipant'
  workspaceId: string
  threadId: string
}

export interface BridgeCreateSideChatAction extends BridgeActionMetadata {
  kind: 'createSideChat'
  workspaceId: string
  /** Parent thread the side chat hangs off. */
  threadId: string
  provider?: string
  model?: string
  codexReasoningEffort?: string | null
  claudeReasoningEffort?: string | null
  mode?: 'singleProvider' | 'ensembleClone' | 'fanOut'
}

export interface BridgeEnsembleQueueItemAction extends BridgeActionMetadata {
  kind: 'ensembleQueueItem'
  workspaceId: string
  threadId: string
  /** Index into the canonical queue (`queuedPrompts[]`, or legacy `queuedPrompt` fallback). */
  index: number
  /** Optional race guard — first chars of the expected text; the executor
   * rejects if the item at `index` no longer starts with it. */
  textPrefix?: string
  op: 'steerNow' | 'remove'
}

export interface BridgeEnsembleRosterUpdateAction extends BridgeActionMetadata {
  kind: 'ensembleRosterUpdate'
  workspaceId: string
  threadId: string
  participants: BridgeRosterParticipant[]
}

export interface BridgeEnsembleSteerAction extends BridgeActionMetadata {
  kind: 'ensembleSteer'
  workspaceId: string
  threadId: string
  roundId?: string
  text: string
  message?: string
  /** Phone-attached images — same shape/caps as composerPrompt's. */
  imageAttachments?: BridgeImageAttachment[]
}

export interface BridgeSetYoloModeAction extends BridgeActionMetadata {
  kind: 'setYoloMode'
  /** Used to gate this process-wide escalation through the remote
   * workspace allowlist. */
  workspaceId: string
  enabled: boolean
}

export interface BridgeTogglePinChatAction extends BridgeActionMetadata {
  kind: 'togglePinChat'
  workspaceId: string
  appChatId: string
  pinned: boolean
}

export interface BridgeTogglePinWorkspaceAction extends BridgeActionMetadata {
  kind: 'togglePinWorkspace'
  workspaceId: string
  pinned: boolean
}

/** Fallback for any unrecognized `kind`. The router treats this as a
 * structured deny (no execution) but logs the original kind so we can
 * monitor schema drift between iOS and Electron versions. */
export interface BridgeUnknownAction {
  kind: 'unknown'
  /** Best-effort echo of whatever `kind` value arrived on the wire. */
  rawKind: string
  /** The original parsed object (after JSON parse but before type-gate). */
  raw: unknown
}

export type BridgeActionPayload =
  | BridgeApprovalReplyAction
  | BridgeQuestionReplyAction
  | BridgeQuestionRejectAction
  | BridgeComposerPromptAction
  | BridgeComposerQueuePromptAction
  | BridgeComposerQueueItemAction
  | BridgeCreateThreadAction
  | BridgeThreadRowExpandAction
  | BridgeThreadMediaFetchAction
  | BridgeThreadSnapshotRequestAction
  | BridgeWorkspaceFileListAction
  | BridgeWorkspaceFileReadAction
  | BridgeWorkspaceFileWriteAction
  | BridgeWorkspaceFileDeleteAction
  | BridgeWorkspaceDiffAction
  | BridgeGitSnapshotAction
  | BridgeGitStageAllAction
  | BridgeGitStagePathsAction
  | BridgeGitUnstagePathsAction
  | BridgeGitCommitAction
  | BridgeGitPushAction
  | BridgeGithubPrStatusAction
  | BridgeGithubPrReadinessAction
  | BridgeGithubCreatePrAction
  | BridgeCancelRunAction
  | BridgeEnsembleCancelRoundAction
  | BridgeEnsembleSkipActiveParticipantAction
  | BridgeEnsembleWakeNowAction
  | BridgeEnsembleCancelWakeupAction
  | BridgeEnsembleQueuePromptAction
  | BridgeEnsembleSteerAction
  | BridgeEnsembleRosterUpdateAction
  | BridgeEnsembleQueueItemAction
  | BridgeSetGuestParticipantAction
  | BridgeRemoveGuestParticipantAction
  | BridgeCreateSideChatAction
  | BridgeSetThreadNotesAction
  | BridgeGoalUpdateAction
  | BridgeToggleMessagePinAction
  | BridgeProposedPlanDecisionAction
  | BridgeCanvasActionAction
  | BridgeRegisterApnsTokenAction
  | BridgeEnsemblePresetMutateAction
  | BridgeDiscoverTailnetHostsAction
  | BridgeSetYoloModeAction
  | BridgeTogglePinChatAction
  | BridgeTogglePinWorkspaceAction
  | BridgeUnknownAction

export interface DecodedActionPayload {
  payload: BridgeActionPayload
  /** Original raw JSON object (for diagnostics). */
  rawJson: unknown
}

/** Sentinel error type so callers (router) can distinguish decoder failure
 * from policy denial. */
export class BridgeActionPayloadDecodeError extends Error {
  readonly stage: 'base64' | 'utf8' | 'json' | 'shape'
  constructor(stage: BridgeActionPayloadDecodeError['stage'], message: string) {
    super(message)
    this.name = 'BridgeActionPayloadDecodeError'
    this.stage = stage
  }
}

/** Decode a base64-encoded UTF-8 JSON payload into a typed action.
 * Throws `BridgeActionPayloadDecodeError` on each failure stage so the
 * router can return a tailored deny reason ("malformed base64",
 * "malformed JSON", etc.). */
export function decodeBridgeActionPayload(payloadBase64: string): DecodedActionPayload {
  let bytes: Buffer
  try {
    bytes = Buffer.from(payloadBase64, 'base64')
  } catch (err) {
    throw new BridgeActionPayloadDecodeError(
      'base64',
      `Failed to base64-decode payload: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (bytes.length === 0) {
    throw new BridgeActionPayloadDecodeError('base64', 'Payload is empty after base64 decode')
  }
  // Buffer.from('garbage!', 'base64') silently produces partial bytes — re-encoding
  // and checking for a mismatch catches obviously-non-base64 inputs. We compare
  // canonical forms (strip padding) since Buffer's output is always padded.
  const reencoded = bytes.toString('base64')
  const canonInput = payloadBase64.replace(/=+$/, '')
  const canonReencoded = reencoded.replace(/=+$/, '')
  if (canonInput !== canonReencoded) {
    throw new BridgeActionPayloadDecodeError(
      'base64',
      'Payload base64 does not round-trip — likely corrupted on the wire'
    )
  }

  let text: string
  try {
    text = bytes.toString('utf-8')
  } catch (err) {
    throw new BridgeActionPayloadDecodeError(
      'utf8',
      `Failed UTF-8 decode: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new BridgeActionPayloadDecodeError(
      'json',
      `Malformed JSON in payload: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const payload = coerceToPayload(parsed)
  return { payload, rawJson: parsed }
}

/** Extract the workspace id from a payload variant for allowlist lookups.
 * Returns null for `unknown` actions (so callers can deny with
 * "unrecognized action") and for non-workspace-bound variants like
 * `registerApnsToken` (which are paired-device-level, not workspace-level).
 * Combine with `payloadRequiresWorkspaceGating` to decide whether a null
 * workspaceId is a legitimate skip or a malformed payload. */
export function workspaceIdFromPayload(payload: BridgeActionPayload): string | null {
  switch (payload.kind) {
    case 'approvalReply':
    case 'questionReply':
    case 'questionReject':
    case 'composerPrompt':
    case 'composerQueuePrompt':
    case 'composerQueueItem':
    case 'createThread':
    case 'threadRowExpand':
    case 'threadMediaFetch':
    case 'threadSnapshotRequest':
    case 'workspaceFileList':
    case 'workspaceFileRead':
    case 'workspaceFileWrite':
    case 'workspaceFileDelete':
    case 'workspaceDiff':
    case 'gitSnapshot':
    case 'gitStageAll':
    case 'gitStagePaths':
    case 'gitUnstagePaths':
    case 'gitCommit':
    case 'gitPush':
    case 'githubPrStatus':
    case 'githubPrReadiness':
    case 'githubCreatePr':
    case 'cancelRun':
    case 'ensembleCancelRound':
    case 'ensembleSkipActiveParticipant':
    case 'ensembleWakeNow':
    case 'ensembleCancelWakeup':
    case 'ensembleQueuePrompt':
    case 'ensembleSteer':
    case 'ensembleRosterUpdate':
    case 'ensembleQueueItem':
    case 'setGuestParticipant':
    case 'removeGuestParticipant':
    case 'createSideChat':
    case 'setThreadNotes':
    case 'goalUpdate':
    case 'toggleMessagePin':
    case 'proposedPlanDecision':
    case 'canvasAction':
    case 'setYoloMode':
    case 'togglePinChat':
    case 'togglePinWorkspace':
      return payload.workspaceId
    case 'registerApnsToken':
    case 'ensemblePresetMutate':
    case 'discoverTailnetHosts':
    case 'unknown':
      return null
  }
}

export function actionIdFromPayload(payload: BridgeActionPayload): string | null {
  if (payload.kind === 'unknown') return null
  return payload.actionId ?? null
}

export function expiresAtFromPayload(payload: BridgeActionPayload): number | null {
  if (payload.kind === 'unknown') return null
  return payload.expiresAt ?? null
}

/** Whether a payload variant must pass the workspace-allowlist gate.
 * Most action kinds are workspace-bound; `registerApnsToken` is a
 * paired-device-level system action and bypasses (the pair gate at the
 * QUIC layer is the only authentication needed). */
export function payloadRequiresWorkspaceGating(payload: BridgeActionPayload): boolean {
  switch (payload.kind) {
    case 'approvalReply':
    case 'questionReply':
    case 'questionReject':
    case 'composerPrompt':
    case 'composerQueuePrompt':
    case 'composerQueueItem':
    case 'createThread':
    case 'threadRowExpand':
    case 'threadMediaFetch':
    case 'threadSnapshotRequest':
    case 'workspaceFileList':
    case 'workspaceFileRead':
    case 'workspaceFileWrite':
    case 'workspaceFileDelete':
    case 'workspaceDiff':
    case 'gitSnapshot':
    case 'gitStageAll':
    case 'gitStagePaths':
    case 'gitUnstagePaths':
    case 'gitCommit':
    case 'gitPush':
    case 'githubPrStatus':
    case 'githubPrReadiness':
    case 'githubCreatePr':
    case 'cancelRun':
    case 'ensembleCancelRound':
    case 'ensembleSkipActiveParticipant':
    case 'ensembleWakeNow':
    case 'ensembleCancelWakeup':
    case 'ensembleQueuePrompt':
    case 'ensembleSteer':
    case 'ensembleRosterUpdate':
    case 'ensembleQueueItem':
    case 'setGuestParticipant':
    case 'removeGuestParticipant':
    case 'createSideChat':
    case 'setThreadNotes':
    case 'goalUpdate':
    case 'toggleMessagePin':
    case 'proposedPlanDecision':
    case 'canvasAction':
    case 'setYoloMode':
    case 'togglePinChat':
    case 'togglePinWorkspace':
      return true
    case 'registerApnsToken':
    // ensemblePresetMutate is pair-gated only (no workspace allowlist), like
    // registerApnsToken: roster presets are the user's OWN global data and the
    // QUIC pair binding authenticates the device as theirs. APPLYING a preset is
    // separately workspace-gated (ensembleRosterUpdate → 'steer'), and any
    // elevated per-participant permission is re-clamped at run dispatch — so a
    // preset write can't escalate privilege, only edit the shared preset list.
    case 'ensemblePresetMutate':
    case 'discoverTailnetHosts':
      return false
    case 'unknown':
      // Unknown variants are rejected upstream; the gating question
      // doesn't apply. Return true so a stray unknown-with-workspaceId
      // still gets routed through the workspace path defensively.
      return true
  }
}

/** Legacy coarse classification for compatibility tests and older call sites.
 * The router now uses fine-grained allowlist capabilities, but this remains
 * useful for documenting which payloads mutate desktop-side state (kick off a
 * new run, cancel an in-flight one, inject input into an agent). The
 * non-mutating set — approvalReply, questionReject — is iOS responding to
 * desktop-initiated prompts.
 *
 * Notes on individual variants:
 *   - `approvalReply`: responding to an approval prompt the DESKTOP
 *     already surfaced. The decision itself doesn't initiate new work;
 *     it lets an already-pending tool call proceed. Allowed in read-only.
 *   - `questionReject`: declining to provide input. Strictly less
 *     mutating than answering. Allowed in read-only.
 *   - `questionReply`: provides TYPED INPUT to an in-flight agent. This
 *     is real data flowing into the workspace's state. Blocked in
 *     read-only.
 *   - `composerPrompt`: initiates a new turn. Clearly mutating.
 *   - `cancelRun`: terminates an in-flight run. Read-only blocks; the
 *     desktop user still has full control. (We might revisit this if
 *     "safety cancel from phone" becomes a desired feature, but the
 *     conservative read-only semantic is to deny.)
 *   - `registerApnsToken`: never reaches this check — it bypasses
 *     workspace gating entirely via `payloadRequiresWorkspaceGating`.
 *   - `unknown`: classify defensively as mutating so a forward-compat
 *     unknown action can't sneak past read-only gating.
 */
export function payloadIsMutating(payload: BridgeActionPayload): boolean {
  switch (payload.kind) {
    case 'composerPrompt':
    case 'composerQueuePrompt':
    case 'composerQueueItem':
    case 'createThread':
    case 'cancelRun':
    case 'questionReply':
    case 'ensembleCancelRound':
    case 'ensembleSkipActiveParticipant':
    case 'ensembleWakeNow':
    case 'ensembleCancelWakeup':
    case 'ensembleQueuePrompt':
    case 'ensembleSteer':
    case 'ensembleRosterUpdate':
    case 'ensembleQueueItem':
    case 'setGuestParticipant':
    case 'removeGuestParticipant':
    case 'createSideChat':
    case 'setThreadNotes':
    case 'goalUpdate':
    case 'toggleMessagePin':
    case 'proposedPlanDecision':
    case 'canvasAction':
    case 'setYoloMode':
    case 'togglePinChat':
    case 'togglePinWorkspace':
    case 'workspaceFileWrite':
    case 'workspaceFileDelete':
    case 'gitStageAll':
    case 'gitStagePaths':
    case 'gitUnstagePaths':
    case 'gitCommit':
    case 'gitPush':
    case 'githubCreatePr':
    case 'registerApnsToken':
    case 'ensemblePresetMutate':
      return true
    case 'approvalReply':
    case 'questionReject':
    case 'threadSnapshotRequest':
    case 'threadRowExpand':
    case 'threadMediaFetch':
    case 'workspaceFileList':
    case 'workspaceFileRead':
    case 'workspaceDiff':
    case 'gitSnapshot':
    case 'githubPrStatus':
    case 'githubPrReadiness':
    case 'discoverTailnetHosts':
      return false
    case 'unknown':
      return true
  }
}

// MARK: - Shape gates

function coerceToPayload(parsed: unknown): BridgeActionPayload {
  if (!isRecord(parsed) || typeof parsed.kind !== 'string') {
    return { kind: 'unknown', rawKind: '?', raw: parsed }
  }
  switch (parsed.kind) {
    case 'approvalReply':
      return isApprovalReply(parsed)
        ? (parsed as unknown as BridgeApprovalReplyAction)
        : { kind: 'unknown', rawKind: 'approvalReply', raw: parsed }
    case 'questionReply':
      return isQuestionReply(parsed)
        ? (parsed as unknown as BridgeQuestionReplyAction)
        : { kind: 'unknown', rawKind: 'questionReply', raw: parsed }
    case 'questionReject':
      return isQuestionReject(parsed)
        ? (parsed as unknown as BridgeQuestionRejectAction)
        : { kind: 'unknown', rawKind: 'questionReject', raw: parsed }
    case 'composerPrompt':
      return isComposerPrompt(parsed)
        ? (parsed as unknown as BridgeComposerPromptAction)
        : { kind: 'unknown', rawKind: 'composerPrompt', raw: parsed }
    case 'composerQueuePrompt':
      return isComposerPrompt(parsed)
        ? (parsed as unknown as BridgeComposerQueuePromptAction)
        : { kind: 'unknown', rawKind: 'composerQueuePrompt', raw: parsed }
    case 'composerQueueItem':
      return isComposerQueueItem(parsed)
        ? (parsed as unknown as BridgeComposerQueueItemAction)
        : { kind: 'unknown', rawKind: 'composerQueueItem', raw: parsed }
    case 'createThread':
      return isCreateThread(parsed)
        ? (parsed as unknown as BridgeCreateThreadAction)
        : { kind: 'unknown', rawKind: 'createThread', raw: parsed }
    case 'threadRowExpand':
      return isThreadRowExpand(parsed)
        ? (parsed as unknown as BridgeThreadRowExpandAction)
        : { kind: 'unknown', rawKind: 'threadRowExpand', raw: parsed }
    case 'threadMediaFetch':
      return isThreadMediaFetch(parsed)
        ? (parsed as unknown as BridgeThreadMediaFetchAction)
        : { kind: 'unknown', rawKind: 'threadMediaFetch', raw: parsed }
    case 'threadSnapshotRequest':
      return isThreadSnapshotRequest(parsed)
        ? (parsed as unknown as BridgeThreadSnapshotRequestAction)
        : { kind: 'unknown', rawKind: 'threadSnapshotRequest', raw: parsed }
    case 'workspaceFileList':
      return isWorkspaceFileList(parsed)
        ? (parsed as unknown as BridgeWorkspaceFileListAction)
        : { kind: 'unknown', rawKind: 'workspaceFileList', raw: parsed }
    case 'workspaceFileRead':
      return isWorkspaceFileRead(parsed)
        ? (parsed as unknown as BridgeWorkspaceFileReadAction)
        : { kind: 'unknown', rawKind: 'workspaceFileRead', raw: parsed }
    case 'workspaceFileWrite':
      return isWorkspaceFileWrite(parsed)
        ? (parsed as unknown as BridgeWorkspaceFileWriteAction)
        : { kind: 'unknown', rawKind: 'workspaceFileWrite', raw: parsed }
    case 'workspaceFileDelete':
      return isWorkspaceFileRead(parsed)
        ? (parsed as unknown as BridgeWorkspaceFileDeleteAction)
        : { kind: 'unknown', rawKind: 'workspaceFileDelete', raw: parsed }
    case 'workspaceDiff':
      return isWorkspaceDiff(parsed)
        ? (parsed as unknown as BridgeWorkspaceDiffAction)
        : { kind: 'unknown', rawKind: 'workspaceDiff', raw: parsed }
    case 'gitSnapshot':
      return isGitSnapshot(parsed)
        ? (parsed as unknown as BridgeGitSnapshotAction)
        : { kind: 'unknown', rawKind: 'gitSnapshot', raw: parsed }
    case 'gitStageAll':
      return isWorkspaceScopedGitRead(parsed)
        ? (parsed as unknown as BridgeGitStageAllAction)
        : { kind: 'unknown', rawKind: 'gitStageAll', raw: parsed }
    case 'gitStagePaths':
      return isGitPaths(parsed)
        ? (parsed as unknown as BridgeGitStagePathsAction)
        : { kind: 'unknown', rawKind: 'gitStagePaths', raw: parsed }
    case 'gitUnstagePaths':
      return isGitPaths(parsed)
        ? (parsed as unknown as BridgeGitUnstagePathsAction)
        : { kind: 'unknown', rawKind: 'gitUnstagePaths', raw: parsed }
    case 'gitCommit':
      return isGitCommit(parsed)
        ? (parsed as unknown as BridgeGitCommitAction)
        : { kind: 'unknown', rawKind: 'gitCommit', raw: parsed }
    case 'gitPush':
      return isGitPush(parsed)
        ? (parsed as unknown as BridgeGitPushAction)
        : { kind: 'unknown', rawKind: 'gitPush', raw: parsed }
    case 'githubPrStatus':
      return isWorkspaceScopedGitRead(parsed)
        ? (parsed as unknown as BridgeGithubPrStatusAction)
        : { kind: 'unknown', rawKind: 'githubPrStatus', raw: parsed }
    case 'githubPrReadiness':
      return isWorkspaceScopedGitRead(parsed)
        ? (parsed as unknown as BridgeGithubPrReadinessAction)
        : { kind: 'unknown', rawKind: 'githubPrReadiness', raw: parsed }
    case 'githubCreatePr':
      return isGithubCreatePr(parsed)
        ? (parsed as unknown as BridgeGithubCreatePrAction)
        : { kind: 'unknown', rawKind: 'githubCreatePr', raw: parsed }
    case 'cancelRun':
      return isCancelRun(parsed)
        ? (parsed as unknown as BridgeCancelRunAction)
        : { kind: 'unknown', rawKind: 'cancelRun', raw: parsed }
    case 'ensembleCancelRound':
      return isEnsembleCancelRound(parsed)
        ? (parsed as unknown as BridgeEnsembleCancelRoundAction)
        : { kind: 'unknown', rawKind: 'ensembleCancelRound', raw: parsed }
    case 'ensembleSkipActiveParticipant':
      return isEnsembleSkipActiveParticipant(parsed)
        ? (parsed as unknown as BridgeEnsembleSkipActiveParticipantAction)
        : { kind: 'unknown', rawKind: 'ensembleSkipActiveParticipant', raw: parsed }
    case 'ensembleWakeNow':
      return isEnsembleWakeNow(parsed)
        ? (parsed as unknown as BridgeEnsembleWakeNowAction)
        : { kind: 'unknown', rawKind: 'ensembleWakeNow', raw: parsed }
    case 'ensembleCancelWakeup':
      return isEnsembleCancelWakeup(parsed)
        ? (parsed as unknown as BridgeEnsembleCancelWakeupAction)
        : { kind: 'unknown', rawKind: 'ensembleCancelWakeup', raw: parsed }
    case 'ensembleQueuePrompt':
      return isEnsembleQueuePrompt(parsed)
        ? (parsed as unknown as BridgeEnsembleQueuePromptAction)
        : { kind: 'unknown', rawKind: 'ensembleQueuePrompt', raw: parsed }
    case 'ensembleSteer':
      return isEnsembleSteer(parsed)
        ? (parsed as unknown as BridgeEnsembleSteerAction)
        : { kind: 'unknown', rawKind: 'ensembleSteer', raw: parsed }
    case 'ensembleRosterUpdate':
      return isEnsembleRosterUpdate(parsed)
        ? (parsed as unknown as BridgeEnsembleRosterUpdateAction)
        : { kind: 'unknown', rawKind: 'ensembleRosterUpdate', raw: parsed }
    case 'ensembleQueueItem':
      return isEnsembleQueueItem(parsed)
        ? (parsed as unknown as BridgeEnsembleQueueItemAction)
        : { kind: 'unknown', rawKind: 'ensembleQueueItem', raw: parsed }
    case 'setGuestParticipant':
      return isSetGuestParticipant(parsed)
        ? (parsed as unknown as BridgeSetGuestParticipantAction)
        : { kind: 'unknown', rawKind: 'setGuestParticipant', raw: parsed }
    case 'removeGuestParticipant':
      return isWorkspaceThreadAction(parsed)
        ? (parsed as unknown as BridgeRemoveGuestParticipantAction)
        : { kind: 'unknown', rawKind: 'removeGuestParticipant', raw: parsed }
    case 'createSideChat':
      return isCreateSideChat(parsed)
        ? (parsed as unknown as BridgeCreateSideChatAction)
        : { kind: 'unknown', rawKind: 'createSideChat', raw: parsed }
    case 'setThreadNotes':
      return isSetThreadNotes(parsed)
        ? (parsed as unknown as BridgeSetThreadNotesAction)
        : { kind: 'unknown', rawKind: 'setThreadNotes', raw: parsed }
    case 'goalUpdate':
      return isGoalUpdate(parsed)
        ? (parsed as unknown as BridgeGoalUpdateAction)
        : { kind: 'unknown', rawKind: 'goalUpdate', raw: parsed }
    case 'toggleMessagePin':
      return isToggleMessagePin(parsed)
        ? (parsed as unknown as BridgeToggleMessagePinAction)
        : { kind: 'unknown', rawKind: 'toggleMessagePin', raw: parsed }
    case 'proposedPlanDecision':
      return isProposedPlanDecision(parsed)
        ? (parsed as unknown as BridgeProposedPlanDecisionAction)
        : { kind: 'unknown', rawKind: 'proposedPlanDecision', raw: parsed }
    case 'canvasAction':
      return isCanvasAction(parsed)
        ? (parsed as unknown as BridgeCanvasActionAction)
        : { kind: 'unknown', rawKind: 'canvasAction', raw: parsed }
    case 'registerApnsToken':
      return isRegisterApnsToken(parsed)
        ? (parsed as unknown as BridgeRegisterApnsTokenAction)
        : { kind: 'unknown', rawKind: 'registerApnsToken', raw: parsed }
    case 'ensemblePresetMutate':
      return isEnsemblePresetMutate(parsed)
        ? (parsed as unknown as BridgeEnsemblePresetMutateAction)
        : { kind: 'unknown', rawKind: 'ensemblePresetMutate', raw: parsed }
    case 'discoverTailnetHosts':
      return isDiscoverTailnetHosts(parsed)
        ? (parsed as unknown as BridgeDiscoverTailnetHostsAction)
        : { kind: 'unknown', rawKind: 'discoverTailnetHosts', raw: parsed }
    case 'setYoloMode':
      return isSetYoloMode(parsed)
        ? (parsed as unknown as BridgeSetYoloModeAction)
        : { kind: 'unknown', rawKind: 'setYoloMode', raw: parsed }
    case 'togglePinChat':
      return isTogglePinChat(parsed)
        ? (parsed as unknown as BridgeTogglePinChatAction)
        : { kind: 'unknown', rawKind: 'togglePinChat', raw: parsed }
    case 'togglePinWorkspace':
      return isTogglePinWorkspace(parsed)
        ? (parsed as unknown as BridgeTogglePinWorkspaceAction)
        : { kind: 'unknown', rawKind: 'togglePinWorkspace', raw: parsed }
    default:
      return { kind: 'unknown', rawKind: parsed.kind, raw: parsed }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
}

function isApprovalReply(v: Record<string, unknown>): boolean {
  const decision = v.decision
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    typeof v.threadId === 'string' &&
    typeof v.toolCallId === 'string' &&
    isBridgeApprovalDecision(decision) &&
    (v.message === undefined || typeof v.message === 'string')
  )
}

function isBridgeApprovalDecision(value: unknown): value is BridgeApprovalDecision {
  return (
    value === 'accept' ||
    value === 'acceptForSession' ||
    value === 'acceptForWorkspace' ||
    value === 'decline' ||
    value === 'cancel'
  )
}

function isQuestionReply(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    v.workspaceId.trim().length > 0 &&
    typeof v.threadId === 'string' &&
    v.threadId.trim().length > 0 &&
    (v.runId === undefined || (typeof v.runId === 'string' && v.runId.trim().length > 0)) &&
    typeof v.promptId === 'string' &&
    v.promptId.trim().length > 0 &&
    typeof v.answer === 'string' &&
    v.answer.length <= BRIDGE_QUESTION_ANSWER_MAX_CHARS
  )
}

function isQuestionReject(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    v.workspaceId.trim().length > 0 &&
    typeof v.threadId === 'string' &&
    v.threadId.trim().length > 0 &&
    (v.runId === undefined || (typeof v.runId === 'string' && v.runId.trim().length > 0)) &&
    typeof v.promptId === 'string' &&
    v.promptId.trim().length > 0 &&
    (v.message === undefined ||
      (typeof v.message === 'string' &&
        v.message.length <= BRIDGE_QUESTION_REJECT_MESSAGE_MAX_CHARS))
  )
}

const MAX_IMAGE_ATTACHMENTS = 2
const MAX_IMAGE_ATTACHMENT_COMBINED_BASE64 = 900_000

function isImageAttachments(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IMAGE_ATTACHMENTS) {
    return false
  }
  let combined = 0
  for (const entry of value) {
    if (!isRecord(entry)) return false
    if (typeof entry.mimeType !== 'string' || !entry.mimeType.startsWith('image/')) return false
    if (typeof entry.dataBase64 !== 'string' || entry.dataBase64.length === 0) return false
    if (entry.name !== undefined && typeof entry.name !== 'string') return false
    combined += entry.dataBase64.length
  }
  return combined <= MAX_IMAGE_ATTACHMENT_COMBINED_BASE64
}

function isComposerPrompt(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    typeof v.threadId === 'string' &&
    typeof v.text === 'string' &&
    typeof v.provider === 'string' &&
    (v.approvalMode === undefined || typeof v.approvalMode === 'string') &&
    (v.model === undefined || typeof v.model === 'string') &&
    (v.reasoningEffort === undefined ||
      v.reasoningEffort === null ||
      typeof v.reasoningEffort === 'string') &&
    (v.claudeReasoningEffort === undefined ||
      v.claudeReasoningEffort === null ||
      typeof v.claudeReasoningEffort === 'string') &&
    (v.imageAttachments === undefined || isImageAttachments(v.imageAttachments)) &&
    (v.contextTurns === undefined ||
      (typeof v.contextTurns === 'number' &&
        Number.isInteger(v.contextTurns) &&
        v.contextTurns >= 0)) &&
    (v.extraWorkspaceIds === undefined ||
      (Array.isArray(v.extraWorkspaceIds) &&
        v.extraWorkspaceIds.length <= 2 &&
        v.extraWorkspaceIds.every(
          (id) => typeof id === 'string' && id.trim().length > 0
        ))) &&
    (v.proposedPlanImplementOf === undefined ||
      (typeof v.proposedPlanImplementOf === 'string' &&
        v.proposedPlanImplementOf.trim().length > 0))
  )
}

function isComposerQueueItem(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    typeof v.threadId === 'string' &&
    typeof v.queueId === 'string' &&
    v.queueId.trim().length > 0 &&
    (v.textPrefix === undefined ||
      (typeof v.textPrefix === 'string' && v.textPrefix.length <= 120)) &&
    (v.op === 'steerNow' || v.op === 'remove')
  )
}

function isCreateThread(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    (v.variant === 'workspace' ||
      v.variant === 'single' ||
      v.variant === 'ensemble' ||
      v.variant === 'global') &&
    (v.threadId === undefined || typeof v.threadId === 'string') &&
    (v.provider === undefined || typeof v.provider === 'string') &&
    (v.title === undefined || typeof v.title === 'string') &&
    (v.participants === undefined || isCreateThreadParticipants(v.participants))
  )
}

function isCreateThreadParticipants(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) return false
  return value.every(
    (entry) =>
      isRecord(entry) &&
      typeof entry.provider === 'string' &&
      entry.provider.trim().length > 0 &&
      (entry.model === undefined || typeof entry.model === 'string') &&
      (entry.role === undefined || typeof entry.role === 'string')
  )
}

function isThreadRowExpand(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    typeof v.threadId === 'string' &&
    typeof v.rowId === 'string' &&
    (v.maxChars === undefined ||
      (typeof v.maxChars === 'number' && Number.isInteger(v.maxChars) && v.maxChars > 0))
  )
}

function isThreadMediaFetch(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    typeof v.threadId === 'string' &&
    typeof v.rowId === 'string' &&
    typeof v.mediaId === 'string' &&
    v.mediaId.length > 0 &&
    v.mediaId.length <= BRIDGE_THREAD_ROW_ID_MAX_CHARS * 2 &&
    (v.variant === undefined || v.variant === 'thumbnail' || v.variant === 'full') &&
    (v.maxBytes === undefined ||
      (typeof v.maxBytes === 'number' && Number.isInteger(v.maxBytes) && v.maxBytes > 0)) &&
    // RANGE MODE = both offset+length present. If EITHER is present, BOTH must be
    // present and valid (offset integer ≥ 0, length integer ≥ 1); otherwise reject.
    // Neither present → whole-file mode (unchanged).
    isThreadMediaRangeFields(v)
  )
}

/** Both-or-neither range fields. Returns false when exactly one is present, or
 * when either is present but out of bounds (non-integer / offset < 0 / length < 1).
 * Returns true when both are absent (whole-file mode). */
function isThreadMediaRangeFields(v: Record<string, unknown>): boolean {
  const hasOffset = v.offset !== undefined
  const hasLength = v.length !== undefined
  if (!hasOffset && !hasLength) return true
  if (!hasOffset || !hasLength) return false
  return (
    typeof v.offset === 'number' &&
    Number.isInteger(v.offset) &&
    v.offset >= 0 &&
    typeof v.length === 'number' &&
    Number.isInteger(v.length) &&
    v.length >= 1
  )
}

function isThreadSnapshotRequest(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    typeof v.threadId === 'string' &&
    (v.beforeRowId === undefined ||
      (typeof v.beforeRowId === 'string' &&
        v.beforeRowId.length <= BRIDGE_THREAD_ROW_ID_MAX_CHARS)) &&
    (v.limit === undefined ||
      (typeof v.limit === 'number' && Number.isInteger(v.limit) && v.limit > 0))
  )
}

function isWorkspaceFileList(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    (v.path === undefined ||
      (typeof v.path === 'string' && v.path.length <= BRIDGE_WORKSPACE_FILE_PATH_MAX_CHARS)) &&
    (v.query === undefined ||
      (typeof v.query === 'string' && v.query.length <= BRIDGE_WORKSPACE_FILE_PATH_MAX_CHARS)) &&
    (v.limit === undefined ||
      (typeof v.limit === 'number' && Number.isInteger(v.limit) && v.limit > 0))
  )
}

function isWorkspaceDiff(v: Record<string, unknown>): boolean {
  return hasValidActionMetadata(v) && typeof v.workspaceId === 'string'
}

/** Shared gate for the workspace-only git actions (gitSnapshot,
 * gitStageAll, githubPrStatus, githubPrReadiness). */
function isWorkspaceScopedGitRead(v: Record<string, unknown>): boolean {
  return hasValidActionMetadata(v) && typeof v.workspaceId === 'string'
}

function isGitSnapshot(v: Record<string, unknown>): boolean {
  return isWorkspaceScopedGitRead(v) && (v.publish === undefined || typeof v.publish === 'boolean')
}

const MAX_GIT_COMMIT_MESSAGE_LENGTH = 5_000
const MAX_GIT_PATHS_PER_ACTION = 50
const MAX_GITHUB_PR_TITLE_LENGTH = 300
const MAX_GITHUB_PR_BODY_LENGTH = 20_000

function isGitPaths(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    Array.isArray(v.paths) &&
    v.paths.length > 0 &&
    v.paths.length <= MAX_GIT_PATHS_PER_ACTION &&
    v.paths.every((path) => isWorkspaceRelativeFilePath(path))
  )
}

function isGitCommit(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    typeof v.message === 'string' &&
    v.message.trim().length > 0 &&
    v.message.length <= MAX_GIT_COMMIT_MESSAGE_LENGTH &&
    (v.stageAll === undefined || typeof v.stageAll === 'boolean')
  )
}

function isGitPush(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    (v.setUpstream === undefined || typeof v.setUpstream === 'boolean')
  )
}

function isGithubCreatePr(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    (v.title === undefined ||
      (typeof v.title === 'string' && v.title.length <= MAX_GITHUB_PR_TITLE_LENGTH)) &&
    (v.body === undefined ||
      (typeof v.body === 'string' && v.body.length <= MAX_GITHUB_PR_BODY_LENGTH)) &&
    (v.draft === undefined || typeof v.draft === 'boolean')
  )
}

function isWorkspaceFileRead(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    isWorkspaceRelativeFilePath(v.path)
  )
}

function isWorkspaceFileWrite(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    isWorkspaceRelativeFilePath(v.path) &&
    typeof v.content === 'string' &&
    v.content.length <= BRIDGE_WORKSPACE_FILE_WRITE_MAX_CHARS &&
    typeof v.baseEtag === 'string' &&
    v.baseEtag.trim().length > 0
  )
}

function isWorkspaceRelativeFilePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= BRIDGE_WORKSPACE_FILE_PATH_MAX_CHARS &&
    !value.includes('\u0000')
  )
}

function isCancelRun(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    typeof v.threadId === 'string' &&
    typeof v.provider === 'string' &&
    typeof v.runId === 'string' &&
    (v.message === undefined || typeof v.message === 'string')
  )
}

function isWorkspaceThreadAction(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) && typeof v.workspaceId === 'string' && typeof v.threadId === 'string'
  )
}

function isEnsembleCancelRound(v: Record<string, unknown>): boolean {
  return (
    isWorkspaceThreadAction(v) &&
    (v.roundId === undefined || typeof v.roundId === 'string') &&
    (v.message === undefined || typeof v.message === 'string')
  )
}

function isEnsembleSkipActiveParticipant(v: Record<string, unknown>): boolean {
  return (
    isWorkspaceThreadAction(v) &&
    (v.roundId === undefined || typeof v.roundId === 'string') &&
    (v.participantId === undefined || typeof v.participantId === 'string') &&
    (v.message === undefined || typeof v.message === 'string')
  )
}

function isEnsembleWakeNow(v: Record<string, unknown>): boolean {
  return (
    isWorkspaceThreadAction(v) &&
    typeof v.wakeupId === 'string' &&
    v.wakeupId.length > 0 &&
    (v.message === undefined || typeof v.message === 'string')
  )
}

function isEnsembleCancelWakeup(v: Record<string, unknown>): boolean {
  return (
    isWorkspaceThreadAction(v) &&
    typeof v.wakeupId === 'string' &&
    v.wakeupId.length > 0 &&
    (v.message === undefined || typeof v.message === 'string')
  )
}

function isEnsembleQueuePrompt(v: Record<string, unknown>): boolean {
  return (
    isWorkspaceThreadAction(v) &&
    (v.roundId === undefined || typeof v.roundId === 'string') &&
    typeof v.text === 'string' &&
    v.text.trim().length > 0 &&
    (v.message === undefined || typeof v.message === 'string')
  )
}

function isSetThreadNotes(v: Record<string, unknown>): boolean {
  return (
    isWorkspaceThreadAction(v) && typeof v.notes === 'string' && v.notes.length <= 20_000
  )
}

function isGoalUpdate(v: Record<string, unknown>): boolean {
  const op = v.op
  if (
    !isWorkspaceThreadAction(v) ||
    !(
      op === 'set' ||
      op === 'edit' ||
      op === 'clear' ||
      op === 'pause' ||
      op === 'resume' ||
      op === 'complete' ||
      op === 'block'
    )
  ) {
    return false
  }
  if (
    (op === 'set' || op === 'edit') &&
    !(
      typeof v.objective === 'string' &&
      v.objective.trim().length > 0 &&
      v.objective.length <= BRIDGE_GOAL_OBJECTIVE_MAX_CHARS
    )
  ) {
    return false
  }
  return (
    v.objective === undefined ||
    (typeof v.objective === 'string' && v.objective.length <= BRIDGE_GOAL_OBJECTIVE_MAX_CHARS)
  ) && (
    v.reason === undefined ||
    (typeof v.reason === 'string' && v.reason.length <= BRIDGE_GOAL_REASON_MAX_CHARS)
  )
}

function isToggleMessagePin(v: Record<string, unknown>): boolean {
  return (
    isWorkspaceThreadAction(v) &&
    typeof v.messageId === 'string' &&
    v.messageId.trim().length > 0 &&
    typeof v.pinned === 'boolean'
  )
}

function isProposedPlanDecision(v: Record<string, unknown>): boolean {
  return (
    isWorkspaceThreadAction(v) &&
    typeof v.messageId === 'string' &&
    v.messageId.trim().length > 0 &&
    v.decision === 'dismissed'
  )
}

function isCanvasAction(v: Record<string, unknown>): boolean {
  return (
    isWorkspaceThreadAction(v) &&
    typeof v.canvasId === 'string' &&
    v.canvasId.trim().length > 0 &&
    (v.action === 'close' || v.action === 'reload')
  )
}

function isSetGuestParticipant(v: Record<string, unknown>): boolean {
  return (
    isWorkspaceThreadAction(v) &&
    typeof v.provider === 'string' &&
    v.provider.trim().length > 0 &&
    (v.model === undefined || typeof v.model === 'string') &&
    (v.codexReasoningEffort === undefined ||
      v.codexReasoningEffort === null ||
      typeof v.codexReasoningEffort === 'string') &&
    (v.claudeReasoningEffort === undefined ||
      v.claudeReasoningEffort === null ||
      typeof v.claudeReasoningEffort === 'string')
  )
}

function isCreateSideChat(v: Record<string, unknown>): boolean {
  return (
    isWorkspaceThreadAction(v) &&
    (v.provider === undefined || typeof v.provider === 'string') &&
    (v.model === undefined || typeof v.model === 'string') &&
    (v.codexReasoningEffort === undefined ||
      v.codexReasoningEffort === null ||
      typeof v.codexReasoningEffort === 'string') &&
    (v.claudeReasoningEffort === undefined ||
      v.claudeReasoningEffort === null ||
      typeof v.claudeReasoningEffort === 'string') &&
    (v.mode === undefined ||
      v.mode === 'singleProvider' ||
      v.mode === 'ensembleClone' ||
      v.mode === 'fanOut')
  )
}

function isEnsembleQueueItem(v: Record<string, unknown>): boolean {
  return (
    isWorkspaceThreadAction(v) &&
    typeof v.index === 'number' &&
    Number.isInteger(v.index) &&
    v.index >= 0 &&
    v.index < 100 &&
    (v.textPrefix === undefined ||
      (typeof v.textPrefix === 'string' && v.textPrefix.length <= 120)) &&
    (v.op === 'steerNow' || v.op === 'remove')
  )
}

function isEnsembleRosterUpdate(v: Record<string, unknown>): boolean {
  if (!isWorkspaceThreadAction(v)) return false
  if (!Array.isArray(v.participants)) return false
  if (v.participants.length < 1 || v.participants.length > 12) return false
  return v.participants.every((entry) => {
    if (!entry || typeof entry !== 'object') return false
    const e = entry as Record<string, unknown>
    if (typeof e.provider !== 'string' || e.provider.trim().length === 0) return false
    if (e.id !== undefined && typeof e.id !== 'string') return false
    if (e.model !== undefined && typeof e.model !== 'string') return false
    if (e.role !== undefined && (typeof e.role !== 'string' || e.role.length > 120)) return false
    if (e.brief !== undefined && (typeof e.brief !== 'string' || e.brief.length > 2000)) {
      return false
    }
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean') return false
    if (e.permissionPresetId !== undefined && typeof e.permissionPresetId !== 'string') return false
    if (e.reasoningEffort !== undefined && typeof e.reasoningEffort !== 'string') return false
    if (e.fastModeEnabled !== undefined && typeof e.fastModeEnabled !== 'boolean') return false
    if (e.thinkingEnabled !== undefined && typeof e.thinkingEnabled !== 'boolean') return false
    if (e.isBossman !== undefined && typeof e.isBossman !== 'boolean') return false
    return true
  })
}

function isEnsembleSteer(v: Record<string, unknown>): boolean {
  return (
    isWorkspaceThreadAction(v) &&
    (v.roundId === undefined || typeof v.roundId === 'string') &&
    typeof v.text === 'string' &&
    v.text.trim().length > 0 &&
    (v.message === undefined || typeof v.message === 'string') &&
    (v.imageAttachments === undefined || isImageAttachments(v.imageAttachments))
  )
}

function isSetYoloMode(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) && typeof v.workspaceId === 'string' && typeof v.enabled === 'boolean'
  )
}

function isTogglePinChat(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.workspaceId === 'string' &&
    typeof v.appChatId === 'string' &&
    typeof v.pinned === 'boolean'
  )
}

function isTogglePinWorkspace(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) && typeof v.workspaceId === 'string' && typeof v.pinned === 'boolean'
  )
}

function isEnsemblePresetMutate(v: Record<string, unknown>): boolean {
  if (!hasValidActionMetadata(v)) return false
  if (v.op === 'save') {
    return (
      typeof v.name === 'string' &&
      v.name.trim().length > 0 &&
      Array.isArray(v.participants) &&
      v.participants.every(
        (p) =>
          !!p &&
          typeof p === 'object' &&
          typeof (p as Record<string, unknown>).provider === 'string'
      )
    )
  }
  if (v.op === 'delete') {
    return typeof v.presetId === 'string' && v.presetId.length > 0
  }
  return false
}

function isRegisterApnsToken(v: Record<string, unknown>): boolean {
  return (
    hasValidActionMetadata(v) &&
    typeof v.pairID === 'string' &&
    v.pairID.length > 0 &&
    typeof v.deviceToken === 'string' &&
    // APNs device tokens are 32 bytes = 64 hex chars. Reject anything else so a
    // malformed/foreign token can't be stored verbatim and routed to Apple.
    /^[0-9a-fA-F]{64}$/.test(v.deviceToken) &&
    (v.env === 'production' || v.env === 'sandbox') &&
    (v.agreePub === undefined || typeof v.agreePub === 'string')
  )
}

function isDiscoverTailnetHosts(v: Record<string, unknown>): boolean {
  // No payload fields beyond the shared metadata — the host derives everything
  // (own identity, paired devices, stored OAuth credential) locally.
  return hasValidActionMetadata(v)
}

function hasValidActionMetadata(v: Record<string, unknown>): boolean {
  return (
    (v.actionId === undefined || (typeof v.actionId === 'string' && v.actionId.length > 0)) &&
    (v.issuedAt === undefined || (typeof v.issuedAt === 'number' && Number.isFinite(v.issuedAt))) &&
    (v.expiresAt === undefined || (typeof v.expiresAt === 'number' && Number.isFinite(v.expiresAt)))
  )
}
