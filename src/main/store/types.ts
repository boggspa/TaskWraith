import type { TodoItem } from '../TodoList'
import type { AppIconVariant } from '../../shared/iconVariants'
import type { ClaudeWorkflowTelemetry } from '../../shared/claudeWorkflow'
import type { CodexReviewTelemetry } from '../../shared/codexReview'
import type { UnattendedElevationAck } from '../UnattendedPostureGate'
import type { TaskWraithPluginResourceProvenance } from '../../shared/plugins/PluginTypes'

export type AppearanceMode = 'solid' | 'soft_glass' | 'native_glass'
export type VisualEffectStyle = 'auto' | 'liquid_glass' | 'thin_material' | 'classic'
export type ThemeAppearance =
  | 'system'
  | 'dark'
  | 'light'
  | 'midnight'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'graphite'
  | 'rainbow'
  | 'nebula'
  | 'citrus'
  | 'twilight'
  | 'ocean'
  | 'sunset'
  | 'forest'
  | 'cyber'
  | 'candy'
  | 'mist'
  | 'sage'
  /**
   * 1.0.5-EW54 — "Obsidian" theme. Deep warm-leaning charcoal base
   * with subtle peach/copper halo gradients leaking in at the top
   * and bottom edges, and crisp 1px lit "rim shine" borders on
   * every panel. Glassmorphic panel translucency. Distinct from
   * `graphite` (which trends colder + flatter) — this is the
   * "premium postmodern" reading of dark mode the design brief
   * called for: light catches the lip of every surface rather
   * than the fill itself carrying the identity.
   */
  | 'obsidian'
  /**
   * 1.0.5-EW61 — "Alabaster" theme. Polar inverse of `obsidian`.
   * Where obsidian is volcanic-black glass with white rims and
   * warm dusk halos, alabaster is translucent cream-white stone
   * with charcoal rims and cool blue/lavender halos. Same
   * design language (rim-carries-identity, opaque transcript,
   * deliberately discordant sidebar) — every value mirrored.
   * Distinct from `light` / `mist` / `sage` (which trend
   * cooler, flatter, more "iOS sunlight") — this is the
   * premium-stone postmodern reading of light mode, paired
   * with the obsidian composer's polar twin.
   */
  | 'alabaster'
export type ThemeCornerStyle = 'rounded' | 'hard'
export type ThemeAccentStyle =
  | 'system'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'orange'
  | 'green'
  | 'red'
  | 'yellow'
/**
 * Tool-call icon accent override. `system` = follow theme accent
 * (default). Named overrides target an explicit colour for the
 * tool-call icons only, leaving the rest of the UI on the user's
 * chosen theme accent. CSS seam: `--tool-call-icon-accent` +
 * `[data-tool-icon-accent="X"]` rules in `theme.css`.
 */
export type ToolIconAccent =
  | 'system'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'orange'
  | 'green'
  | 'red'
  | 'yellow'
  | 'graphite'
  | 'amber'
  | 'cyan'
  | 'violet'
/**
 * User chat-bubble colour. `system` (default) keeps the current
 * neutral elevated-surface look. The named overrides tint both the
 * `.message-bubble.user` background AND the matching `.message-meta`
 * "You" label with the same hue — the bubble gets a soft mix into
 * the elevated surface for legibility, the label uses the saturated
 * colour for the typographic accent. CSS seam: `--user-bubble-base`
 * + `[data-user-bubble-color="X"]` rules in `theme.css`.
 */
export type UserBubbleColor =
  | 'system'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'orange'
  | 'green'
  | 'red'
  | 'yellow'
  | 'graphite'
export type PromptSurfaceStyle = 'theme' | 'solid' | 'liquid_glass' | 'classic'
export type ComposerStyle =
  | 'default'
  | 'codex'
  | 'claude'
  /** Cursor: VISUAL-ONLY shell. Copies the Gemini composer layout but
   * strips all chroma + glass — flat neutral GRAY, theme-immune.
   * NOT the ProviderId 'cursor' (the runtime); a chat's shell is
   * independent of its provider, exactly like 'grok' below. */
  | 'cursor'
  /** Grok: visual-only shell. Copies the Gemini composer layout but
   * strips all chroma + glass — strictly monochrome black/white,
   * theme-immune. NOT a provider/runtime. */
  | 'grok'
  | 'gemini'
  | 'kimi'
  /** Modular: every composer element gets its own floating pill,
   * no grouping container. Spacing preserved; chrome inverted. */
  | 'modular'
  /** Terminal: monospace + sharp corners + bracket-style chips +
   * a `>` caret prefix on the textarea. Command-line aesthetic. */
  | 'terminal'
  /** Ticket stub: paper-textured composer with a perforated
   * separator between the controls strip and the textarea bubble.
   * Mirrors TaskWraith's tool-call ticket grouping aesthetic. */
  | 'stub'
  /** Satellite: everything floats; all containers, borders, and
   * fills go invisible. Layout intact, chrome stripped. */
  | 'satellite'
  /**
   * 1.0.5-EW55 — "Obsidian" composer style (renamed from EW54's
   * `rimshine`). Pure black fill, crisp 1px white rim along the
   * top edge, subtle white outer glow, slow rim-shimmer chase
   * animation that travels the perimeter every ~12 seconds, and
   * matching chrome on every detached above-row (Ensemble chip
   * strip, queued-messages, Create-PR row, secondary workspace
   * pill) so the composer reads as a single black-with-white-rim
   * family. Pairs natively with the `obsidian` theme but works
   * on any dark theme via fallback variables. The brief words
   * "charcoal rimshine premium" map to this style.
   */
  | 'obsidian'
  /**
   * 1.0.5-EW61 — "Alabaster" composer style. Polar inverse of
   * `obsidian`. Cream-white fill, crisp 2px charcoal rim,
   * subtle warm-cream outer glow, slow black/charcoal rim-
   * chase animation. Theme-immune subtree (locks light-mode
   * tokens regardless of app theme) — same family of chrome
   * as obsidian, every value mirrored on the luma axis.
   * Pairs natively with the `alabaster` theme.
   */
  | 'alabaster'
// All seven providers below are FIRST-CLASS and permanent. There is no
// experimental/eligibility gate for any of them: Grok and Cursor are accepted
// unconditionally at every trust boundary (validation Sets, IPC, adapter
// registry), exactly like gemini/codex/claude/kimi/ollama. The old per-provider
// eligibility flags and their TASKWRAITH_DISABLE_* / TASKWRAITH_EXPERIMENTAL_*
// kill-switches were removed 2026-06 once Grok + Cursor matured — do NOT
// reintroduce a gate that hides a ProviderId from the accept-sets. (All seven
// are write-capable, gated by approval mode. Per-provider CAPABILITY nuances —
// e.g. Grok using diff-reviewed writes instead of per-tool approval cards, or
// Cursor's read-only plan seat carrying no MCP tools — are enforced elsewhere
// via CLI args / approval posture, never by membership in this union.)
export type ProviderId = 'gemini' | 'codex' | 'claude' | 'kimi' | 'grok' | 'cursor' | 'ollama'
export type ProviderRerouteReason = 'provider-paused' | 'user-failover'
export interface ProviderRunReroute {
  from: ProviderId
  to: ProviderId
  reason: ProviderRerouteReason
  savedAsDefault?: boolean
}
export interface ProviderReroutePlan {
  provider: ProviderId
  selectedModelType?: string
  customModel?: string
  approvalMode?: string
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  codexReasoningEffort?: string | null
  codexServiceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinkingEnabled?: boolean
}
export interface ProviderRunPauseState {
  paused: boolean
  until?: string
  reason?: string
  reroute?: ProviderReroutePlan | null
  updatedAt?: string
}
export type ActiveGoalStatus = 'active' | 'paused' | 'blocked' | 'completed'
export type ActiveGoalMode =
  | 'codex_native'
  | 'claude_native'
  | 'grok_native'
  | 'taskwraith_steered'
  | 'ollama_harness'
export interface ActiveGoal {
  id: string
  objective: string
  status: ActiveGoalStatus
  mode: ActiveGoalMode
  provider: ProviderId
  createdAt: string
  updatedAt: string
  pausedAt?: string
  blockedAt?: string
  blockedReason?: string
  completedAt?: string
  completedSummary?: string
  lastStatusReason?: string
}
export type ChatScope = 'workspace' | 'global'
export type ChatKind = 'single' | 'ensemble'
export type ChatParentRelation = 'subThread' | 'sideChat'
export type SideChatMode = 'ensembleClone' | 'singleProvider' | 'fanOut' | 'guestParticipant'
export type SideChatLifecycleState = 'active' | 'closed' | 'terminated'
export type AgenticServiceId =
  | 'shellCommands'
  | 'fileChanges'
  | 'mcpTools'
  | 'subThreadDelegation'
  // Canvas click/fill — a DEDICATED grant bucket so a session/workspace grant on
  // the generic `mcpTools` service can't silently auto-allow app-mutating canvas
  // interactions (the P1-review exfil concern).
  | 'canvasInteraction'
  // Canvas arbitrary `eval` (RCE in the previewed page). Its OWN service so it is
  // STRICTER than canvasInteraction: signed-elevated — never auto-allowed by any
  // preset, grant, or session-YOLO (every eval is individually human-approved),
  // denied outright under read-only, and non-grantable. See PermissionService
  // (non-grantable), EffectiveRunPermissions (read_only deny), and the YOLO guards.
  | 'canvasEval'
  // Cross-thread retrospection reads (tw_recall_find/read/read_events). A
  // DEDICATED grant bucket — grantable like canvasInteraction, NOT signed-
  // elevated like canvasEval — so a generic `mcpTools` grant can't silently
  // auto-allow reading another thread/workspace's run history, and so the
  // read_only preset can deny it outright.
  | 'crossThreadRead'
  // Media editing (transcode/encode/probe/decode/mix of workspace audio &
  // video). A DEDICATED grant bucket — grantable like canvasInteraction, NOT
  // signed-elevated like canvasEval — so the media tools are gated + audited at
  // shell/file strictness instead of falling through to the generic `mcpTools`
  // service, and so the read_only preset can deny them outright. See
  // MEDIA_EDITING_TOOLS + taskWraithToolAgenticService.
  | 'mediaEditing'
  // Media recording (future mic / camera capture). DEFAULT-DENY everywhere and
  // NON-GRANTABLE — like canvasEval, capture always re-prompts (no preset/grant/
  // YOLO auto-allow) and is denied outright under read-only. SCAFFOLD ONLY: no
  // capture tools classify to it yet; it reserves the grant bucket + posture so
  // the future mic/camera tools land default-closed.
  | 'mediaRecording'
export type OllamaToolControlTier =
  | 'read_only'
  | 'approved_edits'
  | 'approved_shell'
  | 'provider_parity'
export type OllamaRunProfileId =
  | 'local_scout'
  | 'approved_patcher'
  | 'verify_with_shell'
  | 'provider_parity'
  | 'custom'
export type OllamaReasoningLevel = 'low' | 'medium' | 'high'
export type OllamaToolProtocolMode = 'native_first' | 'json_fallback' | 'json_only'
export interface OllamaRunProfile {
  id?: OllamaRunProfileId | string
  label?: string
  tier?: OllamaToolControlTier
  reasoningLevel?: OllamaReasoningLevel
  contextCapTokens?: number
  protocolMode?: OllamaToolProtocolMode
  compactToolSchemas?: boolean
  oneToolAtATime?: boolean
  numPredictTool?: number
  numPredictFinal?: number
  keepAlive?: string
}
export type AgenticServicePolicy = 'ask' | 'workspace' | 'allow' | 'deny'
export type AgenticNetworkPolicy = 'allow' | 'deny'
export type PermissionPresetId =
  | 'read_only'
  | 'plan'
  | 'default'
  | 'workspace_write'
  | 'full_access'
  | 'custom'
export type ChatWorkflowMode = 'normal' | 'plan'
export type CodexSandboxFallbackMode = 'ask_rerun' | 'off'
export type ProductUpdateChannel = 'debug' | 'stable' | 'nightly'
export interface ProductUpdateReleaseNoteInfo {
  version: string
  note: string | null
}
export type ProductUpdateReleaseNotes = string | ProductUpdateReleaseNoteInfo[]
export interface ProductUpdateChangelog {
  version: string
  releaseName?: string
  releaseDate?: string
  releaseNotes?: ProductUpdateReleaseNotes
}
export interface ProductChangelogSnapshot {
  currentVersion: string
  lastSeenChangelogVersion?: string
  pendingUpdateChangelog?: ProductUpdateChangelog
  latestUpdateChangelog?: ProductUpdateChangelog
}
/** Phase M1 — picks which runtime path TaskWraith uses for Gemini runs.
 *
 *   - `'auto'` (default): use the API runtime when an API key /
 *     `GeminiAuthProfile` is configured, otherwise fall back to the CLI
 *     provider. Lets users opt in to the hedge against the upcoming
 *     `gemini` CLI deprecation without losing existing CLI workflows
 *     when no API credentials are set.
 *   - `'always'`: require the API runtime. Fail the run with a
 *     setup-required message if no API credentials are available
 *     instead of silently falling back to the CLI.
 *   - `'never'`: force the CLI provider regardless of API credentials.
 *     Useful for users who want to keep using `gemini login` / OAuth
 *     flows or who need CLI-only features (MCP, ACP) and want to opt
 *     out of the API path entirely.
 *
 * The setting is read by the eventual Step-2 wiring inside
 * `runGeminiProvider`. Step 1 only persists the field — nothing
 * consumes it yet. */
export type GeminiApiRuntimeMode = 'auto' | 'always' | 'never'
export type ProductOperationStatus = 'ok' | 'warning' | 'error' | 'unknown'
export type ExternalPathGrantAccess = 'read' | 'write'
export type ExternalPathGrantDuration = 'thisRun' | 'thisThread' | 'workspace'
export type NativeSubAgentRequestPolicy = 'ask' | 'provider' | 'taskwraith'
export type KeyCommandModifier = 'primary' | 'shift' | 'alt'
export interface KeyCommandBinding {
  key: string
  modifiers: KeyCommandModifier[]
}
export type AgentApprovalAction =
  | 'accept'
  | 'acceptForSession'
  | 'acceptForWorkspace'
  | 'decline'
  | 'cancel'
  | 'useProviderNative'
  | 'useTaskWraithSubthread'
  // Slice 4 of the external-path-redesign arc. When the runtime
  // detector (slice 5) spots a tool call referencing a path outside
  // the workspace, the approval payload uses these actions in place
  // of the generic accept/decline pair. `grantExternalPathRead` /
  // `grantExternalPathEdit` issue a signed grant for the detected
  // path AND resolve the pending approval as if the user accepted;
  // `declineExternalPath` is behaviourally identical to `decline`
  // but signals the renderer to render path-specific copy.
  | 'grantExternalPathRead'
  | 'grantExternalPathEdit'
  | 'declineExternalPath'

export interface ExternalPathGrant {
  id: string
  provider: ProviderId
  workspaceId?: string
  chatId?: string
  path: string
  kind: 'file' | 'directory'
  access: ExternalPathGrantAccess
  duration: ExternalPathGrantDuration
  securityScopedBookmark?: string
  issuedBy?: 'main'
  signature?: string
  createdAt: string
  /**
   * 1.0.6-EW66 — Display order for the additional-workspace list
   * in the composer workspace manager. Order is per-PATH, not
   * per-grant: an ensemble chat creates one grant per enabled
   * participant-provider, and all grants sharing a `path` carry
   * the same `order`. Optional + excluded from the HMAC signing
   * payload (`externalGrantSigningPayload`), so it can be mutated
   * renderer-side without invalidating the grant signature.
   * Coalescing self-heals missing values from `createdAt` order
   * on load — see `coalesceExternalPathGrants`.
   */
  order?: number
}

export interface AgenticServicesSettings {
  shellCommands: AgenticServicePolicy
  fileChanges: AgenticServicePolicy
  mcpTools: AgenticServicePolicy
  subThreadDelegation: AgenticServicePolicy
  canvasInteraction: AgenticServicePolicy
  canvasEval: AgenticServicePolicy
  // Optional for back-compat with settings persisted before cross-thread recall;
  // defaults to 'ask' via servicesFromSettings + the sanitizer. Grantable.
  crossThreadRead?: AgenticServicePolicy
  // Optional for back-compat with settings persisted before the media-editing
  // service; defaults to 'ask' via servicesFromSettings + the sanitizer. Grantable.
  mediaEditing?: AgenticServicePolicy
  // Optional for back-compat. Defaults to 'deny' via servicesFromSettings + the
  // sanitizer (default-closed). Non-grantable scaffold for future mic/camera capture.
  mediaRecording?: AgenticServicePolicy
  networkAccess: AgenticNetworkPolicy
}

export interface AgenticWorkspaceGrant {
  id: string
  workspacePath: string
  provider: ProviderId
  service: AgenticServiceId
  createdAt: string
  updatedAt: string
  expiresAt?: string
  expiresOn?: 'workspace_revocation'
}

export interface PermissionPreset {
  id: PermissionPresetId
  label: string
  approvalMode: string
  agenticServices?: Partial<Record<AgenticServiceId, AgenticServicePolicy>>
  networkAccess?: AgenticNetworkPolicy
}

export interface PermissionOverrides {
  approvalMode?: string
  agenticServices?: Partial<Record<AgenticServiceId, AgenticServicePolicy>>
  networkAccess?: AgenticNetworkPolicy
  externalPathGrants?: ExternalPathGrant[]
}

export interface EffectiveRunPermissions {
  presetId: PermissionPresetId
  approvalMode: string
  agenticServices: Record<AgenticServiceId, AgenticServicePolicy>
  networkAccess: AgenticNetworkPolicy
  externalPathGrants: ExternalPathGrant[]
  workspaceGrantServiceIds: AgenticServiceId[]
  readOnly: boolean
}

export interface RunPermissionPostureSnapshot {
  schemaVersion: 1
  approvalMode?: string
  workflowMode?: ChatWorkflowMode
  presetId?: PermissionPresetId
  readOnly?: boolean
  agenticServices?: Record<AgenticServiceId, AgenticServicePolicy>
  networkAccess?: AgenticNetworkPolicy
  externalPathGrantCount: number
  externalPathGrantHash?: string
  workspaceGrantServiceIds?: AgenticServiceId[]
  postureHash: string
  signature?: string
  signaturePresent: boolean
  context?: {
    provider?: string
    scope?: string
    appRunId?: string
    appChatId?: string
    workflowMode?: string
    runtimeProfileId?: string
    promptHash?: string
  }
}

export type EnsembleParticipantStatus =
  | 'idle'
  | 'running'
  | 'answered'
  | 'yielded'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  /**
   * 1.0.5-Phase-N — participant voluntarily paused via
   * `schedule_wakeup`. This is Ensemble state only; RunManager
   * still treats provider processes as running / exited.
   */
  | 'sleeping'
  /**
   * 1.0.4-AD — pre-flight health check ran at round start and the
   * participant's runtime / socket / binary couldn't be verified.
   * Distinct from `failed` (which fires after dispatch starts and the
   * provider returned an error) so the chip strip can render a
   * "never reached" affordance and the user knows to re-launch the
   * underlying provider before the next round.
   */
  | 'unreachable'

export type EnsembleOrchestrationMode = 'turn_bound' | 'continuous'

export type EnsembleFanoutPolicy =
  | 'off'
  | 'read_only'
  | 'locked_writers_with_boss'
  | 'locked_writers_user_preflight'

