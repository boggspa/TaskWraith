/**
 * TaskWraith Canvas — shared contracts for the preview/runtime surface.
 *
 * This module is intentionally free of node/electron imports so it can be unit
 * tested in plain vitest AND (later) shared with renderer code without tripping
 * the "node builtins in a renderer-reachable main module blank the window"
 * hazard. Everything here is types + pure functions.
 *
 * Driver support is capability-gated by CanvasService. In particular, `window`
 * can open only through an internal, exact-run native lease target; declaring a
 * driver kind here never makes it agent-requestable.
 *
 * Chart document contracts + validation live in `src/shared/canvasChart.ts`
 * (single source of truth for transcript fences + MCP dock). Re-exported here
 * so existing main/canvas importers keep working.
 */

import type {
  CanvasChartDocument,
  CanvasChartKind,
  CanvasChartPoint,
  CanvasChartSeries,
  CanvasChartValidation
} from '../../shared/canvasChart'
import type { EmulatorObservation, EmulatorStepToolInput } from '../../shared/emulatorCanvas'
import type {
  AppDriveActionReport,
  AppDriveObservationReceipt,
  AppDriveSessionReport,
  AppDriveVerificationVerdict
} from '../appDrive/AppDriveSessionReport'
import {
  CANVAS_CHART_KINDS,
  CANVAS_CHART_MAX_JSON_BYTES,
  CANVAS_CHART_MAX_POINTS_PER_SERIES,
  CANVAS_CHART_MAX_SERIES,
  CANVAS_CHART_MAX_TITLE_CHARS,
  CANVAS_CHART_SCHEMA_VERSION,
  validateCanvasChart
} from '../../shared/canvasChart'

export type {
  CanvasChartDocument,
  CanvasChartKind,
  CanvasChartPoint,
  CanvasChartSeries,
  CanvasChartValidation
}
export {
  CANVAS_CHART_KINDS,
  CANVAS_CHART_MAX_JSON_BYTES,
  CANVAS_CHART_MAX_POINTS_PER_SERIES,
  CANVAS_CHART_MAX_SERIES,
  CANVAS_CHART_MAX_TITLE_CHARS,
  CANVAS_CHART_SCHEMA_VERSION,
  validateCanvasChart
}

/** Compat aliases for earlier seat call sites. */
export const MAX_CANVAS_CHART_SERIES = CANVAS_CHART_MAX_SERIES
export const MAX_CANVAS_CHART_POINTS_PER_SERIES = CANVAS_CHART_MAX_POINTS_PER_SERIES
export const MAX_CANVAS_CHART_TITLE_CHARS = CANVAS_CHART_MAX_TITLE_CHARS

export type CanvasDriverKind =
  | 'web'
  | 'html'
  | 'image'
  | 'sketch'
  | 'window'
  | 'device'
  /** Structured telemetry chart — screenshot-capable; docks without WebContentsView. */
  | 'chart'
  /** Packaged WebAssembly emulator surface, admitted by CanvasService for the fixed reviewed game. */
  | 'emulator'

export type CanvasSessionStatus = 'opening' | 'active' | 'error' | 'closed'

export interface CanvasViewport {
  width: number
  height: number
}

export interface CanvasDeviceTarget {
  /** Simulator UDID (uppercase UUID) or 'booted'. Omit → the booted simulator. */
  udid?: string
}

/**
 * The only packaged game identifier reserved by the emulator foundation.
 *
 * This is deliberately a closed internal union: a Canvas caller cannot turn an
 * emulator open into an arbitrary ROM/file/URL loader. The first runnable
 * package slice supplies the reviewed assets for this identifier.
 */
export const CANVAS_EMULATOR_GAME_IDS = ['homebrew-demo'] as const
export type CanvasEmulatorGameId = (typeof CANVAS_EMULATOR_GAME_IDS)[number]

export function isCanvasEmulatorGameId(value: unknown): value is CanvasEmulatorGameId {
  return (
    typeof value === 'string' && (CANVAS_EMULATOR_GAME_IDS as readonly string[]).includes(value)
  )
}

/**
 * Main-process-only capability reference for a user-consented native window.
 *
 * This is deliberately just an opaque lease id. The attached-window handle,
 * process identity, consent epoch, and other authority remain in the main-owned
 * registry and must never enter agent-facing MCP arguments or renderer state.
 */
export interface CanvasWindowOpenTarget {
  readonly leaseId: string
}

