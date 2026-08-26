/**
 * CanvasWebDriver — the P0 `web` driver.
 *
 * Hosts the app-under-test on a {@link CanvasHostSurface} (a sandboxed standalone
 * BrowserWindow by default; a WebContentsView embedded in the app window when the
 * renderer-pane surface is injected) and drives its `webContents` WITHOUT the CDP
 * `webContents.debugger` (mutually exclusive with an open DevTools window + adds
 * attach/version churn). Instead it uses proven Electron primitives:
 *   - snapshot / inspect / act → `webContents.executeJavaScriptInIsolatedWorld`
 *     (fixed scripts in a page-inaccessible registry; arbitrary eval remains the
 *     separate, signed-elevated canvas_eval verb)
 *   - screenshot         → `webContents.capturePage().toPNG()`
 *   - network            → profile-routed `session.webRequest` ring buffer
 *   - console            → `webContents.on('console-message')` ring buffer
 *   - resize             → the surface's `setContentSize`
 *
 * The surface is injected (`deps.createSurface`) so WHERE the page lives is not the
 * driver's concern. Production canvases share TaskWraith's app-wide persistent
 * Browser profile, while a session router keeps each canvas's network buffer,
 * SSRF policy, and eval egress gate independent. The profile never touches the
 * user's normal browser profile or provider credentials.
 */
import type { WebContents } from 'electron'
import { createHash } from 'crypto'
import {
  createBrowserWindowSurface,
  type CanvasHostSurface,
  type CanvasSurfaceOptions
} from './CanvasHostSurface'
import type {
  CanvasActionInput,
  CanvasActResult,
  CanvasActRefusalReason,
  CanvasActVerification,
  CanvasConsoleEntry,
  CanvasConsoleLevel,
  CanvasDriver,
  CanvasElementDetail,
  CanvasElementTree,
  CanvasEvalResult,
  CanvasFrame,
  CanvasMark,
  CanvasNavigateInput,
  CanvasNavState,
  CanvasNetworkEntry,
  CanvasOpenInput,
  CanvasSessionHandle,
  CanvasSketchDocument,
  CanvasSketchUpdateInput,
  CanvasTargetDescription,
  CanvasViewport
} from './canvasTypes'
import { CanvasEvalEgressGate } from './CanvasEvalEgressGate'
import {
  CANVAS_EVAL_VALUE_CAP,
  isCanvasRequestBlocked,
  resolveViewport,
  validateCanvasUrl
} from './canvasTypes'
import {
  assertCanvasDnsAllowed,
  isCanvasDnsBlocked,
  type CanvasResolveHost
} from './CanvasDnsGuard'
import {
  CanvasBrowserProfile,
  type CanvasBrowserProfileController
} from './CanvasBrowserProfile'

const NETWORK_BUFFER = 200
const CONSOLE_BUFFER = 200
// How long the egress-cut is held AFTER an eval's synchronous frame resolves, so
// requests the script merely SCHEDULED (setTimeout(0) / microtask / a short async
// chain) are still cancelled before egress is restored. A long-delay timer that
// fires after this window is a documented residual — see evaluate().
const EVAL_EGRESS_HOLD_MS = 300

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const LOAD_TIMEOUT_MS = 20000
// History/reload settle wait — deliberately short and non-fatal (see settleAfter).
const NAV_SETTLE_TIMEOUT_MS = 8000

const DEFAULT_INSPECT_STYLES = [
  'color',
  'background-color',
  'font-size',
  'font-family',
  'font-weight',
  'padding',
  'margin',
  'border',
  'display',
  'width',
  'height'
]

/**
 * Fields that hold a secret. Deliberately not just `input[type=password]`:
 *
 * A masked password field already renders as dots, so its pixels leak little.
 * The real exposure is a field whose secret is VISIBLE — a "show password"
 * toggle flips type to text, autofilled credentials land in plain inputs, and
 * one-time codes are almost always type=text. Matching on `autocomplete` catches
 * those regardless of type, and `data-tw-secret` is an escape hatch for app
 * authors. Masked fields are covered too: harmless, and it also hides the value
 * LENGTH, which is a real if minor signal.
 *
 * This matters because the user enters credentials INSIDE the agent-drivable
 * surface, and frames leave the machine whenever a hosted provider is driving.
 * The persistent profile retains the resulting site session, never the values
 * through Canvas tools.
 */
/**
 * Input types that mean a human is actively working in the surface. `mouseMove`
 * is excluded on purpose — a cursor resting over the page is not an interaction,
 * and treating it as one would let a parked pointer block the agent forever.
 */
const USER_PRESENCE_INPUT_TYPES: ReadonlySet<string> = new Set([
  'keyDown',
  'keyUp',
  'char',
  'mouseDown',
  'mouseUp',
  'mouseWheel',
  'gestureScrollBegin',
  'touchStart'
])

/**
 * How long after a human interaction the surface stays theirs. Long enough to
 * cover the gap between keystrokes in a word, short enough that an agent is not
 * locked out by someone who glanced at the page and left.
 */
const USER_ACTIVE_GRACE_MS = 1500

// Keep fixed Canvas scripts out of the page's JavaScript world. The page shares
// the DOM with this world, but cannot replace this world's global registry or
// its trusted-input listener between a snapshot and a ref action.
const CANVAS_ISOLATED_WORLD_ID = 999
export const CANVAS_ISOLATED_STATE_KEY = '__twCanvasIsolatedStateV1'

// Inserted into the snapshot script only. A real renderer event is observed in
// the same world that later checks the epoch and dispatches the action. Synthetic
// DOM events from the page or Canvas action script have `isTrusted === false` and
// therefore cannot advance this epoch.
const ISOLATED_CANVAS_STATE_SETUP = `
  const __twCanvasStateKey = ${JSON.stringify(CANVAS_ISOLATED_STATE_KEY)};
  let __twCanvasState = globalThis[__twCanvasStateKey];
  if (!__twCanvasState || typeof __twCanvasState !== 'object') {
    __twCanvasState = {
      refs: Object.create(null), ids: Object.create(null), seq: 0,
      trustedInputEpoch: 0, inputWatchInstalled: false
    };
    try {
      Object.defineProperty(globalThis, __twCanvasStateKey, {
        value: __twCanvasState, configurable: false, enumerable: false, writable: false
      });
    } catch (e) {
      globalThis[__twCanvasStateKey] = __twCanvasState;
    }
  }
  if (__twCanvasState.inputWatchInstalled !== true &&
      typeof globalThis.addEventListener === 'function') {
    const __twTrustedInputTypes = [
      'keydown', 'keyup', 'beforeinput', 'input', 'pointerdown', 'mousedown',
      'mouseup', 'wheel', 'touchstart', 'touchend'
    ];
    const __twRecordTrustedInput = (event) => {
      if (event && event.isTrusted === true) {
        const current = Number.isSafeInteger(__twCanvasState.trustedInputEpoch) &&
          __twCanvasState.trustedInputEpoch >= 0 ? __twCanvasState.trustedInputEpoch : 0;
        __twCanvasState.trustedInputEpoch = current + 1;
      }
    };
    for (const type of __twTrustedInputTypes) {
      globalThis.addEventListener(type, __twRecordTrustedInput, true);
    }
    __twCanvasState.inputWatchInstalled = true;
  }
`

const SECRET_FIELD_SELECTOR =
  'input[type=password], input[autocomplete*="password"], input[autocomplete="one-time-code"], [data-tw-secret]'

