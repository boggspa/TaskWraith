/**
 * GeminiApiProvider.
 *
 * In-process Gemini runtime built on `@google/genai`. It coexists alongside
 * the CLI provider (`runGeminiProvider` in `src/main/index.ts`) so users can
 * choose the auth/runtime path that works for their environment.
 *
 * Step 1 (scaffold) landed `loadOptionalGeminiSdk` + a no-op stub.
 * Step 2 lit up bare-bones streaming:
 *   - Gating on `AppSettings.geminiApiRuntime` (auto/always/never).
 *   - Auth resolution via the active `GeminiAuthProfile` (api-key only).
 *   - SDK instantiation + `models.generateContentStream` consumption.
 *   - Streaming text deltas to the renderer via `sendAgentCompatLine`
 *     using the same `{ type: 'content', text }` envelope the existing
 *     Gemini CLI adapter already speaks (so GeminiStreamAdapter
 *     understands it unchanged).
 *   - Abort wiring through `runManager.attachAbortController` so the
 *     existing 'Stop' button cancels mid-stream.
 *   - Final `result` event carries `usageMetadata` for future Step-8
 *     quota persistence.
 *
 * Step 3 lit up function calling:
 *   - Per-turn translation of `mcpToolDefinitions()` into Gemini's
 *     `FunctionDeclaration[]` shape (see `GeminiApiToolDeclarations.ts`).
 *   - Outer round loop: stream → collect function calls → dispatch via
 *     host-side `executeGeminiMcpTool` → feed responses back → repeat.
 *   - Hard cap at MAX_TOOL_ROUNDS (20) to prevent runaway loops.
 *   - Abort is checked between rounds AND between dispatches, so a
 *     mid-tool-loop cancel exits cleanly with code 130.
 *   - Approval gates, audit events, and tool_use/tool_result emission
 *     come for free — `executeGeminiMcpTool` already handles all of
 *     those internally. We don't re-implement.
 *
 * Step 5 lit up multi-turn continuity:
 *   - History replay: prior `ChatMessage[]` → Gemini `Content[]` via
 *     `GeminiApiHistoryAdapter.buildGeminiTurnContents`, prepended to
 *     the current user turn. The renderer pre-trims to
 *     `chatContextTurns`, so the in-flight request stays bounded.
 *   - Synthetic `api://<appChatId>` session id persisted onto
 *     `ChatRecord.linkedProviderSessionId` after each successful run,
 *     overwriting any legacy `cli://...` value but leaving an existing
 *     `api://...` value alone (idempotent). Keeps the renderer's
 *     "session continuity" UI working when we're not really using a
 *     server-side session.
 *
 * Steps 7+8+9 (this file) round out the image / usage / migration story:
 *   - Step 7 (image input): when `payload.imagePaths` is non-empty, each
 *     file is mime-sniffed by extension and attached as an `inlineData`
 *     part (base64) when ≤20MB, or uploaded via `client.files.upload`
 *     and referenced as `fileData.fileUri` when larger. Image parts go
 *     BEFORE the text part in the current user turn (Gemini convention).
 *     Unsupported extensions are warned + skipped — never a hard fail.
 *     Replayed history is text-only by design (prior images would be
 *     stale paths anyway), so the model only sees images attached to
 *     the current turn.
 *   - Step 8 (usage persistence): the API's `usageMetadata` is routed
 *     into the existing `AppStore.recordUsage` IPC via a new optional
 *     `deps.recordUsage` hook. Best-effort: a save failure is swallowed
 *     so the user-visible run still completes cleanly.
 *   - Step 9 (migration banner): a chat that has `linkedGeminiSessionId`
 *     (i.e. it used to run via the CLI) and is taking its FIRST turn on
 *     the API path gets a one-time `role: system` notice appended noting
 *     the runtime swap. The gate fires once per chat — the same chat
 *     never sees a duplicate notice on subsequent API turns.
 *
 * Still TODO in later steps:
 *   - Step 10: polish + SDK-load smoke + AGENTS.md note.
 *   - vertex-ai / google-oauth profile kinds (Step 2 only handles
 *     `api-key`; other kinds fall through to the CLI path).
 *
 * IMPORTANT: do NOT import `@google/genai` at module load. The dep is
 * `optionalDependencies`-shaped (declared but may not be installed in
 * every environment, e.g. CI without the optional bucket). Use only
 * the dynamic `import()` inside `loadOptionalGeminiSdk` so typecheck
 * and bundling stay clean when the SDK is absent.
 */

import { promises as fsPromises } from 'fs'
import { extname } from 'path'
import type { AgentRunPayload, AgentRunRoute } from './run/AgentRunTypes'
import { geminiUsageMetadataToStats } from './ProviderRunStats'
import type {
  AppSettings,
  ChatMessage,
  ChatRecord,
  GeminiAuthProfile,
  ProviderId,
  UsageRecord
} from './store/types'
import type { RunManager, RunSessionStatus } from './RunManager'
import { buildGeminiFunctionDeclarations } from './GeminiApiToolDeclarations'
import { buildGeminiTurnContents, type GeminiContentPart } from './GeminiApiHistoryAdapter'

/** Hard cap on how many tool-call rounds we permit inside a single
 *  Gemini turn. Each round adds one model response + at least one tool
 *  dispatch to the conversation. A pathological loop (model keeps
 *  asking for the same tool) would otherwise spin forever. 20 is well
 *  above the natural ceiling for any sane agent task (most settle in
 *  1-5 rounds) and well below where token budgets become punitive. */
const MAX_TOOL_ROUNDS = 20

/** Cutoff for `inlineData` (base64) vs. `files.upload` (`fileData`).
 *  Gemini accepts inline payloads up to ~20MB before request size pressure
 *  starts to bite (slower TTFB, occasional truncation). Above that we
 *  upload via the Files API and reference the returned URI — same model
 *  visibility, much smaller user-turn payload. The exact boundary is a
 *  policy call; 20MB matches the documented per-request inline limit. */
