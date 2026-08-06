import { describe, expect, it } from 'vitest'
import {
  activityRowPaintSignature,
  buildThinkingTraceActions,
  cleanProgressTextSignature,
  getProgressNoteCached,
  liveActivityRevision,
  liveSegmentChildrenReuseKey,
  progressNoteBodySignature,
  thinkingTraceActionsDependencyKey
} from './ActivityStack'
import type { ToolActivity } from '../../../main/store/types'

function thinkingActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'think-1',
    toolName: 'codex_reasoning',
    displayName: 'Thinking',
    category: 'task',
    status: 'running',
    parameters: {
      kind: 'thinking',
      summary: 'Considering the approach for stream smoothness.'
    },
    ...overrides
  } as ToolActivity
}

function toolActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-1',
    toolName: 'read_file',
    displayName: 'Read file',
    category: 'read',
    status: 'success',
    parameters: { path: 'src/main/index.ts' },
    resultSummary: 'ok',
    ...overrides
  } as ToolActivity
}

describe('ActivityStack Phase F memo gates', () => {
  describe('progress note / cleanProgressText caching', () => {
    it('returns the same progress-note object for an unchanged thinking body', () => {
      const activity = thinkingActivity({
        parameters: {
          kind: 'thinking',
          summary: 'A'.repeat(2_000)
        }
      })
      const first = getProgressNoteCached(activity)
      const second = getProgressNoteCached({ ...activity })
      expect(first).not.toBeNull()
      expect(second).toBe(first)
      expect(progressNoteBodySignature(activity)).toBe(progressNoteBodySignature({ ...activity }))
    })

    it('invalidates the progress-note cache when the body grows', () => {
      const base = thinkingActivity({
        parameters: { kind: 'thinking', summary: 'short' }
      })
      const first = getProgressNoteCached(base)
      const grown = thinkingActivity({
        parameters: { kind: 'thinking', summary: 'short then more tokens' }
      })
      const second = getProgressNoteCached(grown)
      expect(second).not.toBe(first)
      expect(second?.body).toContain('more tokens')
      expect(progressNoteBodySignature(base)).not.toBe(progressNoteBodySignature(grown))
    })

    it('builds a compact cleanProgressText signature from length + hash + ends', () => {
      const body = `${'head-'.repeat(400)}TAIL`
      const signature = cleanProgressTextSignature(body, false)
      expect(signature.startsWith('f|')).toBe(true)
      expect(signature).toContain(String(body.length))
      expect(signature.length).toBeLessThan(body.length)
      expect(signature).not.toContain(body)
    })
  })

  describe('live segment children reuse key', () => {
    it('stays stable when only an unrelated segment revision would change', () => {
      const tools = [toolActivity()]
      const revision = liveActivityRevision(tools)
      const keyA = liveSegmentChildrenReuseKey({
        revision,
        liveViewportExpanded: false,
        hiddenTimelineItemCount: 0,
        disclosure: 'expanded:|shimmer:tool-1:0|actions:'
      })
      const keyB = liveSegmentChildrenReuseKey({
        revision,
        liveViewportExpanded: false,
        hiddenTimelineItemCount: 0,
        disclosure: 'expanded:|shimmer:tool-1:0|actions:'
      })
      expect(keyA).toBe(keyB)
    })

    it('changes when revision or disclosure bits change', () => {
      const tools = [toolActivity()]
      const base = liveSegmentChildrenReuseKey({
        revision: liveActivityRevision(tools),
        liveViewportExpanded: false,
        hiddenTimelineItemCount: 0,
        disclosure: 'a'
      })
      const afterRevision = liveSegmentChildrenReuseKey({
        revision: liveActivityRevision([toolActivity({ resultSummary: 'ok\nmore output' })]),
        liveViewportExpanded: false,
        hiddenTimelineItemCount: 0,
        disclosure: 'a'
      })
      const afterDisclosure = liveSegmentChildrenReuseKey({
        revision: liveActivityRevision(tools),
        liveViewportExpanded: true,
        hiddenTimelineItemCount: 0,
        disclosure: 'a'
      })
      expect(afterRevision).not.toBe(base)
      expect(afterDisclosure).not.toBe(base)
    })
  })

  describe('activityRowPaintSignature', () => {
    it('matches for equivalent activity paint fields', () => {
      const a = toolActivity()
      const b = toolActivity()
      expect(activityRowPaintSignature(a)).toBe(activityRowPaintSignature(b))
    })

    it('changes when status or output length changes', () => {
      const a = toolActivity({ status: 'running', resultSummary: 'partial' })
      const b = toolActivity({ status: 'success', resultSummary: 'partial\ndone' })
      expect(activityRowPaintSignature(a)).not.toBe(activityRowPaintSignature(b))
    })
  })

  describe('thinkingTraceActions identity helpers', () => {
    it('dependency key ignores callback identity and tracks paint fields', () => {
      const keyA = thinkingTraceActionsDependencyKey({
        messageId: 'm1',
        label: 'thinking trace',
        copiedId: null,
        pinned: false,
        thumbsVote: null,
        hasAddToPrompt: true
      })
      const keyB = thinkingTraceActionsDependencyKey({
        messageId: 'm1',
        label: 'thinking trace',
        copiedId: null,
        pinned: false,
        thumbsVote: null,
        hasAddToPrompt: true
      })
      const keyCopied = thinkingTraceActionsDependencyKey({
        messageId: 'm1',
        label: 'thinking trace',
        copiedId: 'm1:think-1:thinking',
        pinned: false,
        thumbsVote: null,
        hasAddToPrompt: true
      })
      expect(keyA).toBe(keyB)
      expect(keyCopied).not.toBe(keyA)
    })

    it('buildThinkingTraceActions returns the config for panel wiring', () => {
      const config = buildThinkingTraceActions({
        messageId: 'm1',
        copiedId: null,
        pinned: false,
        copy: () => undefined
      })
      expect(config.messageId).toBe('m1')
    })
  })
})
