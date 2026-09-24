import { describe, it, expect } from 'vitest'
import { GeminiStreamAdapter, type NormalizedEvent } from './GeminiAdapter'
import { reduceSoloToolEventMessages } from './soloToolEventReducer'
import { projectRunItemToolEvents } from './runItemProjection'
import { RunItemEventCompatMapper } from '../../../main/run/RunItemEventCompat'
import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import { inlineStatsForActivity } from './ActivityInlineStats'

/*
 * Dual-lane TOOL event regression suite.
 *
 * Every provider stdout line can carry the SAME tool call twice: the legacy
 * fields (`type:"tool_use"` / `"tool_result"`) and a `runItemEvents[]` sidecar
 * (`tool/progress`, `tool/outputDelta`) synthesized by main's
 * RunItemEventCompatMapper at the single `sendAgentCompatLine` chokepoint. The
 * renderer applies the sidecar through `projectRunItemToolEvents` →
 * `reduceSoloToolEventMessages`, and must skip the legacy normalization
 * whenever `projectedFromRunItem` is set — the flag is attached by
 * GeminiStreamAdapter only when a tool sidecar rode the same line, so flag-set
 * implies the sidecar lane owns the row.
 *
 * The bug this locks out (2026-08-05, user-visible: "shell commands always
 * appear twice"): the skip was a content-keyed Set with THREE independent
 * failure modes, each of which renders one call as two rows —
 *
 *   1. NAME DIVERGENCE. The adapter resolved a tool name from a longer
 *      fallback chain than the compat mapper (it read `function.name`, the
 *      mapper did not), so an OpenAI-shaped call recorded `name:tool` but
 *      looked up `name:Bash` — and the id key could not save it, because the
 *      mapper synthesizes `<runId>:tool-N` for a call whose legacy line
 *      carries no id at all. Both lanes now share `resolveToolEventName`.
 *   2. SET COLLAPSE. Two idless calls to the same tool in one run record ONE
 *      name key between them, and the lookup `delete`s it.
 *   3. DEFERRED RECORD SIDE. The `.add()` lived inside the `updateChatById`
 *      reducer, which enqueues behind an async `getChat` hydration whenever
 *      the chat is still a summary record — while the lookup runs
 *      synchronously. In that window EVERY row doubled.
 *
 * The harness mirrors the two App.tsx lanes over the REAL adapter and the REAL
 * compat mapper, so the wire shapes stay byte-faithful to what main emits.
 */

const CHAT = 'chat-1'
const RUN = 'run-1'

/** Build the exact stdout line main writes: legacy payload + sidecar. */
function wireLine(payload: Record<string, unknown>, mapper: RunItemEventCompatMapper): string {
  const runItemEvents = mapper.createEvents(
    { chatId: CHAT, runId: RUN, provider: 'claude' },
    payload,
    '2026-08-05T23:07:22.957Z'
  )
  return (
    JSON.stringify({
      ...payload,
      provider: 'claude',
      appRunId: RUN,
      appChatId: CHAT,
      ...(runItemEvents.length > 0 ? { runItemEvents } : {})
    }) + '\n'
  )
}

interface HarnessOptions {
  /**
   * Mirrors `updateChatById` enqueueing its reducer behind async chat
   * hydration: the sidecar lane's apply is deferred, the legacy lane's skip
   * decision is not. The flag skip must hold regardless — this is the mode
   * that doubled EVERY row under the old keyed set.
   */
  deferSidecarLane?: boolean
}

function createToolDualLaneHarness(options: HarnessOptions = {}) {
  let messages: ChatMessage[] = []
  let nextId = 0
  const deferred: Array<() => void> = []
  const deps = {
    createMessageId: () => `msg-${++nextId}`,
    nowIso: () => '2026-08-05T23:07:22.957Z',
    provider: 'claude' as const,
    runId: RUN
  }

  const adapter = new GeminiStreamAdapter((event: NormalizedEvent) => {
    if (event.type === 'run_item_event') {
      // Mirrors the App.tsx run_item_event lane: project + apply.
      const projections = projectRunItemToolEvents(event.event, 'claude').filter(
        (projection) => projection.chatId === CHAT
      )
      if (projections.length === 0) return
      const apply = () => {
        for (const projection of projections) {
          messages = reduceSoloToolEventMessages(messages, projection.event, deps).messages
        }
      }
      if (options.deferSidecarLane) deferred.push(apply)
      else apply()
      return
    }
    if (event.type === 'tool_event') {
      // Mirrors the App.tsx legacy lane: the sidecar on the same line is the
      // sole applier — flag-set means skip, unconditionally.
      if (event.projectedFromRunItem === true) return
      messages = reduceSoloToolEventMessages(messages, event, deps).messages
    }
  })

  return {
    adapter,
    /** Drain the deferred reducer, as the hydration queue eventually does. */
    drain: () => {
      deferred.splice(0).forEach((run) => run())
    },
    activities: (): ToolActivity[] => messages.flatMap((message) => message.toolActivities || [])
  }
}