const INLINE_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** Extension → mime-type map for image inputs. We sniff by extension
 *  rather than reading magic bytes because (1) the renderer typically
 *  only attaches paths picked through the OS file picker and (2)
 *  reading the first N bytes for sniffing would double the IO cost
 *  for small files. Unknown extensions get warned + skipped — never
 *  fail the whole run.
 *
 *  `image/heic` is included for forward-compat with Apple Photos
 *  attachments — the Gemini API doesn't natively accept HEIC today but
 *  may in future. Listed so users with HEIC attachments at least see
 *  a coherent attempt rather than a silent drop. */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heic'
}

/** Pick a mime-type from a path's extension. Returns null for unknown
 *  extensions so the caller can warn + skip. */
function sniffImageMimeType(imagePath: string): string | null {
  const ext = extname(imagePath).toLowerCase()
  if (!ext) return null
  return IMAGE_MIME_BY_EXTENSION[ext] || null
}

/** Shape the function-calling loop expects out of the MCP tool list
 *  and the executor. Kept narrow on purpose so `index.ts` can satisfy
 *  the contract with the existing `mcpToolDefinitions()` /
 *  `executeGeminiMcpTool` helpers without inventing a new wire format. */
export interface GeminiApiMcpToolDescriptor {
  name?: string
  description?: string
  inputSchema?: unknown
}

export interface GeminiApiMcpExecutionResult {
  text: string
  isError?: boolean
}

/**
 * Attempt to dynamically import `@google/genai`. Returns `null` if the
 * dep is absent so the caller can fall back to the CLI provider. Mirrors
 * `loadOptionalClaudeSdk` in `src/main/index.ts`. The `new Function`
 * wrapper around `import` is the same trick used there to keep bundlers
 * from statically resolving the specifier — without it, electron-vite
 * would either fail at build time or bake the missing dep into the
 * production bundle.
 */
export async function loadOptionalGeminiSdk(): Promise<any | null> {
  try {
    const importer = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<any>
    return await importer('@google/genai')
  } catch {
    return null
  }
}

/**
 * Dependency surface for `tryRunGeminiApi`. Lets `index.ts` pass its
 * module-local helpers in without forcing GeminiApiProvider to import
 * back from `index.ts` at runtime (which would create a circular import
 * — `index.ts` already imports this module). Also makes the function
 * trivially testable: tests inject a mock `loadSdk` that yields a
 * scripted stream + capture closures for the send/finish helpers.
 */
export interface GeminiApiProviderDeps {
  sendAgentCompatLine: (
    sender: Electron.WebContents,
    provider: ProviderId,
    payload: any,
    route?: AgentRunRoute | null
  ) => void
  sendAgentCompatError: (
    sender: Electron.WebContents,
    provider: ProviderId,
    error: string,
    route?: AgentRunRoute | null
  ) => void
  sendAgentCompatExit: (
    sender: Electron.WebContents,
    provider: ProviderId,
    code: number | null,
    route?: AgentRunRoute | null
  ) => void
  /**
   * Combined-mode AntiGravity reuse (2026-07): the provider identity this
   * turn's events, terminal transitions, and usage rows are attributed to.
   * Defaults to 'gemini' — the retired gemini path is byte-identical without
   * it. The AntiGravity gemini-api lane passes 'antigravity' so the renderer
   * lanes, session-keyed event authority, labels, and the API-spend meter all
   * see the run under the provider the user actually picked.
   */
  providerTag?: ProviderId
  /**
   * Bypasses the gemini auth-profile system AND the `geminiApiRuntime`
   * settings gate. The AntiGravity lane resolves its key from the dedicated
   * post-ready secret store; a returned error is emitted verbatim as the
   * run's failure (fixed nonsecret copy only — never raw provider detail).
   * When absent, the legacy profile resolution runs unchanged.
   */
  resolveAuthOverride?: () => { ok: true; apiKey: string } | { ok: false; error: string }
  /**
   * Model id to write into usage rows (and nothing else). The AntiGravity
   * lane records the full `gemini-api:<model>` wire id so the API-spend
   * aggregation's rate-table keys match; the resolved bare model still goes
   * to the SDK. Defaults to the resolved model.
   */
  usageModelId?: string
  /** `runtime` field stamped on init/result events. Defaults to 'api-sdk'. */
  runtimeLabel?: string
  runManager: Pick<RunManager<any>, 'attachAbortController' | 'finish'>
  getSettings: () => AppSettings
  getGeminiAuthProfiles: () => GeminiAuthProfile[]
  getDefaultGeminiAuthProfileId: () => string | null
  decryptApiKey: (stored?: string | null) => string | null
  /** Phase M1 Step 3: snapshot of `mcpToolDefinitions()` from
   *  `src/main/index.ts`. Re-read at the start of each turn so a
   *  hot-reload / tool-list change picks up without restarting the
   *  app. Empty array disables function calling entirely (the model
   *  can only emit text). */
  getMcpToolDefinitions: () => ReadonlyArray<GeminiApiMcpToolDescriptor>
  /** Phase M1 Step 3: dispatch a tool call. Wraps the host-side
   *  `executeGeminiMcpTool` from `src/main/index.ts` which already
   *  handles approval gates, audit events, tool_use/tool_result
   *  emission, and durable run events. We MUST NOT re-implement any
   *  of that here — just route to the executor. */
  executeMcpTool: (
    toolName: string,
    args: unknown,
    route: AgentRunRoute | null
  ) => Promise<GeminiApiMcpExecutionResult>
  /** Phase M1: install the host-side tool context for API-runtime
   * function calls. The API path does not spawn the Gemini CLI MCP
   * bridge, but it still routes model function calls through the same
   * host executor, so `index.ts` must register sender/cwd/run metadata
   * before the first possible tool call. */
  prepareToolContext?: (
    sender: Electron.WebContents,
    payload: AgentRunPayload,
    route: AgentRunRoute,
    sessionId: string
  ) => Promise<void> | void
  /** Phase M1 Step 5: chat-history accessor for multi-turn replay. The
   *  API path is stateless per request, so to give the model the same
   *  multi-turn awareness the CLI gets via `--resume`, we read the
   *  chat's prior `ChatMessage[]` and convert them to Gemini
   *  `Content[]` (see `GeminiApiHistoryAdapter.ts`). Returns `null`
   *  for non-existent chats — that just collapses to a first-turn
   *  request. Tests can stub this trivially with a closure. */
  getChat?: (chatId: string) => ChatRecord | null | undefined
  /** Phase M1 Step 5: persist the synthetic `api://<appChatId>` session
   *  id back onto the chat record after the first successful API run.
   *  The renderer's continuity UI keys off `linkedProviderSessionId`
   *  (it shows "Resuming session …" / colors the chat icon / etc.) so
   *  if we leave the field empty the user sees "fresh chat" on every
   *  turn even though we're sending replay history.
   *
   *  Implementations should:
   *    - leave an existing `api://...` id alone (idempotent)
   *    - overwrite `cli://...` ids (treat as legacy from before the
   *      runtime switch)
   *    - set when missing
   *
   *  Optional so existing tests that don't exercise persistence can
   *  omit it without churn. */
  saveChatLinkedSessionId?: (chatId: string, sessionId: string) => void
  /** Phase M1 Step 7: read an image file at the host. Defaults to
   *  `fs.promises.readFile` if absent. Tests inject a stub so they can
   *  simulate arbitrary file sizes without touching the disk. Returns
   *  the raw bytes so the provider can decide between `inlineData`
   *  (base64) and `files.upload` based on size. Returning `null` (or
   *  throwing) skips the image with a warning — same behaviour as an
   *  unsupported extension. */
  readImageFile?: (imagePath: string) => Promise<Buffer | null>
  /** Phase M1 Step 8: persist a usage record. Defaults to no-op if
   *  absent so existing tests stay green without wiring AppStore.
   *  Wrapped in try/catch internally — a save failure never fails the
   *  user-visible run. Field mapping (provider/model/workspaceId/etc.)
   *  is the provider's responsibility; the dep just hands the row to
   *  the storage layer. */
  recordUsage?: (entry: Omit<UsageRecord, 'id' | 'timestamp'>) => void
  /** Phase M1 Step 9: append a single system-role message to a chat's
   *  transcript (the migration notice). Implementations should
   *  read-modify-write the chat record, then broadcast `chat-updated`
   *  so the renderer picks up the new entry without a manual refresh.
   *  Optional so older tests can omit it; when absent, no notice is
   *  emitted (the run still completes normally). */
  appendChatSystemMessage?: (chatId: string, message: ChatMessage) => void
  /** Optional SDK loader override; defaults to `loadOptionalGeminiSdk`.
   *  Tests pass a synthetic SDK to avoid real network calls. */
  loadSdk?: () => Promise<any | null>
}

