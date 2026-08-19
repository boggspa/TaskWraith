import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ToolActivity } from '../../../main/store/types'
import { TASKWRAITH_CLOSEOUT_KIND } from '../../../shared/taskWraithCloseout'
import { buildLiveToolFileSummarySignature } from './liveToolFileSummarySignature'

const activity = (id: string, output: string): ToolActivity =>
  ({
    id,
    toolName: 'Bash',
    status: 'success',
    parameters: { command: 'npx tsc --noEmit' },
    resultSummary: output
  }) as unknown as ToolActivity

const toolMessage = (id: string, activities: ToolActivity[]): ChatMessage =>
  ({
    id,
    role: 'tool',
    content: '',
    timestamp: '2026-08-18T22:47:00.000Z',
    toolActivities: activities
  }) as unknown as ChatMessage

describe('buildLiveToolFileSummarySignature', () => {
  // The renderer rebuilds this signature on every coalesced flush, and an
  // ensemble run broadcasts whole-chat snapshots 10-100x/second. A signature
  // that embeds the tool output verbatim therefore allocates a fresh
  // megabyte-scale string tens of times a second, which walked V8's old space
  // into its ~4GB cap and aborted the renderer (crash 2026-08-18 23:31).
  // The signature only ever gets compared for equality, so it must stay
  // compact no matter how much output the run has streamed.
  it('stays compact when tool activities carry megabytes of streamed output', () => {
    const huge = 'x'.repeat(1_000_000)
    const messages = [
      toolMessage('m1', [activity('a1', huge)]),
      toolMessage('m2', [activity('a2', huge)])
    ]

    const signature = buildLiveToolFileSummarySignature(messages)

    expect(signature.length).toBeLessThan(1_000)
  })

  // Ensemble deliveries replace message objects wholesale even when a
  // message's activities are untouched. Keying the chunk cache on the message
  // object re-serialises every one of them on every flush - O(n) per flush,
  // O(n^2) across a run.
  it('does not re-serialise a replaced message whose activities are unchanged', () => {
    const activities = [activity('a1', 'compile ok')]
    const first = toolMessage('m1', activities)
    buildLiveToolFileSummarySignature([first])

    const stringify = vi.spyOn(JSON, 'stringify')
    try {
      // Same activities array, brand-new message object - exactly what an
      // ensemble whole-chat snapshot produces.
      const replaced = toolMessage('m1', activities)
      buildLiveToolFileSummarySignature([replaced])
      expect(stringify).not.toHaveBeenCalled()
    } finally {
      stringify.mockRestore()
    }
  })

  it('changes when a tool activity changes and is stable when nothing changes', () => {
    const before = [toolMessage('m1', [activity('a1', 'running')])]
    const after = [toolMessage('m1', [activity('a1', 'done')])]

    const signatureBefore = buildLiveToolFileSummarySignature(before)
    const signatureAfter = buildLiveToolFileSummarySignature(after)

    expect(signatureAfter).not.toEqual(signatureBefore)
    expect(buildLiveToolFileSummarySignature(before)).toEqual(signatureBefore)
  })

  it('distinguishes an appended activity from the shorter prior list', () => {
    const one = [toolMessage('m1', [activity('a1', 'first')])]
    const two = [toolMessage('m1', [activity('a1', 'first'), activity('a2', 'second')])]

    expect(buildLiveToolFileSummarySignature(two)).not.toEqual(
      buildLiveToolFileSummarySignature(one)
    )
  })

  it('skips closeout messages and messages with no tool activities', () => {
    const closeout = {
      ...toolMessage('m-closeout', [activity('a1', 'summary')]),
      metadata: { kind: TASKWRAITH_CLOSEOUT_KIND }
    } as unknown as ChatMessage
    const empty = toolMessage('m-empty', [])

    expect(buildLiveToolFileSummarySignature([closeout, empty])).toEqual('')
  })
})

describe('identity-keyed digest cache contract', () => {
  // The WeakMap caches are sound ONLY while no renderer code mutates a
  // ToolActivity in place: the structured-clone IPC boundary hands the
  // renderer fresh identities, and renderer-side identity reuse is
  // deepEqual-gated. This test DOCUMENTS that contract. If it ever fails,
  // some renderer code started mutating activities in place — fix that code
  // (frozen file summaries are the symptom), do not weaken this test.
  it('treats an in-place activity mutation as invisible (identity-cached by contract)', () => {
    const shared = activity('a1', 'original output')
    const messages = [toolMessage('m1', [shared])]
    const before = buildLiveToolFileSummarySignature(messages)

    ;(shared as { resultSummary?: string }).resultSummary = 'mutated in place'
    expect(buildLiveToolFileSummarySignature(messages)).toBe(before)

    // A replacement object — the sanctioned way to change an activity — is
    // seen immediately.
    const replaced = [toolMessage('m1', [activity('a1', 'mutated in place')])]
    expect(buildLiveToolFileSummarySignature(replaced)).not.toBe(before)
  })
})
