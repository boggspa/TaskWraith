import { createHash } from 'crypto'
import type { WebContents } from 'electron'
import {
  createBrowserWindowSurface,
  type CanvasHostSurface,
  type CanvasSurfaceOptions
} from './CanvasHostSurface'
import type {
  CanvasActionInput,
  CanvasActResult,
  CanvasConsoleEntry,
  CanvasDriver,
  CanvasElementDetail,
  CanvasElementNode,
  CanvasElementTree,
  CanvasEvalResult,
  CanvasFrame,
  CanvasMark,
  CanvasNetworkEntry,
  CanvasOpenInput,
  CanvasSessionHandle,
  CanvasSketchDocument,
  CanvasSketchElement,
  CanvasSketchElementKind,
  CanvasSketchPoint,
  CanvasSketchUpdateInput,
  CanvasViewport
} from './canvasTypes'
import { resolveViewport } from './canvasTypes'

const MAX_SKETCH_ELEMENTS = 400
const MAX_SKETCH_POINTS = 200
const MAX_SKETCH_TEXT = 500
const MAX_SKETCH_PATH = 4000
const COORD_LIMIT = 100000
const DEFAULT_TITLE = 'Sketch Canvas'

const SKETCH_KINDS: ReadonlySet<CanvasSketchElementKind> = new Set([
  'rect',
  'ellipse',
  'line',
  'arrow',
  'text',
  'path'
])