/**
 * Staged fan-out (docs/ensemble-posture-fanout-preamble-design.md, spike 4) —
 * optional per-participant dispatch stage:
 *
 *   - 'scout'    — read-only investigator; joins the round-start parallel
 *                  read pass exactly like an unstaged read-only participant.
 *   - 'worker'   — always takes a serial turn, even when its permissions
 *                  would qualify it for the round-start read pass.
 *   - 'reviewer' — deferred until every non-reviewer in the round has spoken
 *                  (or been dropped), then runs: as a parallel read-only
 *                  "review wave" when ≥2 eligible reviewers remain, serially
 *                  otherwise. Explicit routing (ensemble_yield / @-mention)
 *                  outranks the deferral.
 *
 * Absent ⇒ pre-stage behavior (fan-out eligibility inferred purely from
 * permissions), so existing chats, presets, and iOS rosters are untouched.
 */
export type EnsembleStageRole = 'scout' | 'worker' | 'reviewer'

export interface EnsembleParticipant {
  id: string
  provider: ProviderId
  enabled: boolean
  role: string
  instructions: string
  order: number
  model?: string
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  /** Ollama-only per-participant tool tier; falls back to chat/global defaults when absent. */
  ollamaToolControlTier?: OllamaToolControlTier
  /** Ollama-only per-participant runtime profile; falls back to chat/global defaults when absent. */
  ollamaRunProfile?: OllamaRunProfileId
  permissionPresetId?: PermissionPresetId
  permissionOverrides?: PermissionOverrides
  /** See EnsembleStageRole — absent means pre-stage dispatch behavior. */
  stageRole?: EnsembleStageRole
  linkedProviderSessionId?: string | null
  /**
   * Host-side SEAT compaction (src/shared/contextCompaction.ts) — the stored
   * session summary for cursor/kimi participants (no native compaction lever).
   * Cursor seats bloat because every round re-embeds the tagged transcript
   * into the seat's native session: compaction stores this summary AND clears
   * `linkedProviderSessionId` above (fresh seat session next round). Kimi
   * seats keep their token (injection-bounded) — the summary is durable
   * memory of rounds that fell off the tagged-transcript budget.
   * EnsemblePrompt injects it above the tagged transcript and drops messages
   * at/before `coversThroughTimestamp` from that seat's transcript window.
   */
  contextCompactionSummary?: {
    text: string
    createdAt: string
    provider: ProviderId
    preTokens?: number
    coversThroughTimestamp?: string
  }
  /**
   * Spike 5 (slim resumed-turn prompts) — the ensemble prompt-shell stamp
   * (`computeEnsemblePromptShellStamp`) this seat last received a FULL
   * prompt for. When the stamp still matches at dispatch time AND the
   * provider session resumes natively, the turn prompt may be slimmed to
   * the dynamic parts only (gated by TASKWRAITH_ENSEMBLE_SLIM_RESUME).
   * The stamp hashes the roster identity, so any roster change falls back
   * to a full prompt automatically. Persisted alongside
   * linkedProviderSessionId in the orchestrator's flushRun.
   */
  promptShellVersion?: string
  /**
   * Slice D — per-participant reasoning + speed + thinking settings.
   * All optional; orchestrator dispatch falls back to provider
   * defaults when absent so existing ensemble chats remain valid.
   *
   *   reasoningEffort  Codex: 'minimal' | 'low'/'light' | 'medium' | 'high' | 'xhigh'
   *                    Claude: 'off' | 'low' | 'medium' | 'high'
   *   fastModeEnabled  Codex (serviceTier=fast) + Claude (claudeFastMode)
   *   thinkingEnabled  Kimi only — toggles K2 thinking mode
   *   serviceTier      Reserved for explicit Codex tier overrides if
   *                    we ever expose more than the fast toggle.
   */
  reasoningEffort?: string
  fastModeEnabled?: boolean
  thinkingEnabled?: boolean
  serviceTier?: string
  /**
   * Agent-Pool link / stats-attribution key. When a participant was sourced
   * from a Settings → Roster "pooled Agent" (`pooled-agent-<uuid>`), this
   * carries that stable agentId so (a) Agent edits propagate back to linked
   * roster-preset participants and (b) the per-Agent stats ledger can attribute
   * this run's work to the right Agent. Absent for default-seeded participants
   * and any chat that predates the pool feature — those are simply never
   * attributed, which is correct. MUST be a `pooled-agent-` prefixed id (see
   * `isPooledAgentId`); a per-chat participant id is never written here.
   */
  pooledAgentId?: string
  /**
   * Frozen display identity for a pooled Agent at the moment it was materialized
   * into a roster/chat. Main cannot read the renderer-local Agent pool, so this
   * compact snapshot is the durable bridge used for transcript labels, icons,
   * and remote projections.
   */
  pooledAgentIdentity?: PooledAgentIdentitySnapshot
  tokenTotals?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
    duration_ms?: number
  }
}

export type PooledAgentIconKind = 'named' | 'seed' | 'asset'

export interface PooledAgentIdentitySnapshot {
  schemaVersion: 1
  agentId: string
  nickname: string
  iconKind: PooledAgentIconKind
  hue: number
  accent?: string
  slug?: string
  assetKey?: string
  seed?: string
  /** When false, render the icon monochrome (ignore accent). Absent ⇒ tinted. */
  hueEnabled?: boolean
}

export interface EnsembleRoundParticipantState {
  participantId: string
  provider: ProviderId
  role: string
  order: number
  status: EnsembleParticipantStatus
  runId?: string
  reason?: string
  startedAt?: string
  endedAt?: string
  /**
   * 1.0.4-AD — last observed failure reason for this participant, set
   * by the pre-flight `probeParticipant` check or by a failed dispatch.
   * Surfaced in the chip strip tooltip so the user can see *why* the
   * participant was marked unreachable without diving into the
   * transcript notes.
   */
  lastFailureReason?: string
}

/**
 * 1.0.5-C1 — Concurrent lane lifecycle. Same set of terminal
 * states as `EnsembleParticipantStatus`, but scoped to a single
 * dispatch attempt rather than the participant's overall round
 * state. A participant can have multiple lifetime lanes within a
 * round (e.g. cancelled + retried) — the lane id is the stable
 * key, the participant id groups them.
 *
 * `awaiting-approval` is a concurrent-specific status: an
 * approval gate is open against this lane and the dispatch is
 * paused until the user resolves it (or another lane's approval
 * cascade unblocks it).
 *
 * `blocked` means a write-intent conflict surfaced from the
 * per-workspace registry (1.0.5-C2): another lane already holds
 * a write lock on a resource this lane wants to write to.
 */
export type ConcurrentLaneStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'awaiting-approval'

/**
 * 1.0.5-C1 — Concurrent lane intent. `none` means the lane is
 * purely conversational (no tool calls planned). `read` means it
 * intends to read but not modify. `write` means it intends to
 * mutate filesystem / external state. The registry uses this to
 * decide whether to grant or block a write-intent acquisition;
 * `read` lanes never block each other.
 *
 * The intent is a hint, not a contract — the actual approvals +
 * write-intent registry enforce the underlying safety.
 */
export type ConcurrentLaneIntent = 'none' | 'read' | 'write'

export type ConcurrentLaneWriteScopeKind = 'path' | 'glob' | 'workspace'

export type ConcurrentLaneWriteScopeApprover = 'boss' | 'user-preflight'

/**
 * Approved mutation envelope for a concurrent writer lane. The lane may still
 * hit the runtime write-intent registry, but it cannot ask for a lock outside
 * this declared scope.
 */
export interface ConcurrentLaneWriteScope {
  kind: ConcurrentLaneWriteScopeKind
  /** Workspace-relative or absolute path/glob. Omitted only for workspace scope. */
  path?: string
  reason?: string
  approvedBy: ConcurrentLaneWriteScopeApprover
  approvedAt: string
}

/**
 * 1.0.5-C1 — Concurrent Ensemble lane record. Bookkeeping seam
 * for multi-writer execution. Persisted on
 * `EnsembleRoundState.lanes` keyed by `laneId`. Serial dispatch
 * paths NEVER populate this — they keep using
 * `activeParticipantId` + `participants[].status` as the source
 * of truth. Concurrent dispatch (gated behind
 * `TASKWRAITH_CONCURRENT_LANES`) populates a lane per dispatched
 * participant.
 */
export interface ConcurrentLane {
  /** Stable lane id (`lane-${roundId}-${participantId}-${attempt}`). */
  laneId: string
  participantId: string
  runId?: string
  provider: ProviderId
  status: ConcurrentLaneStatus
  /** Hint of what this lane plans to do; informs write-intent acquisition. */
  intent: ConcurrentLaneIntent
  /** Required for write-intent lanes before any workspace mutation is allowed. */
  approvedWriteScopes?: ConcurrentLaneWriteScope[]
  startedAt: string
  endedAt?: string
  /** Provider-side session id, when the adapter supports session resume. */
  providerSessionId?: string | null
  /** Count of approvals open against this lane. Bumped when an approval
   * registers, decremented on resolve/timeout/cancel. UI uses this to
   * show "(N pending)" on the lane chip. */
  approvalsQueued?: number
  /** When the user (or another orchestrator path) requested cancel.
   * The lane stays in its current status until the underlying adapter
   * confirms the cancel; then it transitions to `'cancelled'`. */
  cancellationRequestedAt?: string
  /** Last failure or block reason, surfaced in tooltips. */
  reason?: string
}

export interface EnsembleRoundState {
  roundId: string
  status: 'running' | 'completed' | 'cancelled' | 'failed'
  prompt: string
  startedAt: string
  endedAt?: string
  activeParticipantId?: string
  orchestrationMode?: EnsembleOrchestrationMode
  continuationHops?: number
  maxContinuationHops?: number
  /** Boss captured at round start. Event-bound control commands must
   * resolve against this id rather than mutable role/provider labels. */
  bossmanParticipantId?: string
  /** Backup Boss captured at round start. This participant remains
   * standby authority unless the primary Boss is unavailable. */
  secondInCommandParticipantId?: string
  /** Participant ids present at the start of the round. Used to detect
   * replacement/addition commands that would exceed the round baseline. */
  bossmanBaselineParticipantIds?: string[]
  bossmanBaselineParticipantCount?: number
  /**
   * 1.0.5-C1 — Concurrent-mode lane records, keyed by `laneId`.
   * Only populated when the round dispatched in concurrent mode
   * (`concurrentMode === true` AND the
   * `TASKWRAITH_CONCURRENT_LANES` env flag is on). Serial dispatch
   * leaves this undefined; readers should treat
   * `participants[].status` as authoritative when `lanes` is
   * absent or empty.
   */
  lanes?: Record<string, ConcurrentLane>
  /**
   * 1.0.5-C1 — Round-level concurrent-mode flag. When `true` the
   * orchestrator dispatches all eligible participants in parallel
   * lanes; serial-write-conflict pauses fire as the
   * write-intent registry detects collisions. Default `undefined`
   * (treated as serial) so existing rounds keep their behaviour.
   *
   * Refused when the env gate is off — the orchestrator's
   * `startRound` rejects with a structured error rather than
   * silently falling back to serial.
   */
  concurrentMode?: boolean
  /**
   * Explicit fan-out policy captured at round start. Undefined is legacy
   * serial/read-from-config behavior; `concurrentMode` remains for persisted
   * round back-compat.
   */
  fanoutPolicy?: EnsembleFanoutPolicy
  /**
   * Legacy single-prompt queue (1.0.3 ship). Kept for back-compat
   * with persisted round records — the orchestrator's new path uses
   * `queuedPrompts` (array) to accumulate multiple queued sends.
   * Reads in the renderer should prefer `queuedPrompts` and fall
   * back to this field only when migrating an older record.
   */
  queuedPrompt?: string
  /**
   * Multi-entry queue of prompts to dispatch as fresh rounds once
   * the current round finishes (or on Steer). Each entry becomes a
   * new round, processed in order. Defaults to an empty array so
   * existing code that checks length doesn't need null guards.
   */
  queuedPrompts?: string[]
  sleepingParticipantIds?: string[]
  pendingWakeupIds?: string[]
  participants: EnsembleRoundParticipantState[]
}

export type SessionActivityChangedBy = 'user' | 'orchestrator' | 'system'
export type SessionActivityScope = 'session' | 'round' | 'participant'

export interface SessionActivityLedgerEntry {
  id: string
  timestamp: string
  changedBy: SessionActivityChangedBy
  scope: SessionActivityScope
  target?: string
  oldValue?: string | null
  newValue?: string | null
  reason?: string
}

export interface EnsembleRunIdentity {
  roundId: string
  participantId: string
  laneId?: string
  provider: ProviderId
  role: string
  order: number
  /** Configured shared-history char budget captured for this participant run. */
  ensembleContextChars?: number
  /** Configured shared-history turn budget captured for this participant run. */
  ensembleContextTurns?: number
}

/**
 * 1.0.4-AR13 — explicit round-mode model.
 *
 * Orthogonal to `EnsembleOrchestrationMode` (turn_bound /
 * continuous) which describes whether participants can hand
 * work back and forth. `EnsembleRoundMode` describes the
 * STRUCTURE of a single round:
 *
 *   - `targeted`       — only the named participant speaks
 *                        (overlaps with the existing
 *                        `dmTargetParticipantId` DM path; this is
 *                        the explicit name for it).
 *   - `roundtable`     — every enabled participant speaks once,
 *                        no special structure. Default.
 *   - `chair-summary`  — the synthesizer participant (AT8) goes
 *                        LAST and is explicitly told to
 *                        summarise the prior turns.
 *   - `rebuttal`       — each participant responds to a
 *                        designated peer's last contribution
 *                        rather than starting from the user's
 *                        original prompt.
 *
 * Undefined reads as `'roundtable'` (the pre-AR13 default).
 */
export type EnsembleRoundMode = 'targeted' | 'roundtable' | 'chair-summary' | 'rebuttal'

export interface EnsembleRoundSummaryRecord {
  roundId: string
  participantId: string
  provider: ProviderId
  role?: string
  runId?: string
  summary: string
  capturedAt: string
}

export type EnsembleWakeupStatus = 'pending' | 'fired' | 'cancelled' | 'expired'

export interface EnsembleWakeupRecord {
  wakeupId: string
  chatId: string
  roundId: string
  participantId: string
  provider: ProviderId
  role?: string
  runId?: string
  scheduledAt: string
  wakeAt: string
  status: EnsembleWakeupStatus
  reason?: string
  cancelOnUserInput?: boolean
  firedAt?: string
  cancelledAt?: string
  expiredAt?: string
  message?: string
}

/**
 * 1.0.5-EW37 — Solo-chat wakeup record. Mirrors `EnsembleWakeupRecord`
 * minus the ensemble-specific routing fields (`roundId`,
 * `participantId`, `role`). Persisted on `ChatRecord.soloWakeups`
 * so it survives app restart via the same recovery flow as the
 * ensemble path.
 *
 * Reuses `EnsembleWakeupStatus` — same lifecycle of
 * `pending → fired/cancelled/expired`.
 */
export interface SoloChatWakeupRecord {
  wakeupId: string
  chatId: string
  provider: ProviderId
  /** Optional — the solo run that scheduled the wakeup. Used by the
   * fire handler to seed the continuation run's prompt with the
   * original reason and (where possible) reuse the provider session
   * via `chat.linkedProviderSessionId`. */
  runId?: string
  scheduledAt: string
  wakeAt: string
  status: EnsembleWakeupStatus
  reason?: string
  cancelOnUserInput?: boolean
  /** Permission posture captured from the run that scheduled the
   * wakeup. Replayed into the continuation run so a constrained
   * agent cannot resume later with broader defaults. */
  resumePermissions?: {
    approvalMode?: string
    sessionTrust?: boolean
    externalPathGrants?: ExternalPathGrant[]
    effectivePermissions?: EffectiveRunPermissions
  }
  firedAt?: string
  cancelledAt?: string
  expiredAt?: string
}

/** M4 — TTL scope for a blackboard entry.
 * - `round`   : visible only during the round that wrote it (pruned next round)
 * - `session` : persists across rounds while the ensemble session is live
 * - `chat`    : persists for the lifetime of the chat */
export type BlackboardScope = 'round' | 'session' | 'chat'

/** M4 — category buckets, mirroring the synthesizer's round-summary shape so a
 * round summary can be auto-derived into blackboard entries. */
export type BlackboardCategory = 'decision' | 'fact' | 'risk' | 'do-not-repeat' | 'note'

/** M4 — a single entry in the cross-participant shared scratchpad. Participants
 * read a compact digest of in-scope entries in their prompt (so shared context
 * doesn't mean dumping full transcript memory) and can post new entries via the
 * `blackboard_post` MCP tool. See src/main/blackboard/Blackboard.ts. */
export interface BlackboardEntry {
  id: string
  chatId: string
  /** Round in which the entry was written (drives `round`-scope pruning). */
  roundId: string
  /** Author participant id, or 'synthesizer' / 'system' for derived entries. */
  participantId: string
  /** Short stable handle for the note (used for de-dupe/upsert per author). */
  key: string
  value: string
  category: BlackboardCategory
  scope: BlackboardScope
  /** Provenance — a tool-call id or a prior entry id this was derived from. */
  derivedFrom?: string
  createdAt: string
}

/** M5 — what a complexity-escalation signal is flagging.
 * - `stuck`                    : round completed but no participant produced an answer
 * - `looping`                  : round exhausted its handoff budget without returning to the user
 * - `disagreement-unresolved`  : multiple answers, no synthesizer to reconcile them
 * - `tool-error-cluster`       : a cluster of participants failed / were unreachable */
export type ComplexityEscalationKind =
  | 'stuck'
  | 'looping'
  | 'disagreement-unresolved'
  | 'tool-error-cluster'

/** M5 — the orchestrator's *recommended* response. Advisory only: the
 * orchestrator NEVER auto-acts on a signal — the renderer surfaces these as
 * chips and the user (or a future policy gate) decides. */
export type ComplexityEscalationAction = 'extend-rounds' | 'call-synthesizer' | 'pause-for-user'

/** M5 — a single complexity-escalation signal emitted at round end by the
 * heuristic in src/main/escalation/ComplexityEscalation.ts. Persisted on
 * `EnsembleConfig.escalationSignals` and broadcast to the renderer via the
 * existing `chat-updated` channel. */
export interface ComplexityEscalationSignal {
  id: string
  chatId: string
  roundId: string
  kind: ComplexityEscalationKind
  /** Human-readable explanation of why the signal fired. */
  evidence: string
  recommendedAction: ComplexityEscalationAction
  createdAt: string
}