export interface CanvasOpenInput {
  driver?: CanvasDriverKind
  url?: string
  viewport?: CanvasViewport
  /**
   * INTERNAL ONLY. The fixed packaged emulator game to start. Public MCP
   * admission goes through emulator_open, which always passes the reviewed
   * packaged id; arbitrary game/ROM/URL input is never accepted.
   */
  gameId?: CanvasEmulatorGameId
  /**
   * Bind this canvas to one saved site login (web driver only).
   *
   * The surface then uses that site's OWN persistent partition and may only
   * navigate documents to origins the user authorized for it. Omitted means the
   * pre-existing unbound surface on the shared app-wide profile.
   * See docs/appdrive/authorized-site-sessions.md.
   */
  siteId?: string
  // --- device driver (iOS simulator; P4) ---
  /** Target simulator. Omit → the currently-booted sim. */
  device?: CanvasDeviceTarget
  /** Absolute path to a built .app to install before launch (optional). */
  appPath?: string
  /** Bundle id to launch + screenshot. REQUIRED for the device driver. */
  bundleId?: string
  /**
   * Renderer-pane embed for a live web, sketch, or internal emulator driver:
   * host the preview as a WebContentsView inside the app window instead of a
   * standalone BrowserWindow. Renderer IPC opens web/sketch surfaces; the
   * packaged emulator is admitted only through the main-owned path, under
   * canonical agent or trusted renderer authority.
   */
  embed?: boolean
  /**
   * INTERNAL ONLY. Distinguishes an explicit agent request to focus the Canvas
   * dock from an ordinary renderer-owned embed (for example, a multiview pane).
   * For web/sketch/internal-emulator this requires `embed: true`. For `chart`,
   * presentation:"dock" is allowed WITHOUT a WebContentsView embed (native
   * TelemetryPane). Renderer IPC never forwards this field.
   */
  presentation?: 'dock'
  // --- html driver (agent-authored layout/SVG; canvas_render_html) ---
  /**
   * Self-contained HTML (or SVG markup) the agent wants rendered. REQUIRED for
   * the `html` driver. It is rasterized to a PNG by the same hardened offscreen
   * engine the image tools use (scripts disabled, ALL network egress cut), so it
   * is a static, fully-contained preview — never a live, scriptable page.
   */
  html?: string
  // --- image driver (content-addressed image attachment; canvas_open_attachment) ---
  /**
   * Content hash of an EXISTING image asset in the content-addressed media store.
   * REQUIRED for the `image` driver. It resolves through the same realpath jail as
   * twmedia:// (the store rejects a bad/unknown hash + enforces a mime->ext
   * whitelist), so it is never an arbitrary-file-read primitive. CanvasService
   * binds the canonical active chat to the image driver, and the host loader must
   * verify that chat's durable asset grant before returning bytes; possession of
   * a hash alone is not authority.
   */
  mediaSha256?: string
  /** MIME type of the image asset (e.g. "image/png"). REQUIRED for the `image` driver. */
  mediaMimeType?: string
  /**
   * Structured chart document for the `chart` driver (canvas_render_chart).
   * INTERNAL open-input only — agent-facing canvas_open must never accept
   * `driver: "chart"`; the dedicated MCP tool owns the contract.
   */
  chartDocument?: CanvasChartDocument
  /**
   * Internal sketch driver bootstrap document. Set by CanvasService from the
   * persisted per-chat sketch document, never by agent-facing MCP schemas.
   */
  initialSketchDocument?: CanvasSketchDocument
  /**
   * INTERNAL ONLY. Set by the trusted canvas_open_launch executor after it has
   * resolved an exact chat+run-owned native-window lease. Agent-facing
   * canvas_open schemas and parsing must never accept or forward this field.
   */
  windowTarget?: CanvasWindowOpenTarget
}

export interface CanvasElementNode {
  /** Stable handle assigned by the snapshot pass, e.g. "e7". */
  ref: string
  role: string
  name?: string
  tag: string
  value?: string
  /**
   * Trusted native accessibility metadata when available. It is a boolean only;
   * secure-field contents are never represented in a Canvas tree.
   */
  secure?: boolean
  /** [x, y, width, height] in CSS pixels relative to the viewport. */
  bbox?: [number, number, number, number]
  /** Short visible text, truncated. */
  text?: string
  children?: CanvasElementNode[]
}

export interface CanvasElementTree {
  url: string
  title: string
  viewport: CanvasViewport
  capturedAt: string
  root: CanvasElementNode
  /** Number of refs assigned in this snapshot. */
  nodeCount: number
  /** True when the walk hit the node cap — the tree is partial (document order). */
  truncated: boolean
  /**
   * Trusted human-input epoch for this surface at capture time. Echo it back as
   * `expectedInputEpoch` on a subsequent action to have that action refused if
   * the user touched the page in between. Web drivers compare it atomically in
   * their isolated renderer world and retain an independent main-process guard.
   */
  inputEpoch?: number
  /** Trusted post-action observation receipt for canvas_drive_verify. */
  driveObservation?: AppDriveObservationReceipt
}

export interface CanvasFrame {
  mimeType: 'image/png'
  /** base64-encoded PNG bytes. */
  data: string
  width: number
  height: number
  byteLength: number
  /** sha256 of the raw bytes — what audit records (never the bytes). */
  hash: string
  capturedAt: string
  /**
   * Number of credential fields painted over before capture. Frames leave the
   * machine when a hosted provider is driving, so the caller (and the audit
   * trail) should be able to see that the redaction ran.
   */
  secretsRedacted?: number
}

/** Public-safe emulator observation plus its separately delivered PNG bytes. */
export interface CanvasEmulatorObservationResult {
  readonly observation: EmulatorObservation
  readonly frame: Readonly<CanvasFrame>
  readonly driveObservation?: AppDriveObservationReceipt
}

export type CanvasEmulatorStepRefusalReason =
  | 'stale_observation'
  | 'stale_input_epoch'
  | 'user_active'
  | Extract<
      CanvasActRefusalReason,
      | 'appdrive_lease_required'
      | 'appdrive_lease_expired'
      | 'appdrive_step_budget_exhausted'
      | 'appdrive_binding_mismatch'
      | 'appdrive_independent_verifier_required'
    >