// Refuses capture while a secret field owns focus; otherwise paints an opaque
// box over every visible secret field and returns how many it covered. The
// structured result is validated main-side before capture so a failed/malformed
// page probe cannot silently degrade to an unredacted screenshot.
// Exported for CanvasWebDriverActScript.test.ts — see actScript's note.
export const REDACT_SECRETS_SCRIPT = `(() => {
  const sel = ${JSON.stringify(SECRET_FIELD_SELECTOR)};
  let nodes = [];
  try {
    nodes = Array.prototype.slice.call(document.querySelectorAll(sel));
  } catch (e) {
    return { status: 'probe_failed', secretsRedacted: 0 };
  }
  const active = document.activeElement;
  const focusedSecret = nodes.some((el) =>
    el === active || (active && typeof el.contains === 'function' && el.contains(active))
  );
  if (focusedSecret) return { status: 'focused_secret', secretsRedacted: 0 };
  const boxes = [];
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) boxes.push(r);
  }
  if (boxes.length === 0) return { status: 'ready', secretsRedacted: 0 };
  const old = document.getElementById('__twSecretRedaction');
  if (old) old.remove();
  const layer = document.createElement('div');
  layer.id = '__twSecretRedaction';
  layer.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none;';
  for (const r of boxes) {
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;background:#111827;border:1px solid #6b7280;' +
      'left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
    layer.appendChild(box);
  }
  document.documentElement.appendChild(layer);
  return { status: 'ready', secretsRedacted: boxes.length };
})()`

export const CLEAR_SECRET_REDACTION_SCRIPT = `(() => {
  const layer = document.getElementById('__twSecretRedaction');
  if (layer) layer.remove();
  return true;
})()`

interface SecretRedactionPreparation {
  focusedSecret: boolean
  secretsRedacted: number
}

function requireSecretRedactionPreparation(value: unknown): SecretRedactionPreparation {
  if (!value || typeof value !== 'object') {
    throw new Error('Secret-field probe returned no structured result.')
  }
  const record = value as Record<string, unknown>
  if (record.status === 'focused_secret' && record.secretsRedacted === 0) {
    return { focusedSecret: true, secretsRedacted: 0 }
  }
  if (
    record.status !== 'ready' ||
    typeof record.secretsRedacted !== 'number' ||
    !Number.isSafeInteger(record.secretsRedacted) ||
    record.secretsRedacted < 0
  ) {
    throw new Error('Secret-field probe did not verify a safe capture state.')
  }
  return { focusedSecret: false, secretsRedacted: record.secretsRedacted }
}

// Structural + explicit-label identity for one element. Recorded per ref at
// snapshot time and RECOMPUTED before every actuation, so a ref that now points
// at a rebuilt or detached node is refused instead of clicked.
//
// Deliberately EXCLUDES textContent. Live text (counters, timers, unread
// badges) would churn the digest and make a healthy control permanently
// un-actionable; explicit labels and structure are stable. The asymmetry is
// intentional: a false "stale" costs one wasted re-observe, a false "fresh"
// clicks the wrong element.
//
// NOTE: template literal — every regex backslash is DOUBLED so it survives into
// the evaluated page JS (`\\s` here → `\s` in the page).
const TARGET_IDENTITY_FN = `
  const __twIdentity = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const label = (el.getAttribute('aria-label') || el.getAttribute('alt') ||
      el.getAttribute('title') || el.getAttribute('placeholder') || '')
      .replace(/\\s+/g, ' ').trim().slice(0, 80);
    let path = '', n = el, depth = 0;
    while (n && n.nodeType === 1 && depth < 6) {
      const p = n.parentElement;
      let idx = 0;
      if (p) { for (const s of p.children) { if (s === n) break; if (s.tagName === n.tagName) idx++; } }
      path = '/' + n.tagName + '[' + idx + ']' + path;
      n = p; depth++;
    }
    return el.tagName + '|' + (el.getAttribute('role') || '') + '|' +
      (el.getAttribute('type') || '') + '|' + label + '|' + path;
  };`

// Injected DOM-walk that assigns stable refs (e1, e2, …), stashes elements in an
// isolated-world registry for inspect/act, and returns a compact tree. The page
// cannot replace that registry or redirect a later ref action.
// NOTE: this is a template literal — every regex backslash is DOUBLED so it
// survives into the evaluated JS string (`\\s` here → `\s` in the page).
export const SNAPSHOT_SCRIPT = `(() => {
  const MAX_NODES = 400, TEXT_TRUNCATE = 200;
  ${ISOLATED_CANVAS_STATE_SETUP}
  const reg = { refs: Object.create(null), ids: Object.create(null), seq: 0 };
  __twCanvasState.refs = reg.refs;
  __twCanvasState.ids = reg.ids;
  __twCanvasState.seq = reg.seq;
  ${TARGET_IDENTITY_FN}
  let count = 0;
  const truncate = (s) => { s = (s || '').replace(/\\s+/g, ' ').trim(); return s.length > TEXT_TRUNCATE ? s.slice(0, TEXT_TRUNCATE) + '\\u2026' : s; };
  const isVisible = (el) => {
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const INTERACTIVE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','LABEL','OPTION']);
  const LANDMARK = new Set(['NAV','MAIN','HEADER','FOOTER','SECTION','ARTICLE','ASIDE','FORM','IMG']);
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','PATH','HEAD','META','LINK']);
  const isHeading = (t) => /^H[1-6]$/.test(t);
  const implicitRole = (el) => {
    const t = el.tagName;
    if (t === 'A' && el.hasAttribute('href')) return 'link';
    if (t === 'BUTTON') return 'button';
    if (t === 'INPUT') return (el.getAttribute('type') || 'text');
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (isHeading(t)) return 'heading';
    if (t === 'NAV') return 'navigation';
    if (t === 'MAIN') return 'main';
    if (t === 'IMG') return 'img';
    return t.toLowerCase();
  };
  const accName = (el) => truncate(
    el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') ||
    el.getAttribute('placeholder') || (INTERACTIVE.has(el.tagName) ? el.textContent : '') || ''
  );
  const directText = (el) => {
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return truncate(t);
  };
  const isSecretField = (el) => {
    try {
      if (typeof el.matches === 'function' && el.matches(${JSON.stringify(SECRET_FIELD_SELECTOR)})) return true;
    } catch (e) {}
    const type = (el.getAttribute('type') || '').toLowerCase();
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    return (el.tagName === 'INPUT' &&
      (type === 'password' || autocomplete.indexOf('password') >= 0 || autocomplete === 'one-time-code')) ||
      el.hasAttribute('data-tw-secret');
  };
  const meaningful = (el) => INTERACTIVE.has(el.tagName) || el.hasAttribute('role') ||
    isHeading(el.tagName) || LANDMARK.has(el.tagName) || Boolean(directText(el));
  const build = (el) => {
    if (count >= MAX_NODES || SKIP.has(el.tagName) || !isVisible(el)) return null;
    const childNodes = [];
    for (const child of el.children) {
      const c = build(child);
      if (c) childNodes.push(c);
      if (count >= MAX_NODES) break;
    }
    const mine = meaningful(el);
    if (!mine && childNodes.length === 0) return null;
    if (!mine && childNodes.length === 1) return childNodes[0];
    const ref = 'e' + (++reg.seq);
    reg.refs[ref] = el; reg.ids[ref] = __twIdentity(el); count++;
    const r = el.getBoundingClientRect();
    const node = { ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || implicitRole(el),
      bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] };
    const name = accName(el); if (name) node.name = name;
    const text = directText(el); if (text) node.text = text;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      const itype = (el.getAttribute('type') || '').toLowerCase();
      if (isSecretField(el)) {
        node.value = '[redacted]';
      } else if (el.tagName === 'INPUT' && (itype === 'password' || itype === 'hidden')) {
        node.value = itype === 'password' ? '[redacted]' : '[hidden]';
      } else if (itype === 'checkbox' || itype === 'radio') {
        node.value = el.checked ? 'checked' : 'unchecked';
      } else {
        const v = el.value; if (v) node.value = String(v).slice(0, 200);
      }
    }
    if (childNodes.length) node.children = childNodes;
    return node;
  };
  const root = (document.body && build(document.body)) || { ref: 'e0', tag: 'body', role: 'document' };
  // The next snapshot replaces this isolated registry wholesale. Freezing its
  // maps catches accidental mutation by another fixed Canvas script; page code
  // cannot access this JavaScript world at all.
  __twCanvasState.seq = reg.seq;
  try { Object.freeze(reg.refs); Object.freeze(reg.ids); Object.freeze(reg); } catch (e) {}
  return { url: location.href, title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight }, root,
    nodeCount: reg.seq, truncated: count >= MAX_NODES,
    trustedInputEpoch: __twCanvasState.trustedInputEpoch };
})()`