export interface EnsembleConfig {
  enabled: boolean
  maxParticipants: number
  orchestrationMode?: EnsembleOrchestrationMode
  /**
   * Legacy boolean preference for concurrent fan-out. New code should prefer
   * `fanoutPolicy`; persisted `true` maps to `read_only` so older chats never
   * surprise-upgrade into writer parallelism.
   */
  concurrentModeEnabled?: boolean
  /**
   * Per-chat fan-out policy. `read_only` runs read-only participants in
   * parallel before serial writers; writer policies require either Boss-scoped
   * explicit `ensemble_fanout` scopes or host-owned no-Boss preflight.
   */
  fanoutPolicy?: EnsembleFanoutPolicy
  /** 1.0.4-AR13 — see `EnsembleRoundMode` for semantics. Undefined
   * reads as `'roundtable'` so all pre-AR13 chats keep their
   * existing structure. */
  roundMode?: EnsembleRoundMode
  maxContinuationHops?: number
  /**
   * Per-ensemble shared-transcript char budget (5K–500K), set via the Turn
   * picker. Drives how much recent panel history each participant prompt carries
   * (buildTaggedTranscript). Undefined falls back to the default cap.
   */
  ensembleContextChars?: number
  participants: EnsembleParticipant[]
  /** Optional user-designated Ensemble manager. No Boss is assigned by
   * default; controls are rejected unless the active run belongs to this id. */
  bossmanParticipantId?: string
  /** Optional user-designated Captain. This seat uses Boss-like
   * controls only when the primary Boss is missing, disabled, unreachable,
   * or failed for the active round. */
  secondInCommandParticipantId?: string
  /** Opt-in auto-approval preference. The current runtime only records and
   * surfaces this explicit consent; approval execution remains constrained by
   * the permission ledger/policy layer. */
  bossmanAutoApprovals?: {
    enabled: boolean
    mode: 'permission_preset_once'
    confirmedAt: string
  }
  bossmanControlState?: {
    completedRoundCount?: number
    lastReorderAtCompletedRound?: number
  }
  sessionActivityLedger?: SessionActivityLedgerEntry[]
  activeRound?: EnsembleRoundState
  updatedAt?: string
  /**
   * 1.0.4-AF — opt-in "self-reflective" mode. When true, the ensemble
   * prompt's deictic-resolution rule (1.0.4-Q) is inverted so
   * "this app / this repo" refers to TaskWraith itself rather than the
   * active workspace. Used by the `/discuss` slash command for
   * meta-conversations about the harness.
   */
  selfReflective?: boolean
  /**
   * 1.0.4-AK — supervised multi-round autonomy mode. When present
   * AND `status === 'active'`, the orchestrator queues follow-up
   * rounds via `ensemble_continue` (the MCP control tool) instead
   * of returning to the user after each round. See
   * `src/main/EnsembleContinue.ts` for the handler and
   * `WorkSessionConfig` for field semantics.
   */
  workSession?: WorkSessionConfig
  /**
   * 1.0.4-AT8 — designated synthesizer/owner participant. When set,
   * the prompt builder appends a structured "summarise this round"
   * instruction to this participant's prompt (decisions / open
   * risks / next action), letting the panel produce a canonical
   * round summary instead of leaving every participant's final
   * paragraph as N parallel takes the user has to reconcile.
   *
   * The orchestrator's end-of-round hook captures the synthesizer's
   * final text into `lastRoundSummary` once the round is complete.
   * Subsequent rounds' participant prompts read
   * `lastRoundSummary` (when non-empty) and prepend it as a
   * "Prior round summary:" block so corrections propagate.
   *
   * Undefined = no synthesizer (pre-AT8 behavior; each participant
   * speaks for themselves).
   */
  synthesizerParticipantId?: string
  /**
   * 1.0.4-AT8 — canonical summary of the most recent completed
   * round. Set by the orchestrator (follow-up) when the
   * synthesizer participant emits their structured summary. Read
   * by subsequent rounds' prompt builders. Cleared by `Steer`
   * (intentional reset) and `Stop` (round cancelled).
   */
  lastRoundSummary?: string
  /**
   * 1.0.5-AT8 — per-round summary history keyed by round id. This
   * backs historical round cards and future long-running checkpoint
   * views while `lastRoundSummary` remains the prompt-facing latest
   * summary.
   */
  roundSummaries?: Record<string, EnsembleRoundSummaryRecord>
  /**
   * 1.0.5-Phase-N — persisted pending/fired/cancelled wakeups for
   * Ensemble participants. These records are the source of truth for
   * restart recovery; timers are only in-memory accelerators.
   */
  wakeups?: Record<string, EnsembleWakeupRecord>
  /**
   * M4 (1.0.7) — cross-participant shared scratchpad. Entries are
   * auto-derived from each round's synthesizer summary (decisions /
   * corrections / open risks / next action) and surfaced to every
   * participant's prompt next round as a compact digest, so shared
   * context propagates without dumping full transcript memory. TTL-
   * pruned per round/session/chat. See src/main/blackboard/Blackboard.ts.
   */
  blackboard?: BlackboardEntry[]
  /**
   * M5 (1.0.7) — complexity-escalation signals emitted by the orchestrator
   * heuristic at round end (stuck / looping / disagreement-unresolved /
   * tool-error-cluster). Events ONLY — the orchestrator never auto-acts on
   * them; the renderer surfaces them as advisory chips with a recommended
   * action. Capped to the most recent few. See
   * src/main/escalation/ComplexityEscalation.ts.
   */
  escalationSignals?: ComplexityEscalationSignal[]
}

/**
 * 1.0.4-AK — supervised multi-round autonomy ("Work Session") mode.
 * The user defines an objective + acceptance criteria + safety
 * budget; participants drive themselves through rounds via the
 * `ensemble_continue` MCP control tool until acceptance is reported,
 * a hard-stop trips, or the user clicks Stop.
 *
 * Critically, Work Session does NOT bypass `EffectiveRunPermissions`
 * — the `permissionPresetId` here is fed INTO the existing per-run
 * permission resolution (see `EnsembleOrchestrator.ts`'s
 * `resolveParticipantPermissions`) rather than replacing it. Every
 * mutation still goes through the same approval gate it would in
 * an interactive serial session.
 */
export type WorkSessionStatus =
  /** No active session — the field may exist but ignored. */
  | 'idle'
  /** Session running, rounds may auto-queue via `ensemble_continue`. */
  | 'active'
  /** Blocked on user (a participant called `ask_user_question` or
   * `ensemble_continue(acceptanceStatus: 'blocked')`). Resume button
   * re-arms the session once the user has answered. */
  | 'paused'
  /** Acceptance criteria reported met by `ensemble_continue`. */
  | 'completed'
  /** User clicked Stop. */
  | 'cancelled'
  /** Round / duration / token budget exhausted. The transcript
   * status row distinguishes which budget hit (see `endedReason`). */
  | 'limit_reached'

export interface WorkSessionConfig {
  /** Whether this session field is meaningful. Lets us persist
   * a "last config" without it counting as an active session. */
  enabled: boolean
  status: WorkSessionStatus
  objective: string
  acceptanceCriteria: string
  /** Subset of ensemble participants allowed to act in the session.
   * `null` means "all currently-enabled participants". Participants
   * not in the list are skipped from rotation. */
  allowedParticipantIds: string[] | null
  /** Designated lead — gets the first speaker slot of every round.
   * Optional; absent = roster-order. */
  leadParticipantId?: string
  /** Captured from the Ensemble Boss when a Work Session starts. When set,
   * only this participant may advance or complete the autonomous loop. */
  managerParticipantId?: string
  /** Id of the chat's active Goal at the moment this Work Session was started,
   * if any. When the Boss marks the session complete and this still matches
   * the chat's current `activeGoal`, that goal is completed too. Unrelated
   * goals (id mismatch, or none) are left untouched. */
  linkedActiveGoalId?: string
  /** Permission preset clamped over each participant for the
   * duration of the session. Fed into the existing
   * `resolveEffectiveRunPermissions` pipeline so workspace grants +
   * overrides still apply. Never bypasses approval gates. */
  permissionPresetId: PermissionPresetId
  /** Hard-stop budgets. */
  maxRoundsPerProvider: number
  maxDurationMs: number
  maxTokenBudget?: number
  /** Parallel fan-out opt-in (legacy field name: Scout Pass, 1.0.4-AK5/AK6).
   * When false the
   * session stays pure-serial regardless of participant count. */
  enableScoutPass: boolean
  startedAt?: string
  endedAt?: string
  /** Human-readable reason captured at terminal-status transition
   * (e.g. "Round budget reached for codex (38/38)"). */
  endedReason?: string
  /** Rolling counters surfaced in the session strip + used for
   * `limit_reached` checks. Initialised to zero per-provider when
   * the session starts. */
  roundsUsed: Record<ProviderId, number>
  /** Sum of `roundsUsed[*]`. Cached so the UI doesn't re-sum on
   * every render. */
  totalRoundsUsed: number
  /** No-progress guard state. Tracks the last successfully-queued
   * continuation's author + a signature of its (nextPrompt, summary)
   * and how many times that EXACT continuation has been queued
   * consecutively by that author. Lets `ensemble_continue` stop a
   * participant looping on a verbatim continuation long before the
   * coarse per-provider round budget would (maxRoundsPerProvider can
   * be up to 38). Absent until the first continuation is queued. */
  lastContinuation?: {
    participantId: string
    signature: string
    repeatCount: number
  }
}

/**
 * 1.0.4-AE — typed shape for the `provider_auth_status` MCP tool,
 * split out of the legacy single-string `appServer` field into
 * orthogonal concerns the panel review flagged as conflated:
 *   - `serverState`: lifecycle. `'error'` is reserved for helpers
 *     that crashed mid-run; `'unavailable'` for "not reachable at
 *     all"; `'started'` / `'lazy'` cover the codex hot/cold path.
 *   - `transport`: wire protocol. The `'pty'` and `'http'` arms are
 *     reserved for adapters in flight (cf. the Kimi wire / Gemini
 *     API transport ramps) so MCP consumers don't need a schema
 *     bump when they land.
 *   - `approvalSupport`: capability — does this provider's adapter
 *     route approvals through TaskWraith's main-authority gate?
 *   - `mcpStatusSupport`: capability — can the adapter answer
 *     MCP status probes (Codex via app-server, the others not yet).
 *   - `authState`: actionable state, not the previous vague
 *     `'unknown'` catch-all. `'expired'` is reserved for credentials
 *     we proactively detect as past TTL (vs `'missing'` for never-set).
 *
 * `appServer` and `accountStatus` are preserved as deprecated
 * aliases for the 1.0.4 → 1.0.5 transition window and are removed
 * after 1.0.5. MCP consumers should migrate to
 * `serverState` / `transport` (replaces `appServer`) and
 * `authState` / `authReason` (replaces `accountStatus`).
 */
export type ProviderAuthServerState = 'started' | 'lazy' | 'error' | 'unavailable'
export type ProviderAuthTransport = 'sdk' | 'cli' | 'app-server' | 'pty' | 'http' | 'unavailable'
export type ProviderAuthState =
  | 'authenticated'
  | 'not-queried'
  | 'not-observable'
  | 'missing'
  | 'expired'

export interface ProviderAuthStatusV2 {
  provider: ProviderId
  serverState: ProviderAuthServerState
  transport: ProviderAuthTransport
  approvalSupport: boolean
  mcpStatusSupport: boolean
  authState: ProviderAuthState
  /** Optional human-readable reason — populated for `missing` /
   * `not-observable` / `not-queried` / `expired` states where context
   * helps the agent decide what to do next (re-auth, surface to user,
   * etc.). */
  authReason?: string
  /** @deprecated 1.0.4 → 1.0.5 alias for the legacy single-string
   * `appServer` field. Use `serverState` and `transport` instead.
   * Removed after 1.0.5. */
  appServer?: string
  /** @deprecated 1.0.4 → 1.0.5 alias for the legacy `accountStatus`
   * field. Use `authState` and `authReason` instead. Removed after
   * 1.0.5. */
  accountStatus?: string
}

export interface GeminiMcpBridgeStatus {
  checkedAt: string
  enabled: boolean
  installed: boolean
  available: boolean
  serverName: 'TaskWraith'
  command?: string[]
  socketPath?: string
  message?: string
  raw?: string
  error?: string
}

export type ProviderCapabilityState =
  | 'available'
  | 'gated'
  | 'blocked'
  | 'delegated'
  | 'unavailable'
export type ProviderCapabilityWarningSeverity = 'info' | 'warning' | 'error'
export type ProviderToolingCapabilityId =
  // canvasInteraction / canvasEval / crossThreadRead / mediaEditing /
  // mediaRecording are approval-grant buckets, not provider-capability contract
  // rows — excluded like subThreadDelegation. (The media tools are already
  // advertised under the MCP/tool surface; they don't get their own contract row.)
  | Exclude<
      AgenticServiceId,
      | 'subThreadDelegation'
      | 'canvasInteraction'
      | 'canvasEval'
      | 'crossThreadRead'
      | 'mediaEditing'
      | 'mediaRecording'
    >
  | 'creativeApps'
  | 'networkAccess'
  | 'elicit'
  | 'delegate'

export interface ProviderCapabilityWarning {
  id: string
  severity: ProviderCapabilityWarningSeverity
  title: string
  message: string
}

export interface ProviderToolingCapability {
  id: ProviderToolingCapabilityId
  label: string
  state: ProviderCapabilityState
  source: 'taskwraith' | 'provider' | 'bridge' | 'settings'
  enforcedByTaskWraith?: boolean
  enforcement?: 'taskwraith' | 'provider' | 'bridge' | 'settings' | 'best_effort' | 'none'
  policy?: AgenticServicePolicy | AgenticNetworkPolicy
  requiresApproval: boolean
  tools: string[]
  details?: string
}

export interface ProviderApprovalCapability {
  requestedMode: string
  effectiveMode: string
  providerMode: string
  inAppApprovals: boolean
  supportsWorkspaceGrants: boolean
  notes: string[]
}

export interface ProviderMcpCapability {
  state: ProviderCapabilityState
  // 'provider-managed': the provider resolves its own tools and TaskWraith does
  // not expose a structured bridge. 'taskwraith web bridge' and 'unsupported'
  // are retained for back-compat fixtures but no longer produced for active
  // Cursor/Grok capability contracts.
  source:
    | 'taskwraith'
    | 'provider'
    | 'bridge'
    | 'unsupported'
    | 'provider-managed'
    | 'taskwraith web bridge'
  available: boolean
  enabled?: boolean
  installed?: boolean
  serverName?: string
  tools: string[]
  message?: string
}

export interface ProviderAvailabilityCapability {
  available: boolean
  setupRequired?: boolean
  binaryPath?: string | null
  binarySource?: string
  version?: string
  authState?: string
  appServer?: string
  error?: string
}

export interface ProviderCapabilityContract {
  provider: ProviderId
  label: string
  refreshedAt: string
  workspacePath?: string
  availability: ProviderAvailabilityCapability
  tools: Record<ProviderToolingCapabilityId, ProviderToolingCapability>
  approvals: ProviderApprovalCapability
  mcp: ProviderMcpCapability
  warnings: ProviderCapabilityWarning[]
}

export type ProviderAdapterTransport =
  | 'gemini-cli'
  | 'codex-app-server'
  | 'claude-sdk-or-cli'
  | 'kimi-wire-or-cli'
  | 'grok-cli'
  | 'cursor-cli'
  | 'ollama-http'

export type ProviderAdapterRunChannel = 'run-agent'

export interface ProviderAdapterFeatureFlags {
  persistentSessions: boolean
  appManagedApprovals: boolean
  workspaceGrants: boolean
  agentBenchMcpBridge: boolean
  providerManagedMcp: boolean
  nativeThreadTools: boolean
  hostCommandFallback: boolean
}

export interface ProviderAdapterCapabilityCaveat {
  id: string
  severity: 'info' | 'warning'
  capability: 'taskwraithMcpBridge' | 'providerMcp' | 'approvalModes'
  title: string
  message: string
}

/** Static per-provider capability declarations.
 *
 * `features` (above) describes INFRASTRUCTURE characteristics —
 * whether the adapter uses TaskWraith's MCP bridge, has persistent
 * sessions, etc. `ProviderAdapterCapabilities` describes USER-FACING
 * UX capabilities — what the iOS composer / desktop renderer should
 * render for this provider.
 *
 * Examples of how UI consumes these:
 *   - `reasoningEffort: false` → hide the reasoning-effort picker
 *   - `imageAttachments: false` → disable the paperclip button
 *   - `approvalModes: ['default']` → hide the "plan mode" toggle
 *   - `speedTiers: []` → no speed-tier picker at all
 *
 * iOS UI subscribes to a provider's capabilities snapshot (sent during
 * pair init, refreshed on capability changes) and renders accordingly.
 * Desktop renderer can do the same via the existing
 * `get-provider-adapters` IPC.
 *
 * Future additions: thinking-mode flags, tool-call-batch support,
 * worktree variants — extend cautiously, since iOS clients tolerate
 * unknown fields but new required fields would break older clients. */
export interface ProviderAdapterCapabilities {
  /** Approval modes the provider's runtime accepts. iOS composer
   * filters this against `RemoteWorkspaceEntry.allowedApprovalModes`
   * to produce the final picker contents. */
  approvalModes: Array<'default' | 'plan' | 'allow-all'>
  /** Whether the run payload's `reasoningEffort` field has any effect
   * for this provider. Codex / Claude honor it; Gemini / Kimi
   * currently don't. */
  reasoningEffort: boolean
  /** Provider-specific speed tier identifiers. Empty array → no
   * speed-tier picker. */
  speedTiers: string[]
  /** Whether `imagePaths` in the run payload are forwarded to the
   * provider. iOS composer's image-picker is gated by this. */
  imageAttachments: boolean
  /** Whether the prompt-composition layer's context-turn injection
   * applies. When false, the composer's contextTurns slider has no
   * effect — UI hides it. */
  contextInjection: boolean
  /** Whether `providerSessionId` in the run payload resumes a prior
   * session (vs the provider creating a fresh session every turn). */
  sessionResumption: boolean
  /** Whether the provider supports per-thread MCP server scoping
   * (Gemini-style). When false, MCP servers are workspace-wide. */
  perThreadMcp: boolean
  /** Granularity of assistant text updates delivered to TaskWraith UI. */
  assistantTextStreaming: 'token' | 'turn' | 'none'
}

export interface ProviderAdapterDescriptor {
  provider: ProviderId
  label: string
  transport: ProviderAdapterTransport
  runChannel: ProviderAdapterRunChannel
  capabilitySource: 'taskwraith' | 'provider' | 'bridge' | 'mixed'
  features: ProviderAdapterFeatureFlags
  capabilities: ProviderAdapterCapabilities
  capabilityCaveats?: ProviderAdapterCapabilityCaveat[]
}

export type RuntimeWorkspaceMode = 'local' | 'worktree' | 'container'
export type RuntimeNetworkPolicy = 'inherit' | 'allow' | 'deny'
export type RuntimePersistence = 'reusable' | 'ephemeral'

export interface RuntimeProfile {
  id: string
  name: string
  provider: ProviderId
  scope: ChatScope
  workspaceMode: RuntimeWorkspaceMode
  binaryPath?: string
  env: Record<string, string>
  mcpProfileId?: string
  approvalMode?: string
  agenticServices?: AgenticServicesSettings
  networkPolicy: RuntimeNetworkPolicy
  persistence: RuntimePersistence
  containerConfig?: {
    image?: string
    workdir?: string
    mounts?: Array<{ source: string; target: string; access: 'read' | 'write' }>
  }
  builtin?: boolean
  createdAt: string
  updatedAt: string
}

export type UserMcpServerTransport = 'stdio' | 'http' | 'sse'

export interface UserMcpServerConfig {
  id: string
  name: string
  enabled: boolean
  transport: UserMcpServerTransport
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  bearerTokenEnvVar?: string
  description?: string
  pluginProvenance?: TaskWraithPluginResourceProvenance
  createdAt?: string
  updatedAt?: string
}

export interface HandoffCard {
  id: string
  status: 'draft' | 'dispatched' | 'archived'
  sourceChatId: string
  sourceRunId?: string
  sourceProvider: ProviderId
  workspaceId?: string
  workspacePath?: string
  summary: string
  selectedFiles: string[]
  workspaceChangeSetIds: string[]
  rawEventRunIds: string[]
  recommendedProvider?: ProviderId
  recommendedModel?: string
  recommendedApprovalMode?: string
  targetChatId?: string
  dispatchedRunId?: string
  finalPrompt: string
  createdAt: string
  updatedAt: string
  dispatchedAt?: string
}

export interface HandoffCardFilter {
  sourceChatId?: string
  sourceRunId?: string
  status?: HandoffCard['status']
}

export type FunFxMode = 'off' | 'subtle' | 'cinematic' | 'epic'

export interface AdvancedFxSettings {
  agentAura: boolean
  livingWorkspace: boolean
  dataViz: boolean
  /** Refractive "liquid glass" material on popovers/surfaces; respects Reduce Transparency. */
  refraction: boolean
  intensity: Exclude<FunFxMode, 'off'>
}