/** Honest whole-macro status; `executed` may be true while `partial` is true. */
export interface CanvasEmulatorStepResult extends CanvasEmulatorObservationResult {
  readonly outcome: 'completed' | 'refused' | 'interrupted'
  readonly refusalReason?: CanvasEmulatorStepRefusalReason
  readonly framesRequested: number
  readonly framesCompleted: number
  readonly executed: boolean
  readonly partial: boolean
  readonly driveReportId?: string
  readonly driveActionId?: string
  readonly independentVerificationRequired?: boolean
}

export interface CanvasElementDetail {
  ref?: string
  selector?: string
  found: boolean
  tag?: string
  role?: string
  text?: string
  bbox?: [number, number, number, number]
  styles?: Record<string, string>
}

export interface CanvasInspectInput {
  ref?: string
  selector?: string
  styles?: string[]
  /** Exact native observation being inspected; optional for non-window drivers. */
  expectedObservationId?: string
}

export type CanvasActionKind = 'click' | 'fill' | 'key' | 'scroll' | 'hover' | 'select' | 'wait_for'

export type CanvasControlActionKind = Exclude<CanvasActionKind, 'wait_for'>

/** Structured interaction. ref-first; selector/xy are explicit fallbacks. */
export interface CanvasActionInput {
  kind: CanvasActionKind
  ref?: string
  selector?: string
  x?: number
  y?: number
  value?: string
  /** Non-text keyboard key (Enter/Escape/Tab/arrows/etc.) for `key`. */
  key?: string
  /** Scroll delta in CSS pixels for `scroll`. */
  deltaX?: number
  deltaY?: number
  /** Poll ceiling for `wait_for` (milliseconds). */
  timeoutMs?: number
  /** Require a different Ensemble participant to attest the postcondition. */
  requireIndependentVerifier?: boolean
  /**
   * The `inputEpoch` from the snapshot this action was planned against. When
   * supplied and no longer current — i.e. the human has touched the surface since
   * — the action is refused instead of executed against a page the caller has not
   * seen. Omit to act on the live page regardless.
   */
  expectedInputEpoch?: number
  /** Exact native observation being acted upon; optional for non-window drivers. */
  expectedObservationId?: string
}

/**
 * Why an actuation refused. Every one of these means NOTHING WAS DISPATCHED —
 * the check failed before the element was touched.
 */
export type CanvasActRefusalReason =
  /** No element resolved from ref/selector/xy. */
  | 'not_found'
  /**
   * The ref resolved, but the element is detached or no longer matches the
   * identity recorded for it at snapshot time. Re-snapshot and retry.
   */
  | 'stale_target'
  /** The element's centre hit-tests to something else — it is covered. */
  | 'occluded'
  /** The element cannot accept a fill (not a field, or a file input). */
  | 'not_fillable'
  /**
   * The target is a credential field. Never retried, never worked around: the
   * human types their own secrets. See SECRET_FIELD_SELECTOR in CanvasWebDriver.
   */
  | 'secret_field'
  /**
   * A human is interacting with the surface right now. Transient — wait, then
   * re-snapshot. The user always wins.
   */
  | 'user_active'
  /**
   * The caller pinned an `expectedInputEpoch` and the human has interacted since.
   * The observation the plan was built on is stale; re-snapshot.
   */
  | 'stale_input_epoch'
  /** No live user-minted AppDrive lease exists for this exact web surface. */
  | 'appdrive_lease_required'
  /** The bounded AppDrive lease expired and must be approved again. */
  | 'appdrive_lease_expired'
  /** The user-approved AppDrive step budget has been consumed. */
  | 'appdrive_step_budget_exhausted'
  /** The lease belongs to another run/provider/participant binding. */
  | 'appdrive_binding_mismatch'
  /** A solo actor requested a verifier split that requires two Ensemble seats. */
  | 'appdrive_independent_verifier_required'
  /** The driver intentionally does not implement this structured verb. */
  | 'unsupported_action'
  /** `wait_for` reached its bounded timeout without finding the target. */
  | 'wait_timeout'
  /**
   * Native target appears consequential and no content-bound confirmation
   * receipt exists. Nothing was dispatched.
   */
  /**
   * The canvas is bound to a saved site login the user granted READ access to.
   * Never retried and never worked around: the user chose to be signed in
   * there without being acted for, and only they can widen it.
   */
  | 'site_read_only'
  | 'consequential_confirmation_required'

/**
 * Read-only description of the target an action would hit. Produced before
 * dispatch so a consequential control can be confirmed by the human first.
 */
export interface CanvasTargetDescription {
  readonly found: boolean
  /**
   * Accessible name of the resolved element (aria-label, text, value, title).
   * PAGE-CONTROLLED — treat as untrusted data for matching only. It must never
   * be rendered into a dialog the human reads; see consequentialSummary.
   */
  readonly label: string | null
  /**
   * The surface's current trusted input epoch, to be pinned as
   * `expectedInputEpoch` on the follow-up dispatch so the action refuses if the
   * human touched the page while a confirmation was open.
   */
  readonly inputEpoch: number | null
}

/** Did the page move around the dispatch? See `CanvasActResult.verified`. */
export type CanvasActVerification = 'changed' | 'unchanged' | 'unknown'