/** Every tool row the transcript renders, as the label a human reads. */
function labels(harness: ReturnType<typeof createToolDualLaneHarness>): string[] {
  return harness.activities().map((activity) => activity.displayName)
}

describe('tool event dual-lane dedupe', () => {
  it('renders ONE row for a shell call whose lanes name the tool differently', () => {
    // OpenAI-shaped function call: the adapter reads `function.name`, and the
    // compat mapper's chain used to stop short and yield "tool" — so the two
    // lanes rendered two rows under DIFFERENT labels ("Used tool" from the
    // sidecar, "Shell command" from the legacy lane).
    const harness = createToolDualLaneHarness()
    harness.adapter.appendChunk(
      wireLine(
        { type: 'tool_use', function: { name: 'Bash' }, parameters: { command: 'npm test' } },
        new RunItemEventCompatMapper()
      )
    )

    const activities = harness.activities()
    expect(labels(harness)).toEqual(['Shell command'])
    expect(activities[0].toolName).toBe('Bash')
    expect(activities[0].parameters?.command).toBe('npm test')
  })

  it('renders ONE row per call when the same idless tool runs twice in a run', () => {
    // Two calls, two rows — never three. A Set collapsed the two identical
    // name keys into one entry, so the second call had nothing left to match.
    const mapper = new RunItemEventCompatMapper()
    const harness = createToolDualLaneHarness()
    harness.adapter.appendChunk(
      wireLine({ type: 'tool_use', tool_name: 'Bash', parameters: { command: 'ls' } }, mapper)
    )
    harness.adapter.appendChunk(
      wireLine({ type: 'tool_use', tool_name: 'Bash', parameters: { command: 'pwd' } }, mapper)
    )

    expect(labels(harness)).toEqual(['Shell command', 'Shell command'])
    expect(harness.activities().map((activity) => activity.parameters?.command)).toEqual([
      'ls',
      'pwd'
    ])
  })

  it('renders ONE row when the sidecar lane defers behind chat hydration', () => {
    // `updateChatById` enqueues its reducer whenever the chat is still a
    // summary record; the legacy lane's skip decision runs synchronously
    // regardless. A flag needs no cross-lane ordering — a keyed set does.
    const harness = createToolDualLaneHarness({ deferSidecarLane: true })
    harness.adapter.appendChunk(
      wireLine(
        { type: 'tool_use', tool_name: 'Bash', tool_id: 'call_1', parameters: { command: 'ls' } },
        new RunItemEventCompatMapper()
      )
    )
    harness.drain()

    expect(labels(harness)).toEqual(['Shell command'])
  })

  it('pairs a tool result onto its call instead of opening a second row', () => {
    const mapper = new RunItemEventCompatMapper()
    const harness = createToolDualLaneHarness()
    harness.adapter.appendChunk(
      wireLine(
        { type: 'tool_use', tool_name: 'Bash', tool_id: 'call_1', parameters: { command: 'ls' } },
        mapper
      )
    )
    harness.adapter.appendChunk(
      wireLine(
        { type: 'tool_result', tool_name: 'Bash', tool_id: 'call_1', output: 'a\nb' },
        mapper
      )
    )

    const activities = harness.activities()
    expect(activities).toHaveLength(1)
    expect(activities[0].status).toBe('success')
    expect(activities[0].outputPreview).toContain('a\nb')
  })

  it('preserves alternate argument bags through the sidecar-owned edit row', () => {
    const harness = createToolDualLaneHarness()
    harness.adapter.appendChunk(
      wireLine(
        {
          type: 'tool_use',
          tool_name: 'replace',
          tool_id: 'alternate-args',
          arguments: { path: 'src/a.ts', old_string: 'old', new_string: 'new\nnext' }
        },
        new RunItemEventCompatMapper()
      )
    )

    const activity = harness.activities()[0]
    expect(activity.parameters).toMatchObject({ path: 'src/a.ts', old_string: 'old' })
    expect(inlineStatsForActivity(activity)).toMatchObject({
      visible: true,
      additions: 2,
      deletions: 1
    })
  })

  it('keeps result-only changes and Codex patch envelopes after legacy suppression', () => {
    const mapper = new RunItemEventCompatMapper()
    const harness = createToolDualLaneHarness()
    harness.adapter.appendChunk(
      wireLine(
        {
          type: 'tool_use',
          tool_name: 'edit_file',
          tool_id: 'result-evidence',
          parameters: { path: 'src/a.ts' }
        },
        mapper
      )
    )
    harness.adapter.appendChunk(
      wireLine(
        {
          type: 'tool_result',
          tool_name: 'edit_file',
          tool_id: 'result-evidence',
          output: 'done',
          changes: [{ path: 'src/a.ts', additions: 4, deletions: 2 }]
        },
        mapper
      )
    )
    const changed = harness.activities()[0]
    expect(inlineStatsForActivity(changed)).toMatchObject({ additions: 4, deletions: 2 })

    const patchHarness = createToolDualLaneHarness()
    const patchMapper = new RunItemEventCompatMapper()
    patchHarness.adapter.appendChunk(
      wireLine(
        {
          type: 'tool_use',
          tool_name: 'apply_patch',
          tool_id: 'patch-evidence',
          parameters: { path: 'src/b.ts' }
        },
        patchMapper
      )
    )
    patchHarness.adapter.appendChunk(
      wireLine(
        {
          type: 'tool_result',
          tool_name: 'apply_patch',
          tool_id: 'patch-evidence',
          output: 'done',
          patch: '*** Begin Patch\n*** Update File: src/b.ts\n-old\n+new\n+next\n*** End Patch'
        },
        patchMapper
      )
    )
    expect(inlineStatsForActivity(patchHarness.activities()[0])).toMatchObject({
      visible: true,
      additions: 2,
      deletions: 1
    })
  })

  it('projects a valid capability invocation as its concrete mutation target', () => {
    const harness = createToolDualLaneHarness()
    harness.adapter.appendChunk(
      wireLine(
        {
          type: 'tool_use',
          tool_name: 'mcp__TaskWraith__capability_invoke',
          tool_id: 'gateway-replace',
          parameters: {
            name: 'replace',
            arguments: { path: 'src/gateway.ts', old_string: 'before', new_string: 'after' }
          }
        },
        new RunItemEventCompatMapper()
      )
    )

    const activity = harness.activities()[0]
    expect(activity).toMatchObject({ toolName: 'replace', category: 'write' })
    expect(inlineStatsForActivity(activity)).toMatchObject({ additions: 1, deletions: 1 })
  })

  it('renders ONE row for a visible-progress line that carries a sidecar', () => {
    // `update_topic` and friends take the emitVisibleProgress path, which
    // emits a use AND a result event — both need the flag or the pair doubles.
    const harness = createToolDualLaneHarness()
    harness.adapter.appendChunk(
      wireLine(
        { type: 'update_topic', tool_id: 'topic-1', title: 'Refactor', summary: 'Splitting lanes' },
        new RunItemEventCompatMapper()
      )
    )

    const activities = harness.activities()
    expect(activities).toHaveLength(1)
    expect(activities[0].status).toBe('success')
  })

  it('still applies a legacy tool line that carries NO sidecar (loss guard)', () => {
    // Subagent events aren't a type the compat mapper maps, so no sidecar
    // rides the line, the flag stays unset, and the legacy lane MUST remain
    // the applier. This is the text-loss guard — never make the skip
    // unconditional.
    const harness = createToolDualLaneHarness()
    harness.adapter.appendChunk(
      JSON.stringify({
        type: 'subagent_event',
        params: { type: 'subagentEvent', agent_id: 'agent-1' },
        appRunId: RUN,
        appChatId: CHAT
      }) + '\n'
    )

    expect(harness.activities()).toHaveLength(1)
  })
})