export interface ProviderApiKeyStatus {
  available: boolean
  authState: string
  apiKeyConfigured: boolean
  encryptionAvailable: boolean
  version?: string
  binaryPath?: string | null
}

export type GeminiAuthProfileKind = 'api-key' | 'vertex-ai' | 'google-oauth'

export interface GeminiAuthProfile {
  id: string
  label: string
  kind: GeminiAuthProfileKind
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
  encryptedApiKey?: string
  vertexProject?: string
  vertexLocation?: string
}

export type GeminiOAuthLoginStatusValue = 'idle' | 'running' | 'success' | 'error' | 'cancelled'

export interface GeminiOAuthLoginStatus {
  profileId: string
  status: GeminiOAuthLoginStatusValue
  startedAt?: string
  finishedAt?: string
  message?: string
  authUrl?: string
  exitCode?: number | null
}

export interface GeminiAuthProfileSummary {
  id: string
  label: string
  kind: GeminiAuthProfileKind
  configured: boolean
  isDefault: boolean
  authState: string
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
  vertexProject?: string
  vertexLocation?: string
  oauthEmail?: string
  oauthConfigured?: boolean
  oauthLogin?: GeminiOAuthLoginStatus
}

export interface GeminiAuthStatus extends ProviderApiKeyStatus {
  activeProfileId?: string | null
  activeProfileLabel?: string
  profiles: GeminiAuthProfileSummary[]
  oauthLogin?: GeminiOAuthLoginStatus
}

export interface AppSettings {
  activeProvider?: ProviderId
  providerRunPauses?: Partial<Record<ProviderId, ProviderRunPauseState>>
  /** When true, a run that dies on a provider quota wall (429) is auto-paused
   * and re-dispatched to a healthy provider. Default off. */
  autoFailoverEnabled?: boolean
  /** Escape hatch for the per-occurrence mid-run budget kill. The per-workflow
   * WorkflowLimits ARE the opt-in (hasAnyBudget guards registration); this global
   * flag only lets a user disable the enforcement entirely. Default TRUE (a run
   * that sets a budget expects it enforced). Registration requires
   * `workflowBudgetKillEnabled !== false && hasAnyBudget(limits)`. */
  workflowBudgetKillEnabled?: boolean
  /**
   * Stage 0b-dispatch — when TRUE (default) a SOLO scheduled task that comes due
   * while the app is WINDOWLESS (window closed but process alive) is composed +
   * dispatched by MAIN instead of waiting for a renderer to receive the
   * 'scheduled-task-due' broadcast. Set false to revert to renderer-only dispatch
   * (a windowless app then defers its solo runs until a window opens; the task
   * stays 'due' and is retried each scheduler tick). Ensemble occurrences are
   * never headless-dispatched regardless (they run through runEnsembleRound). */
  headlessScheduledDispatchEnabled?: boolean
  windowBounds?: {
    x?: number
    y?: number
    width: number
    height: number
    isMaximized?: boolean
  }
  /** Display name used to greet the user in New General Chat. Optional;
   * blank/whitespace is treated as "no name" and omitted from the greeting. */
  userName?: string
  claudeBinaryPath?: string
  claudeApiKey?: string
  kimiBinaryPath?: string
  kimiApiKey?: string
  ollamaBaseUrl?: string
  ollamaDefaultModel?: string
  ollamaToolControlTier?: OllamaToolControlTier
  ollamaDefaultRunProfile?: OllamaRunProfileId
  ollamaRunProfiles?: Record<string, OllamaRunProfile>
  /** Per-model timestamps (ms) for the one-shot honest capability preflight. */
  ollamaModelPreflightAt?: Record<string, number>
  ollamaProviderParityAcknowledgedAt?: string
  ollamaProviderParityWorkspaceGrants?: Record<string, string>
  defaultGeminiAuthProfileId?: string | null
  geminiAuthProfiles?: GeminiAuthProfile[]
  /** Phase M1 — Gemini API runtime selection. See {@link GeminiApiRuntimeMode}
   * for the per-mode semantics. Defaults to `'auto'`: use the API path
   * when an API key is configured, else CLI. `'always'` requires API;
   * `'never'` forces CLI. Step 1 persists this field but does not yet
   * consume it — wiring lands in Phase M1 Step 2. */
  geminiApiRuntime?: GeminiApiRuntimeMode
  userMcpServers?: UserMcpServerConfig[]
  codexUsageCredential?: {
    encryptedAccessToken?: string
    accountId?: string
    importedAt?: string
    source?: string
    encryptionAvailable?: boolean
  }
  storeLocalChatHistory: boolean
  storeRawEvents: boolean
  storePromptResponseInUsage: boolean
  ensembleModeEnabled: boolean
  geminiCheckpointingEnabled: boolean
  chatContextTurns: number
  appearanceMode: AppearanceMode
  visualEffectStyle: VisualEffectStyle
  themeAppearance: ThemeAppearance
  themeCornerStyle: ThemeCornerStyle
  themeAccentStyle: ThemeAccentStyle
  toolIconAccent: ToolIconAccent
  userBubbleColor: UserBubbleColor
  /** Selected app-icon variant; Dock/taskbar swap on desktop. See src/shared/iconVariants.ts. */
  appIconVariant: AppIconVariant
  promptSurfaceStyle: PromptSurfaceStyle
  composerStyle: ComposerStyle
  transcriptFontFamily?: string
  composerFontFamily?: string
  keyCommandBindings?: Record<string, KeyCommandBinding | null>
  /** 1.0.5-EW25 — Display currency for cost / token-spend chips.
   * The underlying USD value comes verbatim from provider event
   * payloads (`cost_usd`); the renderer converts to the user's
   * chosen display currency via `src/renderer/src/lib/formatCost.ts`.
   * Rates are static approximations (no live FX lookup yet — that's
   * deferred to 1.0.6 sub-slice c). USD is the default. */
  currency: 'USD' | 'GBP' | 'EUR'
  /** 1.0.5-EW34 — Currency sub-slice (e): conservative-overestimate
   * mode. When non-zero, cost displays are multiplied by
   * `1 + (percent / 100)` BEFORE FX conversion, so a `$0.10` actual
   * cost renders as `$0.11` with a 10% safety bias. Useful for
   * users who want their displayed cost to over-shoot the real bill
   * (so a session that "looks like" $5 has actually spent under
   * that). Clamped to 0–25 at the slider UI; we also clamp
   * defensively in `formatCost` so a stored value outside the
   * range can't break rendering. Default 0 (no bias). Optional
   * field so older settings files / test fixtures don't need to
   * round-trip a value they never set. */
  currencyOverestimatePercent?: number
  /** Settings → General toggle for the desktop/iOS Task Complete / Final Summary
   * cards. Defaults to true; optional so older settings files keep showing the
   * card until the user explicitly disables it. */
  showRunCompleteSummary?: boolean
  /** Settings → General toggle for host auto-compaction: when a Cursor/Kimi
   * solo chat crosses ~90% context after a turn, the host dispatches a
   * summarize turn and compacts the session automatically (Claude/Codex
   * self-compact natively and are unaffected). Defaults to true; the
   * summarize turn is a real, visible provider run. */
  hostAutoCompactEnabled?: boolean
  /** Settings → General toggle: collapse older Ensemble rounds into
   * expandable round cards in the transcript (the most recent / active
   * round stays expanded). Defaults to true; optional so older settings
   * files default to the collapsed-card behaviour. Set false to restore
   * the flat per-message transcript. */
  ensembleCollapseOlderRounds?: boolean
  /**
   * Sidebar Model Usage card view toggle. `'plan'` (default) shows the
   * PLAN-subsidised quota meters; `'spend'` shows per-provider API/SDK
   * spend (projected from the per-model rate table, in the display
   * currency) over rolling Day / 7-day / 30-day windows. Persisted as a
   * lightweight UI pref so the chosen view survives reload. Optional so
   * older settings files / fixtures default to the quota view.
   */
  modelUsagePanelView?: 'plan' | 'spend' | 'context'
  /**
   * Settings → Model usage table "External Usage" toggle. When `true`, the
   * per-provider / per-model usage table folds in provider activity tracked
   * OUTSIDE TaskWraith (the same dataset behind the External Activity
   * heatmap) so the user sees provider-WIDE usage; when `false`/unset it
   * shows only TaskWraith's own runs. Persisted as a lightweight UI pref so
   * the chosen scope survives reload. Optional so older settings files /
   * fixtures default to TaskWraith-only.
   */
  modelUsageExternalUsage?: boolean
  /**
   * 1.0.5-EW49 — Dashboard statistics preferences. Two slots:
   *   - `visibility` (per-stat boolean map): hide a chip to
   *     remove it from the dense grid without losing the
   *     underlying data. Re-enable any time. Default: every
   *     stat visible (`undefined` entry resolves to `true`).
   *   - `resetAt` (single epoch-ms timestamp): user clicked
   *     "Reset all dashboard stats" — every stat that supports
   *     reset filters its input records by
   *     `record.timestamp >= resetAt`. Default: `0` / undefined
   *     means "no reset, include all history".
   * The shared key set is enumerated in
   * `src/renderer/src/lib/dashboardStatRegistry.ts` so the
   * Settings UI + dashboard renderer + builder stay in sync.
   * Per-stat reset (one button per stat) is deferred to EW49b
   * because the builder threading would touch every stat
   * computation invasively.
   */
  dashboardStatPrefs?: {
    visibility?: Record<string, boolean>
    resetAt?: number
    /**
     * 1.0.5-EW51 — Workspaces tab on/off. Default: visible. The
     * tab itself filters the dashboard tab strip; the underlying
     * data is still computed so toggling it back on doesn't
     * re-cost anything.
     */
    workspacesTabEnabled?: boolean
    /**
     * 1.0.5-EW51 — Max number of workspace cards shown in the
     * scrollable list at the top of the Workspaces tab. The full
     * sorted list is always computed; the renderer slices to
     * this count. Default 8; clamped 4–20 at the slider UI.
     */
    workspacesShown?: number
    /**
     * 1.0.5-EW52 — Providers tab visibility (default true).
     * When false, the Providers tab hides from the dashboard
     * tab strip and the auto-cycle skips it. The underlying
     * data is still computed — toggling back doesn't re-cost.
     */
    providersTabEnabled?: boolean
    /**
     * 1.0.5-EW52 — Auto-cycle the dashboard tabs in a loop
     * every N seconds while the welcome screen is mounted.
     * Default 180 (3 minutes). 0 / undefined disables the
     * cycle. Range 30–3600 enforced by the slider UI.
     */
    autoCycleSeconds?: number
    /**
     * 1.0.72 — Show/hide the entire welcome Statistics dashboard card.
     * Default true (visible). When false the card is hidden even when there
     * is activity to show; the standalone heatmaps are unaffected.
     */
    dashboardEnabled?: boolean
    /**
     * Welcome dashboard display size. Small is the default compact welcome
     * treatment; large preserves the full-size layout.
     */
    dashboardSize?: 'large' | 'small'
  }
  /**
   * Welcome-screen standalone heatmap visibility. All three heatmaps
   * default to visible; a stored `false` hides only that heatmap.
   */
  welcomeHeatmapPrefs?: {
    workspaceActivityEnabled?: boolean
    taskwraithActivityEnabled?: boolean
    externalActivityEnabled?: boolean
    /**
     * 1.0.72 — Layout for the welcome standalone heatmaps:
     *   - 'stacked': every enabled heatmap stacked vertically
     *     (the long-standing layout).
     *   - 'single' (default): one heatmap at a time, auto-cycling every 90s through
     *     the enabled heatmaps (mirrors the dashboard tab auto-cycle).
     */
    layout?: 'single' | 'stacked'
  }
  /** 1.0.5-EW26 — Kimi (Moonshot) compatibility filter toggle.
   * When true, prompts dispatched to a Kimi participant are
   * scanned by `src/main/lib/kimiSanitiser.ts` and any sentence
   * containing a configured trigger keyword (default list +
   * `kimiSanitiserCustomKeywords`) is replaced with a redacted
   * placeholder before the Kimi process spawns. Other
   * participants always see the unfiltered prompt. Default `true`
   * so Moonshot compatibility retries are available out of the box. */
  kimiSanitiserEnabled: boolean
  /** 1.0.5-EW26 — Newline-separated extra trigger keywords the
   * user wants the Kimi compatibility filter to catch on top of
   * the curated defaults. Lines starting with `#` are treated as
   * comments and skipped. Empty string = use defaults only. */
  kimiSanitiserCustomKeywords: string
  /** 1.0.7-M10 — Opt-in second-pass Kimi classifier redaction.
   * When enabled, a Kimi content-filter retry can escalate beyond
   * literal EW26 keyword matches to a deterministic sentence
   * classifier. Missing/false keeps the retry envelope keyword-only. */
  kimiClassifierEnabled?: boolean
  funFxEnabled: boolean
  funFxMode: FunFxMode
  advancedFx: AdvancedFxSettings
  reduceTransparency: boolean
  reduceMotion: boolean
  compactDensity: boolean
  /** Cursor-style live activity viewport. When enabled (default), streaming
   * thinking + tool activity renders inside a fixed-height, edge-masked,
   * auto-following region during an in-flight turn, collapsing to the compact
   * tool summary once activity settles. */
  liveActivityViewport: boolean
  showInspector: boolean
  inspectorWidth: number
  sidebarWidth: number
  sidebarOpacity: number
  mainPaneOpacity: number
  sidebarOpacityOverride?: boolean
  mainPaneOpacityOverride?: boolean
  agenticServices: AgenticServicesSettings
  agenticWorkspaceGrants: AgenticWorkspaceGrant[]
  /** User preference for provider-native sub-agent tools (`Task`,
   * `invoke_agent`, etc.) versus TaskWraith durable sub-threads. When
   * unset, the runtime asks on the first observable native request. */
  nativeSubAgentRequests?: NativeSubAgentRequestPolicy
  /** When true (default), an agent's parent chat is automatically
   * "nudged" with a synthetic continuation prompt after a sub-thread
   * the agent delegated to (with `returnResultToParent: true`) finishes
   * and its final assistant message has been back-propagated to the
   * parent transcript. Without this, the back-propagated result just
   * sits in the parent transcript until the user manually types
   * something — the agent has no event to wake up on. See
   * `src/main/AutoResumeParent.ts` for the gating logic and
   * `maybePropagateSubThreadResult` in `src/main/index.ts` for the
   * dispatch site. */
  autoResumeParentOnSubThreadCompletion: boolean
  geminiMcpBridgeEnabled: boolean
  geminiMcpBridgeLastStatus?: GeminiMcpBridgeStatus
  /**
   * Permission-mode ELEVATION warning acknowledgements. Keyed by
   * `${workspacePath}|${provider}` (see `approvalElevationAckKey` in
   * `src/renderer/src/lib/approvalElevation.ts`); a `true` value means the
   * Tier-1 "raise to Default Approval" notice has been confirmed once for that
   * (workspace, provider) and should not be shown again. Tier-2 (Full Workspace
   * Access) is never suppressed and never recorded here. Optional so older
   * settings files round-trip without the field.
   */
  approvalModeElevationAcknowledgements?: Record<string, boolean>
  bridgeDaemonEnabled?: boolean
  /** iOS remote bridge (relay + E2EE transport). Settings-first so
   * login-item/GUI launches work without shell env; IOS_REMOTE_TRUE
   * keeps env-override semantics (1/true force-on, 0/false force-off)
   * via resolveDaemonShouldRun. */
  iosRemoteEnabled?: boolean
  /** External relay URL (ws:// or wss://). Empty = embedded relay. */
  iosRemoteRelayUrl?: string
  /** Optional user-specified relay door advertised alongside the automatic LAN /
   * Tailscale candidates. Accepts a host/IP or ws(s):// URL; normalized at use. */
  iosRemoteManualRelayUrl?: string
  /** Local Servers — run agent shell commands in their own process group so the
   * Local Servers panel can group-kill the whole tree on Stop. Off by default. */
  localServersDetachSpawns?: boolean
  /** Local Servers — stop agent-spawned servers still running when TaskWraith
   * quits. Off by default. */
  localServersStopOnQuit?: boolean
  codexSandboxFallback: CodexSandboxFallbackMode
  /** Settings -> General "Enable Auto-Update". Defaults on; when false,
   * the updater service stays disabled even on stable/nightly channels. */
  autoUpdateEnabled?: boolean
  updateChannel: ProductUpdateChannel
  lastSeenChangelogVersion?: string
  pendingUpdateChangelog?: ProductUpdateChangelog
  /** Per-provider + main-authority approval timeout policy (Phase E1.1).
   * When an approval enters the pending registry, a timer fires after
   * the matching ms value and auto-denies the request. `enabled: false`
   * disables the entire scheduler (same effect as
   * `TASKWRAITH_APPROVAL_TIMEOUT_OFF=1`). */
  approvalTimeouts: {
    enabled: boolean
    perProviderMs: {
      gemini: number
      codex: number
      claude: number
      kimi: number
    }
    mainAuthorityMs: number
  }
  /** Phase E1 (iOS bridge gap #1) — APNs production credentials for
   * wake-on-approval push delivery to paired iOS devices. The .p8
   * auth-key content is encrypted via Electron `safeStorage` before
   * persistence; everything else is plain strings. When all four
   * credential fields are populated AND the encrypted key decrypts,
   * `createBridgeApnsPusher` returns a real `Http2ApnsPusher` instead
   * of the default no-op. */
  apnsConfig?: {
    /** base64 ciphertext of the .p8 PEM bytes, encrypted via
     * `safeStorage.encryptString`. Set to undefined when cleared. */
    encryptedAuthKey?: string
    /** Apple Developer "Key ID" (10 chars, from Keys > APNs). */
    keyId?: string
    /** Apple Developer "Team ID" (10 chars, from Membership). */
    teamId?: string
    /** iOS companion app bundle id. Defaults to a placeholder value.
     * Configure it locally when Remote/iOS work is enabled. */
    bundleId?: string
    /** ISO timestamp of the most recent successful save. */
    configuredAt?: string
    /** Snapshot of the most recent test-push round-trip so the
     * Settings UI can show "delivered 1/1" or "failed: reason" without
     * keeping the result in renderer state. */
    lastTestResult?: {
      at: string
      delivered: number
      failed: number
      error?: string
    }
    /** Caches `safeStorage.isEncryptionAvailable()` at save-time so the
     * UI can warn if the user previously saved a key on a Mac with
     * encryption but is now reading on one without (e.g. fresh login). */
    encryptionAvailable?: boolean
  }
  /** Image generation (text->image via a paid API). OFF by default — the
   * image_generate MCP tool refuses unless `enabled` is true AND a key for the
   * chosen provider is configured. Keys are safeStorage-encrypted base64
   * ciphertext, NEVER stored or passed in plaintext/argv. */
  imageGeneration?: {
    enabled?: boolean
    /** Default provider when the tool call doesn't specify one. */
    provider?: 'openai' | 'xai'
    /** safeStorage-encrypted (base64) API keys, per provider. */
    encryptedKeys?: {
      openai?: string
      xai?: string
    }
  }
  /** Audit orchestration policy (durable, set once in Settings). The user's
   * standing contribution to the four-actor model — the resolver enforces
   * eligibility within this envelope and the agent assigns roles within the
   * resolved set. See src/main/audit/ProviderCapabilityResolver.ts. */
  auditOrchestration?: AuditOrchestrationSettings
  /** QR-optional multi-host discovery (Slice 5d) — Tailscale OAuth client
   * credentials so an ALREADY-PAIRED host can enumerate the tailnet on a
   * phone's behalf ("connected host is the oracle"). The secret NEVER reaches
   * the phone: it lives here, host-side only, encrypted via `safeStorage`. Read
   * back for use via `loadTailscaleOAuthCredentials`; written only by the
   * dedicated `ios-remote-tailscale-oauth-set` IPC (kept OUT of
   * SETTINGS_PATCH_KEYS so the renderer can't overwrite it through the generic
   * patch path). devices:core:read is the only scope it needs. */
  tailscaleOAuth?: {
    /** Tailscale OAuth client id (not secret; shown back in Settings). */
    clientId?: string
    /** base64 ciphertext of the tskey-client-… secret, encrypted via
     * `safeStorage.encryptString`. Undefined when cleared. */
    encryptedClientSecret?: string
    /** ISO timestamp of the most recent successful save. */
    configuredAt?: string
    /** Caches `safeStorage.isEncryptionAvailable()` at save-time so the UI can
     * warn if the secret was saved on a Mac with encryption but is now being
     * read on one without it. */
    encryptionAvailable?: boolean
  }
}