/** Default model used when the payload doesn't specify one or specifies
 *  a CLI-flavoured placeholder (`cli-default`, `auto`, etc.). Step 6
 *  will wire the real model picker; for now this keeps the API path
 *  functional for smoke testing. The 2.0 Flash family is the cheapest
 *  generally-available API model that streams reliably. */
const DEFAULT_GEMINI_API_MODEL = 'gemini-2.0-flash'

/** Synthetic `session_id` prefix for the API path. The renderer's
 *  GeminiAdapter stores `session_id` as `linkedProviderSessionId` for
 *  later resume — but the API SDK is stateless per-request, so we mint
 *  a per-chat synthetic id rather than leaving the field empty (an
 *  empty id breaks downstream UI assumptions). The `api://` scheme
 *  makes it obvious in logs that this id is not a real provider
 *  session token. */
const API_SESSION_ID_PREFIX = 'api://'

function resolveGeminiApiModel(requested?: string | null): string {
  const trimmed = typeof requested === 'string' ? requested.trim() : ''
  if (
    !trimmed ||
    trimmed === 'cli-default' ||
    trimmed === 'auto' ||
    trimmed === 'default' ||
    trimmed === 'custom'
  ) {
    return DEFAULT_GEMINI_API_MODEL
  }
  // Aliases that match the CLI's friendly names.
  if (trimmed === 'pro') return 'gemini-2.5-pro'
  if (trimmed === 'flash') return 'gemini-2.5-flash'
  if (trimmed === 'flash-lite') return 'gemini-2.5-flash-lite'
  return trimmed
}

function syntheticApiSessionId(route: AgentRunRoute): string {
  // Prefer the chat id (stable across runs for the same chat); fall
  // back to the run id (unique per turn) so we never emit an empty
  // session id. Renderer treats both as opaque strings.
  return `${API_SESSION_ID_PREFIX}${route.appChatId || route.appRunId || 'unknown'}`
}

function selectGeminiAuthProfile(
  payload: AgentRunPayload,
  deps: GeminiApiProviderDeps
): GeminiAuthProfile | null {
  const profiles = deps.getGeminiAuthProfiles()
  if (!profiles.length) return null
  const requestedId = payload.geminiAuthProfileId || deps.getDefaultGeminiAuthProfileId()
  if (!requestedId) return null
  return profiles.find((profile) => profile.id === requestedId) || null
}

/** Extract the streaming text delta from a single `generateContentStream`
 *  chunk. The SDK exposes a `text` getter that concatenates all text
 *  parts from the first candidate; we prefer that for forward
 *  compatibility. Falls back to a manual walk of
 *  `candidates[0].content.parts` so the function doesn't break if the
 *  SDK changes the getter's behaviour. */
/**
 * 1.0.4-AD — drop literal `[Thought: true|false]` prefixes that some
 * Gemini SDK paths embed in text payloads. We've seen these bleed
 * through into ensemble transcripts as visible chat content. The
 * primary defence is the `part.thought === true` filter in
 * `chunkText` below; this stripper is the belt-and-braces second
 * line for the case where Gemini ever returns thought-flagged text
 * inside an unflagged part (or via the `chunk.text` fast-path).
 */
function stripThoughtMarkers(text: string): string {
  return text.replace(/\[Thought:\s*(true|false)\]\s*/g, '')
}

