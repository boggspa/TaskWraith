import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createMuseThinkingTranscript } from '../../../main/muse/MuseThinkingTranscript'
import { createToolActivity, pairToolResult } from '../lib/ToolParser'
import { ActivityStack, buildTimelineItems, buildTimelineSegments } from './ActivityStack'

describe('Muse reasoning in the shared transcript hierarchy', () => {
  it('renders native summaries in the existing Thinking viewport with full text and actions', () => {
    const transcript = createMuseThinkingTranscript('run')
    const text = 'Check the fixture and verify its result. '.repeat(25)
    const [use, result] = transcript.project({
      type: 'thinking',
      payloadType: 'runtime.session',
      thinkingId: 'summary-1',
      thinkingCumulative: true,
      text,
      raw: {}
    })
    const activity = pairToolResult(createToolActivity(use), result)
    expect(activity.resultSummary).toBe(text)
    const html = renderToStaticMarkup(
      <ActivityStack
        provider="muse"
        activities={[activity]}
        liveActivityViewport
        thinkingTraceActions={{
          messageId: 'message-1',
          copiedId: null,
          pinned: false,
          copy: () => undefined
        }}
      />
    )
    expect(html).toContain('live-activity-viewport')
    expect(html).toContain('is-thinking-trace')
    expect(html).toContain('Muse thinking trace')
    expect(html).toContain('activity-thinking-actions-row')
    expect(html).toContain(text.trim())
    expect(html).not.toContain('activity-row')
  })

  it('keeps Thinking, tool work, and subsequent Thinking in separate chronological viewports', () => {
    const transcript = createMuseThinkingTranscript('ordered-run')
    const thought = (thinkingId: string, text: string) => {
      const [use, result] = transcript.project({
        type: 'thinking',
        payloadType: 'runtime.session',
        thinkingId,
        thinkingCumulative: true,
        text,
        raw: {}
      })
      return pairToolResult(createToolActivity(use), result)
    }
    const first = thought('before-tools', 'Inspect the fixture.')
    const tool = createToolActivity({
      type: 'tool_use',
      tool_name: 'read_file',
      tool_id: 'read-1',
      parameters: { path: 'fixture.txt' }
    })
    transcript.observe({ type: 'tool_use', tool_name: 'read_file' })
    const last = thought('after-tools', 'Verify the result.')
    const segments = buildTimelineSegments(buildTimelineItems([first, tool, last]))
    expect(segments.map((segment) => segment.kind)).toEqual(['thinking', 'tools', 'thinking'])
    const html = renderToStaticMarkup(
      <ActivityStack activities={[first, tool, last]} provider="muse" liveActivityViewport />
    )
    expect(html.indexOf('Inspect the fixture.')).toBeLessThan(html.indexOf('fixture.txt'))
    expect(html.indexOf('fixture.txt')).toBeLessThan(html.indexOf('Verify the result.'))
  })
})