export type ProductCrashSource =
  | 'main'
  | 'renderer'
  | 'child_process'
  | 'provider'
  | 'bridge'
  | 'startup'
  | 'unknown'

export interface ProductCrashRecord {
  schemaVersion: 1
  id: string
  source: ProductCrashSource
  severity: 'warning' | 'error' | 'fatal'
  occurredAt: string
  appVersion: string
  platform: string
  arch: string
  processType?: string
  reason?: string
  exitCode?: number | null
  name?: string
  message: string
  stack?: string
  metadata?: Record<string, unknown>
}

export type ProductCrashInput = Omit<
  ProductCrashRecord,
  'schemaVersion' | 'id' | 'occurredAt' | 'appVersion' | 'platform' | 'arch'
> &
  Partial<Pick<ProductCrashRecord, 'id' | 'occurredAt' | 'appVersion' | 'platform' | 'arch'>>

export interface ProductCrashFilter {
  source?: ProductCrashSource
  severity?: ProductCrashRecord['severity']
  since?: string
  limit?: number
}

export interface ProductHealthCheck {
  id: string
  label: string
  status: ProductOperationStatus
  message: string
  repairAction?: 'install_gemini_bridge' | 'create_user_data_dir' | 'none'
  checkedAt: string
}

export interface ProductBridgeHealthRecord {
  provider: ProviderId
  bridgeId: string
  label: string
  status: ProductOperationStatus
  checkedAt: string
  enabled: boolean
  installed: boolean
  available: boolean
  message: string
  rawStatus?: GeminiMcpBridgeStatus
}

export interface ProductInstallRepairStatus {
  checkedAt: string
  status: ProductOperationStatus
  appPath: string
  userDataPath: string
  checks: ProductHealthCheck[]
}

export type ProductUpdateArtifactArch = 'universal' | 'arm64' | 'x64' | 'unknown'
export type ProductMacUpdateArtifactArch = ProductUpdateArtifactArch

export interface ProductArchitectureCompatibilityStatus {
  checkedAt: string
  status: ProductOperationStatus
  hostPlatform: string
  hostArch: string
  updateArtifactName?: string
  updateArtifactArch: ProductUpdateArtifactArch
  updateCompatible: boolean
  reason?: string
  message: string
}

export interface ProductReleaseAutomationStatus {
  checkedAt: string
  status: ProductOperationStatus
  updateChannel: ProductUpdateChannel
  appId?: string
  productName?: string
  outputDirectory?: string
  scripts: {
    build?: string
    test?: string
    ci?: string
    buildUnpack?: string
    buildMac?: string
    buildMacNotarized?: string
    buildDebugMac?: string
    buildDebugMacNotarized?: string
    buildWin?: string
    buildWinUnpack?: string
    buildWinSigned?: string
    buildDebugWin?: string
    smokeNodePty?: string
    smokePackage?: string
    validateRelease?: string
    validateMacUpdateFeed?: string
    validateWinUpdateFeed?: string
  }
  nativeModules: {
    configured: boolean
    validationScript?: string
    message: string
  }
  updateDistribution: {
    configured: boolean
    provider?: string
    owner?: string
    repo?: string
    url?: string
    message: string
  }
  notarization: {
    configured: boolean
    keychainProfile?: string
    scriptName?: string
    message: string
  }
  signing: {
    configured: boolean
    identity?: string
    message: string
  }
  architectureCompatibility?: ProductArchitectureCompatibilityStatus
  releaseSteps: string[]
}

export interface ProductOperationsStatus {
  generatedAt: string
  updateChannel: ProductUpdateChannel
  overallStatus: ProductOperationStatus
  app: {
    name: string
    version: string
    isPackaged: boolean
    appPath: string
    userDataPath: string
  }
  system: {
    platform: string
    arch: string
    osRelease: string
  }
  bridgeHealth: ProductBridgeHealthRecord[]
  installRepair: ProductInstallRepairStatus
  releaseAutomation: ProductReleaseAutomationStatus
  recentCrashes: ProductCrashRecord[]
  counts: {
    workspaces: number
    chats: number
    queuedRuns: number
    activeRuns: number
    interruptedRuns: number
    approvalLedgerRecords: number
    workspaceChangeSets: number
    scheduledTasks: number
    workflows?: number
    runtimeProfiles?: number
    handoffCards?: number
  }
}

export interface ProductDiagnosticsSnapshot {
  schemaVersion: 1
  generatedAt: string
  status: ProductOperationsStatus
  settings: {
    activeProvider?: ProviderId
    updateChannel: ProductUpdateChannel
    storeLocalChatHistory: boolean
    storeRawEvents: boolean
    agenticServices: AgenticServicesSettings
    geminiMcpBridgeEnabled: boolean
    codexSandboxFallback: CodexSandboxFallbackMode
  }
  workspaces: Array<
    Pick<WorkspaceRecord, 'id' | 'path' | 'displayName' | 'lastOpenedAt' | 'pinned'>
  >
  runQueue: RunQueueJob[]
  runRecovery: RunRecoveryRecord[]
  scheduledTasks: ScheduledTask[]
  workflows: WorkflowDefinition[]
  approvalLedger: ApprovalLedgerRecord[]
  workspaceChanges: WorkspaceChangeSet[]
  recentCrashes: ProductCrashRecord[]
}

export interface ProductDiagnosticsExportResult {
  ok: boolean
  path?: string
  snapshot?: ProductDiagnosticsSnapshot
  error?: string
}

export interface GeminiWorktreeConfig {
  enabled: boolean
  name?: string
  effectivePath?: string
}

export type GeminiWorktreeLaunchOption = GeminiWorktreeConfig | string | boolean | null | undefined

export interface WorkspaceRecord {
  id: string
  path: string
  displayName: string
  lastOpenedAt: number
  createdAt: number
  isGitRepo?: boolean
  branch?: string
  remoteOriginUrl?: string
  geminiWorktree?: GeminiWorktreeConfig
  pinned: boolean
  lastActiveChatId?: string
  notes?: string
}

export type TranscriptMediaSource = 'generated' | 'workspace_path' | 'upload' | 'tool_result'
// Widened for the native AV pipeline (S0a). Additive + backward-compatible: every
// stored ref is 'image', no migration. Consumers that branch on kind fail closed
// (drop unknown kinds) until the later AV slices teach them audio/video — so this
// widening is invisible to existing image behavior. The RAW-provider sanitizer
// (src/shared/transcriptMediaRefSanitize.ts) deliberately STAYS raster-only — AV
// arrives only via the sanitized tool-result lane, never untrusted provider stdout.
export type TranscriptMediaKind = 'image' | 'audio' | 'video'
export type TranscriptMediaFormat = 'raster' | 'svg' | 'container'
export type TranscriptMediaStatus =
  | 'available'
  | 'missing'
  | 'denied'
  | 'unsafe_svg'
  | 'too_large'
  | 'unsupported'

export interface TranscriptMediaThumbnail {
  dataBase64: string
  mimeType: string
  width?: number
  height?: number
}

export interface TranscriptMediaRef {
  id: string
  kind: TranscriptMediaKind
  format: TranscriptMediaFormat
  source: TranscriptMediaSource
  name: string
  alt?: string
  caption?: string
  mimeType: string
  width?: number
  height?: number
  /** Duration in ms — audio/video refs (from ffprobe / VideoToolbox / Core Audio). */
  durationMs?: number
  /** Codec descriptor for AV refs, e.g. "h264,aac" (informational, for the UI/agent). */
  codecs?: string
  /**
   * Compact waveform envelope for AUDIO refs — N integer buckets (target 256,
   * hard-cap 512), each 0–255 = round(maxAbsSampleInBucket * 255). Harvested from
   * the same offscreen Web-Audio analysis pass that paints the poster (no second
   * decode); the renderer canvas-draws a crisp DAW waveform from it (normalize by
   * /255). Optional everywhere — absent for non-audio, oversized-skipped, or older
   * refs (the poster JPEG is the graceful fallback). Kept tiny (≤~700 bytes JSON).
   */
  peaks?: number[]
  byteLength?: number
  sha256?: string
  assetId?: string
  path?: string
  workspaceId?: string
  workspaceRelativePath?: string
  thumbnail?: TranscriptMediaThumbnail
  status?: TranscriptMediaStatus
  /**
   * Optional grouping hint for the renderer: a contiguous run of refs sharing the same
   * `groupKind` is laid out as a unit (e.g. `video_frames` → an NLE filmstrip) instead
   * of separate cards. Purely cosmetic. On the RAW provider lane this is VALUE-RESTRICTED
   * to a known allowlist (see `sanitizeRawProviderMediaRefs`) so a hostile provider can't
   * forge arbitrary grouping.
   */
  groupKind?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'tool' | 'error'
  content: string
  timestamp: string
  runId?: string
  toolActivities?: ToolActivity[]
  /** Phase F2: structured metadata for synthetic messages. The most
   * common case is a sub-thread result-return entry: the parent
   * transcript shows "↩ Result from <Provider>" with the sub-thread's
   * final assistant message inlined as untrusted tool output; metadata lets the renderer
   * detect and treat it differently from a regular tool activity
   * (link back to the sub-thread, distinct visual treatment, etc.). */
  metadata?: {
    kind?: 'subThreadReturn' | 'subThreadDelegation' | 'guestParticipantReply' | string
    /** Sub-thread id for `kind: 'subThreadReturn' | 'subThreadDelegation'`. */
    subThreadId?: string
    /** Sub-thread's provider for badge/icon rendering. */
    subThreadProvider?: ProviderId
    /** Sub-thread title at time of delegation/return for the inline
     * card header (may differ from current title if user renamed). */
    subThreadTitle?: string
    /** Phase I3.2 — parent provider at delegation time, used by the
     * inline delegation card to render the cross-provider arc. */
    parentProvider?: ProviderId
    /** Phase I3.2 — full delegation prompt (kept for click-through). */
    delegationPrompt?: string
    /** Phase I3.2 — truncated delegation prompt (140-240 chars) for the
     * card preview area. */
    delegationPromptPreview?: string
    /** Phase I3.2 — whether the sub-thread is configured to return its
     * result to the parent transcript. */
    returnResultToParent?: boolean
    /** Concurrent Ensemble lane id for lane-aware transcript rows. */
    ensembleLaneId?: string
    /** Agent Pool identity frozen at dispatch/materialization time. */
    pooledAgentId?: string
    pooledAgentIdentity?: PooledAgentIdentitySnapshot
    /** Guest participant child chat id for `kind: 'guestParticipantReply'`. */
    guestChatId?: string
    /** Guest participant provider for inline badge/icon rendering. */
    guestProvider?: ProviderId
    /** Guest participant model at dispatch time. */
    guestModel?: string
    /** Guest participant role label at dispatch time. */
    guestRole?: string
    /** Guest participant run id whose final assistant reply was mirrored. */
    guestRunId?: string
    /** Parent chat id that received the mirrored guest reply. */
    parentChatId?: string
    /** User pin timestamp (ms since epoch). Missing means not pinned. */
    pinnedAt?: number
    /** User thumbs feedback on an ASSISTANT message. This field is the render
     *  state + toggle key only; the durable, attributed (provider/model/role/run)
     *  audit signal is written to the thumbs receipt ledger. `reason`/`note` are
     *  the optional thumbs-down category + free-text (local-only). */
    feedback?: {
      vote: 'up' | 'down'
      at: number
      reason?: string
      note?: string
    }
    /** Plan-mode proposed plan presented for approval (the ProposedPlanCard).
     *  Persisted on the message so the card survives reload + the decision,
     *  and the raw <proposed_plan> block is stripped from `content`. */
    proposedPlan?: {
      title: string
      body: string
      status: 'pending' | 'approved' | 'dismissed'
      artifactPath?: string
    }
    /** Deterministic Evidence Pack check for completion-style final answers. */
    completionClaimSupport?: CompletionClaimSupportAnnotation
    /** Presentation-only link preview targets extracted from user-visible prompt text. */
    linkPreviews?: Array<{ url: string; origin: string; host: string }>
    /** Local filesystem paths of images attached to this message (desktop
     * file-picker or phone upload). Mac-only — remote clients can't read them. */
    imagePaths?: string[]
    /** Small base64 JPEG previews of the attached images, built Mac-side so
     * remote clients (iOS) — which can't read `imagePaths` — can render the
     * actual attachment inline in the transcript. ~256px, size-capped. */
    imageThumbnails?: Array<{
      dataBase64: string
      mimeType: string
      width?: number
      height?: number
    }>
    /** Canonical transcript media artifacts. Unlike legacy image paths, these
     * can represent assistant/tool-generated media and must be produced by the
     * main-process media service after provenance and path validation. */
    mediaRefs?: TranscriptMediaRef[]
    [key: string]: unknown
  }
}

export interface PinnedMessageSummary {
  id: string
  role: ChatMessage['role']
  content: string
  timestamp: string
  runId?: string
  pinnedAt: number
}

export interface PinnedMessageChatGroup {
  chatId: string
  chatTitle: string
  chatKind?: ChatKind
  provider?: ProviderId
  updatedAt: number
  workspaceId?: string
  workspacePath?: string
  workspaceDisplayName: string
  pinnedNotes?: string
  messages: PinnedMessageSummary[]
}

export interface PinnedMessageGroup {
  workspaceId?: string
  workspacePath?: string
  workspaceDisplayName: string
  chats: PinnedMessageChatGroup[]
}

export interface ChatRun {
  runId: string
  provider?: ProviderId
  providerReroute?: ProviderRunReroute
  providerRunId?: string
  providerThreadId?: string
  providerMetadata?: Record<string, unknown>
  startedAt: string
  endedAt?: string
  promptMessageId?: string
  requestedModel?: string
  actualModel?: string
  approvalMode?: string
  workflowMode?: ChatWorkflowMode
  permissionPosture?: RunPermissionPostureSnapshot
  status?: string // RunStatus
  warnings?: RunWarning[]
  exitCode?: number
  cancelled?: boolean
  suppressRunSummary?: boolean
  stats?: any
  geminiWorktree?: GeminiWorktreeConfig
  effectiveWorkspacePath?: string
  diffUnavailableReason?: string
  rawEventsFile?: string
  diffSnapshot?: string
  runDiff?: RunDiffResult
  /**
   * 1.0.6-TV7 — per-WRITE-workspace file-change summaries for this run,
   * keyed by absolute workspace path. Populated at run end from the
   * run's tool-reported diffs (the same source that drives the WRITE
   * workspace rows + the "this run" summary view), so multi-workspace
   * runs are reviewable per workspace in Diff Studio (TV8). `runDiff`
   * stays the authoritative snapshot diff for the PRIMARY workspace;
   * this is additive and best-effort (absent when no WRITE workspace
   * changed). A snapshot-based RunDiffResult per path is a future
   * upgrade gated on main-process external-path snapshot support.
   */
  runDiffByPath?: Record<string, DiffFileSummary[]>
  workspaceChangeSetId?: string
  preSnapshot?: WorkspaceSnapshot
  postSnapshot?: WorkspaceSnapshot
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  handoffSourceRunId?: string
  ensembleRoundId?: string
  ensembleParticipantId?: string
  ensembleLaneId?: string
  ensembleRole?: string
  ensembleOrder?: number
  pooledAgentId?: string
  pooledAgentIdentity?: PooledAgentIdentitySnapshot
  ensembleSleepWakeupId?: string
  ensembleSleepUntil?: string
  ensembleSleepReason?: string
  ensembleSleepResumeWarning?: string
  runAnalyst?: RunAnalystSnapshot
}

export interface RunAnalystSignal {
  label: string
  value: string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
}

export interface RunAnalystRequest {
  runId: string
  provider?: ProviderId
  chatTitle?: string
  status?: string
  startedAt?: string
  endedAt?: string
  promptPreview?: string
  workspacePath?: string
  touchedFiles?: string[]
  warnings?: string[]
  countsByKind?: Partial<Record<RunEventKind, number>>
  timeline?: Array<{
    kind: RunEventKind | string
    summary?: string
    timestamp?: string
  }>
}

export interface RunAnalystSnapshot {
  runId: string
  generatedAt: string
  source: 'local' | 'foundationModels'
  status: 'ready' | 'unavailable' | 'error'
  summary: string
  risks: string[]
  nextSteps: string[]
  signals: RunAnalystSignal[]
  model?: string
  error?: string
}

export interface GuestParticipantConfig {
  childChatId: string
  provider: ProviderId
  selectedModelType: string
  customModel: string
  codexReasoningEffort?: string | null
  codexServiceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinkingEnabled?: boolean
  createdAt: number
  updatedAt: number
  persistent: true
}