function inspectScript(args: { ref?: string; selector?: string; styles?: string[] }): string {
  const ref = JSON.stringify(args.ref || null)
  const selector = JSON.stringify(args.selector || null)
  const props = JSON.stringify(
    args.styles && args.styles.length ? args.styles : DEFAULT_INSPECT_STYLES
  )
  return `(() => {
    const ref = ${ref}, selector = ${selector}, props = ${props};
    let el = null;
    const reg = globalThis[${JSON.stringify(CANVAS_ISOLATED_STATE_KEY)}];
    if (ref && reg && reg.refs) el = reg.refs[ref] || null;
    if (!el && selector) { try { el = document.querySelector(selector); } catch (e) { el = null; } }
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    const cs = window.getComputedStyle(el);
    const styles = {};
    for (const p of props) styles[p] = cs.getPropertyValue(p);
    return { found: true, tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      bbox: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], styles };
  })()`
}

// P1 click/fill. Resolves an element by ref (preferred), selector, or x/y, then
// performs a realistic interaction. Fill uses the native value setter +
// input/change events so React's controlled inputs notice the change.
//
// PRECONDITIONS (added 2026-07-26). A ref resolved out of the frozen snapshot
// registry is NOT proof the element is still real: `el.click()` on a detached
// node does not throw, `scrollIntoView` no-ops, and the old contract returned
// `{ ok: true, found: true }` for a node that had been re-rendered away. The
// agent then re-observed, saw no change, and tried harder — a silent-empty-
// success loop against a live app. Every actuation now asserts, in order:
//   1. the element is still attached (`isConnected`),
//   2. its recomputed identity still matches the snapshot's (ref path only),
//   3. its centre still hit-tests to itself (i.e. it is not covered).
// Any failure refuses WITHOUT dispatching and reports `refusalReason`. A
// credential field is refused outright on the same path.
//
// POSTCONDITION: a cheap document+target digest is taken either side of the
// dispatch so the result can say whether anything actually moved. Synchronous
// only — see the `verified` doc comment on CanvasActResult.
/**
 * Read-only pre-flight probe. Resolves the SAME target `actScript` would, using
 * the same registry/selector/point order, and reports its accessible label and
 * the current trusted input epoch — then stops. Nothing is clicked, filled,
 * focused or scrolled.
 *
 * It deliberately omits actScript's occlusion and identity refusals: this is
 * not the gate that decides whether the action may run, only what the target
 * appears to BE. The real preconditions still run at dispatch, so a target that
 * goes stale between probe and act is refused there.
 *
 * The label is PAGE-CONTROLLED and bounded here. It is used for term matching
 * only and must never be rendered into a dialog the human reads.
 *
 * Exported for CanvasWebDriverActScript.test.ts, like actScript.
 */
export function describeTargetScript(action: CanvasActionInput): string {
  const a = JSON.stringify({
    ref: action.ref ?? null,
    selector: action.selector ?? null,
    x: typeof action.x === 'number' ? action.x : null,
    y: typeof action.y === 'number' ? action.y : null
  })
  return `(() => {
    const a = ${a};
    const reg = globalThis[${JSON.stringify(CANVAS_ISOLATED_STATE_KEY)}];
    const epoch = reg && Number.isSafeInteger(reg.trustedInputEpoch)
      ? reg.trustedInputEpoch : null;
    let el = null;
    if (a.ref && reg && reg.refs) el = reg.refs[a.ref] || null;
    if (!el && a.selector) { try { el = document.querySelector(a.selector); } catch (e) { el = null; } }
    if (!el && a.x != null && a.y != null) el = document.elementFromPoint(a.x, a.y);
    if (!el || el.nodeType !== 1 || el.isConnected === false) {
      return { found: false, label: null, inputEpoch: epoch };
    }
    // Same precedence as the snapshot's accessible name, plus value/textContent
    // so a <button value="Delete"> and <button>Delete</button> both read.
    let label = '';
    try {
      label = el.getAttribute('aria-label') || el.getAttribute('title') ||
        el.getAttribute('alt') ||
        (typeof el.value === 'string' && el.value ? el.value : '') ||
        el.textContent || '';
    } catch (e) { label = ''; }
    label = String(label).replace(/\\s+/g, ' ').trim().slice(0, 200);
    return { found: true, label: label || null, inputEpoch: epoch };
  })()`
}

