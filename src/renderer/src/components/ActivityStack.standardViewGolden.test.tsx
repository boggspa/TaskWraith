import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ActivityStack } from './ActivityStack'
import type { ToolActivity } from '../../../main/store/types'

/**
 * FROZEN SSR MARKUP, CAPTURED FROM THE PRE-TRANSCRIPT-VIEW IMPLEMENTATION.
 *
 * This is the equivalence proof for the transcript-view feature: it asserts
 * that `standard` renders what the transcript rendered BEFORE any view gating
 * existed, byte for byte.
 *
 * The sibling assertion in `ActivityStack.transcriptView.test.tsx` — that
 * passing transcriptView="standard" matches passing nothing — cannot do this
 * job, because both sides of it run through the SAME current code. It proves
 * the default is `standard` and nothing more; if the view gating had quietly
 * changed what standard renders, it would still pass. Only a reference
 * captured from the old code can catch that, so here it is.
 *
 * Produced by rendering this exact matrix, with these exact fixture builders,
 * against a worktree at 1f9adc672 — the last commit before d42426f8c added the
 * segment gate. The builders below are byte-identical to the ones used for the
 * capture; changing one without recapturing makes the comparison meaningless.
 *
 * DO NOT REGENERATE THIS BLOB TO SILENCE A FAILURE. Regenerating it from
 * current code turns the only before/after proof this feature has into a
 * tautology. A failure here means standard stopped being today's transcript,
 * which is the one thing the feature promised never to do.
 */

const THINK = 'THINKING-BODY-MARKER'
const TOOL = 'TOOL-BODY-MARKER'
const FAILED = 'FAILED-BODY-MARKER'

function thinking(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'think-1',
    toolName: 'reasoning',
    displayName: 'Thinking',
    category: 'task',
    status: 'success',
    parameters: { kind: 'thinking' },
    outputPreview: THINK,
    resultSummary: THINK,
    ...overrides
  } as ToolActivity
}

function shell(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-1',
    toolName: 'Bash',
    displayName: 'Bash',
    category: 'shell',
    status: 'success',
    parameters: { command: TOOL },
    outputPreview: TOOL,
    resultSummary: TOOL,
    ...overrides
  } as ToolActivity
}

function yielding(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'yield-1',
    toolName: 'mcp_TaskWraith_ensemble_yield',
    displayName: 'Captain K yielding to Gems',
    category: 'task',
    status: 'success',
    parameters: { target: 'Gems' },
    ...overrides
  } as ToolActivity
}

function spawn(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'spawn-1',
    toolName: 'task',
    displayName: 'Task',
    category: 'task',
    status: 'success',
    parameters: { prompt: 'SPAWN-PROMPT-MARKER' },
    ...overrides
  } as ToolActivity
}

function todo(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'todo-1',
    toolName: 'TodoWrite',
    displayName: 'Todo',
    category: 'task',
    status: 'success',
    parameters: { todos: [{ content: 'PLAN-RAIL-MARKER', status: 'in_progress' }] },
    ...overrides
  } as ToolActivity
}

/**
 * The captured matrix. Every kind the view gate can touch: a thinking body, a
 * tool body, the two together, a failed step, the priority yield, an
 * agent-anchoring spawn, and the plan rail.
 */
const GOLDEN_CASES: { name: string; activities: ToolActivity[] }[] = [
  { name: 'thinking+shell', activities: [thinking(), shell()] },
  { name: 'thinking-only', activities: [thinking()] },
  { name: 'shell-only', activities: [shell()] },
  {
    name: 'failed-shell',
    activities: [
      thinking(),
      shell({ id: 'fail-1', status: 'error', parameters: { command: FAILED } })
    ]
  },
  { name: 'yield', activities: [yielding()] },
  { name: 'yield+thinking', activities: [yielding(), thinking()] },
  { name: 'spawn', activities: [spawn()] },
  { name: 'todo', activities: [todo()] }
]