export interface ChatRecord {
  appChatId: string
  scope?: ChatScope
  chatKind?: ChatKind
  provider?: ProviderId
  title: string
  workspaceId?: string
  workspacePath?: string
  createdAt: number
  updatedAt: number
  archived: boolean
  /** When true the chat is rendered in the sidebar's "Pinned" section
   * and excluded from "Recents". Default false. Persisted via the
   * existing `save-chat` IPC. */
  pinned?: boolean
  /** Per-thread markdown notes shown above this chat's pinned messages. */
  pinnedNotes?: string
  linkedProviderSessionId?: string
  /**
   * Host-side context compaction (src/shared/contextCompaction.ts) — the
   * stored session summary for providers with no native compaction lever.
   * Cursor: written when the host summarize-and-reset flow completes (the
   * session id above is cleared so the next turn starts fresh and
   * composeRunPrompt injects this block once). Kimi: written without a
   * session reset (its cross-turn context is injection-bounded); the block
   * upgrades the lossy recent-transcript window, and messages at/before
   * `coversThroughTimestamp` drop out of future transcript injection.
   */
  contextCompactionSummary?: {
    text: string
    createdAt: string
    provider: ProviderId
    /** Context occupancy (tokens) of the session when the summary was taken. */
    preTokens?: number
    /** Transcript messages at/before this are covered by `text`. */
    coversThroughTimestamp?: string
  }
  providerMetadata?: Record<string, unknown>
  linkedGeminiSessionId?: string
  activeGoal?: ActiveGoal
  /** Product workflow state. Separate from permissionPreset/approvalMode:
   * `normal` means ordinary chat/recon; `plan` means plan-first UX with an
   * explicit accept/refine/execute transition. Capability enforcement still
   * flows through the existing permission/approval layers. */
  workflowMode?: ChatWorkflowMode
  /** Per-lane agent ToDo / plan checklists — a persisted sibling of activeGoal.
   * Lane key = ensemble participantId, or TODO_SOLO_LANE for solo/guest. Written
   * by the todo_write MCP tool (+ ingested provider-native plans) and broadcast
   * to renderer + iOS via the chat-updated path. */
  chatTodos?: Record<string, TodoItem[]>
  ensemble?: EnsembleConfig
  guestParticipant?: GuestParticipantConfig
  /**
   * 1.0.5-EW37 — Solo-chat wakeup records. Mirror of
   * `ensemble.wakeups` for solo chats: the agent calls
   * `schedule_wakeup`, we persist the record here, and on fire the
   * `SoloChatWakeupService` dispatches a continuation prompt
   * against this chat using its existing
   * `linkedProviderSessionId`. Only populated for chats where
   * `chatKind !== 'ensemble'` (ensemble chats use the path under
   * `ensemble.wakeups`).
   *
   * Keyed by `wakeupId` so the recovery classifier on app boot
   * can iterate across all chats uniformly without caring whether
   * the source was ensemble or solo.
   */
  soloWakeups?: Record<string, SoloChatWakeupRecord>
  requestedModel?: string
  lastActualModel?: string
  messages: ChatMessage[]
  runs: ChatRun[]
  settingsSnapshot?: {
    model: string
    approvalMode: string
    sandboxEnabled: boolean
  }
  /** Phase F1 — linked child chats. Legacy records with `parentChatId`
   * and no `parentChatRelation` are sub-threads. Newer records use the
   * discriminator below so user-opened side chats can stay linked to a
   * source chat without inheriting delegation / result-return semantics.
   *
   * v1 sub-thread constraint: max depth 1. A sub-thread cannot itself spawn a
   * sub-thread (UI affordance disabled when `parentChatId` is set).
   * Future revs can lift this. */
  parentChatId?: string
  parentChatRelation?: ChatParentRelation
  /** User-owned split-view chat metadata. A side chat is context-isolated
   * like a normal chat but keeps a back-pointer to the chat it was opened
   * beside. It must not use `delegationContext`, auto-return, or parent
   * auto-resume. */
  sideChatContext?: {
    createdAt: number
    mode?: SideChatMode
    lifecycleState?: SideChatLifecycleState
    openedAt?: number
    closedAt?: number
    terminatedAt?: number
    terminationReason?: string
    originMessageId?: string
    originRunId?: string
    transcriptVisibility?: 'none' | 'summary' | 'selected' | 'snapshot'
  }
  /** Phase F1 — delegation metadata, present only when `parentChatId`
   * is set for a `parentChatRelation: 'subThread'` record. Records WHY
   * this sub-thread exists so the audit trail + future auto-orchestration
   * can reconstruct intent. */
  /**
   * 1.4.4 — Pruned Ollama transcript memory for session continuity across runs.
   * Stores compressed tool trajectory (calls + summaries), not full file bodies.
   */
  ollamaSessionMemory?: {
    modelId: string
    updatedAt: number
    workingMemory: string
    toolTurnCount: number
    trajectory?: Array<{
      toolName: string
      argsSummary: string
      ok: boolean
      resultSummary: string
    }>
  }
  delegationContext?: {
    /** When the delegation was created (ms since epoch). */
    createdAt: number
    /** Provider running the parent thread at the moment of delegation
     * — preserved even if the parent later switches provider. */
    parentProvider: ProviderId
    /** The user-supplied (or future: auto-generated) delegation
     * prompt that primes the sub-thread's first turn. Persisted for
     * the parent-thread "↪ Delegated to X" surface to show. */
    delegationPrompt: string
    /** Whether the user asked for the sub-thread's final assistant
     * message to be auto-propagated back to the parent transcript
     * when the sub-thread completes. v1 records the flag but does
     * NOT auto-propagate yet (manual navigation only); F2 will wire
     * the back-propagation. */
    returnResultToParent: boolean
    /** Last time a sub-thread assistant result was returned to the parent (F2+). */
    resultReturnedAt?: number
    /** Populated when the agent-driven dispatch that should have
     * started this sub-thread's first run failed before the adapter
     * was reached (null `runCoordinatorRef`, thrown `dispatch`, etc.).
     * The sub-thread record exists (the user can still see + open it
     * in the sidebar) but `runs` will stay empty until the user kicks
     * off a manual run. The renderer surfaces this so the parent's
     * delegation card no longer hangs on "Pending" forever — it flips
     * to a "Failed to dispatch" state with the message below. */
    dispatchError?: {
      /** ms since epoch when the failure was observed. */
      at: number
      /** Short user-readable failure message — already sanitized for
       * display, no stack traces. */
      message: string
    }
  }
}

export interface ChatListItem extends ChatRecord {
  summaryOnly: true
  messageCount: number
  runCount: number
  lastRun?: ChatRun
  searchText?: string
  searchPreview?: string
}

export type RunEventKind =
  | 'provider_raw'
  | 'provider_error'
  | 'provider_exit'
  | 'timeline'
  | 'delegation'
  | 'tool'
  | 'approval_request'
  | 'approval_response'
  | 'approval_timer_armed'
  | 'approval_timer_timeout'
  | 'question_requested'
  | 'question_answered'
  | 'question_cancelled'
  | 'subthread_spawned'
  | 'subthread_returned'
  | 'subthread_dispatch_failed'
  | 'subthread_autoresume_dispatched'
  | 'side_chat_created'
  | 'diff'
  | 'final_message'
  | 'lifecycle'
  // Provider context-window compaction (src/shared/contextCompaction.ts) —
  // a provider (or the host, for manual Codex compacts) shrank the session's
  // live context. Distinct from ChatCompaction.ts disk-size compaction.
  | 'context_compaction'
  // Audit orchestration workflow (see src/main/audit/AuditOrchestrator.ts) —
  // each audit role-run writes phase/finding/verdict/gate events to its own
  // run-events ledger so the inline card + iOS card can replay it live.
  | 'audit_phase_start'
  | 'audit_phase_complete'
  | 'audit_finding'
  | 'audit_verdict'
  | 'audit_gate_result'
  | 'audit_provider_substituted'

export type RunEventPhase = 'raw' | 'normalized' | 'control' | 'artifact'

export type RunEventArtifactKind =
  | 'stdin'
  | 'stdout'
  | 'stderr'
  | 'file'
  | 'snapshot'
  | 'diff'
  | 'other'

export interface RunEventArtifactRef {
  id: string
  kind: RunEventArtifactKind
  path: string
  sha256: string
  sizeBytes: number
  sequence?: number
  metadata?: Record<string, unknown>
}

export interface RunEventRecord {
  schemaVersion: 1
  id: string
  sequence: number
  previousHash?: string
  hash?: string
  runId: string
  chatId?: string
  workspaceId?: string
  workspacePath?: string
  provider?: ProviderId
  providerSessionId?: string
  providerRunId?: string
  spanId?: string
  parentSpanId?: string
  toolCallId?: string
  kind: RunEventKind
  phase: RunEventPhase
  source: 'main' | 'renderer' | 'provider' | 'replay'
  timestamp: string
  summary?: string
  payload?: unknown
  artifacts?: RunEventArtifactRef[]
}

export type AgentActivityKind =
  | 'root'
  | 'subagent'
  | 'fork'
  | 'handoff'
  | 'tool'
  | 'approval'
  | 'artifact'
  | 'progress'

export type AgentActivityStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'unknown'

export interface AgentActivity {
  activityId: string
  parentActivityId?: string
  runId?: string
  turnId?: string
  provider?: ProviderId
  providerThreadId?: string
  providerAgentId?: string
  parentToolCallId?: string
  kind: AgentActivityKind
  name: string
  model?: string
  status: AgentActivityStatus
  promptPreview?: string
  summary?: string
  toolPolicy?: string
  mcpPolicy?: string
  approvalMode?: string
  filesTouched?: string[]
  tokenUsage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }
  rawEventRefs?: Array<{
    sequence?: number
    hash?: string
    toolCallId?: string
    spanId?: string
  }>
}

export type RunEventInput = Omit<
  RunEventRecord,
  'schemaVersion' | 'id' | 'sequence' | 'timestamp'
> &
  Partial<Pick<RunEventRecord, 'id' | 'sequence' | 'timestamp'>>

export interface RunEventFilter {
  runId?: string
  chatId?: string
  workspaceId?: string
  provider?: ProviderId
  kinds?: RunEventKind[]
  phases?: RunEventPhase[]
  fromSequence?: number
  limit?: number
}

export interface RunEventReplay {
  runId: string
  events: RunEventRecord[]
  count: number
  lastSequence: number
  hashHead?: string
  hashChainValid: boolean
  countsByKind: Partial<Record<RunEventKind, number>>
  timeline: Array<{
    sequence: number
    timestamp: string
    kind: RunEventKind
    phase: RunEventPhase
    source: RunEventRecord['source']
    summary?: string
    spanId?: string
    parentSpanId?: string
    toolCallId?: string
    artifactIds?: string[]
    hash?: string
  }>
  startedAt?: string
  endedAt?: string
}

export type ApprovalLedgerStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired'
export type ApprovalLedgerScope = 'request' | 'run' | 'session' | 'workspace'
export type ApprovalLedgerDecisionSource =
  | 'user'
  | 'policy'
  | 'workspace_grant'
  | 'session_grant'
  | 'session_yolo'
  | 'bossman_auto'
  | 'plan_artifact'
  | 'system'
export type ApprovalLedgerExpirationMode =
  | 'pending_timeout'
  | 'on_decision'
  | 'run_end'
  | 'session_end'
  | 'workspace_revocation'
  | 'none'

export interface ApprovalLedgerExpiration {
  mode: ApprovalLedgerExpirationMode
  description: string
  expiresAt?: string
  expiredAt?: string
  expiredReason?: string
}

export interface ApprovalLedgerRecord {
  schemaVersion: 1
  id: string
  approvalId: string
  provider: ProviderId
  service?: AgenticServiceId
  method: string
  title: string
  body?: string
  preview?: unknown
  params?: unknown
  actions: AgentApprovalAction[]
  status: ApprovalLedgerStatus
  requestedAt: string
  respondedAt?: string
  decision?: AgentApprovalAction | 'autoAllow' | 'autoDeny' | 'expired'
  decisionSource?: ApprovalLedgerDecisionSource
  grantedScope?: ApprovalLedgerScope
  expiration: ApprovalLedgerExpiration
  runId?: string
  chatId?: string
  workspaceId?: string
  workspacePath?: string
  providerSessionId?: string
  providerRunId?: string
  rpcId?: number | string
  metadata?: Record<string, unknown>
}

export type ApprovalLedgerRequestInput = Omit<
  ApprovalLedgerRecord,
  | 'schemaVersion'
  | 'id'
  | 'status'
  | 'requestedAt'
  | 'respondedAt'
  | 'decision'
  | 'decisionSource'
  | 'grantedScope'
  | 'expiration'
> &
  Partial<
    Pick<
      ApprovalLedgerRecord,
      | 'id'
      | 'requestedAt'
      | 'status'
      | 'respondedAt'
      | 'decision'
      | 'decisionSource'
      | 'grantedScope'
      | 'expiration'
    >
  >

export interface ApprovalLedgerFilter {
  approvalId?: string
  runId?: string
  chatId?: string
  workspaceId?: string
  provider?: ProviderId
  service?: AgenticServiceId
  statuses?: ApprovalLedgerStatus[]
  scopes?: ApprovalLedgerScope[]
  includeExpired?: boolean
  limit?: number
}

export interface UsageRecord {
  id: string
  provider?: ProviderId
  timestamp: number
  workspaceId: string
  chatId: string
  runId: string
  usageKind?: 'run' | 'reset_hint'
  model: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Non-cache prompt tokens when a provider splits cache reads/creation. */
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  inputTokenLimit?: number
  outputTokenLimit?: number
  totalTokenLimit?: number
  resetAt?: string
  resetText?: string
  durationMs: number
  promptText?: string
  responseText?: string
  /** Peak llama-server RSS (GB) sampled during an Ollama run. */
  ollamaMemoryPeakRssGb?: number
  /** Number of periodic memory polls taken during the run. */
  ollamaMemorySampleCount?: number
}

export type WorkspaceActivityEventKind = 'git_commit' | 'worktree_change' | 'filesystem_change'

export interface WorkspaceActivityEvent {
  timestamp: number
  kind: WorkspaceActivityEventKind
  count: number
  weight: number
}

export interface WorkspaceActivitySnapshot {
  workspacePath: string
  dayCount: number
  generatedAt: number
  source: 'git' | 'filesystem' | 'none'
  truncated: boolean
  events: WorkspaceActivityEvent[]
  stats: {
    gitRepo: boolean
    commits: number
    worktreeFiles: number
    filesystemFiles: number
    scannedFiles: number
    scanLimit: number
  }
}

export type ScheduledTaskStatus =
  | 'pending'
  | 'due'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type WorkflowTriggerKind = 'manual' | 'once' | 'interval' | 'cron'

export interface WorkflowTrigger {
  kind: WorkflowTriggerKind
  /** ISO timestamp for one-shot workflows. */
  runAt?: string
  /** Fixed interval cadence for recurring workflows. */
  intervalMs?: number
  /** Optional cadence anchor. Defaults to workflow creation time. */
  startAt?: string
  /** Reserved for future cron support; cron expressions are not evaluated yet. */
  cronExpression?: string
  timezone?: string
}

export type WorkflowMissedRunPolicy = 'coalesce' | 'skip'
export type WorkflowConcurrencyPolicy = 'skip' | 'enqueue'
export type WorkflowExecutionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'

export interface WorkflowLimits {
  maxRunsPerDay?: number
  maxConsecutiveFailures?: number
  /** Wall-clock cap (seconds). Enforced mid-run for ALL providers. */
  timeoutSeconds?: number
  /**
   * Cumulative cost cap (USD). Mid-run kill for live-signal providers
   * (claude/kimi/codex); POST-HOC for grok/cursor (checked at run end → the
   * finished run is marked failed if it exceeded). Best-effort: most providers
   * report cost only at the terminal result.
   */
  maxCostUsd?: number
  /**
   * Cumulative token cap. Mid-run kill for claude/kimi/codex; grok/cursor have no
   * live token signal, so their token budget is enforced POST-HOC (the finished
   * run is marked failed if it exceeded the cap).
   */
  maxTokens?: number
}

export interface WorkflowExecutionRecord {
  id: string
  workflowId: string
  scheduledTaskId?: string
  runId?: string
  plannedFor: string
  status: WorkflowExecutionStatus
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
  error?: string
}

/**
 * 1.0.4-AT3 — discriminant for solo vs ensemble scheduled runs.
 *
 * Pre-AT3 every scheduled task was implicitly a single-provider
 * dispatch (`kind` undefined). Ensemble chats COULD be scheduled
 * (the dispatch path correctly routed via `chat.chatKind` at fire
 * time) BUT the schedule didn't snapshot the participant roster
 * / orchestration mode at schedule time. A user who scheduled a
 * 4-participant ensemble at 9am and then disabled two
 * participants at 9:30 would see only the remaining two
 * participants fire at 10am — not what they scheduled.
 *
 * `kind: 'ensemble'` plus an `ensembleSnapshot` locks in the
 * panel state at schedule time. The dispatcher applies the
 * snapshot to the chat's ensemble config before kicking off the
 * round so the panel composition matches the user's intent.
 *
 * Undefined `kind` reads as `'single'` so existing scheduled
 * records (and the solo-chat scheduling path) keep working
 * verbatim.
 */
export type ScheduledTaskKind = 'single' | 'ensemble'

/**
 * 1.0.4-AT3 — snapshot of the ensemble state captured when the
 * user clicked Schedule. Applied to the chat's ensemble config
 * before the round fires so subsequent roster/mode edits don't
 * change what the user scheduled. Participants are stored in
 * full (not just ids) so we can rehydrate a disabled-since
 * participant if the chat's live record was mutated.
 *
 * `EnsembleOrchestrationMode` and `EnsembleParticipant` are
 * imported below; we reference them via `import type` to avoid
 * a runtime circular.
 */
export interface ScheduledEnsembleSnapshot {
  orchestrationMode: EnsembleOrchestrationMode
  fanoutPolicy?: EnsembleFanoutPolicy
  /** Legacy schedule-time fan-out flag for snapshots created before
   * `fanoutPolicy`. New snapshots include both for one migration cycle. */
  concurrentModeEnabled?: boolean
  participants: EnsembleParticipant[]
  /** Direct-message target participant id, when scheduled with
   * Cmd/Ctrl-Send while a chip was selected. */
  dmTargetParticipantId?: string
  maxParticipants?: number
  maxContinuationHops?: number
  /** Snapshot ISO timestamp — purely informational, so the user
   * can compare "scheduled with this roster at X" vs the chat's
   * current ensemble config at fire time. */
  capturedAt: string
}

export interface ScheduledTask {
  id: string
  workspaceId: string
  workspacePath: string
  chatId: string
  provider: ProviderId
  prompt: string
  displayPrompt?: string
  selectedModelType: string
  customModel: string
  approvalMode: string
  sessionTrust: boolean
  imageAttachments: Array<{
    id: string
    path: string
    name: string
  }>
  externalPathGrants?: ExternalPathGrant[]
  geminiWorktree?: GeminiWorktreeConfig
  codexReasoningEffort?: string | null
  codexServiceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinkingEnabled?: boolean
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  handoffSourceRunId?: string
  runAt: string
  timezone: string
  status: ScheduledTaskStatus
  createdAt: string
  updatedAt: string
  runId?: string
  firedAt?: string
  /**
   * ISO timestamp stamped ONLY on the transition INTO 'running' in
   * `AppStore.updateScheduledTask`. The stall reconciler measures a running
   * task's staleness from here (never `updatedAt`, which a benign re-patch would
   * reset). Absent on tasks that went running before this field existed — the
   * reconciler falls back to `firedAt`.
   */
  runningSince?: string
  completedAt?: string
  lastError?: string
  workflowId?: string
  workflowExecutionId?: string
  workflowOccurrenceAt?: string
  /** 1.0.4-AT3 — discriminant. Undefined == legacy single-provider. */
  kind?: ScheduledTaskKind
  /** 1.0.4-AT3 — required when `kind === 'ensemble'`. Applied to
   * the chat's ensemble config at fire time so roster/mode edits
   * after scheduling don't reshape the dispatch. */
  ensembleSnapshot?: ScheduledEnsembleSnapshot
}

export type WorkflowRunTemplate = Omit<
  ScheduledTask,
  | 'id'
  | 'runAt'
  | 'timezone'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  | 'runId'
  | 'firedAt'
  | 'completedAt'
  | 'lastError'
  | 'workflowId'
  | 'workflowExecutionId'
  | 'workflowOccurrenceAt'
>

/** Stage 2 — how a maker→verifier LOOP workflow decides to STOP. maxIterations is
 * a non-optional fail-safe backstop (clamped ≥1 on save) — the loop NEVER runs
 * unbounded regardless of the verifier. The optional verifier adds an adversarial
 * accept/revise gate after each maker pass. See WorkflowLoopModel. */
export interface WorkflowLoopAcceptance {
  maxIterations: number
  verifier?: {
    /** Prefer a verifier provider OTHER than the maker's (cross-provider check). */
    provider?: ProviderId
  }
}

/** The cumulative ceiling spanning ALL iterations (the per-run WorkflowLimits bounds
 * one run; this bounds the whole loop). */
export interface WorkflowLoopLimits {
  /** Max TOTAL runs (maker + verifier) across the loop. Always enforced (clamped ≥1). */
  maxRuns: number
  maxTokens?: number
  maxCostUsd?: number
}

export interface WorkflowLoopConfig {
  acceptance: WorkflowLoopAcceptance
  limits: WorkflowLoopLimits
}