// Exported for CanvasWebDriverActScript.test.ts: the preconditions live inside
// the injected page script, so the only honest way to test them is to evaluate
// the generated source against a DOM stub. There is no jsdom in this project.
export function actScript(action: CanvasActionInput): string {
  const a = JSON.stringify({
    kind: action.kind,
    ref: action.ref ?? null,
    selector: action.selector ?? null,
    x: typeof action.x === 'number' ? action.x : null,
    y: typeof action.y === 'number' ? action.y : null,
    value: typeof action.value === 'string' ? action.value : null,
    key: typeof action.key === 'string' ? action.key : null,
    deltaX: typeof action.deltaX === 'number' ? action.deltaX : null,
    deltaY: typeof action.deltaY === 'number' ? action.deltaY : null,
    expectedInputEpoch:
      typeof action.expectedInputEpoch === 'number' ? action.expectedInputEpoch : null
  })
  return `(() => {
    const a = ${a};
    ${TARGET_IDENTITY_FN}
    const refuse = (reason, message, found) => ({
      ok: false, found: found === true, action: a.kind, executed: false,
      verified: 'unknown', refusalReason: reason, message: message
    });
    const reg = globalThis[${JSON.stringify(CANVAS_ISOLATED_STATE_KEY)}];
    // This check and the eventual dispatch execute in one renderer task. Unlike
    // a page-owned DOM listener, only actual browser input can advance this
    // isolated epoch; page-dispatched MouseEvent/Event objects are untrusted.
    if (a.expectedInputEpoch != null) {
      const actualEpoch = reg && Number.isSafeInteger(reg.trustedInputEpoch)
        ? reg.trustedInputEpoch : null;
      if (actualEpoch !== a.expectedInputEpoch) {
        return refuse('stale_input_epoch',
          'The user has interacted with this canvas since your snapshot; re-run canvas_snapshot.', false);
      }
    }
    let el = null;
    let byRef = false;
    if (a.ref && reg && reg.refs) {
      el = reg.refs[a.ref] || null;
      byRef = Boolean(el);
    }
    if (!el && a.selector) { try { el = document.querySelector(a.selector); } catch (e) { el = null; } }
    if (!el && a.x != null && a.y != null) el = document.elementFromPoint(a.x, a.y);
    if (!el && a.kind === 'scroll') el = document.scrollingElement || document.documentElement;
    if (!el) return refuse('not_found', 'Element not found.', false);

    // 1. Still attached? A detached node accepts clicks silently.
    if (el.isConnected === false) {
      return refuse('stale_target', 'Target is no longer attached to the document; re-run canvas_snapshot.', false);
    }
    // 2. Still the same element this ref described?
    if (byRef && reg && reg.ids) {
      const expected = reg.ids[a.ref];
      if (expected && __twIdentity(el) !== expected) {
        return refuse('stale_target', 'Target changed since the snapshot that produced this ref; re-run canvas_snapshot.', false);
      }
    }
    if (a.kind === 'wait_for') {
      return {
        ok: true, found: true, action: a.kind, executed: false,
        verified: 'unchanged', message: 'Target condition is present.'
      };
    }

    const inView = () => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
    };
    if (a.kind !== 'scroll' && !inView() && typeof el.scrollIntoView === 'function') {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    }

    // 3. Does the centre still belong to us? Covered controls silently eat the
    //    click in a real browser, so refuse rather than pretend it landed.
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    if (a.kind !== 'scroll' && rect.width > 0 && rect.height > 0 && cx >= 0 && cy >= 0 &&
        cx <= window.innerWidth && cy <= window.innerHeight) {
      let hit = null;
      try { hit = document.elementFromPoint(cx, cy); } catch (e) { hit = null; }
      if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
        return refuse('occluded', 'Target centre is covered by another element; dismiss the overlay or scroll it into the clear.', true);
      }
    }

    const digest = () => {
      let doc = '';
      try {
        doc = location.href + '|' + (document.title || '') + '|' +
          (document.body ? document.body.childElementCount : 0);
      } catch (e) { doc = 'err'; }
      let target = '';
      try {
        target = el.isConnected === false ? 'detached'
          : (el.parentElement ? el.parentElement.childElementCount : -1) + ':' +
            el.childElementCount + ':' +
            (typeof el.value === 'string' ? el.value.length : -1) + ':' +
            (el.checked === true ? 1 : 0) + ':' +
            Number(el.scrollLeft || 0) + ':' + Number(el.scrollTop || 0) + ':' +
            (el.getAttribute('aria-expanded') || '') + ':' +
            String(el.className || '').length;
      } catch (e) { target = 'err'; }
      return doc + '||' + target;
    };
    const before = digest();
    const settle = (found, message) => {
      const after = digest();
      return {
        ok: true, found: found, action: a.kind, executed: true,
        verified: after === before ? 'unchanged' : 'changed',
        ...(message ? { message: message } : {})
      };
    };

    if (a.kind === 'fill') {
      const tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        return refuse('not_fillable', 'Target is not a fillable field.', true);
      }
      const itype = (el.getAttribute('type') || '').toLowerCase();
      // Never type a credential. The user authenticates inside this very
      // surface and the frames go to whichever provider is driving; the
      // dedicated profile may retain the site session, but the agent must not
      // handle its secrets — refuse rather than redact, and let the human type.
      const autofill = (el.getAttribute('autocomplete') || '').toLowerCase();
      if (itype === 'password' || autofill.indexOf('password') >= 0 ||
          autofill === 'one-time-code' || el.hasAttribute('data-tw-secret')) {
        return refuse('secret_field',
          'Refusing to type into a credential field. Ask the user to enter this value themselves.', true);
      }
      try { el.focus(); } catch (e) {}
      if (tag === 'INPUT' && (itype === 'checkbox' || itype === 'radio')) {
        const want = a.value === 'true' || a.value === 'checked' || a.value === '1' || a.value === 'on';
        el.checked = want;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return settle(true, 'checked=' + want);
      }
      if (tag === 'INPUT' && itype === 'file') {
        return refuse('not_fillable', 'File inputs cannot be set programmatically.', true);
      }
      const next = a.value == null ? '' : String(a.value);
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      if (desc && desc.set) desc.set.call(el, next); else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return settle(true);
    }
    if (a.kind === 'select') {
      if (el.tagName !== 'SELECT') {
        return refuse('not_fillable', 'Target is not a select element.', true);
      }
      const next = a.value == null ? '' : String(a.value);
      const option = Array.from(el.options || []).find((candidate) =>
        String(candidate.value) === next || String(candidate.textContent || '').trim() === next);
      if (!option) return refuse('not_found', 'No matching select option was found.', true);
      el.value = option.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return settle(true, 'selected=' + String(option.value));
    }
    if (a.kind === 'scroll') {
      const dx = Number.isFinite(a.deltaX) ? a.deltaX : 0;
      const dy = Number.isFinite(a.deltaY) ? a.deltaY : 0;
      if (dx === 0 && dy === 0) return refuse('not_found', 'Scroll requires a non-zero delta.', true);
      if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
        try { window.scrollBy({ left: dx, top: dy, behavior: 'auto' }); }
        catch (e) { window.scrollBy(dx, dy); }
      } else if (typeof el.scrollBy === 'function') {
        try { el.scrollBy({ left: dx, top: dy, behavior: 'auto' }); }
        catch (e) { el.scrollLeft += dx; el.scrollTop += dy; }
      } else {
        el.scrollLeft += dx; el.scrollTop += dy;
      }
      return settle(true, 'scrolled');
    }
    if (a.kind === 'hover') {
      const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new MouseEvent('mouseenter', opts));
      el.dispatchEvent(new MouseEvent('mousemove', opts));
      return settle(true, 'hovered');
    }
    if (a.kind === 'key') {
      const allowed = new Set(['Enter','Escape','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
        'Home','End','PageUp','PageDown','Backspace','Delete',' ']);
      if (!allowed.has(a.key)) {
        return refuse('unsupported_action', 'Key is not in the structured non-text allowlist.', true);
      }
      try { el.focus(); } catch (e) {}
      const opts = { key: a.key, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      return settle(true, 'key=' + a.key);
    }
    if (a.kind !== 'click') {
      return refuse('unsupported_action', 'Structured Canvas action is unsupported.', true);
    }
    try { el.focus(); } catch (e) {}
    const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    if (typeof el.click === 'function') { try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', opts)); } }
    else el.dispatchEvent(new MouseEvent('click', opts));
    return settle(true);
  })()`
}

// Set-of-Mark overlay: a fixed, pointer-events:none layer of numbered boxes the
// agent draws over elements (by ref or explicit bbox) to flag issues for the
// human. Numbers are the mark order; colour encodes severity.
function annotateScript(marks: CanvasMark[]): string {
  const m = JSON.stringify(marks)
  return `(() => {
    const marks = ${m};
    const SEV = { info: '#3b82f6', warn: '#f59e0b', error: '#ef4444' };
    const existing = document.getElementById('__twCanvasAnnotations');
    if (existing) existing.remove();
    const layer = document.createElement('div');
    layer.id = '__twCanvasAnnotations';
    // position:absolute (document-anchored) + page coords so boxes scroll WITH
    // the content instead of detaching on scroll (position:fixed would float).
    layer.style.cssText = 'position:absolute;top:0;left:0;z-index:2147483647;pointer-events:none;';
    let count = 0;
    marks.forEach((mk, i) => {
      let rect = Array.isArray(mk.bbox) ? { x: mk.bbox[0], y: mk.bbox[1], w: mk.bbox[2], h: mk.bbox[3] } : null;
      const reg = globalThis[${JSON.stringify(CANVAS_ISOLATED_STATE_KEY)}];
      if (!rect && mk.ref && reg && reg.refs && reg.refs[mk.ref]) {
        const r = reg.refs[mk.ref].getBoundingClientRect();
        rect = { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      if (!rect) return;
      const left = rect.x + window.scrollX, top = rect.y + window.scrollY;
      const color = SEV[mk.severity] || SEV.info;
      const box = document.createElement('div');
      box.style.cssText = 'position:absolute;left:' + left + 'px;top:' + top + 'px;width:' + rect.w + 'px;height:' + rect.h + 'px;border:2px solid ' + color + ';border-radius:3px;box-sizing:border-box;';
      const tag = document.createElement('div');
      tag.textContent = (i + 1) + (mk.label ? ': ' + mk.label : '');
      tag.style.cssText = 'position:absolute;left:0;top:-18px;background:' + color + ';color:#fff;font:11px/14px sans-serif;padding:1px 4px;border-radius:3px;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis;';
      box.appendChild(tag);
      layer.appendChild(box);
      count++;
    });
    document.body.appendChild(layer);
    return { count };
  })()`
}

function normalizeConsoleLevel(level: unknown): CanvasConsoleLevel {
  if (typeof level === 'number') {
    return level >= 3 ? 'error' : level === 2 ? 'warn' : level === 0 ? 'debug' : 'info'
  }
  const s = String(level || '').toLowerCase()
  if (s.includes('err')) return 'error'
  if (s.includes('warn')) return 'warn'
  if (s.includes('debug') || s.includes('verbose')) return 'debug'
  if (s === 'log') return 'log'
  return 'info'
}