const SSR_GOLDEN = `
CASE {"case":"thinking+shell","live":true}
<div class="activity-timeline"><div class="live-activity-viewport is-collapsed is-following activity-thinking-trace-viewport" data-following="true" data-active="false"><span class="live-activity-viewport-rail" aria-hidden="true"></span><div class="live-activity-viewport-scroll" style="max-height:168px;--live-activity-collapsed-height:168px" role="log" aria-label="Thinking traces" aria-live="off"><div class="activity-timeline-live-inner"><div class="activity-progress-note status-success is-thinking-trace" data-provider="unknown"><svg class="activity-progress-note-thinking-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" role="img"><title>Thinking trace</title><g><path d="M8.1 13.3C6.5 12.1 5.7 10.4 5.9 8.6 6.2 5.8 8.6 3.9 11.8 3.8 15.1 3.8 17.6 5.8 17.8 8.7 17.9 10.6 17 12.2 15.3 13.4 14.4 14.1 14.1 14.8 14 15.8L9.9 15.9C9.8 14.8 9.2 14.1 8.1 13.3Z"></path><path d="M9.7 18 14.4 17.8"></path><path d="M10.2 20.2 13.7 20.1"></path><path d="M10.4 15.8 10.2 12.6 13.7 12.4 13.8 15.7"></path><path d="M10.4 12.6C10.2 11.1 11.1 10.1 12.1 10.1 13.2 10.1 14 11 13.7 12.4"></path><path d="M12 1.8 12 3"></path><path d="M4.5 4.6 5.5 5.6"></path><path d="M19.6 4.5 18.5 5.6"></path><path d="M3.2 10.2 4.6 10.2"></path><path d="M19.3 10.1 20.8 10"></path></g></svg><div class="activity-progress-note-body"><div class="activity-progress-note-title"><span>Thinking</span></div><p>THINKING-BODY-MARKER</p></div></div></div></div><div class="live-activity-viewport-controls"><button type="button" class="live-activity-viewport-toggle" aria-expanded="false">Expand thinking traces<svg class="live-activity-viewport-toggle-chevron" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,4.5 6,7.5 9,4.5"></polyline></svg></button></div></div><div class="live-activity-viewport is-collapsed is-following activity-tool-call-viewport" data-following="true" data-active="false"><span class="live-activity-viewport-rail" aria-hidden="true"></span><div class="live-activity-viewport-scroll" style="max-height:168px;--live-activity-collapsed-height:168px" role="log" aria-label="Live activity" aria-live="off"><div class="activity-timeline-live-inner"><div class="activity-row activity-row-inline collapsed no-expand" data-category="shell" data-status="success" data-provider="unknown" tabindex="-1"><div class="activity-body"><div class="activity-header"><div class="activity-label"><span class="activity-label-main"><svg class="activity-inline-icon category-shell" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g><path d="M3.7 5.1 20.4 4.8 20.9 18.7 3.2 19.1Z"></path><path d="M4.2 8.2 20.3 8"></path><path d="M7.1 11.1 10.4 13.5 7.2 15.9"></path><path d="M12.8 16.2 17.4 16.1"></path><path d="M6.2 6.6 6.2 6.7"></path><path d="M8.4 6.5 8.5 6.6"></path></g></svg>Ran <code class="activity-inline-command">TOOL-BODY-MARKER</code></span></div></div></div></div></div></div><div class="live-activity-viewport-controls"><button type="button" class="live-activity-viewport-toggle" aria-expanded="false">Expand activity<svg class="live-activity-viewport-toggle-chevron" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,4.5 6,7.5 9,4.5"></polyline></svg></button></div></div></div>

CASE {"case":"thinking+shell","live":false}
<div class="activity-timeline"><div class="activity-progress-note status-success is-thinking-trace" data-provider="unknown"><svg class="activity-progress-note-thinking-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" role="img"><title>Thinking trace</title><g><path d="M8.1 13.3C6.5 12.1 5.7 10.4 5.9 8.6 6.2 5.8 8.6 3.9 11.8 3.8 15.1 3.8 17.6 5.8 17.8 8.7 17.9 10.6 17 12.2 15.3 13.4 14.4 14.1 14.1 14.8 14 15.8L9.9 15.9C9.8 14.8 9.2 14.1 8.1 13.3Z"></path><path d="M9.7 18 14.4 17.8"></path><path d="M10.2 20.2 13.7 20.1"></path><path d="M10.4 15.8 10.2 12.6 13.7 12.4 13.8 15.7"></path><path d="M10.4 12.6C10.2 11.1 11.1 10.1 12.1 10.1 13.2 10.1 14 11 13.7 12.4"></path><path d="M12 1.8 12 3"></path><path d="M4.5 4.6 5.5 5.6"></path><path d="M19.6 4.5 18.5 5.6"></path><path d="M3.2 10.2 4.6 10.2"></path><path d="M19.3 10.1 20.8 10"></path></g></svg><div class="activity-progress-note-body"><div class="activity-progress-note-title"><span>Thinking</span></div><p>THINKING-BODY-MARKER</p></div></div><div class="activity-row activity-row-inline collapsed no-expand" data-category="shell" data-status="success" data-provider="unknown" tabindex="-1"><div class="activity-body"><div class="activity-header"><div class="activity-label"><span class="activity-label-main"><svg class="activity-inline-icon category-shell" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g><path d="M3.7 5.1 20.4 4.8 20.9 18.7 3.2 19.1Z"></path><path d="M4.2 8.2 20.3 8"></path><path d="M7.1 11.1 10.4 13.5 7.2 15.9"></path><path d="M12.8 16.2 17.4 16.1"></path><path d="M6.2 6.6 6.2 6.7"></path><path d="M8.4 6.5 8.5 6.6"></path></g></svg>Ran <code class="activity-inline-command">TOOL-BODY-MARKER</code></span></div></div></div></div></div>

CASE {"case":"thinking-only","live":true}
<div class="activity-timeline"><div class="live-activity-viewport is-collapsed is-following activity-thinking-trace-viewport" data-following="true" data-active="false"><span class="live-activity-viewport-rail" aria-hidden="true"></span><div class="live-activity-viewport-scroll" style="max-height:168px;--live-activity-collapsed-height:168px" role="log" aria-label="Thinking traces" aria-live="off"><div class="activity-timeline-live-inner"><div class="activity-progress-note status-success is-thinking-trace" data-provider="unknown"><svg class="activity-progress-note-thinking-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" role="img"><title>Thinking trace</title><g><path d="M8.1 13.3C6.5 12.1 5.7 10.4 5.9 8.6 6.2 5.8 8.6 3.9 11.8 3.8 15.1 3.8 17.6 5.8 17.8 8.7 17.9 10.6 17 12.2 15.3 13.4 14.4 14.1 14.1 14.8 14 15.8L9.9 15.9C9.8 14.8 9.2 14.1 8.1 13.3Z"></path><path d="M9.7 18 14.4 17.8"></path><path d="M10.2 20.2 13.7 20.1"></path><path d="M10.4 15.8 10.2 12.6 13.7 12.4 13.8 15.7"></path><path d="M10.4 12.6C10.2 11.1 11.1 10.1 12.1 10.1 13.2 10.1 14 11 13.7 12.4"></path><path d="M12 1.8 12 3"></path><path d="M4.5 4.6 5.5 5.6"></path><path d="M19.6 4.5 18.5 5.6"></path><path d="M3.2 10.2 4.6 10.2"></path><path d="M19.3 10.1 20.8 10"></path></g></svg><div class="activity-progress-note-body"><div class="activity-progress-note-title"><span>Thinking</span></div><p>THINKING-BODY-MARKER</p></div></div></div></div><div class="live-activity-viewport-controls"><button type="button" class="live-activity-viewport-toggle" aria-expanded="false">Expand thinking traces<svg class="live-activity-viewport-toggle-chevron" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,4.5 6,7.5 9,4.5"></polyline></svg></button></div></div></div>

CASE {"case":"thinking-only","live":false}
<div class="activity-timeline"><div class="activity-progress-note status-success is-thinking-trace" data-provider="unknown"><svg class="activity-progress-note-thinking-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" role="img"><title>Thinking trace</title><g><path d="M8.1 13.3C6.5 12.1 5.7 10.4 5.9 8.6 6.2 5.8 8.6 3.9 11.8 3.8 15.1 3.8 17.6 5.8 17.8 8.7 17.9 10.6 17 12.2 15.3 13.4 14.4 14.1 14.1 14.8 14 15.8L9.9 15.9C9.8 14.8 9.2 14.1 8.1 13.3Z"></path><path d="M9.7 18 14.4 17.8"></path><path d="M10.2 20.2 13.7 20.1"></path><path d="M10.4 15.8 10.2 12.6 13.7 12.4 13.8 15.7"></path><path d="M10.4 12.6C10.2 11.1 11.1 10.1 12.1 10.1 13.2 10.1 14 11 13.7 12.4"></path><path d="M12 1.8 12 3"></path><path d="M4.5 4.6 5.5 5.6"></path><path d="M19.6 4.5 18.5 5.6"></path><path d="M3.2 10.2 4.6 10.2"></path><path d="M19.3 10.1 20.8 10"></path></g></svg><div class="activity-progress-note-body"><div class="activity-progress-note-title"><span>Thinking</span></div><p>THINKING-BODY-MARKER</p></div></div></div>

CASE {"case":"shell-only","live":true}
<div class="activity-timeline"><div class="live-activity-viewport is-collapsed is-following activity-tool-call-viewport" data-following="true" data-active="false"><span class="live-activity-viewport-rail" aria-hidden="true"></span><div class="live-activity-viewport-scroll" style="max-height:168px;--live-activity-collapsed-height:168px" role="log" aria-label="Live activity" aria-live="off"><div class="activity-timeline-live-inner"><div class="activity-row activity-row-inline collapsed no-expand" data-category="shell" data-status="success" data-provider="unknown" tabindex="-1"><div class="activity-body"><div class="activity-header"><div class="activity-label"><span class="activity-label-main"><svg class="activity-inline-icon category-shell" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g><path d="M3.7 5.1 20.4 4.8 20.9 18.7 3.2 19.1Z"></path><path d="M4.2 8.2 20.3 8"></path><path d="M7.1 11.1 10.4 13.5 7.2 15.9"></path><path d="M12.8 16.2 17.4 16.1"></path><path d="M6.2 6.6 6.2 6.7"></path><path d="M8.4 6.5 8.5 6.6"></path></g></svg>Ran <code class="activity-inline-command">TOOL-BODY-MARKER</code></span></div></div></div></div></div></div><div class="live-activity-viewport-controls"><button type="button" class="live-activity-viewport-toggle" aria-expanded="false">Expand activity<svg class="live-activity-viewport-toggle-chevron" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,4.5 6,7.5 9,4.5"></polyline></svg></button></div></div></div>

CASE {"case":"shell-only","live":false}
<div class="activity-timeline"><div class="activity-row activity-row-inline collapsed no-expand" data-category="shell" data-status="success" data-provider="unknown" tabindex="-1"><div class="activity-body"><div class="activity-header"><div class="activity-label"><span class="activity-label-main"><svg class="activity-inline-icon category-shell" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g><path d="M3.7 5.1 20.4 4.8 20.9 18.7 3.2 19.1Z"></path><path d="M4.2 8.2 20.3 8"></path><path d="M7.1 11.1 10.4 13.5 7.2 15.9"></path><path d="M12.8 16.2 17.4 16.1"></path><path d="M6.2 6.6 6.2 6.7"></path><path d="M8.4 6.5 8.5 6.6"></path></g></svg>Ran <code class="activity-inline-command">TOOL-BODY-MARKER</code></span></div></div></div></div></div>

CASE {"case":"failed-shell","live":true}
<div class="activity-timeline"><div class="live-activity-viewport is-collapsed is-following activity-thinking-trace-viewport" data-following="true" data-active="false"><span class="live-activity-viewport-rail" aria-hidden="true"></span><div class="live-activity-viewport-scroll" style="max-height:168px;--live-activity-collapsed-height:168px" role="log" aria-label="Thinking traces" aria-live="off"><div class="activity-timeline-live-inner"><div class="activity-progress-note status-success is-thinking-trace" data-provider="unknown"><svg class="activity-progress-note-thinking-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" role="img"><title>Thinking trace</title><g><path d="M8.1 13.3C6.5 12.1 5.7 10.4 5.9 8.6 6.2 5.8 8.6 3.9 11.8 3.8 15.1 3.8 17.6 5.8 17.8 8.7 17.9 10.6 17 12.2 15.3 13.4 14.4 14.1 14.1 14.8 14 15.8L9.9 15.9C9.8 14.8 9.2 14.1 8.1 13.3Z"></path><path d="M9.7 18 14.4 17.8"></path><path d="M10.2 20.2 13.7 20.1"></path><path d="M10.4 15.8 10.2 12.6 13.7 12.4 13.8 15.7"></path><path d="M10.4 12.6C10.2 11.1 11.1 10.1 12.1 10.1 13.2 10.1 14 11 13.7 12.4"></path><path d="M12 1.8 12 3"></path><path d="M4.5 4.6 5.5 5.6"></path><path d="M19.6 4.5 18.5 5.6"></path><path d="M3.2 10.2 4.6 10.2"></path><path d="M19.3 10.1 20.8 10"></path></g></svg><div class="activity-progress-note-body"><div class="activity-progress-note-title"><span>Thinking</span></div><p>THINKING-BODY-MARKER</p></div></div></div></div><div class="live-activity-viewport-controls"><button type="button" class="live-activity-viewport-toggle" aria-expanded="false">Expand thinking traces<svg class="live-activity-viewport-toggle-chevron" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,4.5 6,7.5 9,4.5"></polyline></svg></button></div></div><div class="live-activity-viewport is-collapsed is-following activity-tool-call-viewport" data-following="true" data-active="false"><span class="live-activity-viewport-rail" aria-hidden="true"></span><div class="live-activity-viewport-scroll" style="max-height:168px;--live-activity-collapsed-height:168px" role="log" aria-label="Live activity" aria-live="off"><div class="activity-timeline-live-inner"><div class="activity-row activity-row-inline collapsed no-expand" data-category="shell" data-status="error" data-provider="unknown" tabindex="-1"><div class="activity-body"><div class="activity-header"><div class="activity-label"><span class="activity-label-main"><svg class="activity-inline-icon category-shell" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g><path d="M3.7 5.1 20.4 4.8 20.9 18.7 3.2 19.1Z"></path><path d="M4.2 8.2 20.3 8"></path><path d="M7.1 11.1 10.4 13.5 7.2 15.9"></path><path d="M12.8 16.2 17.4 16.1"></path><path d="M6.2 6.6 6.2 6.7"></path><path d="M8.4 6.5 8.5 6.6"></path></g></svg>Ran <code class="activity-inline-command">FAILED-BODY-MARKER</code></span></div></div></div></div></div></div><div class="live-activity-viewport-controls"><button type="button" class="live-activity-viewport-toggle" aria-expanded="false">Expand activity<svg class="live-activity-viewport-toggle-chevron" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,4.5 6,7.5 9,4.5"></polyline></svg></button></div></div></div>

CASE {"case":"failed-shell","live":false}
<div class="activity-timeline"><div class="activity-progress-note status-success is-thinking-trace" data-provider="unknown"><svg class="activity-progress-note-thinking-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" role="img"><title>Thinking trace</title><g><path d="M8.1 13.3C6.5 12.1 5.7 10.4 5.9 8.6 6.2 5.8 8.6 3.9 11.8 3.8 15.1 3.8 17.6 5.8 17.8 8.7 17.9 10.6 17 12.2 15.3 13.4 14.4 14.1 14.1 14.8 14 15.8L9.9 15.9C9.8 14.8 9.2 14.1 8.1 13.3Z"></path><path d="M9.7 18 14.4 17.8"></path><path d="M10.2 20.2 13.7 20.1"></path><path d="M10.4 15.8 10.2 12.6 13.7 12.4 13.8 15.7"></path><path d="M10.4 12.6C10.2 11.1 11.1 10.1 12.1 10.1 13.2 10.1 14 11 13.7 12.4"></path><path d="M12 1.8 12 3"></path><path d="M4.5 4.6 5.5 5.6"></path><path d="M19.6 4.5 18.5 5.6"></path><path d="M3.2 10.2 4.6 10.2"></path><path d="M19.3 10.1 20.8 10"></path></g></svg><div class="activity-progress-note-body"><div class="activity-progress-note-title"><span>Thinking</span></div><p>THINKING-BODY-MARKER</p></div></div><div class="activity-row activity-row-inline collapsed no-expand" data-category="shell" data-status="error" data-provider="unknown" tabindex="-1"><div class="activity-body"><div class="activity-header"><div class="activity-label"><span class="activity-label-main"><svg class="activity-inline-icon category-shell" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g><path d="M3.7 5.1 20.4 4.8 20.9 18.7 3.2 19.1Z"></path><path d="M4.2 8.2 20.3 8"></path><path d="M7.1 11.1 10.4 13.5 7.2 15.9"></path><path d="M12.8 16.2 17.4 16.1"></path><path d="M6.2 6.6 6.2 6.7"></path><path d="M8.4 6.5 8.5 6.6"></path></g></svg>Ran <code class="activity-inline-command">FAILED-BODY-MARKER</code></span></div></div></div></div></div>

CASE {"case":"yield","live":true}
<div class="activity-timeline"><div class="live-activity-viewport is-collapsed is-following activity-tool-call-viewport" data-following="true" data-active="false"><span class="live-activity-viewport-rail" aria-hidden="true"></span><div class="live-activity-viewport-scroll" style="max-height:168px;--live-activity-collapsed-height:168px" role="log" aria-label="Live activity" aria-live="off"><div class="activity-timeline-live-inner"><div class="activity-row activity-row-inline collapsed no-expand" data-category="task" data-status="success" data-provider="unknown" tabindex="-1"><div class="activity-body"><div class="activity-header"><div class="activity-label"><span class="activity-label-main"><svg class="activity-inline-icon category-task" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g><path d="M4.1 5.7 12.5 5.4C15.9 5.4 18.8 7.7 19 11.1 19.3 15.1 16.2 18.4 12.2 18.4H7.4"></path><path d="M8.4 3.5 4.2 5.8 8.6 8"></path><path d="M7.1 18.4 9.6 15.8"></path><path d="M7.1 18.4 9.8 20.9"></path><path d="M11.3 10.3 15.4 10.2"></path><path d="M11.2 13.4 14.2 13.3"></path></g></svg>Captain K yielded to <span class="activity-yield-target" data-provider="">@Gems</span></span></div></div></div></div></div></div><div class="live-activity-viewport-controls"><button type="button" class="live-activity-viewport-toggle" aria-expanded="false">Expand activity<svg class="live-activity-viewport-toggle-chevron" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,4.5 6,7.5 9,4.5"></polyline></svg></button></div></div></div>

CASE {"case":"yield","live":false}
<div class="activity-timeline"><div class="activity-row activity-row-inline collapsed no-expand" data-category="task" data-status="success" data-provider="unknown" tabindex="-1"><div class="activity-body"><div class="activity-header"><div class="activity-label"><span class="activity-label-main"><svg class="activity-inline-icon category-task" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g><path d="M4.1 5.7 12.5 5.4C15.9 5.4 18.8 7.7 19 11.1 19.3 15.1 16.2 18.4 12.2 18.4H7.4"></path><path d="M8.4 3.5 4.2 5.8 8.6 8"></path><path d="M7.1 18.4 9.6 15.8"></path><path d="M7.1 18.4 9.8 20.9"></path><path d="M11.3 10.3 15.4 10.2"></path><path d="M11.2 13.4 14.2 13.3"></path></g></svg>Captain K yielded to <span class="activity-yield-target" data-provider="">@Gems</span></span></div></div></div></div></div>

CASE {"case":"yield+thinking","live":true}
<div class="activity-timeline"><div class="live-activity-viewport is-collapsed is-following activity-tool-call-viewport" data-following="true" data-active="false"><span class="live-activity-viewport-rail" aria-hidden="true"></span><div class="live-activity-viewport-scroll" style="max-height:168px;--live-activity-collapsed-height:168px" role="log" aria-label="Live activity" aria-live="off"><div class="activity-timeline-live-inner"><div class="activity-row activity-row-inline collapsed no-expand" data-category="task" data-status="success" data-provider="unknown" tabindex="-1"><div class="activity-body"><div class="activity-header"><div class="activity-label"><span class="activity-label-main"><svg class="activity-inline-icon category-task" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g><path d="M4.1 5.7 12.5 5.4C15.9 5.4 18.8 7.7 19 11.1 19.3 15.1 16.2 18.4 12.2 18.4H7.4"></path><path d="M8.4 3.5 4.2 5.8 8.6 8"></path><path d="M7.1 18.4 9.6 15.8"></path><path d="M7.1 18.4 9.8 20.9"></path><path d="M11.3 10.3 15.4 10.2"></path><path d="M11.2 13.4 14.2 13.3"></path></g></svg>Captain K yielded to <span class="activity-yield-target" data-provider="">@Gems</span></span></div></div></div></div></div></div><div class="live-activity-viewport-controls"><button type="button" class="live-activity-viewport-toggle" aria-expanded="false">Expand activity<svg class="live-activity-viewport-toggle-chevron" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,4.5 6,7.5 9,4.5"></polyline></svg></button></div></div><div class="live-activity-viewport is-collapsed is-following activity-thinking-trace-viewport" data-following="true" data-active="false"><span class="live-activity-viewport-rail" aria-hidden="true"></span><div class="live-activity-viewport-scroll" style="max-height:168px;--live-activity-collapsed-height:168px" role="log" aria-label="Thinking traces" aria-live="off"><div class="activity-timeline-live-inner"><div class="activity-progress-note status-success is-thinking-trace" data-provider="unknown"><svg class="activity-progress-note-thinking-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" role="img"><title>Thinking trace</title><g><path d="M8.1 13.3C6.5 12.1 5.7 10.4 5.9 8.6 6.2 5.8 8.6 3.9 11.8 3.8 15.1 3.8 17.6 5.8 17.8 8.7 17.9 10.6 17 12.2 15.3 13.4 14.4 14.1 14.1 14.8 14 15.8L9.9 15.9C9.8 14.8 9.2 14.1 8.1 13.3Z"></path><path d="M9.7 18 14.4 17.8"></path><path d="M10.2 20.2 13.7 20.1"></path><path d="M10.4 15.8 10.2 12.6 13.7 12.4 13.8 15.7"></path><path d="M10.4 12.6C10.2 11.1 11.1 10.1 12.1 10.1 13.2 10.1 14 11 13.7 12.4"></path><path d="M12 1.8 12 3"></path><path d="M4.5 4.6 5.5 5.6"></path><path d="M19.6 4.5 18.5 5.6"></path><path d="M3.2 10.2 4.6 10.2"></path><path d="M19.3 10.1 20.8 10"></path></g></svg><div class="activity-progress-note-body"><div class="activity-progress-note-title"><span>Thinking</span></div><p>THINKING-BODY-MARKER</p></div></div></div></div><div class="live-activity-viewport-controls"><button type="button" class="live-activity-viewport-toggle" aria-expanded="false">Expand thinking traces<svg class="live-activity-viewport-toggle-chevron" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,4.5 6,7.5 9,4.5"></polyline></svg></button></div></div></div>

CASE {"case":"yield+thinking","live":false}
<div class="activity-timeline"><div class="activity-row activity-row-inline collapsed no-expand" data-category="task" data-status="success" data-provider="unknown" tabindex="-1"><div class="activity-body"><div class="activity-header"><div class="activity-label"><span class="activity-label-main"><svg class="activity-inline-icon category-task" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g><path d="M4.1 5.7 12.5 5.4C15.9 5.4 18.8 7.7 19 11.1 19.3 15.1 16.2 18.4 12.2 18.4H7.4"></path><path d="M8.4 3.5 4.2 5.8 8.6 8"></path><path d="M7.1 18.4 9.6 15.8"></path><path d="M7.1 18.4 9.8 20.9"></path><path d="M11.3 10.3 15.4 10.2"></path><path d="M11.2 13.4 14.2 13.3"></path></g></svg>Captain K yielded to <span class="activity-yield-target" data-provider="">@Gems</span></span></div></div></div></div><div class="activity-progress-note status-success is-thinking-trace" data-provider="unknown"><svg class="activity-progress-note-thinking-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" role="img"><title>Thinking trace</title><g><path d="M8.1 13.3C6.5 12.1 5.7 10.4 5.9 8.6 6.2 5.8 8.6 3.9 11.8 3.8 15.1 3.8 17.6 5.8 17.8 8.7 17.9 10.6 17 12.2 15.3 13.4 14.4 14.1 14.1 14.8 14 15.8L9.9 15.9C9.8 14.8 9.2 14.1 8.1 13.3Z"></path><path d="M9.7 18 14.4 17.8"></path><path d="M10.2 20.2 13.7 20.1"></path><path d="M10.4 15.8 10.2 12.6 13.7 12.4 13.8 15.7"></path><path d="M10.4 12.6C10.2 11.1 11.1 10.1 12.1 10.1 13.2 10.1 14 11 13.7 12.4"></path><path d="M12 1.8 12 3"></path><path d="M4.5 4.6 5.5 5.6"></path><path d="M19.6 4.5 18.5 5.6"></path><path d="M3.2 10.2 4.6 10.2"></path><path d="M19.3 10.1 20.8 10"></path></g></svg><div class="activity-progress-note-body"><div class="activity-progress-note-title"><span>Thinking</span></div><p>THINKING-BODY-MARKER</p></div></div></div>

CASE {"case":"spawn","live":true}
<div class="activity-timeline"><div class="live-activity-viewport is-collapsed is-following activity-tool-call-viewport" data-following="true" data-active="false"><span class="live-activity-viewport-rail" aria-hidden="true"></span><div class="live-activity-viewport-scroll" style="max-height:168px;--live-activity-collapsed-height:168px" role="log" aria-label="Live activity" aria-live="off"><div class="activity-timeline-live-inner"><div class="activity-progress-note status-success" data-provider="unknown"><span class="activity-status success"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5.5"></circle><polyline points="4.5,7 6.2,8.8 9.5,5.2"></polyline></svg></span><div class="activity-progress-note-body"><div class="activity-progress-note-title"><span>Task</span></div></div></div></div></div><div class="live-activity-viewport-controls"><button type="button" class="live-activity-viewport-toggle" aria-expanded="false">Expand activity<svg class="live-activity-viewport-toggle-chevron" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,4.5 6,7.5 9,4.5"></polyline></svg></button></div></div></div>

CASE {"case":"spawn","live":false}
<div class="activity-timeline"><div class="activity-progress-note status-success" data-provider="unknown"><span class="activity-status success"><svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="5.5"></circle><polyline points="4.5,7 6.2,8.8 9.5,5.2"></polyline></svg></span><div class="activity-progress-note-body"><div class="activity-progress-note-title"><span>Task</span></div></div></div></div>

CASE {"case":"todo","live":true}
<div class="activity-timeline"><div class="live-activity-viewport is-collapsed is-following activity-tool-call-viewport" data-following="true" data-active="false"><span class="live-activity-viewport-rail" aria-hidden="true"></span><div class="live-activity-viewport-scroll" style="max-height:168px;--live-activity-collapsed-height:168px" role="log" aria-label="Live activity" aria-live="off"><div class="todo-pinned-step" aria-label="Current step: PLAN-RAIL-MARKER"><span class="todo-pinned-label">Current step</span><span class="todo-pinned-text">1/1 · PLAN-RAIL-MARKER</span></div><div class="activity-timeline-live-inner"><div class="activity-row activity-row-inline collapsed" data-category="task" data-status="success" data-provider="unknown" role="button" tabindex="0" aria-expanded="false"><div class="activity-body"><div class="activity-header"><div class="activity-label"><span class="activity-label-main"><svg class="activity-inline-icon category-task" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g><path d="M4.2 5.3 9.3 3.9 14.7 5.4 19.8 4.2 19.3 18.5 14.2 19.9 9 18.3 4 19.5Z"></path><path d="M9.3 3.9 9 18.3"></path><path d="M14.7 5.4 14.2 19.9"></path><path d="M16.4 8.1 16.4 13.9"></path><path d="M16.4 8.1 19 9.3 16.4 10.7"></path><path d="M6.3 9.4 8.1 9"></path><path d="M5.9 13.2 7.7 12.8"></path></g></svg>Goal steps · 0/1 complete<span class="activity-expand-chevron" data-expanded="false" aria-hidden="true">›</span></span></div></div><ul class="todo-checklist-card is-compact" aria-label="Plan steps"><li class="todo-checklist-item status-in_progress" data-status="in_progress"><span class="todo-checklist-glyph" aria-hidden="true">◉</span><span class="todo-checklist-text">PLAN-RAIL-MARKER</span></li></ul></div></div></div></div><div class="live-activity-viewport-controls"><button type="button" class="live-activity-viewport-toggle" aria-expanded="false">Expand activity<svg class="live-activity-viewport-toggle-chevron" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3,4.5 6,7.5 9,4.5"></polyline></svg></button></div></div></div>

CASE {"case":"todo","live":false}
<div class="activity-timeline"><div class="activity-row activity-row-inline collapsed" data-category="task" data-status="success" data-provider="unknown" role="button" tabindex="0" aria-expanded="false"><div class="activity-body"><div class="activity-header"><div class="activity-label"><span class="activity-label-main"><svg class="activity-inline-icon category-task" width="25" height="25" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><g><path d="M4.2 5.3 9.3 3.9 14.7 5.4 19.8 4.2 19.3 18.5 14.2 19.9 9 18.3 4 19.5Z"></path><path d="M9.3 3.9 9 18.3"></path><path d="M14.7 5.4 14.2 19.9"></path><path d="M16.4 8.1 16.4 13.9"></path><path d="M16.4 8.1 19 9.3 16.4 10.7"></path><path d="M6.3 9.4 8.1 9"></path><path d="M5.9 13.2 7.7 12.8"></path></g></svg>Goal steps · 0/1 complete<span class="activity-expand-chevron" data-expanded="false" aria-hidden="true">›</span></span></div></div><ul class="todo-checklist-card is-compact" aria-label="Plan steps"><li class="todo-checklist-item status-in_progress" data-status="in_progress"><span class="todo-checklist-glyph" aria-hidden="true">◉</span><span class="todo-checklist-text">PLAN-RAIL-MARKER</span></li></ul></div></div></div>
`.trim()