// Exported for test coverage (1.0.4-AD). The thinking-bleed filter
// inside `chunkText` is the safest single point to verify the fix,
// and the regression suite can reach it via this alias without
// having to stand up a full streaming-SDK harness.
export function chunkTextForTest(chunk: any): string {
  return chunkText(chunk)
}

// Companion to `chunkText`: extract ONLY the `thought: true` parts so the
// model's reasoning can be surfaced as a streamed reasoning note (rather than
// silently dropped). Exported for test coverage.
export function chunkThoughtTextForTest(chunk: any): string {
  return chunkThoughtText(chunk)
}

function chunkThoughtText(chunk: any): string {
  if (!chunk) return ''
  try {
    const parts = chunk.candidates?.[0]?.content?.parts
    if (Array.isArray(parts)) {
      const texts: string[] = []
      for (const part of parts) {
        if (part && typeof part.text === 'string' && part.thought === true) {
          texts.push(part.text)
        }
      }
      return stripThoughtMarkers(texts.join(''))
    }
  } catch {
    // Defensive: never let chunk shape weirdness crash the loop.
  }
  return ''
}

function chunkText(chunk: any): string {
  if (!chunk) return ''
  // 1.0.4-AD — Gemini's thinking-capable models stream parts with
  // `thought: true` in the SAME `candidates[0].content.parts` array
  // as the visible response. Pre-fix, `chunkText` concatenated
  // every text part regardless of the flag, so the model's internal
  // monologue ("Acknowledging the User's Sign-off, I am
  // recognizing…") got piped straight into the assistant bubble.
  // Filter thought parts out of the visible stream and strip any
  // residual literal markers as defence-in-depth.
  try {
    const parts = chunk.candidates?.[0]?.content?.parts
    if (Array.isArray(parts)) {
      const texts: string[] = []
      for (const part of parts) {
        if (part && typeof part.text === 'string' && part.thought !== true) {
          texts.push(part.text)
        }
      }
      return stripThoughtMarkers(texts.join(''))
    }
  } catch {
    // Defensive: never let chunk shape weirdness crash the loop.
  }
  if (typeof chunk.text === 'string' && chunk.text) {
    return stripThoughtMarkers(chunk.text)
  }
  return ''
}

/** Phase M1 Step 7: load + classify image attachments for the current
 *  user turn. Returns an ordered list of Gemini content parts to PREPEND
 *  to the text part. Each input path is handled independently:
 *    - unsupported extension → log warning, skip
 *    - read fails → log warning, skip
 *    - size ≤ INLINE_IMAGE_MAX_BYTES → `inlineData` with base64
 *    - size > INLINE_IMAGE_MAX_BYTES → `client.files.upload` →
 *      `fileData` with the returned `fileUri`
 *
 *  A skipped image is NEVER a hard failure for the run — the model
 *  just sees fewer attachments. The warning surfaces in the host
 *  console so a developer can debug "why didn't my screenshot land".
 *
 *  The SDK client is passed in because the upload path needs it; it's
 *  fine if it's null (e.g. tests that only exercise inline) — we'll
 *  treat oversized images as "skip + warn" in that case.
 */
async function loadImageParts(
  imagePaths: ReadonlyArray<string>,
  client: any,
  deps: GeminiApiProviderDeps
): Promise<GeminiContentPart[]> {
  if (!imagePaths.length) return []
  const reader =
    deps.readImageFile ||
    (async (path: string): Promise<Buffer | null> => {
      try {
        return await fsPromises.readFile(path)
      } catch (error) {
        console.warn(
          `[GeminiApiProvider] Image read failed for ${path}: ${error instanceof Error ? error.message : String(error)}`
        )
        return null
      }
    })
  const parts: GeminiContentPart[] = []
  for (const imagePath of imagePaths) {
    if (!imagePath || typeof imagePath !== 'string') continue
    const mimeType = sniffImageMimeType(imagePath)
    if (!mimeType) {
      console.warn(`[GeminiApiProvider] Skipping image with unsupported extension: ${imagePath}`)
      continue
    }
    let bytes: Buffer | null
    try {
      bytes = await reader(imagePath)
    } catch (error) {
      console.warn(
        `[GeminiApiProvider] Image read threw for ${imagePath}: ${error instanceof Error ? error.message : String(error)}`
      )
      continue
    }
    if (!bytes) continue
    if (bytes.length <= INLINE_IMAGE_MAX_BYTES) {
      parts.push({
        inlineData: {
          mimeType,
          data: bytes.toString('base64')
        }
      })
      continue
    }
    // Oversized — use the Files API. Falls back to skip+warn if the
    // SDK client is missing the files surface (older SDK build, or a
    // test that didn't mock it).
    const uploader = client?.files?.upload
    if (typeof uploader !== 'function') {
      console.warn(
        `[GeminiApiProvider] Image ${imagePath} exceeds inline limit (${bytes.length} > ${INLINE_IMAGE_MAX_BYTES}) and SDK files.upload is unavailable; skipping.`
      )
      continue
    }
    try {
      const uploaded = await client.files.upload({
        file: imagePath,
        config: { mimeType }
      })
      const fileUri = typeof uploaded?.uri === 'string' ? uploaded.uri : ''
      if (!fileUri) {
        console.warn(`[GeminiApiProvider] files.upload returned no uri for ${imagePath}; skipping.`)
        continue
      }
      parts.push({
        fileData: {
          fileUri,
          mimeType
        }
      })
    } catch (error) {
      console.warn(
        `[GeminiApiProvider] files.upload failed for ${imagePath}: ${error instanceof Error ? error.message : String(error)}`
      )
      continue
    }
  }
  return parts
}

function chunkUsage(chunk: any): Record<string, number> | null {
  const usage = chunk?.usageMetadata
  if (!usage || typeof usage !== 'object') return null
  const out: Record<string, number> = {}
  for (const key of [
    'promptTokenCount',
    'candidatesTokenCount',
    'totalTokenCount',
    'cachedContentTokenCount',
    'thoughtsTokenCount',
    'toolUsePromptTokenCount'
  ]) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    }
  }
  return Object.keys(out).length ? out : null
}