export interface CanvasWebDriverDeps {
  /** Inject an alternate host surface (e.g. an embedded WebContentsView). */
  createSurface?: (opts: CanvasSurfaceOptions) => CanvasHostSurface
  /** Injectable DNS seam for SSRF/rebinding tests. Production uses dns.lookup. */
  resolveHost?: CanvasResolveHost
  /**
   * Live browser-chrome state stream (address bar / back-forward / spinner).
   * Ephemeral: consumers must not persist raw URLs from it.
   */
  onNavState?: (state: CanvasNavState) => void
  /** Fired once per committed main-frame / in-page navigation (url settled). */
  onNavigationCommitted?: (state: CanvasNavState) => void
  /** Human floating-window chrome route (service-owned for audit/serialization). */
  onHumanNavigate?: (input: CanvasNavigateInput) => Promise<CanvasNavState>
  /** Human asks to move this standalone surface into the app dock. */
  onDockRequest?: () => void | Promise<void>
  /** Shared in production; injectable so driver tests stay session-local. */
  browserProfile?: CanvasBrowserProfileController
}

type SnapshotScriptResult = Omit<CanvasElementTree, 'capturedAt' | 'inputEpoch'> & {
  trustedInputEpoch: unknown
}

function requireTrustedInputEpoch(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('Canvas snapshot did not return a valid trusted input epoch.')
  }
  return Number(value)
}

export class CanvasWebDriver implements CanvasDriver {
  readonly kind = 'web' as const

  private surface: CanvasHostSurface | null = null
  private readonly partition: string
  private readonly networkBuffer: CanvasNetworkEntry[] = []
  private readonly networkById = new Map<number, CanvasNetworkEntry>()
  private readonly consoleEntries: CanvasConsoleEntry[] = []
  // While an arbitrary eval is in flight, ALL page requests are cancelled (not
  // just SSRF-class) so the model's script can never use fetch/XHR/ws/<img> as an
  // exfiltration channel during the eval window. Set immediately before, cleared
  // in a finally immediately after, win.webContents.executeJavaScript.
  private readonly evalEgressGate = new CanvasEvalEgressGate()
  private readonly createSurface: (opts: CanvasSurfaceOptions) => CanvasHostSurface
  private readonly resolveHost?: CanvasResolveHost
  private readonly dnsBlockCache = new Map<string, Promise<boolean>>()
  // A Canvas driver is single-use. Once close() has been requested, every
  // pending open continuation must stay cancelled; otherwise a slow DNS or
  // navigation await can create/re-adopt a surface after history was cleared.
  private lifecycleGeneration = 0
  private closeRequested = false
  /** Bumped by every human interaction; see attachUserInputWatch. */
  private inputEpoch = 0
  /** Main input epoch recorded for each isolated renderer snapshot epoch. */
  private readonly mainInputEpochByTrustedEpoch = new Map<number, number>()
  /** Epoch-ms until which the human owns the surface. */
  private userActiveUntil = 0
  private readonly onNavState?: (state: CanvasNavState) => void
  private readonly onNavigationCommitted?: (state: CanvasNavState) => void
  private readonly onHumanNavigate?: (input: CanvasNavigateInput) => Promise<CanvasNavState>
  private readonly onDockRequest?: () => void | Promise<void>
  private readonly browserProfile: CanvasBrowserProfileController
  private releaseProfileRegistration: (() => void) | null = null

  constructor(sessionId: string, deps: CanvasWebDriverDeps = {}) {
    // Directly constructed drivers keep a one-canvas in-memory profile. The app
    // injects one shared persistent profile for first-class cookie/sign-in reuse.
    this.browserProfile =
      deps.browserProfile ?? new CanvasBrowserProfile({ partition: `canvas-${sessionId}` })
    this.partition = this.browserProfile.partition
    this.createSurface = deps.createSurface ?? createBrowserWindowSurface
    this.resolveHost = deps.resolveHost
    this.onNavState = deps.onNavState
    this.onNavigationCommitted = deps.onNavigationCommitted
    this.onHumanNavigate = deps.onHumanNavigate
    this.onDockRequest = deps.onDockRequest
  }

  private requireSurface(): CanvasHostSurface {
    if (!this.surface || this.surface.isDestroyed()) {
      throw new Error('Canvas surface is not open (or was closed).')
    }
    return this.surface
  }

  private executeCanvasScript<T>(wc: WebContents, code: string): Promise<T> {
    // Do not fall back to executeJavaScript: a page-world fallback would let
    // page code replace the ref registry that authorizes later actions.
    return wc.executeJavaScriptInIsolatedWorld(
      CANVAS_ISOLATED_WORLD_ID,
      [{ code }],
      true
    ) as Promise<T>
  }

  private rememberTrustedInputEpoch(trustedEpoch: number): void {
    // A repeated epoch is normal between snapshots; retain the latest main-side
    // guard value and bound memory for long-lived canvases.
    this.mainInputEpochByTrustedEpoch.delete(trustedEpoch)
    this.mainInputEpochByTrustedEpoch.set(trustedEpoch, this.inputEpoch)
    while (this.mainInputEpochByTrustedEpoch.size > 128) {
      const oldest = this.mainInputEpochByTrustedEpoch.keys().next().value
      if (oldest === undefined) break
      this.mainInputEpochByTrustedEpoch.delete(oldest)
    }
  }

  async open(input: CanvasOpenInput): Promise<CanvasSessionHandle> {
    if (this.closeRequested) {
      throw new Error('Canvas open was cancelled because the driver was closed.')
    }
    const lifecycleGeneration = this.lifecycleGeneration
    const assertOpenStillLive = (): void => {
      if (this.closeRequested || lifecycleGeneration !== this.lifecycleGeneration) {
        throw new Error('Canvas open was cancelled because the driver was closed.')
      }
    }
    const rawUrl = (input.url || '').trim()
    let initialUrl: string | null = null
    if (rawUrl) {
      const verdict = validateCanvasUrl(rawUrl)
      if (!verdict.ok || !verdict.normalizedUrl) {
        throw new Error(verdict.reason || 'Canvas URL was rejected.')
      }
      await assertCanvasDnsAllowed(verdict.normalizedUrl, this.resolveHost)
      initialUrl = verdict.normalizedUrl
    }
    assertOpenStillLive()
    const viewport = resolveViewport({
      width: input.viewport?.width,
      height: input.viewport?.height
    })

    const surface = this.createSurface({
      partition: this.partition,
      kind: 'web',
      width: viewport.width,
      height: viewport.height
    })
    this.surface = surface
    const wc = surface.webContents
    surface.onNavigateRequest?.((input) =>
      this.onHumanNavigate ? this.onHumanNavigate(input) : this.navigate(input)
    )
    if (this.onDockRequest) surface.onDockRequest?.(this.onDockRequest)

    // Single-page-browser popup policy: no new window EVER escapes the canvas,
    // but a target=_blank / window.open link navigates THIS surface in place
    // (when the URL passes the same open-gate policy), matching what a user
    // expects from a one-pane browser. A rejected URL is simply dropped.
    wc.setWindowOpenHandler((details) => {
      const verdict = validateCanvasUrl(details.url || '')
      if (verdict.ok && verdict.normalizedUrl && !this.closeRequested) {
        void wc.loadURL(verdict.normalizedUrl).catch(() => {
          // Load failures surface through did-fail-load / nav-state; never throw here.
        })
      }
      return { action: 'deny' }
    })
    // Main-frame navigation gate for IN-PAGE causes (link clicks, meta refresh,
    // page scripts): the per-request SSRF hook below already cancels blocked
    // http(s) requests, but only will-navigate can refuse a scheme change
    // (file:, chrome:, custom protocols) before Chromium commits it.
    wc.on('will-navigate', (event, url) => {
      if (!validateCanvasUrl(url || '').ok) event.preventDefault()
    })
    this.hardenWebContents(wc)
    // The fixed metadata deny rule is enforced per request in attachNetwork.
    wc.on('console-message', (details) => {
      this.pushConsole({
        level: normalizeConsoleLevel((details as { level?: unknown }).level),
        message: String((details as { message?: unknown }).message ?? ''),
        line: (details as { lineNumber?: number }).lineNumber,
        sourceId: (details as { sourceId?: string }).sourceId,
        at: new Date().toISOString()
      })
    })
    this.attachNetwork(wc)
    this.attachUserInputWatch(wc)
    this.attachNavigationWatch(wc)
    surface.onClosed(() => {
      if (this.surface === surface) this.surface = null
      this.releaseBrowserProfile()
    })

    if (initialUrl) await this.loadUrl(wc, initialUrl)
    assertOpenStillLive()
    surface.setNavigationState?.(this.navState())
    return {
      url: wc.getURL() || initialUrl || 'about:blank',
      title: surface.getTitle(),
      viewport
    }
  }