/** Each block is one `CASE {json}` line followed by one line of markup. */
function goldenBlocks(): Map<string, string> {
  const blocks = new Map<string, string>()
  for (const block of SSR_GOLDEN.split('\n\n')) {
    const split = block.indexOf('\n')
    blocks.set(block.slice(0, split), block.slice(split + 1))
  }
  return blocks
}

function key(name: string, live: boolean): string {
  return `CASE ${JSON.stringify({ case: name, live })}`
}

describe('standard is byte-identical to the transcript before the view gate', () => {
  it('parses the frozen blob into every captured case, all non-empty', () => {
    // Anti-vacuity. Without this a mangled blob would make every comparison
    // below compare undefined to undefined, or one empty string to another,
    // and the suite would stay green while proving nothing at all.
    const blocks = goldenBlocks()
    expect(blocks.size).toBe(GOLDEN_CASES.length * 2)
    for (const { name } of GOLDEN_CASES) {
      for (const live of [true, false]) {
        const markup = blocks.get(key(name, live))
        expect(markup, key(name, live)).toBeTruthy()
        expect(markup!.length).toBeGreaterThan(200)
      }
    }
  })

  for (const { name, activities } of GOLDEN_CASES) {
    for (const live of [true, false]) {
      it(`renders ${name} (liveActivityViewport=${live}) exactly as it did before`, () => {
        const markup = renderToStaticMarkup(
          <ActivityStack
            activities={activities}
            transcriptView="standard"
            liveActivityViewport={live}
          />
        )
        expect(markup).toBe(goldenBlocks().get(key(name, live)))
      })

      it(`renders ${name} (liveActivityViewport=${live}) the same with no view at all`, () => {
        // The default must BE standard — measured against the old markup,
        // rather than against current code as the sibling assertion does.
        const markup = renderToStaticMarkup(
          <ActivityStack activities={activities} liveActivityViewport={live} />
        )
        expect(markup).toBe(goldenBlocks().get(key(name, live)))
      })
    }
  }
})