export interface WorkflowDefinition {
  id: string
  name: string
  /**
   * P2 opt-in unattended elevation. When present AND it passes HMAC
   * verification + isUnattendedElevationAckCurrent at dispatch, an unattended
   * (scheduled) run of this workflow may rise above the forced-'plan' clamp to
   * Default / Full-Workspace-Access. Minted server-side only (the
   * set-workflow-unattended-elevation IPC); the save/update sanitizers strip a
   * renderer-supplied value. Eagerly nulled when template.approvalMode changes.
   */
  unattendedElevation?: UnattendedElevationAck
  workspaceId: string
  workspacePath: string
  enabled: boolean
  trigger: WorkflowTrigger
  template: WorkflowRunTemplate
  missedRunPolicy: WorkflowMissedRunPolicy
  concurrencyPolicy: WorkflowConcurrencyPolicy
  limits: WorkflowLimits
  /** Stage 2 — optional maker→verifier loop. Absent ⇒ the workflow runs as a single
   * occurrence (the existing path). Validated/clamped by normalizeWorkflowLoopConfig
   * on save (maxIterations + maxRuns are fail-safe ≥1 backstops). */
  loop?: WorkflowLoopConfig
  nextRunAt?: string
  lastRunAt?: string
  lastCompletedAt?: string
  lastStatus?: WorkflowExecutionStatus
  lastError?: string
  /** Stage 2 slice 7b — cached summary of the latest LOOP execution, for the SYNC
   * remote projection to iOS (the durable ledger query is async). Written by the loop
   * engine on completion, mirroring lastStatus/lastRunAt; absent for non-loop runs. */
  lastRunIterationCount?: number
  lastRunStopReason?: string
  lastRunTokens?: number
  failureStreak: number
  activeExecutionId?: string
  history: WorkflowExecutionRecord[]
  createdAt: string
  updatedAt: string
}

export type WorkspaceBoardColumnId =
  | 'inbox'
  | 'ready'
  | 'running'
  | 'needs-input'
  | 'blocked'
  | 'review-ready'
  | 'done'
  | 'archived'

export interface WorkspaceBoardColumn {
  id: WorkspaceBoardColumnId
  name: string
  sortOrder: number
  wipLimit?: number
}

export const WORKSPACE_BOARD_CARD_LINK_KINDS = [
  'chat',
  'workflow',
  'scheduled-task',
  'run-queue-job',
  'local-server',
  'pinned-message'
] as const

export type WorkspaceBoardCardLinkKind = (typeof WORKSPACE_BOARD_CARD_LINK_KINDS)[number]

export interface WorkspaceBoardCardLink {
  kind: WorkspaceBoardCardLinkKind
  id: string
}

export interface WorkspaceBoardActivityEntry {
  id: string
  at: string
  actor: 'user' | 'agent' | 'system'
  action: string
  detail?: string
}

export type WorkspaceBoardProvenanceActor = 'user' | 'agent' | 'system'
export type WorkspaceBoardProvenanceSourceKind =
  | 'manual'
  | 'capture'
  | 'seed'
  | 'duplicate'
  | 'thread'
  | 'goal'
  | 'plan'
  | 'agent'

export interface WorkspaceBoardProvenance {
  actor: WorkspaceBoardProvenanceActor
  sourceKind: WorkspaceBoardProvenanceSourceKind
  at: string
  trust?: 'user-confirmed' | 'agent-proposed' | 'system-derived'
  sourceId?: string
  sourceTitle?: string
  provider?: ProviderId | string
  runId?: string
  note?: string
}

export interface WorkspaceBoardDefinition {
  id: string
  workspaceId: string
  workspacePath: string
  name: string
  description?: string
  columns: WorkspaceBoardColumn[]
  provenance?: WorkspaceBoardProvenance
  pinned?: boolean
  archived?: boolean
  createdAt: string
  updatedAt: string
  activity: WorkspaceBoardActivityEntry[]
}

export interface WorkspaceBoardCard {
  id: string
  boardId: string
  workspaceId: string
  columnId: WorkspaceBoardColumnId
  title: string
  body?: string
  sortOrder: number
  humanOwner?: string
  labels?: string[]
  link?: WorkspaceBoardCardLink
  blockedReason?: string
  nextStep?: string
  reminderAt?: string
  provenance?: WorkspaceBoardProvenance
  archived?: boolean
  createdAt: string
  updatedAt: string
  activity: WorkspaceBoardActivityEntry[]
}

// ── Audit orchestration workflow ───────────────────────────────────────────
// A bounded, disciplined, multi-provider strengths/weaknesses audit. Unlike
// WorkflowDefinition (a reusable schedule template), an AuditRunRecord is a
// durable RUN object: a phase DAG (recon → plan → gates‖reviewers → dedup →
// verify → synthesis) whose agents emit TYPED artifacts (findings/verdicts via
// MCP tools, not prose). See docs + src/main/audit/AuditOrchestrator.ts.

export type AuditMode = 'quick' | 'deep' | 'release'

export type AuditRunStatus =
  | 'planning'
  | 'awaitingConfirm'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Phases in execution order. `gates` and `review` run in parallel. */
export type AuditPhaseId = 'recon' | 'plan' | 'gates' | 'review' | 'dedup' | 'verify' | 'synthesis'

export type AuditPhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface AuditPhase {
  id: AuditPhaseId
  status: AuditPhaseStatus
  startedAt?: string
  endedAt?: string
  detail?: string
}

/** Roles an audit assigns to providers. The gates runner is deterministic
 * (no model), so it is NOT a role here. */
export type AuditRole = 'recon' | 'reviewer' | 'skeptic' | 'synthesis'

export type AuditFindingSeverity = 'low' | 'medium' | 'high' | 'critical'
export type AuditFindingPolarity = 'strength' | 'weakness'

/** Verification lifecycle of a finding. `refuted` is only reachable when a
 * skeptic cited contradicting evidence; an unsupported refutation downgrades
 * to `unverified` (kept, flagged) — never silently dropped. */
export type AuditFindingVerdictState = 'pending' | 'confirmed' | 'unverified' | 'refuted'

export interface AuditEvidenceRef {
  /** Workspace-relative path. */
  path: string
  line?: number
  /** Short quoted snippet or note anchoring the claim. */
  note?: string
}

export interface AuditFinding {
  id: string
  dimension: string
  polarity: AuditFindingPolarity
  claim: string
  severity: AuditFindingSeverity
  /** Reviewer's self-assessed confidence 0..1. */
  confidence: number
  evidenceRefs: AuditEvidenceRef[]
  /** How to reproduce / verify the claim. */
  verification?: string
  suggestedFix?: string
  blastRadius?: string
  authorProvider: ProviderId
  /** Stable key used by the dedup barrier (file+line+normalized-claim). */
  dedupKey: string
  /** Finding ids merged into this one during dedup. */
  mergedFrom?: string[]
  verdictState: AuditFindingVerdictState
  createdAt: string
}

export type AuditVerdictDecision = 'accept' | 'downgrade' | 'refute'

export interface AuditVerdict {
  id: string
  findingId: string
  skepticProvider: ProviderId
  decision: AuditVerdictDecision
  /** Required for a `refute` to actually delete a finding. */
  counterEvidence?: AuditEvidenceRef[]
  rationale?: string
  createdAt: string
}

export interface AuditGateResult {
  id: string
  /** e.g. 'typecheck', 'test', 'supply-chain', 'outdated', 'validate-release'. */
  check: string
  command: string
  status: 'pass' | 'fail' | 'skipped'
  exitCode?: number
  /** Ref to the captured command log in the run-artifacts dir. */
  logArtifactId?: string
  summary?: string
  durationMs?: number
}

export interface AuditParticipant {
  runId: string
  role: AuditRole
  dimension?: string
  provider: ProviderId
  /** Identicon catalog name (agentIdentity) for the inline card. */
  identicon?: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'substituted' | 'cancelled'
  /** Provider this run was reassigned FROM, when the chain substituted. */
  substitutedFrom?: ProviderId
  tokens?: number
  costUsd?: number
  durationMs?: number
  startedAt?: string
  endedAt?: string
}

/** Resolved role→provider fallback chains + what was dropped and why. */
export interface AuditRoster {
  perRole: Partial<Record<AuditRole, ProviderId[]>>
  degradations: AuditDegradation[]
}

export interface AuditDegradation {
  provider: ProviderId
  /** Eligibility layer that excluded it. */
  reason:
    | 'unconfigured'
    | 'unauthenticated'
    | 'unhealthy'
    | 'rate_limited'
    | 'policy_excluded'
    | 'ollama_disabled'
  detail?: string
}

export interface AuditBudget {
  maxAgents: number
  maxTokens?: number
  spentAgents: number
  spentTokens: number
  /** True once a ceiling forced verification to stop early. */
  truncated: boolean
}

/** Honest reporting of how thorough the run actually was. */
export interface AuditCoverage {
  dimensionsPlanned: number
  dimensionsCompleted: number
  /** Finding ids verified by ≥2 providers. */
  crossProviderVerifiedCount: number
  /** Finding ids verified by only one provider (decorrelation limited). */
  singleProviderVerifiedCount: number
  substitutions: number
  notes?: string[]
}

export interface AuditRunRecord {
  schemaVersion: 1
  id: string
  mode: AuditMode
  /** The triggering chat the final report is posted into. */
  chatId: string
  workspaceId?: string
  workspacePath: string
  status: AuditRunStatus
  phases: AuditPhase[]
  /** Recon output — the typed project profile that drives planning. */
  profile?: AuditProjectProfile
  dimensions: string[]
  roster?: AuditRoster
  participants: AuditParticipant[]
  findings: AuditFinding[]
  verdicts: AuditVerdict[]
  gates: AuditGateResult[]
  budget: AuditBudget
  coverage?: AuditCoverage
  /** Final synthesized markdown report (set on completion). */
  report?: string
  error?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  endedAt?: string
}

export type EvidenceCapabilityStatus =
  | 'verified'
  | 'partial'
  | 'blocked'
  | 'unsupported'
  | 'unverified'

export type CapabilityMapProvenanceState =
  | 'inferred'
  | 'user_confirmed'
  | 'implementation_revised'
  | 'deprecated'

export interface CapabilityMapProvenance {
  state: CapabilityMapProvenanceState
  source: 'scope_radar' | 'user' | 'agent' | 'evidence_pack' | 'system'
  at: string
  note?: string
  evidenceRefs?: AuditEvidenceRef[]
}

export interface CapabilityMapEntry {
  key: string
  title: string
  description?: string
  parentKey?: string
  provenance: CapabilityMapProvenance
}

export interface EvidencePackCapabilityCell {
  capabilityKey: string
  title?: string
  status: EvidenceCapabilityStatus
  evidenceRefs: AuditEvidenceRef[]
  statusReason?: string
  validationCommand?: string
  unsupportedClaims?: string[]
}

export interface EvidencePackCompletionClaim {
  claim: string
  supported: boolean
  evidenceRefs: AuditEvidenceRef[]
  note?: string
}

export interface EvidencePackRecord {
  schemaVersion: 1
  id: string
  workspaceId: string
  workspacePath?: string
  chatId?: string
  runId?: string
  provider?: ProviderId
  title?: string
  mapEntries: CapabilityMapEntry[]
  capabilityCells: EvidencePackCapabilityCell[]
  completionClaims: EvidencePackCompletionClaim[]
  diffTouchedFiles?: string[]
  createdAt: string
  updatedAt: string
}

export interface CapabilityLedgerCell {
  capabilityKey: string
  title: string
  status: EvidenceCapabilityStatus
  evidenceRefs: AuditEvidenceRef[]
  statusReason?: string
  validationCommand?: string
  unsupportedClaims?: string[]
  latestEvidencePackId: string
  latestRunId?: string
  updatedAt: string
}

export type CapabilityStallSignalKind =
  | 'diff_without_capability_delta'
  | 'partial_without_new_evidence'

export interface CapabilityStallSignal {
  kind: CapabilityStallSignalKind
  severity: 'info' | 'warning'
  capabilityKey?: string
  evidencePackIds: string[]
  runIds?: string[]
  note: string
}

export interface CapabilityLedgerSnapshot {
  workspaceId?: string
  generatedAt: string
  cells: CapabilityLedgerCell[]
  mapEntries: CapabilityMapEntry[]
  totalCompletionClaims: number
  unsupportedCompletionClaims: number
  unsupportedCompletionClaimRate: number
  stallSignals: CapabilityStallSignal[]
}

export type CompletionClaimSupportStatus =
  | 'no_completion_claim'
  | 'supported'
  | 'partial'
  | 'unsupported'

export interface CompletionClaimSupportAssessment {
  status: CompletionClaimSupportStatus
  hasCompletionLanguage: boolean
  completionPhrases: string[]
  evidencePackIds: string[]
  supportedClaims: EvidencePackCompletionClaim[]
  unsupportedClaims: EvidencePackCompletionClaim[]
  supportingEvidenceRefs: AuditEvidenceRef[]
  message: string
  recommendedCaveat?: string
}

export interface CompletionClaimSupportAnnotation {
  status: CompletionClaimSupportStatus
  hasCompletionLanguage: boolean
  completionPhrases: string[]
  evidencePackIds: string[]
  supportingEvidenceRefs: AuditEvidenceRef[]
  message: string
  recommendedCaveat?: string
  assessedAt: string
}

export type ScopeRadarSliceKind =
  | 'prerequisite'
  | 'known'
  | 'unknown'
  | 'speculative'

export interface ScopeRadarSlopBudget {
  maxNewFiles: number
  maxNewAbstractions: number
  maxPlaceholderFiles: number
  maxBroadStylingChanges: number
  maxDuplicatedPatterns: number
  note: string
}

export interface ScopeRadarQuestion {
  id: string
  question: string
  reason: string
}

export interface ScopeRadarResult {
  schemaVersion: 1
  title: string
  prompt: string
  riskLevel: 'low' | 'medium' | 'high'
  desiredCapability: string
  currentState?: string
  capabilityMap: CapabilityMapEntry[]
  sliceKinds: Record<string, ScopeRadarSliceKind>
  evidenceRequired: string[]
  allowedSurfaces: string[]
  nonGoals: string[]
  questions: ScopeRadarQuestion[]
  slopBudget: ScopeRadarSlopBudget
  evidencePackDraft: Pick<
    EvidencePackRecord,
    'mapEntries' | 'capabilityCells' | 'completionClaims' | 'diffTouchedFiles'
  >
}

export type RepoConventionIndexEntryKind =
  | 'component_family'
  | 'utility'
  | 'architectural_boundary'
  | 'style_system'
  | 'generated_path'
  | 'decision'
  | 'do_not_repeat'

export interface RepoConventionIndexEntry {
  id: string
  kind: RepoConventionIndexEntryKind
  title: string
  description?: string
  paths?: string[]
  evidenceRefs?: AuditEvidenceRef[]
  provenance: 'scan' | 'blackboard' | 'evidence_pack' | 'user'
  updatedAt: string
}

export interface RepoConventionIndexSnapshot {
  schemaVersion: 1
  workspaceId: string
  workspacePath?: string
  generatedAt: string
  entries: RepoConventionIndexEntry[]
  staleReason?: string
}

export type CoherenceGateStatus = 'pass' | 'warn' | 'block'

export type CoherenceGateFindingSeverity = 'info' | 'warning' | 'blocker'

export type CoherenceGateFindingKind =
  | 'generated_path_edit'
  | 'placeholder_only_work'
  | 'slop_budget_exceeded'
  | 'broad_styling_drift'
  | 'duplicate_abstraction_risk'
  | 'scope_surface_mismatch'
  | 'missing_validation_evidence'
  | 'repo_convention_missing'

export interface CoherenceGateFinding {
  kind: CoherenceGateFindingKind
  severity: CoherenceGateFindingSeverity
  title: string
  detail: string
  paths?: string[]
  conventionEntryIds?: string[]
  capabilityKeys?: string[]
  evidenceRefs?: AuditEvidenceRef[]
}

export interface CoherenceGateCounts {
  touchedFiles: number
  newFiles: number
  placeholderFiles: number
  broadStylingChanges: number
  duplicatePatternRisks: number
  validationEvidenceRefs: number
}

export interface CoherenceGateResult {
  schemaVersion: 1
  generatedAt: string
  status: CoherenceGateStatus
  summary: string
  findings: CoherenceGateFinding[]
  counts: CoherenceGateCounts
  slopBudget?: ScopeRadarSlopBudget
  desiredCapability?: string
  scopeRiskLevel?: ScopeRadarResult['riskLevel']
  conventionIndexGeneratedAt?: string
}

export type PromptTaskMode = 'explore' | 'build' | 'harden' | 'coherence' | 'release'

export interface PromptTaskAllowedSurface {
  label: string
  source: 'scope_radar' | 'repo_convention' | 'system'
  paths?: string[]
  conventionEntryIds?: string[]
  note?: string
}

export interface PromptTaskContract {
  schemaVersion: 1
  generatedAt: string
  prompt: string
  currentState?: string
  desiredCapability: string
  inferredMode: PromptTaskMode
  riskLevel: ScopeRadarResult['riskLevel']
  capabilityMap: CapabilityMapEntry[]
  sliceKinds: Record<string, ScopeRadarSliceKind>
  nonGoals: string[]
  evidenceRequired: string[]
  acceptanceCriteria: string[]
  allowedSurfaces: PromptTaskAllowedSurface[]
  questions: ScopeRadarQuestion[]
  slopBudget: ScopeRadarSlopBudget
  firstSliceKey?: string
  firstSliceTitle?: string
  conventionIndexGeneratedAt?: string
}

export interface AuditProjectProfile {
  stack?: string[]
  testSurface?: string[]
  releasePaths?: string[]
  securityAreas?: string[]
  providerBoundaries?: string[]
  docsSurface?: string[]
  riskZones?: string[]
}

/** Carried on AgentRunPayload for audit role-runs (parallel to
 * EnsembleRunIdentity) so the adapter routes events back to the orchestrator. */
export interface AuditRunIdentity {
  auditRunId: string
  role: AuditRole
  dimension?: string
  /** Set for skeptic runs — the finding being refuted. */
  findingId?: string
}

export interface AuditOrchestrationSettings {
  /** Providers permitted in orchestration. Undefined = all available. */
  providerAllowlist?: ProviderId[]
  /** Local models opt-in (off by default — concurrency risk). */
  ollamaEnabled?: boolean
  /** Concurrent local-model cap, separate from the cloud pool. */
  ollamaMaxConcurrent?: number
  /** Optional per-role preference order (intersected with eligibility). */
  perRolePreferences?: Partial<Record<AuditRole, ProviderId[]>>
  budgetMaxAgents?: number
  budgetMaxTokens?: number
}

export type RunQueueJobStatus =
  | 'queued'
  | 'steer_promoting'
  | 'starting'
  | 'active'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'

export type RunQueueJobSource =
  | 'manual'
  | 'remote'
  | 'scheduled'
  | 'retry'
  | 'permission_retry'
  | 'review'
  | 'host_rerun'
  | 'system'

export interface RunQueueImageAttachmentSnapshot {
  id?: string
  path: string
  name?: string
}

export interface RunQueueDiscordContextSelectionSnapshot {
  guildId?: string
  guildName?: string
  channelId: string
  channelName?: string
  limit: 10 | 25 | 50 | 100
}

export interface RunQueueRequestSnapshot {
  scope?: ChatScope
  prompt: string
  displayPrompt?: string
  selectedModelType: string
  customModel: string
  approvalMode: string
  workflowMode?: ChatWorkflowMode
  sessionTrust: boolean
  imageAttachments: RunQueueImageAttachmentSnapshot[]
  discordContextSelection?: RunQueueDiscordContextSelectionSnapshot
  externalPathGrants?: ExternalPathGrant[]
  geminiWorktree?: GeminiWorktreeConfig
  codexNativeReview?: boolean
  codexReasoningEffort?: string | null
  codexServiceTier?: string | null
  claudeReasoningEffort?: string | null
  claudeFastMode?: boolean | null
  kimiThinkingEnabled?: boolean
  scheduledTaskId?: string
  scheduledRunAt?: string
  preserveComposer?: boolean
  runtimeProfileId?: string
  geminiAuthProfileId?: string | null
  handoffSourceRunId?: string
  guestParentChatId?: string
  guestRole?: string
  remoteComposer?: {
    workspaceId: string
    threadId: string
    provider: string
    text: string
    approvalMode?: string
    workflowMode?: ChatWorkflowMode
    model?: string
    reasoningEffort?: string | null
    claudeReasoningEffort?: string | null
    contextTurns?: number
    extraWorkspaceIds?: string[]
  }
}