  private loadUrl(wc: WebContents, url: string): Promise<void> {
    return new Promise<void>((resolvePromise, reject) => {
      let settled = false
      const finish = (err?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        wc.removeListener('did-finish-load', onLoad)
        wc.removeListener('did-fail-load', onFail)
        err ? reject(err) : resolvePromise()
      }
      const onLoad = (): void => finish()
      const onFail = (
        _e: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ): void => {
        // -3 ERR_ABORTED fires when a main-frame load is superseded by a client/
        // server redirect that then succeeds; ignore it (mirrors the proven
        // browser path, which only logs did-fail-load) and let did-finish-load
        // or the timeout settle.
        if (isMainFrame && errorCode !== -3) {
          finish(new Error(`Navigation failed (${errorCode}): ${errorDescription} [${validatedURL}]`))
        }
      }
      const timer = setTimeout(() => finish(new Error(`Canvas load timed out after ${LOAD_TIMEOUT_MS}ms.`)), LOAD_TIMEOUT_MS)
      wc.on('did-finish-load', onLoad)
      wc.on('did-fail-load', onFail)
      wc.loadURL(url).catch((err) => finish(err instanceof Error ? err : new Error(String(err))))
    })
  }

  /**
   * Close the egress channel that webRequest.onBeforeRequest (and thus the eval
   * egress-cut) cannot see on this webContents:
   *  - WebRTC ICE/STUN/TURN/data-channel is UDP and bypasses webRequest entirely,
   *    so a script could open an RTCPeerConnection to exfiltrate. Force non-proxied
   *    UDP off and deny the media permission. (TURN-over-TCP remains a documented
   *    residual — see the canvas_eval security notes.)
   * Session-wide permission and download denial lives in CanvasBrowserProfile,
   * where it is installed exactly once for the shared persistent partition.
   */
  private hardenWebContents(wc: WebContents): void {
    try {
      wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    } catch {
      // Older Electron / unavailable — best effort.
    }
  }

  /**
   * Tracks real human input into the surface so the agent can be told to stand
   * down, and so it can detect that the page moved under it.
   *
   * Uses `input-event` rather than `before-input-event`: the latter is keyboard
   * only, and a mouse click is exactly the interaction we must not talk over.
   * This is a MAIN-process hook on the real OS input pipeline, so a page cannot
   * suppress or forge it. It also means the agent cannot trip its own guard —
   * synthetic DOM events dispatched through executeJavaScript never enter the
   * input pipeline (we deliberately do not use sendInputEvent anywhere).
   */
  private attachUserInputWatch(wc: WebContents): void {
    try {
      wc.on('input-event', (_event, input) => {
        const type = String((input as { type?: unknown })?.type ?? '')
        if (!USER_PRESENCE_INPUT_TYPES.has(type)) return
        this.inputEpoch += 1
        this.userActiveUntil = Date.now() + USER_ACTIVE_GRACE_MS
      })
    } catch {
      // Older Electron without 'input-event'. The guard then never engages;
      // the element preconditions and the serialization lock still apply.
    }
  }

  /**
   * Browser-chrome state stream. Every signal here is a cheap sync read at
   * event time; consumers throttle/render, and nothing raw is persisted (the
   * committed callback's consumer redacts before any durable write).
   */
  private attachNavigationWatch(wc: WebContents): void {
    if (!this.onNavState && !this.onNavigationCommitted && !this.surface?.setNavigationState) return
    const emitState = (): void => {
      if (this.closeRequested || !this.surface || this.surface.isDestroyed()) return
      try {
        const state = this.navState()
        this.surface.setNavigationState?.(state)
        this.onNavState?.(state)
      } catch {
        // A chrome listener must never break the page lifecycle.
      }
    }
    const emitCommitted = (): void => {
      if (this.closeRequested || !this.surface || this.surface.isDestroyed()) return
      try {
        this.onNavigationCommitted?.(this.navState())
      } catch {
        // Same: navigation bookkeeping is advisory to the driver.
      }
      emitState()
    }
    wc.on('did-start-loading', emitState)
    wc.on('did-stop-loading', emitState)
    wc.on('page-title-updated', emitState)
    wc.on('did-navigate', emitCommitted)
    wc.on('did-navigate-in-page', emitCommitted)
  }

  navState(): CanvasNavState {
    const surface = this.requireSurface()
    const wc = surface.webContents
    const history = this.readNavHistoryFlags(wc)
    let isLoading = false
    try {
      isLoading = wc.isLoading()
    } catch {
      // Teardown tolerance: report a chrome-safe default.
    }
    return {
      url: wc.getURL() || 'about:blank',
      title: surface.getTitle(),
      isLoading,
      canGoBack: history.canGoBack,
      canGoForward: history.canGoForward
    }
  }

  /**
   * Read back/forward availability across Electron versions. The modern
   * `webContents.navigationHistory.{canGoBack,canGoForward}` is preferred, but
   * on some builds it is not present on an embedded WebContentsView's
   * webContents, so fall back to the (deprecated but still shipped) direct
   * methods rather than silently reporting "no history" and greying the
   * buttons on a page that plainly has history.
   */
  private readNavHistoryFlags(wc: WebContents): { canGoBack: boolean; canGoForward: boolean } {
    const nav = (wc as unknown as { navigationHistory?: unknown }).navigationHistory as
      | { canGoBack?: () => boolean; canGoForward?: () => boolean }
      | undefined
    let canGoBack = false
    let canGoForward = false
    if (nav && typeof nav.canGoBack === 'function' && typeof nav.canGoForward === 'function') {
      try {
        canGoBack = nav.canGoBack()
        canGoForward = nav.canGoForward()
        return { canGoBack, canGoForward }
      } catch {
        // Fall through to the legacy methods.
      }
    }
    const legacy = wc as unknown as { canGoBack?: () => boolean; canGoForward?: () => boolean }
    try {
      if (typeof legacy.canGoBack === 'function') canGoBack = legacy.canGoBack()
      if (typeof legacy.canGoForward === 'function') canGoForward = legacy.canGoForward()
    } catch {
      // History unavailable mid-teardown; chrome-safe defaults stand.
    }
    return { canGoBack, canGoForward }
  }

  async navigate(input: CanvasNavigateInput): Promise<CanvasNavState> {
    const surface = this.requireSurface()
    const wc = surface.webContents
    const action = input.action
    const rawUrl = (input.url || '').trim()
    if ((rawUrl && action) || (!rawUrl && !action)) {
      throw new Error('Provide exactly one of `url` or `action` to navigate.')
    }
    if (rawUrl) {
      // Same open gate + DNS policy as the initial load: http(s) only, with a
      // fixed link-local/metadata deny rule and no host allowlist.
      const verdict = validateCanvasUrl(rawUrl)
      if (!verdict.ok || !verdict.normalizedUrl) {
        throw new Error(verdict.reason || 'Canvas URL was rejected.')
      }
      await assertCanvasDnsAllowed(verdict.normalizedUrl, this.resolveHost)
      if (this.closeRequested) {
        throw new Error('Canvas navigation was cancelled because the driver was closed.')
      }
      await this.loadUrl(wc, verdict.normalizedUrl)
      return this.navState()
    }
    if (action === 'stop') {
      try {
        wc.stop()
      } catch {
        // Nothing loading is a normal outcome.
      }
      return this.navState()
    }
    if (action === 'reload') {
      await this.settleAfter(wc, () => wc.reload())
      return this.navState()
    }
    const flags = this.readNavHistoryFlags(wc)
    if (action === 'back') {
      if (!flags.canGoBack) throw new Error('Nothing earlier in this canvas history.')
      await this.settleAfter(wc, () => this.goHistory(wc, 'back'))
      return this.navState()
    }
    if (!flags.canGoForward) throw new Error('Nothing later in this canvas history.')
    await this.settleAfter(wc, () => this.goHistory(wc, 'forward'))
    return this.navState()
  }