export interface CanvasActResult {
  ok: boolean
  action: CanvasActionKind
  ref?: string
  selector?: string
  found: boolean
  /**
   * True ONLY when the interaction was actually dispatched at the target.
   *
   * This exists because `ok`/`found` could not express "we touched nothing":
   * `el.click()` on a detached node does not throw, so a re-rendered-away ref
   * used to report `{ ok: true, found: true }` while the screen never changed.
   * A refused precondition is always `executed: false` with a `refusalReason`.
   */
  executed: boolean
  /**
   * Whether the page changed SYNCHRONOUSLY around the dispatch.
   *
   * `'unchanged'` does NOT mean the action failed — async re-renders, network
   * round-trips and navigations all settle after `executeJavaScript` resolves.
   * It means the action is UNCONFIRMED. Treat it as a possible no-op and
   * re-snapshot rather than immediately retrying the same action, which is how
   * a single misfire turns into a destructive retry loop.
   */
  verified: CanvasActVerification
  /** Set only when `executed` is false. */
  refusalReason?: CanvasActRefusalReason
  message?: string
  /**
   * URL/title at action completion. NB: a click that triggers a navigation may
   * not have settled yet (executeJavaScript resolves before navigation
   * completes), so re-run canvas_snapshot to confirm the resulting page.
   */
  url?: string
  title?: string
  /** Value-free AppDrive report correlation for this consumed action step. */
  driveReportId?: string
  driveActionId?: string
  independentVerificationRequired?: boolean
}

/**
 * P2 arbitrary eval result. The model-supplied script runs in the page's global
 * scope (RCE) — this is the signed-elevated `canvasEval` verb. The completion
 * value is JSON-stringified and size-capped; the audit trail records only the
 * script HASH + length, never the script text or the returned value.
 */
export interface CanvasEvalResult {
  ok: boolean
  /** typeof the raw completion value (e.g. 'object', 'string', 'undefined'). */
  valueType?: string
  /** JSON.stringify of the completion value, capped to CANVAS_EVAL_VALUE_CAP. */
  value?: string
  /** True when `value` was truncated to the cap. */
  truncated?: boolean
  /** Present when the script threw (or the page CSP blocked eval). */
  error?: string
  /** URL/title after the script ran (a navigation it triggered may not have settled). */
  url?: string
  title?: string
}

/** Content-minimised proof binding an approved script to one execution. */
export interface CanvasEvalApprovalReceipt {
  schemaVersion: 2
  approvalId: string
  /** SHA-256 over the exact JavaScript UTF-16 code units encoded little-endian. */
  scriptHashAlgorithm: 'sha256-utf16le'
  scriptHash: string
  /** JavaScript UTF-16 code-unit length (`String#length`). */
  scriptLength: number
  /** UTF-8 encoded byte length. */
  scriptByteLength: number
}

/** Max chars of a stringified eval result returned to the model (and never logged). */
export const CANVAS_EVAL_VALUE_CAP = 8000
/** Reviewability ceiling for one signed-elevated script (UTF-16 code units). */
export const CANVAS_EVAL_SCRIPT_CAP = 16_384

/** A Set-of-Mark annotation cell — agent→human redline by ref or explicit bbox. */
export interface CanvasMark {
  ref?: string
  bbox?: [number, number, number, number]
  label: string
  severity?: 'info' | 'warn' | 'error'
}

export type CanvasSketchElementKind = 'rect' | 'ellipse' | 'line' | 'arrow' | 'text' | 'path'

export interface CanvasSketchPoint {
  x: number
  y: number
}

export interface CanvasSketchElement {
  id?: string
  kind: CanvasSketchElementKind
  x?: number
  y?: number
  width?: number
  height?: number
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  points?: CanvasSketchPoint[]
  d?: string
  text?: string
  fill?: string
  stroke?: string
  strokeWidth?: number
  fontSize?: number
  opacity?: number
}

export interface CanvasSketchDocument {
  schemaVersion: 1
  title: string
  viewport: CanvasViewport
  elements: CanvasSketchElement[]
  updatedAt: string
}

export type CanvasSketchUpdateMode = 'replace' | 'append' | 'clear' | 'delete'

export interface CanvasSketchUpdateInput {
  mode?: CanvasSketchUpdateMode
  title?: string
  elements?: CanvasSketchElement[]
  elementIds?: string[]
  /**
   * Optimistic-concurrency guard: the `updatedAt` the caller last read from
   * canvas_sketch_get. When present and no longer current, the update is refused
   * rather than clobbering edits the caller never saw. Omit to force.
   */
  expectedUpdatedAt?: string
}

export interface CanvasAnnotation {
  schemaVersion: 1
  id: string
  canvasId: string
  /** Durable main-owned authority so scoped purge never depends on capped history. */
  chatId?: string
  workspacePath?: string
  runId?: string
  marks: CanvasMark[]
  author: 'agent' | 'human'
  createdAt: string
}

export interface CanvasNetworkEntry {
  id: number
  url: string
  method: string
  status?: number
  resourceType?: string
  ok?: boolean
  startedAt: string
  completedAt?: string
  errorText?: string
}

export type CanvasConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface CanvasConsoleEntry {
  level: CanvasConsoleLevel
  message: string
  sourceId?: string
  line?: number
  at: string
}

/** What a driver returns when a session opens. */
export interface CanvasSessionHandle {
  url: string
  title: string
  viewport: CanvasViewport
}

/** Chrome-style history verbs for the web driver's browser surface. */
export type CanvasNavigationAction = 'back' | 'forward' | 'reload' | 'stop'

/** One navigation request: exactly one of `url` (absolute http/https) or `action`. */
export interface CanvasNavigateInput {
  url?: string
  action?: CanvasNavigationAction
}

/**
 * Live navigation state of a web canvas — what browser chrome renders (address
 * bar, back/forward, spinner). Ephemeral UI state, never persisted as-is: the
 * durable session record stores only the query-redacted URL + title.
 */