export type RunRecoveryProcessAction = 'left_running' | 'not_found' | 'inaccessible' | 'unknown'

export interface RunRecoveryProcessSnapshot {
  pid: number
  checkedAt: string
  alive: boolean
  command?: string
  errorCode?: string
  errorMessage?: string
  detection: 'pid_signal' | 'pid_signal_and_ps'
  action: RunRecoveryProcessAction
}

export interface RunQueueJob {
  id: string
  runId: string
  provider: ProviderId
  ensembleParticipantId?: string
  ensembleRole?: string
  scope?: ChatScope
  workspaceId?: string
  workspacePath?: string
  chatId?: string
  source: RunQueueJobSource
  status: RunQueueJobStatus
  promotionOwnerToken?: string
  promotionToken?: string
  transitionVersion?: number
  promotionAttempt?: number
  promotedAt?: string
  queueMessageId?: string
  priority: number
  attempt: number
  promptPreview?: string
  request?: RunQueueRequestSnapshot
  permissionPosture?: RunPermissionPostureSnapshot
  providerSessionId?: string
  providerRunId?: string
  processPid?: number
  processStartedAt?: string
  processCommand?: string
  runtimeProfileId?: string
  handoffSourceRunId?: string
  orphanProcess?: RunRecoveryProcessSnapshot
  parentRunId?: string
  createdAt: string
  updatedAt: string
  enqueuedAt?: string
  startedAt?: string
  pausedAt?: string
  endedAt?: string
  cancelledAt?: string
  failedAt?: string
  completedAt?: string
  interruptedAt?: string
  recoveredAt?: string
  statusReason?: string
  lastError?: string
  recoveryReason?: string
  resumeAvailable?: boolean
  resumeHint?: string
}

export interface RunQueueJobFilter {
  workspaceId?: string
  chatId?: string
  provider?: ProviderId
  statuses?: RunQueueJobStatus[]
  includeTerminal?: boolean
}

export type RunRecoveryAction =
  | 'marked_failed'
  | 'marked_failed_orphan_detected'
  | 'requeued_stale_steer_promoting'
  | 'cleared_stale_paused_process'
  | 'cleared_stale_process'
  | 'cleared_stale_orphan_process'

export interface RunRecoveryRecord {
  schemaVersion: 1
  id: string
  runId: string
  jobId: string
  provider: ProviderId
  ensembleParticipantId?: string
  ensembleRole?: string
  chatId?: string
  workspaceId?: string
  workspacePath?: string
  previousStatus: RunQueueJobStatus
  recoveredStatus: RunQueueJobStatus
  action: RunRecoveryAction
  reason: string
  recoveredAt: string
  process?: RunRecoveryProcessSnapshot
  resumeAvailable: boolean
  resumeHint: string
  jobSnapshot: {
    providerSessionId?: string
    providerRunId?: string
    promptPreview?: string
    startedAt?: string
    updatedAt?: string
    processPid?: number
    processStartedAt?: string
    processCommand?: string
  }
}

export interface RunRecoveryFilter {
  runId?: string
  chatId?: string
  workspaceId?: string
  provider?: ProviderId
  actions?: RunRecoveryAction[]
  onlyOrphans?: boolean
  limit?: number
}

export type RunStatus =
  | 'success'
  | 'success_with_warnings'
  | 'failed'
  | 'cancelled'
  | 'running'
  | 'sleeping'

export interface RunWarning {
  message: string
  timestamp: string
}

export type ToolActivityStatus = 'pending' | 'running' | 'success' | 'warning' | 'error'

export interface ToolDiffFileSummary {
  path?: string
  status?: DiffFileStatus | 'updated' | 'unknown'
  additions?: number
  deletions?: number
}

export interface ToolDiffSummary {
  additions?: number
  deletions?: number
  files?: ToolDiffFileSummary[]
  source:
    | 'codex_changes'
    | 'patch_preview'
    | 'string_replace'
    | 'content'
    | 'result_diff'
    | 'unknown'
  confidence: 'exact' | 'estimated' | 'unknown'
}

export interface ToolActivity {
  id: string
  toolName: string
  displayName: string
  category: 'task' | 'read' | 'write' | 'search' | 'shell' | 'unknown'
  status: ToolActivityStatus
  startedAt?: string
  endedAt?: string
  durationMs?: number
  parameters?: Record<string, unknown>
  resultSummary?: string
  outputPreview?: string
  filePath?: string
  diffSummary?: ToolDiffSummary
  rawUseEvent?: unknown
  rawResultEvent?: unknown
  /** If this tool call was emitted by a sub-agent, the tool_use id of the parent Task / Agent call that spawned it. */
  parentToolCallId?: string
  /** 1.0.4-AG — optional attribution metadata. `provider` names the
   * CLI/runtime that issued the call, `ensembleProvider` names the
   * specific ensemble participant provider when the chat is multi-provider,
   * and `ensembleParticipantId` keeps same-provider participants separated.
   * That lets compact tool-trace and plan/todo surfaces read "Codex calls
   * write_file" vs "Claude calls Edit" distinctly during cross-provider rounds.
   * All are optional; absent means "fall back to the chat-level
   * provider passed to ActivityStack". */
  metadata?: {
    provider?: ProviderId
    ensembleProvider?: ProviderId
    ensembleParticipantId?: string
  }
  /** Live status of a Claude-native `Workflow` run, when this activity IS the
   * originating `Workflow` tool call. Populated from the SDK's `type:'system'`
   * task-lifecycle frames (keyed back to this activity by tool_use id) and read
   * by the transcript's Claude workflow card. Absent for every other tool. */
  workflowSummary?: ClaudeWorkflowTelemetry
  /** Live status of a Codex native code-review run, when this activity IS the
   * synthesized `codex_review` anchor. Populated from the review lifecycle
   * (`review/start` → `review/completed`) and read by the transcript's review
   * card. Coarse run-status only (target/status/duration/tokens/model) — Codex
   * emits no structured findings. Absent for every other tool. */
  reviewSummary?: CodexReviewTelemetry
  // Legacy fields preserved for backward compatibility
  affectedFilePath?: string
  operationCategory?: 'update_topic' | 'read_file' | 'edit_file' | 'search' | 'shell' | 'unknown'
  outputSummary?: string
  rawEventRefs?: string[]
}

export type ChildAgentKind =
  | 'claude-task'
  | 'codex-background'
  | 'kimi-swarm'
  | 'grok-agent'
  | 'cursor-agent'
  | 'gemini-subagent'
  | 'manual'
export type ChildAgentInteractivity = 'interactive' | 'oneshot' | 'observe-only'
export type ChildAgentState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface ChildAgentThread {
  id: string
  parentChatId?: string
  parentRunId?: string
  /** The tool_use id of the Task/Agent call that produced this thread (when applicable). */
  parentToolCallId?: string
  provider: ProviderId
  kind: ChildAgentKind
  interactivity: ChildAgentInteractivity
  name: string
  role?: string
  state: ChildAgentState
  startedAt?: string
  endedAt?: string
  durationMs?: number
  seedPrompt?: string
  finalResult?: string
  /** Tool activity ids that belong to this child thread. */
  toolActivityIds: string[]
  /** Visual identity (display name + color) assigned by `assignAgentIdentity`.
   * For Codex this may carry a platform-extracted name; for other providers it
   * comes from our bespoke nickname pool. Persisted to
   * `ChatRecord.providerMetadata.agentIdentities` so the same thread keeps the
   * same identity across renders and app reloads. */
  identity?: AgentIdentity
}

/** Source of a subagent's display identity. */
export type AgentIdentitySource = 'pool' | 'platform' | 'manual'

/** Visual identity for a single sub-agent. Indexed by `ChildAgentThread.id`
 * inside `ChatRecord.providerMetadata.agentIdentities`. */
export interface AgentIdentity {
  agentId: string
  /** Display name shown in chips, cards, panels. */
  name: string
  /** Accent color (hex). Drives chip color, card name color, dot color. */
  color: string
  /** Generated fallback-identity slug when this identity maps to a named SVG. */
  slug?: string
  /** Generated fallback-identity accent. Mirrors `color` for named SVG identities. */
  accent?: string
  /** Optional role label (e.g. "explorer", "reviewer"). */
  role?: string
  source: AgentIdentitySource
  /** ISO timestamp the identity was assigned. */
  assignedAt: string
}

/**
 * Aggregated work profile for a Settings → Roster pooled Agent
 * (`pooled-agent-<uuid>`), folded from the per-Agent stats ledger. Attribution
 * accrues from first pool-use forward (no backfill); a fresh / never-run Agent
 * has all-zero counters. `±lines` / `filesTouched` are run-LEVEL coverage
 * estimates — `runsWithDiffUnavailable` reports how many finalized runs carried
 * no diff so the UI can qualify the figure ("N of M runs").
 */
export interface PooledAgentStatsSummary {
  agentId: string
  /** Finalized runs attributed to this agent. */
  runs: number
  success: number
  failed: number
  cancelled: number
  tokensIn: number
  tokensOut: number
  tokensTotal: number
  costUsd: number
  durationMs: number
  linesAdded: number
  linesRemoved: number
  filesTouched: number
  /** Distinct chat ids this agent participated in. */
  distinctChats: number
  /** Finalized runs with no run-diff available (so ±lines is undercounted). */
  runsWithDiffUnavailable: number
  /** Most-recent attributed run finalize time (ms epoch), 0 if never run. */
  lastRunAt: number
}

export type TrustStatus = 'trusted' | 'untrusted' | 'inherited' | 'unknown' | 'not_checked'

export interface TrustStatusResult {
  status: TrustStatus
  reason?: string
  isSessionOnly?: boolean
}

/**
 * Result of a persistent workspace-trust WRITE (the one-click
 * "Trust this folder" button that writes ~/.gemini/trustedFolders.json
 * directly, replacing the broken interactive `/permissions trust`
 * terminal flow). `status` is the resulting trust state ('trusted' on
 * success); `path` is the canonical realpath that was keyed into the
 * trust file.
 */
export interface TrustWriteResult {
  ok: boolean
  status: TrustStatus
  path?: string
  reason?: string
}

export interface GeminiSessionSummary {
  id: string
  title?: string
  createdAt?: string
  updatedAt?: string
  raw?: string
}

export interface GeminiSessionListResult {
  ok: boolean
  sessions: GeminiSessionSummary[]
  rawLines: string[]
  error?: string
}

export interface WorkspaceFileEntry {
  path: string
  name: string
  isDirectory: boolean
  sizeBytes?: number
  depth: number
  hasChildren?: boolean
}

export interface WorkspaceFileReadResult {
  path: string
  content: string
  sizeBytes: number
  mtimeMs?: number
  etag?: string
  changeSet?: WorkspaceChangeSet
}

export type DiffFileStatus =
  | 'modified'
  | 'created'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'binary'
  | 'too_large'
  | 'hidden_sensitive'
  | 'noise'

export type DiffPreviewKind =
  | 'git_diff'
  | 'synthetic_new_file'
  | 'text_preview'
  | 'binary'
  | 'hidden'
  | 'none'

export interface DiffFileSummary {
  path: string
  status: DiffFileStatus
  additions?: number
  deletions?: number
  isBinary?: boolean
  isNoise?: boolean
  isSensitive?: boolean
  previewKind: DiffPreviewKind
  diffText?: string
  diffTextTruncated?: boolean
  diffTextOmittedLines?: number
  diffTextOriginalBytes?: number
  sizeBytes?: number
  staged?: boolean
  unstaged?: boolean
}

export interface WorkspaceSnapshot {
  capturedAt: string
  isGitRepo: boolean
  workspacePath?: string
  gitStatus?: string // git status --porcelain=v1 -z output
  files?: FileSnapshot[]
}

export interface FileSnapshot {
  path: string
  sizeBytes: number
  mtimeMs: number
  hash?: string
}

export interface RunDiffResult {
  runId: string
  preSnapshot: WorkspaceSnapshot
  postSnapshot?: WorkspaceSnapshot
  changeSetId?: string
  createdFiles: DiffFileSummary[]
  modifiedFiles: DiffFileSummary[]
  deletedFiles: DiffFileSummary[]
  preExistingFiles: DiffFileSummary[]
}

export type WorkspaceChangeSource =
  | 'provider_run'
  | 'editor'
  | 'host_command'
  | 'checkpoint'
  | 'worktree'
  | 'system'

export type WorkspaceChangeStatus = 'captured' | 'failed' | 'superseded'

export type WorkspaceChangeFileOrigin =
  | 'run_diff'
  | 'manual_edit'
  | 'tool_activity'
  | 'git_status'
  | 'snapshot'
  | 'pre_existing'

export type WorkspaceArtifactKind =
  | 'file'
  | 'directory'
  | 'diff'
  | 'snapshot'
  | 'checkpoint'
  | 'worktree'

export interface WorkspaceChangeFile {
  path: string
  status: DiffFileStatus
  origin: WorkspaceChangeFileOrigin
  additions?: number
  deletions?: number
  sizeBytes?: number
  isBinary?: boolean
  isNoise?: boolean
  isSensitive?: boolean
  previewKind?: DiffPreviewKind
  diffText?: string
  diffTextTruncated?: boolean
  diffTextOmittedLines?: number
  diffTextOriginalBytes?: number
}

export interface WorkspaceChangeArtifact {
  id: string
  kind: WorkspaceArtifactKind
  path?: string
  label?: string
  source: WorkspaceChangeSource
  sizeBytes?: number
  metadata?: Record<string, unknown>
}

export interface WorkspaceChangeWorktreeContext {
  enabled: boolean
  name?: string
  baseWorkspacePath?: string
  effectivePath?: string
}

export interface WorkspaceChangeCheckpointContext {
  enabled: boolean
  provider?: ProviderId
  checkpointId?: string
  label?: string
}

export interface WorkspaceChangeStats {
  filesCreated: number
  filesModified: number
  filesDeleted: number
  filesPreExisting: number
  artifactsGenerated: number
  additions: number
  deletions: number
}

export interface WorkspaceChangeSet {
  schemaVersion: 1
  id: string
  source: WorkspaceChangeSource
  status: WorkspaceChangeStatus
  title: string
  summary?: string
  workspaceId?: string
  workspacePath: string
  effectiveWorkspacePath?: string
  chatId?: string
  runId?: string
  provider?: ProviderId
  createdAt: string
  updatedAt: string
  preSnapshot?: WorkspaceSnapshot
  postSnapshot?: WorkspaceSnapshot
  files: WorkspaceChangeFile[]
  artifacts: WorkspaceChangeArtifact[]
  worktree?: WorkspaceChangeWorktreeContext
  checkpoint?: WorkspaceChangeCheckpointContext
  stats: WorkspaceChangeStats
  metadata?: Record<string, unknown>
}

export type WorkspaceChangeSetInput = Omit<
  WorkspaceChangeSet,
  'schemaVersion' | 'id' | 'status' | 'createdAt' | 'updatedAt' | 'stats' | 'files' | 'artifacts'
> &
  Partial<
    Pick<
      WorkspaceChangeSet,
      'id' | 'status' | 'createdAt' | 'updatedAt' | 'stats' | 'files' | 'artifacts'
    >
  >

export interface WorkspaceRunChangeInput {
  runId: string
  chatId?: string
  workspaceId?: string
  workspacePath: string
  effectiveWorkspacePath?: string
  provider?: ProviderId
  runDiff: RunDiffResult
  worktree?: WorkspaceChangeWorktreeContext
  checkpoint?: WorkspaceChangeCheckpointContext
  metadata?: Record<string, unknown>
}

export interface WorkspaceEditorChangeInput {
  workspaceId?: string
  workspacePath: string
  effectiveWorkspacePath?: string
  chatId?: string
  filePath: string
  existedBefore: boolean
  deleted?: boolean
  previousContent?: string
  nextContent: string
  sizeBytes?: number
  metadata?: Record<string, unknown>
}

export interface WorkspaceChangeFilter {
  workspaceId?: string
  workspacePath?: string
  chatId?: string
  runId?: string
  provider?: ProviderId
  sources?: WorkspaceChangeSource[]
  statuses?: WorkspaceChangeStatus[]
  since?: string
  limit?: number
}

export type BenchmarkArtifactKind =
  | 'stdout'
  | 'stderr'
  | 'file'
  | 'directory'
  | 'snapshot'
  | 'diff'
  | 'score'
  | 'other'

export interface BenchmarkPinnedFile {
  path: string
  sizeBytes: number
  sha256: string
  mtimeMs?: number
  mode?: number
}

export interface BenchmarkGitManifest {
  root?: string
  head?: string
  branch?: string
  dirty: boolean
  statusPorcelain?: string
  trackedFiles?: BenchmarkPinnedFile[]
}

export type BenchmarkScorerKind =
  | 'exact_match'
  | 'regex_match'
  | 'file_exists'
  | 'artifact_exists'
  | 'json_field_equals'

export interface BenchmarkScorerDefinition {
  id: string
  kind: BenchmarkScorerKind
  weight?: number
  target?: string
  expected?: unknown
  pattern?: string
  flags?: string
  path?: string
  sha256?: string
  artifactName?: string
  artifactKind?: BenchmarkArtifactKind
  metadata?: Record<string, unknown>
}

export interface BenchmarkTaskManifest {
  schemaVersion: 1
  id: string
  title: string
  prompt: string
  provider?: ProviderId
  workspacePath?: string
  inputFiles?: string[]
  expectedArtifacts?: Array<{
    name: string
    kind: BenchmarkArtifactKind
    sha256?: string
  }>
  scorers: BenchmarkScorerDefinition[]
  metadata?: Record<string, unknown>
}

export interface BenchmarkEnvironmentManifest {
  schemaVersion: 1
  capturedAt: string
  platform: NodeJS.Platform
  arch: NodeJS.Architecture
  nodeVersion: string
  appVersion?: string
  workspacePath?: string
  git?: BenchmarkGitManifest
  files: BenchmarkPinnedFile[]
  env?: Record<string, string>
}

export interface BenchmarkArtifactRecord {
  id: string
  runId: string
  kind: BenchmarkArtifactKind
  name: string
  relativePath: string
  absolutePath?: string
  sha256: string
  sizeBytes: number
  createdAt: string
  metadata?: Record<string, unknown>
}

export interface BenchmarkScoreResult {
  scorerId: string
  kind: BenchmarkScorerKind
  passed: boolean
  score: number
  maxScore: number
  message?: string
  metadata?: Record<string, unknown>
}

export interface BenchmarkEvaluationReport {
  schemaVersion: 1
  taskId: string
  evaluatedAt: string
  score: number
  maxScore: number
  passed: boolean
  results: BenchmarkScoreResult[]
}

export interface BenchmarkRunManifest {
  schemaVersion: 1
  id: string
  taskId: string
  runId?: string
  provider?: ProviderId
  workspacePath?: string
  createdAt: string
  taskManifestSha256: string
  environmentManifestSha256: string
  promptSha256: string
  task: BenchmarkTaskManifest
  environment: BenchmarkEnvironmentManifest
  artifacts: BenchmarkArtifactRecord[]
  evaluation?: BenchmarkEvaluationReport
  metadata?: Record<string, unknown>
}
