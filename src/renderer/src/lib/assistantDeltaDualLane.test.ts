import { describe, it, expect } from 'vitest'
import { GeminiStreamAdapter, type NormalizedEvent } from './GeminiAdapter'
import { applyAssistantDelta } from './applyAssistantDelta'
import { projectRunItemAssistantDelta } from './runItemProjection'
import type { ChatMessage } from '../../../main/store/types'

/*
 * Dual-lane assistant delta regression suite.
 *
 * Every provider stdout line can carry the SAME assistant text twice: the
 * legacy fields (`type:"content"`, `text`) and a `runItemEvents[]` sidecar
 * (`item/delta`, channel `assistant`) synthesized by main's
 * RunItemEventCompatMapper. The renderer applies the sidecar through
 * `projectRunItemAssistantDelta` → `applyAssistantDelta`, and must skip the
 * legacy normalization whenever `projectedFromRunItem` is set — the flag is
 * attached by GeminiStreamAdapter only when a non-empty assistant item/delta
 * rode the same line, so flag-set implies the sidecar lane owns the text.
 *
 * The bug this locks out (2026-07-01, user-visible on Claude): the skip was
 * previously a content-keyed set lookup whose record side embedded the compat
 * mapper's synthesized `<runId>:assistant` itemId while the lookup side used
 * the legacy event's absent itemId — the keys never matched for providers
 * whose legacy content lines carry no itemId (Claude/Kimi/Grok/Ollama), so
 * both lanes applied and every increment after the first doubled:
 * D1+D2+D2+D3+D3. The first delta survived single only because an exact
 * restatement short-circuits in resolveAssistantDeltaMerge.
 *
 * The harness below mirrors the two App.tsx lanes (run_item_event apply +
 * flag-gated legacy skip) over the REAL adapter so the wire shapes stay
 * byte-faithful to what main emits.
 */

interface WireSidecar {
  kind: 'item/started' | 'item/delta'
  itemId: string
  delta?: string
  cumulative?: boolean
}

function wireLine(input: {
  chatId: string
  runId: string
  text: string
  itemId?: string
  cumulative?: boolean
  sidecars?: WireSidecar[]
  sequenceStart?: number
}): string {
  let sequence = input.sequenceStart ?? 1
  return (
    JSON.stringify({
      type: 'content',
      text: input.text,
      provider: 'claude',
      appRunId: input.runId,
      appChatId: input.chatId,
      ...(input.itemId ? { itemId: input.itemId } : {}),
      ...(input.cumulative === true ? { cumulative: true } : {}),
      ...(input.sidecars
        ? {
            runItemEvents: input.sidecars.map((sidecar) => ({
              protocolVersion: 1,
              chatId: input.chatId,
              runId: input.runId,
              provider: 'claude',
              source: 'adapter',
              sequence: sequence++,
              createdAt: '2026-07-01T23:07:22.957Z',
              ...(sidecar.kind === 'item/started'
                ? {
                    kind: 'item/started',
                    itemId: sidecar.itemId,
                    itemKind: 'assistant_message'
                  }
                : {
                    kind: 'item/delta',
                    itemId: sidecar.itemId,
                    itemKind: 'assistant_message',
                    channel: 'assistant',
                    delta: sidecar.delta ?? '',
                    ...(sidecar.cumulative === true ? { cumulative: true } : {})
                  })
            }))
          }
        : {})
    }) + '\n'
  )
}