export interface CanvasNavState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

/**
 * The internal driver contract — NOT the MCP surface. CanvasService talks to a
 * driver; the MCP tools talk to CanvasService. Drivers are injected so the
 * service is unit-testable with a fake (the real `web` driver needs Electron).
 */
export interface CanvasDriver {
  readonly kind: CanvasDriverKind
  open(input: CanvasOpenInput): Promise<CanvasSessionHandle>
  snapshot(): Promise<CanvasElementTree>
  screenshot(): Promise<CanvasFrame>
  inspect(args: CanvasInspectInput): Promise<CanvasElementDetail>
  network(args: { filter?: 'all' | 'failed'; requestId?: number }): Promise<CanvasNetworkEntry[]>
  console(args: { level?: 'all' | 'warn' | 'error'; lines?: number }): Promise<CanvasConsoleEntry[]>
  resize(viewport: CanvasViewport): Promise<CanvasViewport>
  // P1 interaction + annotation.
  act(action: CanvasActionInput): Promise<CanvasActResult>
  /**
   * Read-only pre-flight: resolve the same target `act` would and report its
   * accessible label plus the surface's current trusted input epoch, WITHOUT
   * dispatching anything. Feeds the consequential-action check (design §7).
   *
   * A driver whose surface has no page labels to judge (sketch, chart, image,
   * device) leaves this undefined; the service then does not gate it, because
   * refusing on an absent probe would block every action on those drivers.
   */
  describeTarget?(action: CanvasActionInput): Promise<CanvasTargetDescription>
  annotate(marks: CanvasMark[]): Promise<{ count: number }>
  sketchDocument(): Promise<CanvasSketchDocument>
  sketchUpdate(update: CanvasSketchUpdateInput): Promise<CanvasSketchDocument>
  // P2 arbitrary eval (RCE). The driver MUST cut the page's network egress while
  // the script runs so eval cannot be used as an exfiltration channel.
  evaluate(args: { script: string }): Promise<CanvasEvalResult>
  /** Re-navigate the surface to its current page (web: webContents.reload). */
  reload(): Promise<void>
  /**
   * Browser-style navigation (web driver only). A driver that does not host a
   * navigable page leaves this undefined; CanvasService then refuses the verb
   * with a typed error instead of a silent no-op.
   */
  navigate?(input: CanvasNavigateInput): Promise<CanvasNavState>
  /** Live chrome state (web driver only). Synchronous read of the surface. */
  navState?(): CanvasNavState
  /**
   * Structured chart document (chart driver only). Synchronous read so
   * canvas_list / canvas_status can feed the Canvas dock TelemetryPane.
   */
  chartDocument?(): CanvasChartDocument | null
  close(): Promise<void>
}

/** Lightweight summary returned by canvas_list / canvas_status (no pixels). */
export interface CanvasSessionSummary {
  canvasId: string
  driver: CanvasDriverKind
  url: string
  title: string
  status: CanvasSessionStatus
  viewport: CanvasViewport
  createdAt: string
  updatedAt: string
  /** Live host placement. Present only when the surface belongs in the Canvas dock. */
  presentation?: 'dock'
  /**
   * Structured chart payload for the Canvas dock TelemetryPane.
   * Present only for live chart-driver sessions (not persisted history).
   */
  chartDocument?: CanvasChartDocument
  /** Live browser-chrome state; present only for open web-driver sessions. */
  isLoading?: boolean
  canGoBack?: boolean
  canGoForward?: boolean
  /**
   * Live-only human-play flag (emulator driver). Present once a page
   * observation exists; never present for persisted history.
   */
  humanActive?: boolean
}

/** Persisted session record (audit / history). */
export interface CanvasSessionRecord {
  schemaVersion: 1
  id: string
  driver: CanvasDriverKind
  url: string
  title: string
  viewport: CanvasViewport
  status: CanvasSessionStatus
  chatId?: string
  runId?: string
  workspacePath?: string
  /** The saved site login this canvas was bound to, when it was site-bound. */
  siteId?: string
  createdAt: string
  updatedAt: string
  closedAt?: string
  error?: string
}

export type CanvasEventKind =
  | 'session.opened'
  | 'session.closed'
  | 'session.error'
  | 'snapshot'
  | 'screenshot'
  | 'inspect'
  | 'network'
  | 'console'
  | 'resize'
  | 'interaction'
  | 'annotation'
  | 'sketch.read'
  | 'sketch.update'
  | 'eval'
  | 'eval.started'
  | 'eval.completed'
  | 'reload'
  | 'navigation'

/**
 * Audit event. `detail` is REDACTED, structured metadata only — never pixel
 * bytes and never raw secrets. A screenshot event records `{ frameHash, width,
 * height }`, not the PNG.
 */
export interface CanvasEventRecord {
  schemaVersion: 1
  id: string
  canvasId: string
  kind: CanvasEventKind
  provider?: string
  chatId?: string
  workspacePath?: string
  runId?: string
  approvalId?: string
  detail?: Record<string, unknown>
  createdAt: string
}

/**
 * The surface CanvasService exposes to the MCP executor. Defining it here (not
 * on the concrete class) lets CanvasToolExecutors depend on an interface and be
 * tested against a fake controller.
 */