/** Shape of a function-call slot the model emitted during a turn. We
 *  keep `id` optional because the SDK populates it only when the model
 *  emits one (newer models do, 2.0 Flash sometimes omits it). */
interface PendingFunctionCall {
  id?: string
  name: string
  args: Record<string, unknown>
}

/** Extract any function calls from a single streamed chunk. The SDK
 *  exposes a `functionCalls` convenience getter on `GenerateContentResponse`
 *  that flattens the first candidate's `Part[]`; we prefer that for
 *  forward compatibility. Falls back to a manual walk of
 *  `candidates[0].content.parts` for older / mocked shapes. Returns an
 *  empty array when there are no calls in the chunk. */
function chunkFunctionCalls(chunk: any): PendingFunctionCall[] {
  if (!chunk) return []
  const out: PendingFunctionCall[] = []
  const fromGetter = chunk.functionCalls
  if (Array.isArray(fromGetter)) {
    for (const call of fromGetter) {
      if (call && typeof call.name === 'string') {
        out.push({
          id: typeof call.id === 'string' ? call.id : undefined,
          name: call.name,
          args:
            call.args && typeof call.args === 'object' && !Array.isArray(call.args)
              ? (call.args as Record<string, unknown>)
              : {}
        })
      }
    }
    if (out.length) return out
  }
  try {
    const parts = chunk.candidates?.[0]?.content?.parts
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const call = part?.functionCall
        if (call && typeof call.name === 'string') {
          out.push({
            id: typeof call.id === 'string' ? call.id : undefined,
            name: call.name,
            args:
              call.args && typeof call.args === 'object' && !Array.isArray(call.args)
                ? (call.args as Record<string, unknown>)
                : {}
          })
        }
      }
    }
  } catch {
    // Defensive: chunk shape weirdness shouldn't crash the loop.
  }
  return out
}

/**
 * Decide whether the API path should attempt to handle this run, given
 * the user's `geminiApiRuntime` setting + the selected auth profile.
 *
 *   - `never`: always return false (CLI only).
 *   - `auto` : run when an api-key profile is selected, else fall back.
 *   - `always`: run regardless; downstream resolveAuth may still bail.
 *
 * vertex-ai and google-oauth profile kinds are intentionally NOT
 * supported in Step 2 — they need additional auth wiring that lives
 * in later steps. When such a profile is selected we fall through to
 * the CLI even under `always` (the CLI already handles those modes).
 */
export function shouldAttemptGeminiApi(
  payload: AgentRunPayload,
  deps: GeminiApiProviderDeps
): { attempt: boolean; reason?: string } {
  const settings = deps.getSettings()
  const mode = settings.geminiApiRuntime || 'auto'
  if (mode === 'never') {
    return { attempt: false, reason: 'geminiApiRuntime=never' }
  }
  const profile = selectGeminiAuthProfile(payload, deps)
  if (mode === 'auto') {
    if (!profile) return { attempt: false, reason: 'no profile selected' }
    if (profile.kind !== 'api-key') {
      return { attempt: false, reason: `profile kind ${profile.kind} not supported yet` }
    }
    if (!profile.encryptedApiKey) {
      return { attempt: false, reason: 'profile has no api key' }
    }
    return { attempt: true }
  }
  // mode === 'always'
  if (profile && profile.kind !== 'api-key') {
    // Step 2 can't honour vertex/oauth profiles; defer to CLI even
    // under `always` so the user doesn't see hard failures.
    return { attempt: false, reason: `profile kind ${profile.kind} not supported yet` }
  }
  return { attempt: true }
}

/**
 * Attempt to run a Gemini turn via the API SDK path. Returns `true`
 * when the function took ownership of the run (success or handled
 * error) — caller must NOT then fall through to the CLI. Returns
 * `false` only when the API path declined to handle the run before
 * touching the event stream; the caller is free to invoke the CLI
 * provider in that case.
 *
 * Current scope (Steps 2–9):
 *   - Multi-turn continuity via history replay (Step 5).
 *   - Text + tool-call rounds streamed out (Steps 2 + 3).
 *   - Function calling via TaskWraith MCP tools (Step 3).
 *   - Approval gates inherited from `executeGeminiMcpTool` (Step 4).
 *   - Synthetic `api://<chatId>` session id pinned on success (Step 5).
 *   - Image input attached as inlineData / fileData parts (Step 7).
 *   - usageMetadata persisted via recordUsage on success (Step 8).
 *   - One-time migration banner for chats moving CLI → API (Step 9).
 */
