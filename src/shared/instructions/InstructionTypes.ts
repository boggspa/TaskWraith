/**
 * Custom instructions + prompt-envelope vocabulary (2026-08).
 *
 * TaskWraith does not own one universal system prompt — it composes a
 * TaskWraith instruction envelope (usually as user-message content) while
 * several providers add private, provider-native system context the host
 * cannot inspect. These types describe the two USER-owned instruction layers
 * TaskWraith resolves before composition (a global document under userData
 * and a per-workspace `TASKWRAITH.md`), plus the per-run envelope snapshot
 * the Prompt Inspector renders.
 *
 * Precedence contract (host-enforced, not merely prompt-stated):
 *   runtime capability facts → global defaults → workspace defaults →
 *   chat/participant role → current explicit request.
 * Instruction layers can bias style and workflow; they can never grant
 * permissions, enable tools, or alter approval posture — those remain
 * host-owned capability facts.
 */

/** Workspace-root instruction file name. Provider-neutral on purpose:
 * `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` carry provider-specific loading
 * semantics, and a dot-directory home would be invisible in the workspace
 * file editor (dot-entries are skipped there). */
export const WORKSPACE_INSTRUCTIONS_FILE = 'TASKWRAITH.md'

/**
 * Hard per-layer byte ceiling. An over-cap layer is SKIPPED whole, never
 * truncated — instructions cut mid-sentence can invert meaning ("never do X"
 * losing its object), so refusal-with-reason is the honest failure mode.
 */
export const INSTRUCTION_LAYER_MAX_BYTES = 65_536

export type InstructionScope = 'global' | 'workspace'

export type InstructionLayerStatus = 'applied' | 'absent' | 'disabled' | 'skipped'

export type InstructionSkipReason =
  /** File larger than INSTRUCTION_LAYER_MAX_BYTES. */
  | 'too_large'
  /** Bytes do not strictly decode as UTF-8. */
  | 'invalid_utf8'
  /** Bidi override/isolate controls or C0 controls (other than tab/newline)
   * present — the Trojan-Source class. Refused, never silently stripped. */
  | 'unsafe_characters'
  /** The instruction file itself is a symlink. */
  | 'symlink_refused'
  /** Realpath resolution left the canonical workspace root. */
  | 'outside_workspace'
  /** Filesystem error while reading (permissions, transient IO). */
  | 'unreadable'
  /** Compose-time skip: small local models get bare prompts on
   * conversational turns by design; scaffolding (including instructions)
   * is withheld there and reported honestly. */
  | 'conversational_turn'

export interface ResolvedInstructionLayer {
  scope: InstructionScope
  /** Human-readable source label ("Settings → Custom Instructions" or the
   * workspace-relative file name). */
  source: string
  status: InstructionLayerStatus
  skipReason?: InstructionSkipReason
  /** SHA-256 (hex) of the normalized applied content. Present when applied. */
  sha256?: string
  /** Raw on-disk byte length (pre-normalization). Present when the source
   * exists, including skipped layers. */
  bytes?: number
  /** Normalized instruction text. Present only when status === 'applied'. */
  content?: string
}

export interface ResolvedInstructionContext {
  /** Global first, then workspace — the order they enter the envelope.
   * A run with no workspace scope simply has no workspace layer. */
  layers: ResolvedInstructionLayer[]
  /**
   * Stable digest over the applied layers (scope + content hash), or the
   * literal 'none' when nothing applied. This is the replacement-block stamp:
   * a session-carrying provider seat re-receives the instruction block only
   * when this digest differs from the one recorded on the chat.
   */
  digest: string
  /** Mirror of the user setting; false lists both layers as 'disabled'. */
  enabled: boolean
}

// ============================================================================
// Prompt-envelope snapshot — the Inspector's "Layers" view.
// ============================================================================

/** Envelope layer identifiers, in top-to-bottom composed-prompt order. */
export type PromptEnvelopeLayerId =
  | 'simulator_canvas_hint'
  | 'browser_canvas_hint'
  | 'runtime_preamble'
  | 'ultratask_note'
  | 'recon_steer'
  | 'image_tools_note'
  | 'instructions_global'
  | 'instructions_workspace'
  | 'session_start_hooks'
  | 'skill_discovery'
  | 'compaction_summary'
  | 'conversation_context'
  | 'peer_context'
  | 'active_goal'
  | 'work_contract'
  | 'ollama_session_memory'
  | 'ollama_workflow_hint'
  | 'current_request'

export type PromptEnvelopeLayerState = 'applied' | 'skipped' | 'inherited' | 'opaque' | 'redacted'

export interface PromptEnvelopeLayerSnapshot {
  id: PromptEnvelopeLayerId
  label: string
  state: PromptEnvelopeLayerState
  /** Why a layer was skipped/inherited (e.g. 'resumed session carries it'). */
  reason?: string
  sha256?: string
  bytes?: number
  /** Full layer text. Persisted only when the user's raw-event storage
   * setting is on; metadata above persists regardless. */
  content?: string
}

/**
 * Accuracy labels, verbatim product contract:
 * - 'composed'  → "Exact TaskWraith request" as composed, BEFORE the provider
 *                 adapter; transport fallback can still change the wire form.
 * - 'wire'      → captured at the provider's final launch boundary.
 * Provider-owned/private system context is always 'opaque' — never claimed.
 */
export type PromptEnvelopeAccuracy = 'composed' | 'wire'

export interface WirePromptCapture {
  /** Which provider transport produced this capture. */
  transport: string
  /** Ordinal dispatch attempt (retries/fallbacks append, never overwrite). */
  attempt: number
  capturedAt: string
  /** e.g. 'system' | 'user' | 'kickoff' | 'argv' — transport-specific role. */
  part: string
  sha256: string
  bytes: number
  /** Present only when raw-event storage is on. */
  content?: string
  /** Named host-side transforms applied after composition (mode preamble,
   * goal preamble, broker receipt, image instructions…). */
  transforms?: string[]
}

export interface PromptEnvelopeSnapshot {
  version: 1
  composedAt: string
  provider: string
  model?: string
  accuracy: PromptEnvelopeAccuracy
  layers: PromptEnvelopeLayerSnapshot[]
  /** Digest + size of the full composed prompt string. */
  composedSha256: string
  composedBytes: number
  /** True when layer/wire content fields were persisted (raw events on). */
  contentStored: boolean
  /** Instruction-resolution digest that fed this composition ('none' when
   * nothing applied) — joins seat-generation cache evidence. */
  instructionsDigest: string
  /** Wire-boundary captures, appended per dispatch attempt. */
  wire?: WirePromptCapture[]
}