export interface CanvasController {
  open(
    input: CanvasOpenInput,
    ctx: CanvasCallContext
  ): Promise<{ canvasId: string } & CanvasSessionHandle>
  list(ctx: CanvasCallContext): CanvasSessionSummary[]
  status(canvasId: string, ctx: CanvasCallContext): CanvasSessionSummary | null
  /** Value-free AppDrive reports across web, Simulator, and managed native surfaces. */
  driveReports?(
    input: { reportId?: string; surfaceId?: string; limit?: number },
    ctx: CanvasCallContext
  ): readonly AppDriveSessionReport[]
  /** Record a post-observation attestation for one reported action. */
  verifyDriveAction?(
    input: {
      reportId: string
      actionId: string
      surfaceId: string
      observationId: string
      verdict: AppDriveVerificationVerdict
    },
    ctx: CanvasCallContext
  ): AppDriveActionReport
  /**
   * Structured chart payload for a live chart session (Canvas dock TelemetryPane).
   * Returns null when the canvas is missing, not owned, or not a chart driver.
   */
  getChartDocument(canvasId: string, ctx: CanvasCallContext): CanvasChartDocument | null
  snapshot(
    canvasId: string,
    ctx: CanvasCallContext,
    options?: { driveActionId?: string }
  ): Promise<CanvasElementTree>
  screenshot(canvasId: string, ctx: CanvasCallContext): Promise<CanvasFrame>
  inspect(
    canvasId: string,
    args: CanvasInspectInput,
    ctx: CanvasCallContext
  ): Promise<CanvasElementDetail>
  network(
    canvasId: string,
    args: { filter?: 'all' | 'failed'; requestId?: number },
    ctx: CanvasCallContext
  ): Promise<CanvasNetworkEntry[]>
  console(
    canvasId: string,
    args: { level?: 'all' | 'warn' | 'error'; lines?: number },
    ctx: CanvasCallContext
  ): Promise<CanvasConsoleEntry[]>
  resize(
    canvasId: string,
    viewport: CanvasViewport,
    ctx: CanvasCallContext
  ): Promise<CanvasViewport>
  click(canvasId: string, args: CanvasActionInput, ctx: CanvasCallContext): Promise<CanvasActResult>
  fill(canvasId: string, args: CanvasActionInput, ctx: CanvasCallContext): Promise<CanvasActResult>
  act(canvasId: string, args: CanvasActionInput, ctx: CanvasCallContext): Promise<CanvasActResult>
  annotate(canvasId: string, marks: CanvasMark[], ctx: CanvasCallContext): Promise<CanvasAnnotation>
  sketchDocument(canvasId: string, ctx: CanvasCallContext): Promise<CanvasSketchDocument>
  sketchUpdate(
    canvasId: string,
    update: CanvasSketchUpdateInput,
    ctx: CanvasCallContext
  ): Promise<CanvasSketchDocument>
  evaluate(
    canvasId: string,
    args: { script: string },
    ctx: CanvasCallContext
  ): Promise<CanvasEvalResult>
  reload(canvasId: string, ctx: CanvasCallContext): Promise<void>
  /**
   * Browser navigation on a web canvas (goto/back/forward/reload/stop).
   * `chargeInteraction: false` is reserved for the HUMAN chrome path (the
   * user browsing their own canvas is never metered by the agent runaway
   * budget); agent verbs must keep the default.
   */
  navigate(
    canvasId: string,
    input: CanvasNavigateInput,
    ctx: CanvasCallContext,
    opts?: { chargeInteraction?: boolean }
  ): Promise<CanvasNavState>
  /** Main-owned live placement update used when a Canvas pop-out returns. */
  presentInDock?(canvasId: string, ctx: CanvasCallContext): CanvasSessionSummary
  close(canvasId: string, ctx: CanvasCallContext): Promise<void>
}

/** Run/chat attribution threaded onto every canvas action for the audit trail. */
export interface CanvasCallContext {
  provider?: string
  chatId?: string
  runId?: string
  workspacePath?: string
  /** Main-owned renderer WebContents id for an embedded Canvas host. Never
   * accepted from MCP/tool input; renderer IPC stamps it from the sender. */
  surfaceHostId?: number
  /**
   * Ensemble seat that opened the canvas (when present). Device-driver lease
   * mint uses this as ownerParticipantId.
   */
  participantId?: string
  /** Required by CanvasService for the signed-elevated canvas_eval verb. */
  canvasEvalApproval?: CanvasEvalApprovalReceipt
}

/**
 * Separate internal emulator seam. CanvasController remains unchanged so every
 * existing generic Canvas fake need not pretend to expose emulator controls.
 */
export interface CanvasEmulatorController {
  observeEmulator(
    canvasId: string,
    ctx: CanvasCallContext
  ): Promise<CanvasEmulatorObservationResult>
  stepEmulator(
    canvasId: string,
    input: EmulatorStepToolInput,
    ctx: CanvasCallContext
  ): Promise<CanvasEmulatorStepResult>
}

/** Main-only exact-surface resolution for future AppDrive composition wiring. */
export type CanvasEmulatorSurfaceResolution = 'emulator' | 'other' | 'missing'

export interface CanvasEmulatorSurfaceResolver {
  resolveEmulatorSurface(canvasId: string, ctx: CanvasCallContext): CanvasEmulatorSurfaceResolution
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in canvasTypes.test.ts)
// ---------------------------------------------------------------------------

export const CANVAS_VIEWPORT_PRESETS = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 }
} as const

export type CanvasViewportPreset = keyof typeof CANVAS_VIEWPORT_PRESETS