export async function tryRunGeminiApi(
  event: Electron.IpcMainInvokeEvent,
  payload: AgentRunPayload,
  route: AgentRunRoute | null,
  deps: GeminiApiProviderDeps
): Promise<boolean> {
  const normalizedRoute: AgentRunRoute = route || {}
  const tag: ProviderId = deps.providerTag ?? 'gemini'
  const runtimeLabel = deps.runtimeLabel ?? 'api-sdk'

  let apiKey: string
  if (deps.resolveAuthOverride) {
    // Combined-mode AntiGravity lane: its admission (disclosure + dedicated
    // secret store) was already applied by the caller; the gemini profile
    // system and geminiApiRuntime gate deliberately do not participate.
    const auth = deps.resolveAuthOverride()
    if (!auth.ok) {
      deps.sendAgentCompatError(event.sender, tag, auth.error, normalizedRoute)
      deps.sendAgentCompatExit(event.sender, tag, 1, normalizedRoute)
      deps.runManager.finish(normalizedRoute.appRunId, 'failed' as RunSessionStatus)
      return true
    }
    apiKey = auth.apiKey
  } else {
    const gating = shouldAttemptGeminiApi(payload, deps)
    if (!gating.attempt) return false

    // Resolve auth: only api-key in Step 2.
    const profile = selectGeminiAuthProfile(payload, deps)
    if (!profile || profile.kind !== 'api-key') {
      return false
    }
    const decrypted = deps.decryptApiKey(profile.encryptedApiKey)
    if (!decrypted) {
      // Profile exists but the key didn't decrypt (likely safeStorage
      // unavailability). Surface a useful error instead of silently
      // falling back so the user knows their profile is misconfigured.
      deps.sendAgentCompatError(
        event.sender,
        tag,
        `Gemini API profile "${profile.label}" has no usable API key; check Settings.`,
        normalizedRoute
      )
      deps.sendAgentCompatExit(event.sender, tag, 1, normalizedRoute)
      deps.runManager.finish(normalizedRoute.appRunId, 'failed' as RunSessionStatus)
      return true
    }
    apiKey = decrypted
  }

  // Load SDK (allow test override).
  const sdk = await (deps.loadSdk || loadOptionalGeminiSdk)()
  const GoogleGenAI = sdk?.GoogleGenAI || sdk?.default?.GoogleGenAI
  if (typeof GoogleGenAI !== 'function') {
    // SDK missing in this environment — defer to CLI.
    return false
  }

  // Set up cancellation: bind an AbortController to the run so the
  // existing 'Stop' button (which routes through runManager.cancel)
  // aborts the stream mid-flight. Mirrors tryRunClaudeSdk's pattern.
  const controller = new AbortController()
  if (normalizedRoute.appRunId) {
    deps.runManager.attachAbortController(normalizedRoute.appRunId, controller)
  }

  const model = resolveGeminiApiModel(payload.model)
  const sessionId = syntheticApiSessionId(normalizedRoute)

  // Emit `init` so the renderer's stream adapter starts the run.
  deps.sendAgentCompatLine(
    event.sender,
    tag,
    {
      type: 'init',
      session_id: sessionId,
      model,
      timestamp: new Date().toISOString(),
      provider: tag,
      runtime: runtimeLabel,
      fallback: false
    },
    normalizedRoute
  )

  let client: any
  try {
    client = new GoogleGenAI({ apiKey })
  } catch (error) {
    const message = `Failed to initialise Gemini API client: ${error instanceof Error ? error.message : String(error)}`
    deps.sendAgentCompatError(event.sender, tag, message, normalizedRoute)
    deps.sendAgentCompatExit(event.sender, tag, 1, normalizedRoute)
    deps.runManager.finish(normalizedRoute.appRunId, 'failed' as RunSessionStatus)
    return true
  }

  if (deps.prepareToolContext) {
    try {
      await deps.prepareToolContext(event.sender, payload, normalizedRoute, sessionId)
      if (normalizedRoute.appRunId) {
        deps.runManager.attachAbortController(normalizedRoute.appRunId, controller)
      }
    } catch (error) {
      const message = `Failed to prepare Gemini API tool context: ${error instanceof Error ? error.message : String(error)}`
      deps.sendAgentCompatError(event.sender, tag, message, normalizedRoute)
      deps.sendAgentCompatExit(event.sender, tag, 1, normalizedRoute)
      deps.runManager.finish(normalizedRoute.appRunId, 'failed' as RunSessionStatus)
      return true
    }
  }

  // Phase M1 Step 5: multi-turn history replay.
  // The API path is stateless per request — there's no `--resume` token
  // — so we read the chat's prior `ChatMessage[]` and prepend them as
  // Gemini `Content[]` before the current user prompt. This is what
  // gives "what's 2+2?" → "double that" the context to answer correctly.
  // When `getChat` is absent (older tests, or when running without a
  // chat record), or when the payload has no `appChatId` (global
  // ad-hoc run, etc.), we degrade gracefully to a single-turn request
  // — the same behaviour Steps 2–4 had.
  const priorChat = deps.getChat && payload.appChatId ? deps.getChat(payload.appChatId) : null
  const contents: any[] = buildGeminiTurnContents(priorChat, payload.prompt)

  // Phase M1 Step 7: image input. Load + classify each path into a
  // Gemini content part (inlineData for ≤20MB, fileData via files.upload
  // for larger). We deliberately only attach images to the CURRENT user
  // turn — replayed history is text-only since older image paths are
  // typically stale or already shrunk into a tool result. The model
  // sees images for the in-flight turn, which matches what the CLI
  // path does via `--include-directories`.
  //
  // Image parts go BEFORE the text part (Gemini's convention: visual
  // context first, then the prompt that references it).
  const imagePaths = Array.isArray(payload.imagePaths) ? payload.imagePaths : []
  if (imagePaths.length) {
    const imageParts = await loadImageParts(imagePaths, client, deps)
    if (imageParts.length) {
      const lastTurn = contents[contents.length - 1]
      if (lastTurn && lastTurn.role === 'user' && Array.isArray(lastTurn.parts)) {
        lastTurn.parts = [...imageParts, ...lastTurn.parts]
      }
    }
  }

  // Phase M1 Step 3: function-calling tool declarations.
  // Translate the TaskWraith MCP tool surface into Gemini's FunctionDeclaration
  // shape ONCE per run (the tool list is stable across rounds, and the
  // converter is pure so the cost is trivial anyway). Empty array
  // disables function calling — model can only emit text.
  const mcpTools = deps.getMcpToolDefinitions()
  const functionDeclarations = mcpTools.length ? buildGeminiFunctionDeclarations(mcpTools) : []
  const generateConfig =
    functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : undefined

  const startedAt = Date.now()
  let lastUsage: Record<string, number> | null = null
  let aborted = false

  // Phase M1 Step 3: outer round loop. Each iteration consumes one
  // model response stream. If the model emits function calls, we
  // dispatch them, append the `model` turn (with the calls) and a
  // `user` turn (with the responses) to `contents`, and continue. We
  // exit the loop when:
  //   - A round produces no function calls (= final answer).
  //   - The user cancels mid-stream (aborted = true).
  //   - We hit MAX_TOOL_ROUNDS (runaway tool-use guard).
  // The cap is intentionally generous; sane agent loops settle in
  // 1-5 rounds. We surface an error event on cap-hit rather than
  // silently emitting partial output, so the user sees something
  // actionable in the chat.
  let round = 0
  for (; round < MAX_TOOL_ROUNDS; round++) {
    if (controller.signal.aborted) {
      aborted = true
      break
    }

    const pendingFunctionCalls: PendingFunctionCall[] = []
    // Reasoning (`thought: true`) for this round, accumulated and re-emitted as
    // a single growing reasoning note so it streams into the live activity
    // viewport instead of being dropped.
    let roundThinking = ''
    let roundThinkingEmitted = false
    const roundThinkingId = `gemini-thinking-${normalizedRoute.appRunId || 'run'}-${round}`
    try {
      const stream = await client.models.generateContentStream(
        generateConfig ? { model, contents, config: generateConfig } : { model, contents }
      )
      for await (const chunk of stream) {
        if (controller.signal.aborted) {
          aborted = true
          break
        }
        const thought = chunkThoughtText(chunk)
        if (thought) {
          if (!roundThinkingEmitted) {
            deps.sendAgentCompatLine(
              event.sender,
              tag,
              {
                type: 'tool_use',
                tool_id: roundThinkingId,
                tool_name: 'gemini_thinking',
                kind: 'think',
                parameters: { title: 'Thinking' },
                provider: tag
              },
              normalizedRoute
            )
            roundThinkingEmitted = true
          }
          roundThinking += thought
          deps.sendAgentCompatLine(
            event.sender,
            tag,
            {
              type: 'tool_result',
              tool_id: roundThinkingId,
              tool_name: 'gemini_thinking',
              status: 'success',
              output: roundThinking,
              provider: tag
            },
            normalizedRoute
          )
        }
        const text = chunkText(chunk)
        if (text) {
          deps.sendAgentCompatLine(
            event.sender,
            tag,
            { type: 'content', text, provider: tag },
            normalizedRoute
          )
        }
        const calls = chunkFunctionCalls(chunk)
        if (calls.length) {
          for (const call of calls) pendingFunctionCalls.push(call)
        }
        const usage = chunkUsage(chunk)
        if (usage) lastUsage = usage
      }
    } catch (error) {
      if (controller.signal.aborted) {
        aborted = true
      } else {
        const message = `Gemini API stream failed: ${error instanceof Error ? error.message : String(error)}`
        deps.sendAgentCompatError(event.sender, tag, message, normalizedRoute)
        deps.sendAgentCompatExit(event.sender, tag, 1, normalizedRoute)
        deps.runManager.finish(normalizedRoute.appRunId, 'failed' as RunSessionStatus)
        return true
      }
    }

    if (aborted) break

    // No function calls this round → model emitted its final answer.
    if (pendingFunctionCalls.length === 0) break

    // Dispatch each pending function call through the host-side
    // executor and accumulate the response parts for the next turn.
    // `executeGeminiMcpTool` (via deps.executeMcpTool) already emits
    // tool_use + tool_result events and handles approval gates, so
    // we just relay the result back to the model. We DO NOT emit
    // additional tool_use / tool_result here — that would double-up
    // in the renderer.
    const modelParts: any[] = pendingFunctionCalls.map((call) => ({
      functionCall: {
        ...(call.id ? { id: call.id } : {}),
        name: call.name,
        args: call.args
      }
    }))
    const responseParts: any[] = []
    for (const call of pendingFunctionCalls) {
      // Re-check abort BEFORE each dispatch so a cancel mid-tool-loop
      // (e.g. user clicked Stop while the executor is awaiting an
      // approval modal) exits cleanly without spinning through every
      // queued call. The executor itself may take a long time when
      // it's gated on user approval.
      if (controller.signal.aborted) {
        aborted = true
        break
      }
      let result: GeminiApiMcpExecutionResult
      try {
        result = await deps.executeMcpTool(call.name, call.args, normalizedRoute)
      } catch (error) {
        // Defensive: a thrown executor never happens in production
        // (executeGeminiMcpTool catches everything), but tests and
        // future refactors could regress this. Convert to an error
        // result so the loop can still feed something back to the
        // model rather than dying mid-turn.
        result = {
          text: `Tool execution threw: ${error instanceof Error ? error.message : String(error)}`,
          isError: true
        }
      }
      // Also re-check after each dispatch — the user could have
      // cancelled WHILE the executor was awaiting (long-running
      // shells, approval modals, etc.).
      if (controller.signal.aborted) {
        aborted = true
        break
      }
      // Gemini expects `response` to be a JSON object, not a raw
      // string. Wrap the text + error flag in a small object so the
      // model can disambiguate. The exact key (`output` for success,
      // `error` for failure) follows Gemini's published convention.
      const responseObject: Record<string, unknown> = result.isError
        ? { error: result.text }
        : { output: result.text }
      responseParts.push({
        functionResponse: {
          ...(call.id ? { id: call.id } : {}),
          name: call.name,
          response: responseObject
        }
      })
    }

    if (aborted) break

    contents.push({ role: 'model', parts: modelParts })
    contents.push({ role: 'user', parts: responseParts })
    // Loop continues — next iteration calls generateContentStream
    // with the updated contents.
  }

  if (aborted) {
    // 130 = 128 + SIGINT; matches the convention CLI-killed runs use
    // so the renderer's "Stopped" treatment kicks in.
    deps.sendAgentCompatExit(event.sender, tag, 130, normalizedRoute)
    deps.runManager.finish(normalizedRoute.appRunId, 'cancelled' as RunSessionStatus)
    return true
  }

  // Cap exhausted without the model producing a final text-only
  // response → emit an actionable error rather than pretending success.
  // We still emit the result event so the renderer can render
  // duration / partial stats, but with status:error + a useful
  // message in the error stream.
  if (round >= MAX_TOOL_ROUNDS) {
    const message = `Gemini API: model exceeded ${MAX_TOOL_ROUNDS} tool-use rounds without producing a final answer (possible loop).`
    deps.sendAgentCompatError(event.sender, tag, message, normalizedRoute)
    deps.sendAgentCompatExit(event.sender, tag, 1, normalizedRoute)
    deps.runManager.finish(normalizedRoute.appRunId, 'failed' as RunSessionStatus)
    return true
  }

  // Phase M1 Step 5: pin the synthetic `api://<appChatId>` id onto the
  // chat record so the renderer's continuity UI ("Resuming session …",
  // session-coloured chat icon, etc.) sees this turn as part of a
  // logically-linked session even though the API runtime is stateless.
  // We do this only on success (not on aborted/error paths) so a
  // failed first turn doesn't leave a stale "session linked" marker.
  // Idempotency rules + the cli://-overwrite case live in the dep
  // implementation; see `geminiApiProviderDeps()` in index.ts.
  if (deps.saveChatLinkedSessionId && normalizedRoute.appChatId) {
    try {
      deps.saveChatLinkedSessionId(normalizedRoute.appChatId, sessionId)
    } catch {
      // Best-effort: a save failure shouldn't crash the run after the
      // model already streamed a successful answer. The next turn will
      // try again.
    }
  }

  const durationMs = Date.now() - startedAt

  // Phase M1 Step 8: route the API's `usageMetadata` into the host-side
  // `AppStore.recordUsage` so the renderer's usage card + quota
  // tracking surfaces it the same way it does for the CLI path. We do
  // this from the provider (not the renderer) for two reasons:
  //   1. The renderer's `extractUsageCountsFromCandidate` doesn't know
  //      about the Gemini API's `promptTokenCount`/`candidatesTokenCount`
  //      key shape — it sniffs `input_tokens`/`prompt_tokens`/etc.
  //      Doing the mapping here keeps the renderer provider-agnostic.
  //   2. Tracking lives behind the dep, so existing back-compat tests
  //      that omit `recordUsage` still pass — the call is a no-op when
  //      the dep is absent.
  // We swallow any thrown error so a flaky disk doesn't crash the run.
  const recordUsage = deps.recordUsage
  const appRunId = normalizedRoute.appRunId
  const appChatId = normalizedRoute.appChatId
  let usageAlreadyRecorded = false
  if (recordUsage && appRunId && appChatId) {
    usageAlreadyRecorded = true
    try {
      const reportedInputTokens = lastUsage?.promptTokenCount ?? 0
      const cacheReadInputTokens = lastUsage?.cachedContentTokenCount ?? 0
      const inputTokens = Math.max(0, reportedInputTokens - cacheReadInputTokens)
      const outputTokens = lastUsage?.candidatesTokenCount ?? 0
      const thoughtsTokens = lastUsage?.thoughtsTokenCount ?? 0
      const totalTokens =
        lastUsage?.totalTokenCount ?? reportedInputTokens + outputTokens + thoughtsTokens
      const workspaceId =
        priorChat?.workspaceId ||
        (priorChat?.scope === 'global' ? '__taskwraith_global_chats__' : '') ||
        ''
      recordUsage({
        provider: tag,
        workspaceId,
        chatId: appChatId,
        runId: appRunId,
        usageKind: 'run',
        // The AntiGravity lane records the full wire id so API-spend
        // aggregation's rate-table keys match; gemini keeps the bare model.
        model: deps.usageModelId ?? model,
        inputTokens,
        outputTokens,
        totalTokens,
        ...(cacheReadInputTokens > 0 ? { cacheReadInputTokens } : {}),
        durationMs
      })
    } catch {
      // Best-effort: usage tracking failure must not fail the run.
    }
  }

  // Phase M1 Step 9: one-time migration banner. A chat that previously
  // ran on the CLI (signal: `linkedGeminiSessionId` set) and is taking
  // its FIRST turn through the API path gets a synthetic system message
  // explaining the runtime swap. The gate is "`linkedGeminiSessionId`
  // present AND `linkedProviderSessionId` was NOT an `api://...` id
  // before this run" — exactly the case where Step 5's persistence
  // helper just transitioned the chat from CLI-flavoured continuity to
  // API-flavoured continuity. Subsequent API turns find the field
  // already starts with `api://` and so the gate stays closed (one
  // notice per chat lifetime).
  //
  // Best-effort: the notice is a UX courtesy, not a correctness
  // requirement, so a save failure here is swallowed.
  if (
    deps.appendChatSystemMessage &&
    normalizedRoute.appChatId &&
    priorChat &&
    priorChat.linkedGeminiSessionId &&
    !(priorChat.linkedProviderSessionId || '').startsWith('api://')
  ) {
    try {
      const noticeRunId = normalizedRoute.appRunId || 'unknown'
      deps.appendChatSystemMessage(normalizedRoute.appChatId, {
        id: `gemini-api-migration-${noticeRunId}`,
        role: 'system',
        content:
          'This chat is now running via the Gemini API runtime. Its CLI session id is preserved for fallback.',
        timestamp: new Date().toISOString(),
        runId: normalizedRoute.appRunId,
        metadata: { kind: 'geminiApiMigrationNotice' }
      })
    } catch {
      // Best-effort: notice append failure shouldn't fail the run.
    }
  }

  // Final `result` event carries the usage block so the renderer's
  // run-finished handler can render duration / token stats inline with
  // the chat. `durationMs` is captured above so the Step-8 recordUsage
  // call and this stats payload agree on the same elapsed value
  // (otherwise the persisted row and the on-screen number could drift
  // by a few ms — small, but easy to avoid).
  deps.sendAgentCompatLine(
    event.sender,
    tag,
    {
      type: 'result',
      status: 'success',
      stats: {
        ...geminiUsageMetadataToStats(lastUsage || {}, durationMs, {
          alreadyRecorded: usageAlreadyRecorded
        })
      },
      provider: tag,
      runtime: runtimeLabel,
      providerThreadId: sessionId,
      fallback: false
    },
    normalizedRoute
  )
  deps.sendAgentCompatExit(event.sender, tag, 0, normalizedRoute)
  deps.runManager.finish(normalizedRoute.appRunId, 'completed' as RunSessionStatus)
  return true
}