function createDualLaneHarness(chatId: string, runId: string) {
  let messages: ChatMessage[] = []
  let nextId = 0
  const deps = {
    createMessageId: () => `msg-${++nextId}`,
    now: () => '2026-07-01T23:07:22.957Z'
  }
  const adapter = new GeminiStreamAdapter((event: NormalizedEvent) => {
    if (event.type === 'run_item_event') {
      // Mirrors the App.tsx run_item_event lane: project + apply.
      const projection = projectRunItemAssistantDelta(event.event)
      if (projection && projection.chatId === chatId) {
        messages = applyAssistantDelta(messages, projection.input, deps)
      }
      return
    }
    if (event.type === 'assistant_message_delta') {
      // Mirrors the App.tsx legacy lane: the sidecar on the same line is the
      // sole applier — flag-set means skip, unconditionally.
      if (event.projectedFromRunItem === true) return
      const itemId = typeof event.itemId === 'string' && event.itemId ? event.itemId : undefined
      messages = applyAssistantDelta(
        messages,
        {
          incoming: event.content,
          runId,
          cumulative: event.cumulative === true,
          itemId
        },
        deps
      )
    }
  })
  return { adapter, messages: () => messages }
}

const CHAT = 'chat-1'
const RUN = 'run-1'
const ASSISTANT_ITEM = `${RUN}:assistant`