  /** Version-tolerant history step, mirroring readNavHistoryFlags. */
  private goHistory(wc: WebContents, direction: 'back' | 'forward'): void {
    const nav = (wc as unknown as { navigationHistory?: unknown }).navigationHistory as
      | { goBack?: () => void; goForward?: () => void }
      | undefined
    const modern = direction === 'back' ? nav?.goBack : nav?.goForward
    if (typeof modern === 'function') {
      modern.call(nav)
      return
    }
    const legacy = wc as unknown as { goBack?: () => void; goForward?: () => void }
    const fn = direction === 'back' ? legacy.goBack : legacy.goForward
    if (typeof fn === 'function') fn.call(wc)
  }

  /**
   * Kick a history/reload navigation and wait for it to settle. Unlike the
   * initial open, a settle miss is NOT an error: SPA history steps commit with
   * no load events at all, so the timeout falls through to the live state.
   */
  private settleAfter(wc: WebContents, kick: () => void): Promise<void> {
    return new Promise<void>((resolvePromise) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        wc.removeListener('did-stop-loading', finish)
        wc.removeListener('did-navigate', finish)
        wc.removeListener('did-navigate-in-page', finish)
        resolvePromise()
      }
      const timer = setTimeout(finish, NAV_SETTLE_TIMEOUT_MS)
      wc.on('did-stop-loading', finish)
      wc.on('did-navigate', finish)
      wc.on('did-navigate-in-page', finish)
      try {
        kick()
      } catch {
        finish()
      }
    })
  }

  private attachNetwork(wc: WebContents): void {
    const push = (entry: CanvasNetworkEntry): void => {
      this.networkById.set(entry.id, entry)
      this.networkBuffer.push(entry)
      while (this.networkBuffer.length > NETWORK_BUFFER) {
        const dropped = this.networkBuffer.shift()
        if (dropped) this.networkById.delete(dropped.id)
      }
    }
    this.releaseBrowserProfile()
    this.releaseProfileRegistration = this.browserProfile.register(wc, {
      shouldBlock: (details) => {
        // Egress-cut during eval takes precedence over the metadata deny rule:
        // while a script is running, NOTHING leaves this canvas.
        if (this.evalEgressGate.active || isCanvasRequestBlocked(details.url)) {
          return true
        }
        return this.dnsBlocked(details.url).catch(() => true)
      },
      onSendHeaders: (details) => {
        push({
          id: details.id,
          url: details.url,
          method: details.method,
          resourceType: details.resourceType,
          startedAt: new Date().toISOString()
        })
      },
      onCompleted: (details) => {
        const entry = this.networkById.get(details.id)
        if (entry) {
          entry.status = details.statusCode
          entry.ok = details.statusCode < 400
          entry.completedAt = new Date().toISOString()
        }
      },
      onErrorOccurred: (details) => {
        const entry = this.networkById.get(details.id)
        if (entry) {
          entry.errorText = details.error
          entry.ok = false
          entry.completedAt = new Date().toISOString()
        }
      }
    })
  }

  private releaseBrowserProfile(): void {
    const release = this.releaseProfileRegistration
    this.releaseProfileRegistration = null
    release?.()
  }

  private dnsBlocked(url: string): Promise<boolean> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return Promise.resolve(false)
    }
    if (!parsed.hostname) return Promise.resolve(false)
    const key = `${parsed.protocol}//${parsed.hostname}`
    let cached = this.dnsBlockCache.get(key)
    if (!cached) {
      cached = isCanvasDnsBlocked(url, this.resolveHost)
      this.dnsBlockCache.set(key, cached)
      if (this.dnsBlockCache.size > 256) {
        const first = this.dnsBlockCache.keys().next().value
        if (first) this.dnsBlockCache.delete(first)
      }
    }
    return cached
  }

  private pushConsole(entry: CanvasConsoleEntry): void {
    this.consoleEntries.push(entry)
    while (this.consoleEntries.length > CONSOLE_BUFFER) this.consoleEntries.shift()
  }

  async snapshot(): Promise<CanvasElementTree> {
    const wc = this.requireSurface().webContents
    const result = await this.executeCanvasScript<SnapshotScriptResult>(wc, SNAPSHOT_SCRIPT)
    const trustedInputEpoch = requireTrustedInputEpoch(result?.trustedInputEpoch)
    const { trustedInputEpoch: _ignoredTrustedEpoch, ...tree } = result
    // `inputEpoch` is the isolated renderer's trusted-input epoch. Pair it with
    // the independent main-process input-event epoch so both guards must still
    // agree before a pinned action reaches the renderer.
    this.rememberTrustedInputEpoch(trustedInputEpoch)
    return { ...tree, capturedAt: new Date().toISOString(), inputEpoch: trustedInputEpoch }
  }

  async screenshot(): Promise<CanvasFrame> {
    const wc = this.requireSurface().webContents
    // Snapshots already redact secret input VALUES, but a screenshot captures the
    // rendered field, so it needs its own guard. Refuse while a secret owns
    // focus, paint over other visible secrets, and fail closed if the probe
    // cannot prove either state. A frame that fails to capture must not leave
    // the user's page defaced.
    const clearSecretRedaction = async (): Promise<void> => {
      try {
        await this.executeCanvasScript(wc, CLEAR_SECRET_REDACTION_SCRIPT)
      } catch {
        // Window may have gone away; any overlay dies with it.
      }
    }
    let preparation: SecretRedactionPreparation
    try {
      preparation = requireSecretRedactionPreparation(
        await this.executeCanvasScript(wc, REDACT_SECRETS_SCRIPT)
      )
    } catch {
      await clearSecretRedaction()
      throw new Error(
        'Canvas screenshot blocked because credential-field protection could not verify the page.'
      )
    }
    if (preparation.focusedSecret) {
      await clearSecretRedaction()
      throw new Error(
        'Canvas screenshot refused while a credential field is focused. Ask the user to finish entering the secret and move focus before capturing.'
      )
    }
    const { secretsRedacted } = preparation
    try {
      const image = await wc.capturePage()
      const png = image.toPNG()
      const size = image.getSize()
      return {
        mimeType: 'image/png',
        data: png.toString('base64'),
        width: size.width,
        height: size.height,
        byteLength: png.byteLength,
        hash: createHash('sha256').update(png).digest('hex'),
        capturedAt: new Date().toISOString(),
        ...(secretsRedacted > 0 ? { secretsRedacted } : {})
      }
    } finally {
      if (secretsRedacted > 0) {
        await clearSecretRedaction()
      }
    }
  }

  async inspect(args: {
    ref?: string
    selector?: string
    styles?: string[]
  }): Promise<CanvasElementDetail> {
    const wc = this.requireSurface().webContents
    const detail = await this.executeCanvasScript<Omit<CanvasElementDetail, 'ref' | 'selector'>>(
      wc,
      inspectScript(args)
    )
    return { ...detail, ref: args.ref, selector: args.selector }
  }

  async network(args: { filter?: 'all' | 'failed'; requestId?: number }): Promise<CanvasNetworkEntry[]> {
    this.requireSurface()
    let entries = [...this.networkBuffer]
    if (typeof args.requestId === 'number') {
      entries = entries.filter((entry) => entry.id === args.requestId)
    }
    if (args.filter === 'failed') {
      entries = entries.filter((entry) => entry.ok === false || (entry.status ?? 0) >= 400)
    }
    return entries
  }

  async console(args: { level?: 'all' | 'warn' | 'error'; lines?: number }): Promise<CanvasConsoleEntry[]> {
    this.requireSurface()
    let entries = [...this.consoleEntries]
    if (args.level === 'error') entries = entries.filter((entry) => entry.level === 'error')
    else if (args.level === 'warn') entries = entries.filter((entry) => entry.level === 'warn' || entry.level === 'error')
    const requested = Math.trunc(Number(args.lines))
    const lines = Math.max(1, Math.min(200, Number.isFinite(requested) ? requested : 50))
    return entries.slice(-lines)
  }

  async resize(viewport: CanvasViewport): Promise<CanvasViewport> {
    this.requireSurface().setContentSize(viewport.width, viewport.height)
    return viewport
  }

  /**
   * Read-only target probe for the consequential-action check. Never dispatches.
   * A failure here is reported as "not found" rather than thrown: the caller
   * treats an unusable probe as "nothing to judge" and lets the ordinary
   * dispatch path surface the real error.
   */
  async describeTarget(action: CanvasActionInput): Promise<CanvasTargetDescription> {
    const wc = this.requireSurface().webContents
    const result = await this.executeCanvasScript<{
      found?: unknown
      label?: unknown
      inputEpoch?: unknown
    }>(wc, describeTargetScript(action))
    return {
      found: result.found === true,
      label: typeof result.label === 'string' ? result.label : null,
      inputEpoch: Number.isSafeInteger(result.inputEpoch) ? Number(result.inputEpoch) : null
    }
  }

  async act(action: CanvasActionInput): Promise<CanvasActResult> {
    const surface = this.requireSurface()
    const wc = surface.webContents

    // The human always wins. Two separate clocks, deliberately:
    //
    // `userActiveUntil` is presence — someone is working in this surface right
    // now, so do not talk over them (this, not stripping el.focus(), is the real
    // fix for the agent stealing focus mid-typing: a synthetic click has no
    // default action, so focus() is what makes focus-driven widgets work at all,
    // and removing it would break menus to solve a problem the guard covers).
    //
    // `inputEpoch` is freshness — the caller can pin the observation its plan to
    // an isolated renderer-side trusted-input epoch. The renderer compares it in
    // the same task as dispatch, while the main input-event epoch remains an
    // independent defence against input the isolated listener could not observe.
    const refuse = (
      refusalReason: 'user_active' | 'stale_input_epoch',
      message: string
    ): CanvasActResult => ({
      ok: false,
      action: action.kind,
      found: false,
      executed: false,
      verified: 'unknown',
      refusalReason,
      message,
      ref: action.ref,
      selector: action.selector,
      url: wc.getURL(),
      title: surface.getTitle()
    })
    if (action.kind !== 'wait_for' && Date.now() < this.userActiveUntil) {
      return refuse(
        'user_active',
        'The user is interacting with this canvas. Wait for them to finish, then re-snapshot.'
      )
    }
    if (typeof action.expectedInputEpoch === 'number') {
      const snapshotMainEpoch = this.mainInputEpochByTrustedEpoch.get(action.expectedInputEpoch)
      if (snapshotMainEpoch !== this.inputEpoch) {
        return refuse(
          'stale_input_epoch',
          'The user has interacted with this canvas since your snapshot. Re-snapshot before acting.'
        )
      }
      // The renderer-side atomic comparison below remains necessary: human
      // input can arrive after this main-process check and before injection.
    }

    type InjectedActResult = {
      ok: boolean
      found: boolean
      action: CanvasActionInput['kind']
      executed?: boolean
      verified?: CanvasActVerification
      refusalReason?: CanvasActRefusalReason
      message?: string
    }
    let result: InjectedActResult
    if (action.kind === 'wait_for') {
      const timeoutMs = Math.max(0, Math.min(30_000, Math.trunc(action.timeoutMs ?? 5_000)))
      const deadline = Date.now() + timeoutMs
      while (true) {
        result = await this.executeCanvasScript<InjectedActResult>(wc, actScript(action))
        if (result.ok && result.found) break
        if (Date.now() >= deadline) {
          result = {
            ok: false,
            found: false,
            action: 'wait_for',
            executed: false,
            verified: 'unknown',
            refusalReason: 'wait_timeout',
            message: `Target did not appear within ${timeoutMs}ms.`
          }
          break
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
      }
    } else {
      result = await this.executeCanvasScript<InjectedActResult>(wc, actScript(action))
    }
    return {
      ...result,
      // Fail honest: an injected result missing these is treated as "we cannot
      // claim this ran", never as a success.
      executed: result.executed === true,
      verified: result.verified ?? 'unknown',
      ref: action.ref,
      selector: action.selector,
      url: wc.getURL(),
      title: surface.getTitle()
    }
  }

  async annotate(marks: CanvasMark[]): Promise<{ count: number }> {
    const wc = this.requireSurface().webContents
    return this.executeCanvasScript<{ count: number }>(wc, annotateScript(marks))
  }

  async sketchDocument(): Promise<CanvasSketchDocument> {
    throw new Error('canvas_sketch_get is only available for the sketch driver.')
  }

  async sketchUpdate(_update: CanvasSketchUpdateInput): Promise<CanvasSketchDocument> {
    throw new Error('canvas_sketch_update is only available for the sketch driver.')
  }

  async evaluate(args: { script: string }): Promise<CanvasEvalResult> {
    const surface = this.requireSurface()
    const wc = surface.webContents
    // Indirect eval `(0, eval)(src)` runs the script in the page's GLOBAL scope and
    // yields its completion value (supports both expressions and statement blocks).
    // The wrapper captures the value/error so a throw (or a page CSP that blocks
    // eval) returns { ok:false } instead of rejecting. JSON.stringify(script) does
    // all the escaping — no manual backslash handling needed.
    const cap = CANVAS_EVAL_VALUE_CAP
    const wrapped =
      '(() => { try { var __r = (0, eval)(' +
      JSON.stringify(args.script) +
      '); var t = typeof __r; var v; try { v = JSON.stringify(__r); } catch (e) { v = String(__r); }' +
      ' if (typeof v === "undefined") v = String(__r); var s = String(v);' +
      ' return { ok: true, valueType: t, value: s.slice(0, ' +
      cap +
      '), truncated: s.length > ' +
      cap +
      ' }; } catch (e) { var es = String((e && e.message) || e); return { ok: false, error: es.slice(0, ' +
      cap +
      '), truncated: es.length > ' +
      cap +
      ' }; } })()'
    // Cut ALL page egress for the script, then restore the per-host SSRF policy in
    // finally — even if the script throws.
    //
    // SCOPE / RESIDUALS (the egress-cut is best-effort defence-in-depth, NOT a hard
    // boundary — the primary control is that a human approved this exact script,
    // which they saw in full):
    //  - executeJavaScript resolves after the script's SYNCHRONOUS frame; a script
    //    can SCHEDULE a deferred request. We hold the cut for EVAL_EGRESS_HOLD_MS
    //    after it resolves to catch setTimeout(0)/microtask/short-async exfil. A
    //    LONG-delay timer (which the approver saw in the script) still escapes.
    //  - The eval RETURN VALUE is itself a read channel (the agent can `return
    //    document.cookie`); the cut does not — and is not meant to — stop that.
    //  - WebRTC/downloads are closed in hardenSession(); TURN-over-TCP is residual.
    const releaseEgressCut = this.evalEgressGate.enter()
    let result: Omit<CanvasEvalResult, 'url' | 'title'>
    try {
      result = (await wc.executeJavaScript(wrapped, true)) as Omit<
        CanvasEvalResult,
        'url' | 'title'
      >
    } finally {
      await delay(EVAL_EGRESS_HOLD_MS)
      releaseEgressCut()
    }
    return { ...result, url: wc.getURL(), title: surface.getTitle() }
  }

  async reload(): Promise<void> {
    this.requireSurface().webContents.reload()
  }

  async close(): Promise<void> {
    this.closeRequested = true
    this.lifecycleGeneration += 1
    const surface = this.surface
    this.surface = null
    this.mainInputEpochByTrustedEpoch.clear()
    this.releaseBrowserProfile()
    if (!surface || surface.isDestroyed()) return
    surface.destroy()
  }
}