const VIEWPORT_MIN = 240
const VIEWPORT_MAX = 3840

export function clampViewportDimension(value: unknown, fallback: number): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(VIEWPORT_MIN, Math.min(VIEWPORT_MAX, n))
}

/** Resolve a viewport from a preset and/or explicit width/height (preset first). */
export function resolveViewport(args: {
  preset?: string
  width?: unknown
  height?: unknown
  fallback?: CanvasViewport
}): CanvasViewport {
  const fallback = args.fallback ?? CANVAS_VIEWPORT_PRESETS.desktop
  const preset =
    args.preset && args.preset in CANVAS_VIEWPORT_PRESETS
      ? CANVAS_VIEWPORT_PRESETS[args.preset as CanvasViewportPreset]
      : undefined
  const base = preset ?? fallback
  return {
    width: clampViewportDimension(args.width, base.width),
    height: clampViewportDimension(args.height, base.height)
  }
}

export type CanvasHostClass = 'loopback' | 'linklocal' | 'private' | 'public' | 'invalid'

// Cloud-metadata DNS names (resolve to link-local). Hard-blocked by name — we
// cannot IP-class a bare hostname here without resolving it.
const METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal'
])

function classifyIPv4(host: string): CanvasHostClass {
  const octets = host.split('.').map((part) => Number(part))
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return 'invalid'
  }
  const [a, b] = octets
  if (a === 127) return 'loopback'
  if (a === 169 && b === 254) return 'linklocal' // 169.254/16 incl. metadata 169.254.169.254
  if (a === 0) return 'private' // 0.0.0.0/8
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  if (a === 100 && b >= 64 && b <= 127) return 'private' // 100.64/10 CGNAT
  return 'public'
}

/**
 * Classify a URL hostname for the SSRF policy. Handles IPv4, IPv4-mapped /
 * NAT64 IPv6 in BOTH dotted (`::ffff:169.254.169.254`) and Node's hex-
 * normalized (`::ffff:a9fe:a9fe`) forms — so the metadata IP cannot be smuggled
 * past a naive string check — plus IPv6 loopback/link-local/ULA and known
 * cloud-metadata DNS names. A bare DNS name we cannot resolve in this pure helper
 * is treated as 'public'; the web driver layers an async DNS guard on top before
 * loading and before each request.
 */
export function classifyCanvasHost(rawHost: string): CanvasHostClass {
  const host = rawHost.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '')
  if (!host) return 'invalid'
  if (METADATA_HOSTNAMES.has(host)) return 'linklocal'
  // IPv4-mapped / NAT64, dotted form.
  const dotted = host.match(/^(?:::ffff:|64:ff9b::)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dotted) return classifyIPv4(dotted[1])
  // IPv4-mapped, Node hex-normalized form (::ffff:HHHH:HHHH).
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (hex) {
    const hi = parseInt(hex[1], 16)
    const lo = parseInt(hex[2], 16)
    return classifyIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`)
  }
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return classifyIPv4(host)
  if (host === 'localhost') return 'loopback'
  if (host === '::1') return 'loopback'
  if (/^fe80:/i.test(host) || /^fec0:/i.test(host)) return 'linklocal'
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return 'private' // fc00::/7 ULA
  if (host === '::') return 'private'
  return 'public'
}

export function isLoopbackHost(rawHost: string): boolean {
  return classifyCanvasHost(rawHost) === 'loopback'
}

export interface CanvasUrlValidation {
  ok: boolean
  reason?: string
  host?: string
  hostClass?: CanvasHostClass
  normalizedUrl?: string
}

/**
 * Top-level browser gate. Any http(s) host the user enters is valid, including
 * loopback, LAN, CGNAT, and ULA addresses. Link-local/cloud-metadata targets
 * remain a fixed deny rule rather than an origin allowlist. `URL` is a Node/Web
 * global.
 */
export function validateCanvasUrl(rawUrl: string): CanvasUrlValidation {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return { ok: false, reason: 'Invalid URL.' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `Unsupported scheme "${parsed.protocol}". Canvas only previews http/https.`
    }
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  const hostClass = classifyCanvasHost(parsed.hostname)
  const normalizedUrl = parsed.toString()
  if (hostClass === 'invalid') return { ok: false, reason: 'Invalid host.', host, hostClass }
  if (hostClass === 'linklocal') {
    return {
      ok: false,
      reason: 'Link-local / cloud-metadata addresses are blocked.',
      host,
      hostClass
    }
  }
  return { ok: true, host, hostClass, normalizedUrl }
}

/**
 * Per-request fixed deny rule for EVERY request the loaded page makes — wired
 * to session.webRequest.onBeforeRequest, so it covers the main frame,
 * subframes, subresources and websockets. Ordinary public, loopback and private
 * network requests are all browser-addressable; link-local/cloud-metadata
 * targets stay blocked.
 */
export function isCanvasRequestBlocked(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false // unparseable / data: / blob: / about: → inert, allow
  }
  if (!parsed.hostname) return false
  const hostClass = classifyCanvasHost(parsed.hostname)
  if (hostClass === 'linklocal') return true
  return false // loopback / private / public / invalid → allow
}

/**
 * Drop the query string + fragment from a URL for PERSISTED session records and
 * audit events, so a `?token=…` style secret never lands in the durable canvas
 * artifacts. The live tool result still returns the full (post-redirect) URL.
 */
export function redactUrlQuery(rawUrl: string): string {
  try {
    const u = new URL(rawUrl)
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return rawUrl.split('?')[0].split('#')[0]
  }
}

// ---------------------------------------------------------------------------
// Device-driver (iOS simulator) input validators. The driver shells out to
// `xcrun simctl` via execFile with an argv ARRAY (never a shell string), so
// these are defence-in-depth + good error messages, not the sole guard.
// ---------------------------------------------------------------------------

/**
 * A reverse-DNS-ish bundle id, e.g. "com.example.App". No spaces / shell chars,
 * and NO leading '-' on the whole string OR any dotted segment — so the value can
 * never be read by `simctl` as an option flag (argument-injection defence-in-depth
 * that does not lean on simctl's positional-arg grammar). Real bundle ids never
 * start a segment with '-'.
 */
export function isValidBundleId(value: string): boolean {
  return (
    value.length <= 255 && /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(value)
  )
}

/** A simulator UDID (uppercase or lowercase UUID) or the literal 'booted'. */
export function isValidSimUdid(value: string): boolean {
  return (
    value === 'booted' ||
    /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(value)
  )
}

/**
 * An absolute path to a `.app` bundle, with no shell metacharacters and no `..`
 * traversal segment. (Absolute → can never be a '-'-leading option token.)
 */
export function isSafeAppBundlePath(value: string): boolean {
  return (
    value.startsWith('/') &&
    value.endsWith('.app') &&
    value.length <= 4096 &&
    !/[;&|`$<>\n\r"'\\*?]/.test(value) &&
    !value.split('/').includes('..')
  )
}