describe('assistant delta dual-lane dedupe', () => {
  it('applies each Claude-shaped dual-emission delta exactly once (D1+D2+D2+D3+D3 regression)', () => {
    // The exact shape from the observed bug: legacy content lines with NO
    // itemId, sidecar deltas under the compat-synthesized `<runId>:assistant`.
    const d1 = 'Hello'
    const d2 =
      "! How can I help you today? Whether it's exploring your workspace, writing or reviewing code, running"
    const d3 = " tasks, or anything else — just let me know what you'd like to do."
    const { adapter, messages } = createDualLaneHarness(CHAT, RUN)

    adapter.appendChunk(
      wireLine({
        chatId: CHAT,
        runId: RUN,
        text: d1,
        sidecars: [
          { kind: 'item/started', itemId: ASSISTANT_ITEM },
          { kind: 'item/delta', itemId: ASSISTANT_ITEM, delta: d1 }
        ]
      })
    )
    adapter.appendChunk(
      wireLine({
        chatId: CHAT,
        runId: RUN,
        text: d2,
        sidecars: [{ kind: 'item/delta', itemId: ASSISTANT_ITEM, delta: d2 }],
        sequenceStart: 3
      })
    )
    adapter.appendChunk(
      wireLine({
        chatId: CHAT,
        runId: RUN,
        text: d3,
        sidecars: [{ kind: 'item/delta', itemId: ASSISTANT_ITEM, delta: d3 }],
        sequenceStart: 4
      })
    )

    const result = messages()
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe(d1 + d2 + d3)
    expect(result[0].content).not.toContain('---')
  })

  it('still applies a legacy delta when no sidecar rode the line (text-loss guard)', () => {
    // runItemIdentityForRoute can resolve null in main (no appRunId/appChatId)
    // and legacy spawns bypass the compat mapper entirely — those lines carry
    // no sidecar, the flag stays unset, and the legacy lane must keep writing.
    const { adapter, messages } = createDualLaneHarness(CHAT, RUN)
    adapter.appendChunk(
      JSON.stringify({ type: 'content', text: 'legacy only', provider: 'claude' }) + '\n'
    )
    const result = messages()
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('legacy only')
  })

  it('does not set the skip flag for an empty sidecar delta', () => {
    const { adapter, messages } = createDualLaneHarness(CHAT, RUN)
    adapter.appendChunk(
      wireLine({
        chatId: CHAT,
        runId: RUN,
        text: 'visible',
        sidecars: [{ kind: 'item/delta', itemId: ASSISTANT_ITEM, delta: '' }]
      })
    )
    const result = messages()
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('visible')
  })

  it('applies byte-identical repeated deltas exactly twice (trusted-incremental append)', () => {
    // Two regressions in one: (a) a Set-based content key collapses two
    // identical (runId,itemId,content) entries into one, so the second legacy
    // twin used to fall through and apply on top of the run-item application
    // (tripling); (b) before the sidecar lane carried `trustedIncremental`,
    // a repeat that exactly equals the whole bubble was shape-detected as a
    // restatement by resolveAssistantDeltaMerge and SWALLOWED ('test ' once).
    // Untagged sidecar deltas are verbatim increments by contract — a
    // six-provider audit confirmed every restatement path is either
    // prefix-sliced main-side or cumulative-tagged — so the repeat appends.
    const { adapter, messages } = createDualLaneHarness(CHAT, RUN)
    for (const sequenceStart of [1, 2]) {
      adapter.appendChunk(
        wireLine({
          chatId: CHAT,
          runId: RUN,
          text: 'test ',
          sidecars: [{ kind: 'item/delta', itemId: ASSISTANT_ITEM, delta: 'test ' }],
          sequenceStart
        })
      )
    }
    const result = messages()
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('test test ')
  })

  it('keeps shape detection on the legacy lane for untagged restatements', () => {
    // A no-sidecar line (legacy lane, no trustedIncremental) that supersets
    // the bubble must still be recognised as a restatement and REPLACE —
    // untagged Cursor banner/text-style lines rely on this.
    const { adapter, messages } = createDualLaneHarness(CHAT, RUN)
    adapter.appendChunk(
      JSON.stringify({ type: 'content', text: 'Hello', provider: 'claude' }) + '\n'
    )
    adapter.appendChunk(
      JSON.stringify({ type: 'content', text: 'Hello world', provider: 'claude' }) + '\n'
    )
    const result = messages()
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('Hello world')
  })

  it('replaces on cumulative sidecar snapshots without doubling (Cursor shape)', () => {
    // Cursor snapshot frames: the sidecar carries cumulative:true (mapped from
    // runItemCumulative/snapshot) while the legacy line can arrive untagged —
    // the sidecar is authoritative and the legacy restatement must be skipped.
    const { adapter, messages } = createDualLaneHarness(CHAT, RUN)
    adapter.appendChunk(
      wireLine({
        chatId: CHAT,
        runId: RUN,
        text: 'Hello',
        sidecars: [{ kind: 'item/delta', itemId: ASSISTANT_ITEM, delta: 'Hello', cumulative: true }]
      })
    )
    adapter.appendChunk(
      wireLine({
        chatId: CHAT,
        runId: RUN,
        text: 'Hello world',
        sidecars: [
          { kind: 'item/delta', itemId: ASSISTANT_ITEM, delta: 'Hello world', cumulative: true }
        ],
        sequenceStart: 2
      })
    )
    const result = messages()
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('Hello world')
  })

  it('keeps the Codex inter-item separator on the sidecar lane, applied once', () => {
    // Codex legacy lines DO carry itemId (both lanes agree); the `---`
    // transition between items is produced by the run-item lane and must
    // appear exactly once with no duplicated text.
    const { adapter, messages } = createDualLaneHarness(CHAT, RUN)
    adapter.appendChunk(
      wireLine({
        chatId: CHAT,
        runId: RUN,
        text: 'Body',
        itemId: 'item-1',
        sidecars: [{ kind: 'item/delta', itemId: 'item-1', delta: 'Body' }]
      })
    )
    adapter.appendChunk(
      wireLine({
        chatId: CHAT,
        runId: RUN,
        text: 'Summary',
        itemId: 'item-2',
        sidecars: [{ kind: 'item/delta', itemId: 'item-2', delta: 'Summary' }],
        sequenceStart: 2
      })
    )
    const result = messages()
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('Body\n\n---\n\nSummary')
  })

  it('drops the legacy twin even when sidecar and legacy text would diverge (sidecar authoritative)', () => {
    // The flag is structural (same-line sidecar presence), not content-keyed:
    // if the lanes ever disagree byte-wise, exactly one representation — the
    // run-item protocol's — must win. A content-keyed dedupe would apply BOTH.
    const { adapter, messages } = createDualLaneHarness(CHAT, RUN)
    adapter.appendChunk(
      wireLine({
        chatId: CHAT,
        runId: RUN,
        text: 'legacy variant',
        sidecars: [{ kind: 'item/delta', itemId: ASSISTANT_ITEM, delta: 'sidecar variant' }]
      })
    )
    const result = messages()
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('sidecar variant')
  })
})