const SKETCH_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>Sketch Canvas</title>
<style>
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; height: 100vh; overflow: hidden; background: #f6f7f8; color: #16181d; }
.toolbar { position: fixed; left: 12px; top: 12px; z-index: 2; display: flex; gap: 4px; align-items: center; padding: 6px; border: 1px solid rgba(20,24,31,.14); border-radius: 8px; background: rgba(255,255,255,.88); box-shadow: 0 8px 24px rgba(0,0,0,.12); backdrop-filter: blur(12px); }
button { border: 0; border-radius: 6px; padding: 6px 8px; background: transparent; color: inherit; font: 12px/1 system-ui, sans-serif; cursor: pointer; }
button:hover { background: rgba(0,0,0,.06); }
button.active { background: #111827; color: #fff; }
.divider { width: 1px; height: 20px; background: rgba(20,24,31,.14); margin: 0 2px; }
.canvas { width: 100vw; height: 100vh; touch-action: none; user-select: none; background-color: #fafafa; background-image: linear-gradient(rgba(22,24,29,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(22,24,29,.08) 1px, transparent 1px); background-size: 24px 24px; }
svg text { user-select: none; white-space: pre; }
.selected-outline { pointer-events: none; fill: none; stroke: #2563eb; stroke-width: 1.5; stroke-dasharray: 5 4; }
.text-editor { position: fixed; z-index: 3; min-width: 160px; max-width: 360px; border: 1px solid #2563eb; border-radius: 6px; padding: 6px 8px; background: rgba(255,255,255,.96); color: #111827; font: 18px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.18); outline: none; }
@media (prefers-color-scheme: dark) {
  body { background: #15171c; color: #f4f7fb; }
  .toolbar { background: rgba(23,25,31,.88); border-color: rgba(255,255,255,.14); }
  button:hover { background: rgba(255,255,255,.08); }
  button.active { background: #f4f7fb; color: #111318; }
  .divider { background: rgba(255,255,255,.16); }
  .canvas { background-color: #191c23; background-image: linear-gradient(rgba(255,255,255,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.08) 1px, transparent 1px); }
  .text-editor { background: rgba(23,25,31,.98); color: #f4f7fb; }
}
</style>
</head>
<body>
<div class="toolbar" aria-label="Sketch tools">
  <button type="button" data-tool="select" class="active" title="Select">Select</button>
  <button type="button" data-tool="pen" title="Freehand">Pen</button>
  <button type="button" data-tool="rect" title="Rectangle">Rect</button>
  <button type="button" data-tool="ellipse" title="Ellipse">Oval</button>
  <button type="button" data-tool="arrow" title="Arrow">Arrow</button>
  <button type="button" data-tool="text" title="Text">Text</button>
  <span class="divider"></span>
  <button type="button" data-action="clear" title="Clear sketch">Clear</button>
</div>
<svg id="stage" class="canvas" xmlns="http://www.w3.org/2000/svg"></svg>
<script>
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const stage = document.getElementById('stage');
  let seq = 0;
  let tool = 'select';
  let selectedId = null;
  let draft = null;
  let doc = {
    schemaVersion: 1,
    title: 'Sketch Canvas',
    viewport: { width: window.innerWidth || 1280, height: window.innerHeight || 800 },
    elements: [],
    updatedAt: new Date().toISOString()
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const now = () => new Date().toISOString();
  const notifyChanged = () => {
    try { console.info('__TW_SKETCH_CHANGED__'); } catch (e) {}
  };
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(-100000, Math.min(100000, n)) : fallback;
  };
  const id = (raw) => {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (/^[A-Za-z0-9_-]{1,80}$/.test(s)) return s;
    seq += 1;
    return 'sketch-' + seq;
  };
  const color = (value, fallback) => {
    const s = typeof value === 'string' ? value.trim().slice(0, 64) : '';
    if (!s || /url\\s*\\(|javascript:|[;\\n\\r]/i.test(s)) return fallback;
    return /^[#(),.%\\w\\s-]+$/.test(s) ? s : fallback;
  };
  const points = (value) => Array.isArray(value)
    ? value.slice(0, 200).map((p) => ({ x: num(p && p.x, 0), y: num(p && p.y, 0) }))
    : [];
  const pathD = (value) => {
    const s = typeof value === 'string' ? value.trim().slice(0, 4000) : '';
    return /^[MmZzLlHhVvCcSsQqTtAa0-9,.\\s+-]*$/.test(s) ? s : '';
  };
  const normalize = (raw) => {
    if (!raw || typeof raw !== 'object') return null;
    const kind = raw.kind;
    if (!['rect', 'ellipse', 'line', 'arrow', 'text', 'path'].includes(kind)) return null;
    const out = {
      id: id(raw.id),
      kind,
      fill: color(raw.fill, kind === 'text' ? '#111827' : kind === 'rect' || kind === 'ellipse' ? 'rgba(59, 130, 246, 0.12)' : 'none'),
      stroke: color(raw.stroke, '#2563eb'),
      strokeWidth: Math.max(0, Math.min(40, num(raw.strokeWidth, 2))),
      opacity: Math.max(0, Math.min(1, num(raw.opacity, 1)))
    };
    if (kind === 'rect' || kind === 'ellipse' || kind === 'text') {
      out.x = num(raw.x, 80);
      out.y = num(raw.y, 80);
      out.width = Math.max(1, Math.min(100000, num(raw.width, kind === 'text' ? 1 : 160)));
      out.height = Math.max(1, Math.min(100000, num(raw.height, kind === 'text' ? 1 : 90)));
    }
    if (kind === 'line' || kind === 'arrow') {
      out.x1 = num(raw.x1, 80);
      out.y1 = num(raw.y1, 80);
      out.x2 = num(raw.x2, 260);
      out.y2 = num(raw.y2, 160);
      out.fill = 'none';
    }
    if (kind === 'path') {
      out.points = points(raw.points);
      out.d = pathD(raw.d);
      out.fill = color(raw.fill, 'none');
    }
    if (kind === 'text') {
      out.text = String(raw.text || '').slice(0, 500);
      out.fontSize = Math.max(6, Math.min(96, num(raw.fontSize, 18)));
      out.fill = color(raw.fill, '#111827');
      out.stroke = color(raw.stroke, 'none');
      out.strokeWidth = Math.max(0, Math.min(8, num(raw.strokeWidth, 0)));
    }
    return out;
  };
  const normalizeMany = (items) => Array.isArray(items)
    ? items.map(normalize).filter(Boolean).slice(0, 400)
    : [];
  const setUpdated = (notify = true) => {
    doc.updatedAt = now();
    if (notify) notifyChanged();
  };
  const pt = (event) => {
    const r = stage.getBoundingClientRect();
    return { x: event.clientX - r.left, y: event.clientY - r.top };
  };
  const make = (name, attrs) => {
    const el = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v !== undefined && v !== null) el.setAttribute(k, String(v));
    }
    return el;
  };
  const pathFromPoints = (pts) => pts.length
    ? 'M ' + pts.map((p) => p.x + ' ' + p.y).join(' L ')
    : '';
  const bbox = (item) => {
    if (item.kind === 'rect' || item.kind === 'ellipse') return { x: item.x, y: item.y, width: item.width, height: item.height };
    if (item.kind === 'text') return { x: item.x, y: item.y - (item.fontSize || 18), width: Math.max(1, String(item.text || '').length * (item.fontSize || 18) * 0.6), height: (item.fontSize || 18) * 1.3 };
    if (item.kind === 'line' || item.kind === 'arrow') {
      const x = Math.min(item.x1, item.x2), y = Math.min(item.y1, item.y2);
      return { x, y, width: Math.abs(item.x2 - item.x1), height: Math.abs(item.y2 - item.y1) };
    }
    const pts = item.points || [];
    if (pts.length) {
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y) };
    }
    return { x: 0, y: 0, width: 1, height: 1 };
  };
  const renderItem = (item) => {
    const common = {
      'data-id': item.id,
      opacity: item.opacity == null ? 1 : item.opacity,
      stroke: item.stroke || '#2563eb',
      'stroke-width': item.strokeWidth == null ? 2 : item.strokeWidth,
      fill: item.fill || 'none',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    };
    if (item.kind === 'rect') return make('rect', { ...common, x: item.x, y: item.y, width: item.width, height: item.height, rx: 4 });
    if (item.kind === 'ellipse') return make('ellipse', { ...common, cx: item.x + item.width / 2, cy: item.y + item.height / 2, rx: item.width / 2, ry: item.height / 2 });
    if (item.kind === 'line') return make('line', { ...common, x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2, fill: 'none' });
    if (item.kind === 'arrow') return make('line', { ...common, x1: item.x1, y1: item.y1, x2: item.x2, y2: item.y2, fill: 'none', 'marker-end': 'url(#arrow)' });
    if (item.kind === 'text') {
      const text = make('text', { ...common, x: item.x, y: item.y, fill: item.fill || '#111827', stroke: item.stroke || 'none', 'stroke-width': item.strokeWidth || 0, 'font-size': item.fontSize || 18, 'font-family': '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif' });
      text.textContent = item.text || '';
      return text;
    }
    return make('path', { ...common, d: item.d || pathFromPoints(item.points || []), fill: item.fill || 'none' });
  };
  const render = () => {
    stage.setAttribute('viewBox', '0 0 ' + doc.viewport.width + ' ' + doc.viewport.height);
    stage.setAttribute('width', String(doc.viewport.width));
    stage.setAttribute('height', String(doc.viewport.height));
    stage.replaceChildren();
    const defs = make('defs');
    const marker = make('marker', { id: 'arrow', markerWidth: 10, markerHeight: 10, refX: 8, refY: 3, orient: 'auto', markerUnits: 'strokeWidth' });
    marker.appendChild(make('path', { d: 'M0,0 L0,6 L9,3 z', fill: '#2563eb' }));
    defs.appendChild(marker);
    stage.appendChild(defs);
    for (const item of doc.elements) stage.appendChild(renderItem(item));
    if (selectedId) {
      const item = doc.elements.find((e) => e.id === selectedId);
      if (item) {
        const b = bbox(item);
        stage.appendChild(make('rect', { class: 'selected-outline', x: b.x - 4, y: b.y - 4, width: b.width + 8, height: b.height + 8, rx: 4 }));
      }
    }
  };
  const setTool = (next) => {
    tool = next;
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  };
  const beginTextEdit = (p) => {
    const existing = document.querySelector('.text-editor');
    if (existing) existing.remove();
    const input = document.createElement('input');
    input.className = 'text-editor';
    input.type = 'text';
    input.placeholder = 'Text';
    input.style.left = Math.max(8, Math.min(window.innerWidth - 180, p.x)) + 'px';
    input.style.top = Math.max(48, Math.min(window.innerHeight - 48, p.y - 14)) + 'px';
    document.body.appendChild(input);
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.remove();
      if (!value) return;
      const fill = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? '#f4f7fb' : '#111827';
      const element = normalize({ kind: 'text', x: p.x, y: p.y, text: value, fill, fontSize: 18 });
      if (element) {
        doc.elements.push(element);
        selectedId = element.id;
        setUpdated();
        render();
      }
    };
    const cancel = () => {
      if (done) return;
      done = true;
      input.remove();
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') commit();
      if (event.key === 'Escape') cancel();
      event.stopPropagation();
    });
    input.addEventListener('blur', commit, { once: true });
    requestAnimationFrame(() => input.focus());
  };
  document.querySelectorAll('[data-tool]').forEach((button) => {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  });
  document.querySelector('[data-action="clear"]').addEventListener('click', () => {
    doc.elements = [];
    selectedId = null;
    setUpdated();
    render();
  });
  stage.addEventListener('pointerdown', (event) => {
    const targetId = event.target && event.target.getAttribute ? event.target.getAttribute('data-id') : null;
    if (tool === 'select') {
      selectedId = targetId;
      render();
      return;
    }
    const p = pt(event);
    if (tool === 'text') {
      beginTextEdit(p);
      return;
    }
    if (tool === 'pen') draft = normalize({ kind: 'path', points: [p], stroke: '#2563eb', fill: 'none', strokeWidth: 2 });
    if (tool === 'rect') draft = normalize({ kind: 'rect', x: p.x, y: p.y, width: 1, height: 1 });
    if (tool === 'ellipse') draft = normalize({ kind: 'ellipse', x: p.x, y: p.y, width: 1, height: 1 });
    if (tool === 'arrow') draft = normalize({ kind: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y });
    if (!draft) return;
    draft.__start = p;
    doc.elements.push(draft);
    selectedId = draft.id;
    stage.setPointerCapture(event.pointerId);
    render();
  });
  stage.addEventListener('pointermove', (event) => {
    if (!draft) return;
    const p = pt(event);
    if (draft.kind === 'path') {
      const last = draft.points[draft.points.length - 1];
      if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 2) draft.points.push(p);
    } else if (draft.kind === 'rect' || draft.kind === 'ellipse') {
      const s = draft.__start;
      draft.x = Math.min(s.x, p.x);
      draft.y = Math.min(s.y, p.y);
      draft.width = Math.max(1, Math.abs(p.x - s.x));
      draft.height = Math.max(1, Math.abs(p.y - s.y));
    } else if (draft.kind === 'arrow') {
      draft.x2 = p.x;
      draft.y2 = p.y;
    }
    setUpdated(false);
    render();
  });
  const finish = (event) => {
    if (!draft) return;
    try { stage.releasePointerCapture(event.pointerId); } catch (e) {}
    delete draft.__start;
    draft = null;
    setUpdated();
    render();
  };
  stage.addEventListener('pointerup', finish);
  stage.addEventListener('pointercancel', finish);
  document.addEventListener('keydown', (event) => {
    if ((event.key === 'Backspace' || event.key === 'Delete') && selectedId) {
      doc.elements = doc.elements.filter((item) => item.id !== selectedId);
      selectedId = null;
      setUpdated();
      render();
    }
  });
  window.addEventListener('resize', () => {
    doc.viewport = { width: window.innerWidth || doc.viewport.width, height: window.innerHeight || doc.viewport.height };
    setUpdated();
    render();
  });
  window.__twSketch = {
    getDocument: () => clone(doc),
    applyUpdate: (update) => {
      // A stroke in flight lives in doc.elements but is ALSO held by the local
      // "draft" reference that pointermove keeps mutating. Any update that
      // rewrites or removes elements drops it from the document while the drag
      // continues against an orphan: render() rebuilds only from doc.elements and
      // finish() cannot put it back, so the human's in-progress stroke is
      // silently destroyed. Refuse for every mode — even append truncates at 400
      // and could evict the draft — and let the caller retry in a moment.
      if (draft) return { __twRefused: 'user_drawing' };
      // Optimistic concurrency: doc.updatedAt was maintained but never used as a
      // precondition, so a caller acting on a stale read overwrote newer human
      // edits last-writer-wins.
      if (update && typeof update.expectedUpdatedAt === 'string' &&
          update.expectedUpdatedAt !== doc.updatedAt) {
        return { __twRefused: 'stale_document', updatedAt: doc.updatedAt };
      }
      const rawMode = update && typeof update.mode === 'string' ? update.mode : 'append';
      const mode = ['replace', 'append', 'clear', 'delete'].includes(rawMode) ? rawMode : 'append';
      if (update && typeof update.title === 'string' && update.title.trim()) {
        doc.title = update.title.trim().slice(0, 120);
        document.title = doc.title;
      }
      if (mode === 'clear') {
        doc.elements = [];
        selectedId = null;
      } else if (mode === 'delete') {
        const ids = new Set(Array.isArray(update.elementIds) ? update.elementIds.map(String) : []);
        doc.elements = doc.elements.filter((item) => !ids.has(item.id));
        if (selectedId && ids.has(selectedId)) selectedId = null;
      } else {
        const next = normalizeMany(update && update.elements);
        doc.elements = mode === 'replace'
          ? next
          : doc.elements.concat(next).slice(0, 400);
      }
      setUpdated();
      render();
      return clone(doc);
    },
    resize: (viewport) => {
      doc.viewport = { width: Math.max(240, Math.min(3840, num(viewport && viewport.width, doc.viewport.width))), height: Math.max(240, Math.min(3840, num(viewport && viewport.height, doc.viewport.height))) };
      setUpdated();
      render();
      return clone(doc);
    }
  };
  render();
})();
</script>
</body>
</html>`

export interface CanvasSketchDriverDeps {
  createSurface?: (opts: CanvasSurfaceOptions) => CanvasHostSurface
  now?: () => string
  initialDocument?: CanvasSketchDocument
  onDocumentChange?: (document: CanvasSketchDocument) => void
  onDockRequest?: () => void | Promise<void>
}

function unsupported(verb: string): never {
  throw new Error(`canvas_${verb} is not available for the sketch driver. Use canvas_sketch_update for edits.`)
}

function finite(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, n)) : fallback
}

function positive(value: unknown, fallback: number): number {
  return Math.max(1, Math.min(COORD_LIMIT, finite(value, fallback)))
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, finite(value, fallback)))
}

function sanitizeId(value: unknown): string | undefined {
  const id = typeof value === 'string' ? value.trim() : ''
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : undefined
}

function sanitizeColor(value: unknown, fallback: string): string {
  const color = typeof value === 'string' ? value.trim().slice(0, 64) : ''
  if (!color || /url\s*\(|javascript:|[;\n\r]/i.test(color)) return fallback
  return /^[#(),.%\w\s-]+$/.test(color) ? color : fallback
}

function sanitizePoints(value: unknown): CanvasSketchPoint[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_SKETCH_POINTS).map((point) => {
    const p = point && typeof point === 'object' ? (point as Record<string, unknown>) : {}
    return { x: finite(p.x, 0), y: finite(p.y, 0) }
  })
}

function sanitizePath(value: unknown): string | undefined {
  const d = typeof value === 'string' ? value.trim().slice(0, MAX_SKETCH_PATH) : ''
  return d && /^[MmZzLlHhVvCcSsQqTtAa0-9,.\s+-]+$/.test(d) ? d : undefined
}

function sanitizeSketchElement(raw: unknown): CanvasSketchElement | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  const kind = input.kind as CanvasSketchElementKind
  if (!SKETCH_KINDS.has(kind)) return null
  const element: CanvasSketchElement = {
    kind,
    fill: sanitizeColor(
      input.fill,
      kind === 'text' ? '#111827' : kind === 'rect' || kind === 'ellipse' ? 'rgba(59, 130, 246, 0.12)' : 'none'
    ),
    stroke: sanitizeColor(input.stroke, '#2563eb'),
    strokeWidth: bounded(input.strokeWidth, 2, 0, 40),
    opacity: bounded(input.opacity, 1, 0, 1)
  }
  const id = sanitizeId(input.id)
  if (id) element.id = id
  if (kind === 'rect' || kind === 'ellipse' || kind === 'text') {
    element.x = finite(input.x, 80)
    element.y = finite(input.y, 80)
    element.width = positive(input.width, kind === 'text' ? 1 : 160)
    element.height = positive(input.height, kind === 'text' ? 1 : 90)
  }
  if (kind === 'line' || kind === 'arrow') {
    element.x1 = finite(input.x1, 80)
    element.y1 = finite(input.y1, 80)
    element.x2 = finite(input.x2, 260)
    element.y2 = finite(input.y2, 160)
    element.fill = 'none'
  }
  if (kind === 'path') {
    const points = sanitizePoints(input.points)
    if (points.length) element.points = points
    const d = sanitizePath(input.d)
    if (d) element.d = d
    element.fill = sanitizeColor(input.fill, 'none')
  }
  if (kind === 'text') {
    element.text = String(input.text || '').slice(0, MAX_SKETCH_TEXT)
    element.fontSize = bounded(input.fontSize, 18, 6, 96)
    element.fill = sanitizeColor(input.fill, '#111827')
    element.stroke = sanitizeColor(input.stroke, 'none')
    element.strokeWidth = bounded(input.strokeWidth, 0, 0, 8)
  }
  return element
}

/**
 * What the page returns instead of a document when it declines an update. Kept
 * distinct from a thrown page error so a refusal is an ordinary, retryable
 * outcome rather than an injected-script failure.
 */
interface SketchUpdateRefusal {
  __twRefused: 'user_drawing' | 'stale_document'
  updatedAt?: string
}

function sketchRefusalOf(
  applied: CanvasSketchDocument | SketchUpdateRefusal | null | undefined
): SketchUpdateRefusal['__twRefused'] | null {
  if (!applied || typeof applied !== 'object') return null
  const reason = (applied as SketchUpdateRefusal).__twRefused
  return reason === 'user_drawing' || reason === 'stale_document' ? reason : null
}

function sanitizeSketchUpdate(update: CanvasSketchUpdateInput): CanvasSketchUpdateInput {
  const mode = update.mode === 'replace' || update.mode === 'clear' || update.mode === 'delete'
    ? update.mode
    : 'append'
  const out: CanvasSketchUpdateInput = { mode }
  if (typeof update.title === 'string' && update.title.trim()) {
    out.title = update.title.trim().slice(0, 120)
  }
  if (typeof update.expectedUpdatedAt === 'string' && update.expectedUpdatedAt) {
    out.expectedUpdatedAt = update.expectedUpdatedAt.slice(0, 64)
  }
  if (mode === 'delete') {
    out.elementIds = Array.isArray(update.elementIds)
      ? update.elementIds.map((id) => sanitizeId(id)).filter((id): id is string => Boolean(id))
      : []
  } else if (mode !== 'clear') {
    out.elements = Array.isArray(update.elements)
      ? update.elements
          .map((element) => sanitizeSketchElement(element))
          .filter((element): element is CanvasSketchElement => Boolean(element))
          .slice(0, MAX_SKETCH_ELEMENTS)
      : []
  }
  return out
}

function elementBbox(element: CanvasSketchElement): [number, number, number, number] {
  if (element.kind === 'rect' || element.kind === 'ellipse') {
    return [element.x ?? 0, element.y ?? 0, element.width ?? 1, element.height ?? 1]
  }
  if (element.kind === 'text') {
    const fontSize = element.fontSize ?? 18
    return [
      element.x ?? 0,
      (element.y ?? 0) - fontSize,
      Math.max(1, String(element.text ?? '').length * fontSize * 0.6),
      fontSize * 1.3
    ]
  }
  if (element.kind === 'line' || element.kind === 'arrow') {
    const x1 = element.x1 ?? 0
    const y1 = element.y1 ?? 0
    const x2 = element.x2 ?? x1
    const y2 = element.y2 ?? y1
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(1, Math.abs(x2 - x1)), Math.max(1, Math.abs(y2 - y1))]
  }
  const points = element.points ?? []
  if (points.length) {
    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return [x, y, Math.max(1, Math.max(...xs) - x), Math.max(1, Math.max(...ys) - y)]
  }
  return [0, 0, 1, 1]
}

function waitForLoad(surface: CanvasHostSurface, url: string): Promise<void> {
  const wc = surface.webContents
  return new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (err?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      wc.removeListener('did-finish-load', onLoad)
      wc.removeListener('did-fail-load', onFail)
      err ? reject(err) : resolve()
    }
    const onLoad = (): void => finish()
    const onFail = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ): void => {
      if (isMainFrame && errorCode !== -3) {
        finish(new Error(`Sketch canvas load failed (${errorCode}): ${errorDescription} [${validatedURL}]`))
      }
    }
    const timer = setTimeout(() => finish(new Error('Sketch canvas load timed out.')), 10000)
    wc.on('did-finish-load', onLoad)
    wc.on('did-fail-load', onFail)
    wc.loadURL(url).catch((err) => finish(err instanceof Error ? err : new Error(String(err))))
  })
}

export class CanvasSketchDriver implements CanvasDriver {
  readonly kind = 'sketch' as const

  private surface: CanvasHostSurface | null = null
  private readonly partition: string
  private readonly createSurface: (opts: CanvasSurfaceOptions) => CanvasHostSurface
  private readonly nowFn: () => string
  private readonly initialDocument?: CanvasSketchDocument
  private readonly onDocumentChange?: (document: CanvasSketchDocument) => void
  private readonly onDockRequest?: () => void | Promise<void>
  private consoleEntries: CanvasConsoleEntry[] = []
  private lastDocument: CanvasSketchDocument | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null

  constructor(sessionId: string, deps: CanvasSketchDriverDeps = {}) {
    this.partition = `canvas-sketch-${sessionId}`
    this.createSurface = deps.createSurface ?? createBrowserWindowSurface
    this.nowFn = deps.now ?? (() => new Date().toISOString())
    this.initialDocument = deps.initialDocument
    this.onDocumentChange = deps.onDocumentChange
    this.onDockRequest = deps.onDockRequest
  }

  private requireSurface(): CanvasHostSurface {
    if (!this.surface || this.surface.isDestroyed()) {
      throw new Error('Sketch canvas is not open (or was closed).')
    }
    return this.surface
  }

  private async runInSketch<T>(source: string): Promise<T> {
    return (await this.requireSurface().webContents.executeJavaScript(source, true)) as T
  }

  private schedulePersist(): void {
    if (!this.onDocumentChange) return
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.sketchDocument()
        .then((document) => this.onDocumentChange?.(document))
        .catch(() => {
          // The window may have closed between the change signal and debounce.
        })
    }, 150)
  }

  async open(input: CanvasOpenInput): Promise<CanvasSessionHandle> {
    const viewport = resolveViewport({ width: input.viewport?.width, height: input.viewport?.height })
    const surface = this.createSurface({
      partition: this.partition,
      kind: 'sketch',
      width: viewport.width,
      height: viewport.height
    })
    this.surface = surface
    if (this.onDockRequest) surface.onDockRequest?.(this.onDockRequest)
    surface.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.hardenSession(surface.webContents)
    surface.webContents.on('console-message', (details) => {
      const message = String((details as { message?: unknown }).message ?? '')
      if (message === '__TW_SKETCH_CHANGED__') {
        this.schedulePersist()
        return
      }
      this.consoleEntries.push({
        level: 'log',
        message,
        line: (details as { lineNumber?: number }).lineNumber,
        sourceId: (details as { sourceId?: string }).sourceId,
        at: this.nowFn()
      })
      this.consoleEntries = this.consoleEntries.slice(-100)
    })
    surface.onClosed(() => {
      if (this.surface === surface) this.surface = null
    })

    await waitForLoad(surface, `data:text/html;charset=utf-8,${encodeURIComponent(SKETCH_HTML)}`)
    if (this.initialDocument) {
      await this.sketchUpdate({
        mode: 'replace',
        title: this.initialDocument.title,
        elements: this.initialDocument.elements
      })
    }
    await this.resize(viewport)
    const document = await this.sketchDocument()
    this.lastDocument = document
    return {
      url: `sketch://${this.partition.replace(/^canvas-sketch-/, '')}`,
      title: document.title || DEFAULT_TITLE,
      viewport: document.viewport
    }
  }

  async snapshot(): Promise<CanvasElementTree> {
    const document = await this.sketchDocument()
    const children: CanvasElementNode[] = document.elements.map((element, index) => ({
      ref: element.id || `sketch-${index + 1}`,
      role: element.kind === 'text' ? 'text' : 'graphics-symbol',
      tag: element.kind,
      name: element.kind === 'text' ? element.text || 'text' : element.kind,
      text: element.kind === 'text' ? element.text : undefined,
      bbox: elementBbox(element)
    }))
    return {
      url: `sketch://${this.partition.replace(/^canvas-sketch-/, '')}`,
      title: document.title,
      viewport: document.viewport,
      capturedAt: this.nowFn(),
      root: {
        ref: 'sketch-root',
        role: 'document',
        tag: 'svg',
        name: document.title,
        bbox: [0, 0, document.viewport.width, document.viewport.height],
        children
      },
      nodeCount: children.length + 1,
      truncated: false
    }
  }

  async screenshot(): Promise<CanvasFrame> {
    const image = await this.requireSurface().webContents.capturePage()
    const png = image.toPNG()
    const size = image.getSize()
    return {
      mimeType: 'image/png',
      data: png.toString('base64'),
      width: size.width,
      height: size.height,
      byteLength: png.byteLength,
      hash: createHash('sha256').update(png).digest('hex'),
      capturedAt: this.nowFn()
    }
  }

  async inspect(args: { ref?: string; selector?: string }): Promise<CanvasElementDetail> {
    const document = await this.sketchDocument()
    const selectorId = args.selector?.match(/^\[data-id=["']?([^"'\]]+)["']?\]$/)?.[1] ?? args.selector?.replace(/^#/, '')
    const id = args.ref || selectorId
    const element = id ? document.elements.find((item) => item.id === id) : null
    if (!element) return { ref: args.ref, selector: args.selector, found: false }
    return {
      ref: args.ref,
      selector: args.selector,
      found: true,
      tag: element.kind,
      role: element.kind === 'text' ? 'text' : 'graphics-symbol',
      text: element.kind === 'text' ? element.text : undefined,
      bbox: elementBbox(element),
      styles: {
        fill: element.fill || '',
        stroke: element.stroke || '',
        strokeWidth: String(element.strokeWidth ?? '')
      }
    }
  }

  async network(): Promise<CanvasNetworkEntry[]> {
    this.requireSurface()
    return []
  }

  async console(args: { level?: 'all' | 'warn' | 'error'; lines?: number }): Promise<CanvasConsoleEntry[]> {
    this.requireSurface()
    const requested = Math.trunc(Number(args.lines))
    const lines = Math.max(1, Math.min(100, Number.isFinite(requested) ? requested : 50))
    return this.consoleEntries.slice(-lines)
  }

  async resize(viewport: CanvasViewport): Promise<CanvasViewport> {
    const applied = resolveViewport({ width: viewport.width, height: viewport.height })
    this.requireSurface().setContentSize(applied.width, applied.height)
    const document = await this.runInSketch<CanvasSketchDocument>(
      `window.__twSketch.resize(${JSON.stringify(applied)})`
    )
    this.lastDocument = document
    return document.viewport
  }

  async act(_action: CanvasActionInput): Promise<CanvasActResult> {
    return unsupported('click/fill')
  }

  async annotate(_marks: CanvasMark[]): Promise<{ count: number }> {
    return unsupported('annotate')
  }

  async sketchDocument(): Promise<CanvasSketchDocument> {
    const document = await this.runInSketch<CanvasSketchDocument>('window.__twSketch.getDocument()')
    this.lastDocument = document
    return document
  }

  /**
   * Parity with CanvasWebDriver.hardenSession. The sketch surface is built by the
   * same embed-view factory as the web surface but only ever set the window-open
   * deny and the permission REQUEST handler, leaving three gaps the web driver
   * closes: a permission CHECK (which some APIs consult without prompting), a
   * download guard, and the WebRTC policy. The page is host-authored rather than
   * remote, so this is defence-in-depth, not a live exploit — but the asymmetry
   * was accidental and the surfaces should not drift.
   */
  private hardenSession(wc: WebContents): void {
    try {
      wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    } catch {
      // Older Electron / unavailable — best effort.
    }
    const ses = wc.session
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    try {
      ses.setPermissionCheckHandler(() => false)
    } catch {
      // Best effort — older Electron.
    }
    ses.on('will-download', (event) => event.preventDefault())
  }

  async sketchUpdate(update: CanvasSketchUpdateInput): Promise<CanvasSketchDocument> {
    const safeUpdate = sanitizeSketchUpdate(update)
    const applied = await this.runInSketch<CanvasSketchDocument | SketchUpdateRefusal>(
      `window.__twSketch.applyUpdate(${JSON.stringify(safeUpdate)})`
    )
    const refusal = sketchRefusalOf(applied)
    if (refusal === 'user_drawing') {
      throw new Error(
        'Canvas sketch update refused while the user is drawing a stroke; retry in a moment.'
      )
    }
    if (refusal === 'stale_document') {
      throw new Error(
        'Canvas sketch update refused because the document moved on since your last read (stale expectedUpdatedAt); re-read canvas_sketch_get first.'
      )
    }
    const document = applied as CanvasSketchDocument
    this.lastDocument = document
    this.onDocumentChange?.(document)
    return document
  }

  async evaluate(_args: { script: string }): Promise<CanvasEvalResult> {
    return unsupported('eval')
  }

  async reload(): Promise<void> {
    const surface = this.requireSurface()
    const document = this.lastDocument ?? (await this.sketchDocument())
    await waitForLoad(surface, `data:text/html;charset=utf-8,${encodeURIComponent(SKETCH_HTML)}`)
    await this.sketchUpdate({ mode: 'replace', title: document.title, elements: document.elements })
  }

  async close(): Promise<void> {
    const surface = this.surface
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    if (surface && !surface.isDestroyed() && this.onDocumentChange) {
      try {
        this.onDocumentChange(await this.sketchDocument())
      } catch {
        // Surface may already be gone.
      }
    }
    this.surface = null
    this.lastDocument = null
    this.consoleEntries = []
    if (!surface || surface.isDestroyed()) return
    surface.destroy()
  }
}