/**
 * Max characters of agent-authored HTML/SVG the `html` driver will rasterize.
 * Mirrors the image tools' SVG cap — bounds the base64 data: URL the offscreen
 * renderer builds so a multi-MB payload can't wedge the loadURL/IPC path.
 */
export const MAX_CANVAS_HTML_CHARS = 512_000

export interface CanvasHtmlValidation {
  ok: boolean
  reason?: string
}

/** Validate agent-supplied HTML/SVG for the `html` driver (non-empty, capped). */
export function validateCanvasHtml(rawHtml: string): CanvasHtmlValidation {
  const html = typeof rawHtml === 'string' ? rawHtml : ''
  if (!html.trim()) return { ok: false, reason: 'The html driver requires non-empty `html`.' }
  if (html.length > MAX_CANVAS_HTML_CHARS) {
    return {
      ok: false,
      reason: `\`html\` too large (${html.length} chars; max ${MAX_CANVAS_HTML_CHARS}).`
    }
  }
  return { ok: true }
}

// Content-addressed media hashes are base64url sha256 (mirrors the asset store's
// SHA256_BASE64URL_PATTERN and twMediaRange's SHA_RE) — no '/' or '.', so a hash
// can never carry a path-traversal segment.
const CANVAS_MEDIA_SHA_RE = /^[A-Za-z0-9_-]{32,96}$/

export interface CanvasMediaRefValidation {
  ok: boolean
  reason?: string
}

/**
 * Validate an agent-supplied image attachment ref for the `image` driver:
 * a well-formed content hash + an image/* MIME. This is the defence-in-depth
 * shape check — the asset store's own mime→ext whitelist + realpath jail is the
 * authoritative gate (and is what actually resolves the bytes).
 */
export function validateCanvasImageRef(sha256: string, mimeType: string): CanvasMediaRefValidation {
  const sha = typeof sha256 === 'string' ? sha256.trim() : ''
  const mime = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : ''
  if (!CANVAS_MEDIA_SHA_RE.test(sha)) {
    return { ok: false, reason: 'A valid content-addressed `mediaSha256` is required.' }
  }
  if (!mime.startsWith('image/')) {
    return {
      ok: false,
      reason: `The image driver only opens image attachments, not "${mime || 'unknown'}".`
    }
  }
  return { ok: true }
}

// Decompression-bomb guards for the `image` driver. A small compressed image can
// declare enormous dimensions (e.g. an 8 MiB solid-colour 20000×20000 PNG decodes
// to ~1.6 GB of RGBA), so the loader (a) rejects a too-large DECLARED size before
// nativeImage allocates the bitmap and (b) downscales an oversized decoded image
// to a sane preview edge before re-encoding + base64'ing it into the tool result.
export const CANVAS_IMAGE_MAX_DECODE_PIXELS = 24_000_000 // ~24M px (mirrors the offscreen-render area cap)
export const CANVAS_IMAGE_MAX_EDGE = 4096

/**
 * Fit width×height inside a square of `maxEdge`, preserving aspect ratio. Returns
 * the original dims when already within bounds. Pure + unit-tested; the Electron
 * `nativeImage.resize` call uses the result.
 */
export function fitWithinMaxEdge(
  width: number,
  height: number,
  maxEdge: number = CANVAS_IMAGE_MAX_EDGE
): { width: number; height: number } {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(1, Math.floor(height))
  const longest = Math.max(w, h)
  if (longest <= maxEdge) return { width: w, height: h }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale))
  }
}

/** Read the pixel dimensions from a PNG buffer's IHDR chunk (0 if not a PNG). */
export function readPngDimensions(buf: Uint8Array): { width: number; height: number } {
  // PNG signature (8) + IHDR length(4) + "IHDR"(4) + width(4) + height(4).
  if (
    buf.length >= 24 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    const u32 = (o: number): number =>
      ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0
    return { width: u32(16), height: u32(20) }
  }
  return { width: 0, height: 0 }
}
