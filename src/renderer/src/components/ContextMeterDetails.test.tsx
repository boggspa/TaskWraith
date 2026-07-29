import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ContextMeterDetails } from './ContextMeterDetails'

describe('ContextMeterDetails', () => {
  it('renders exact provider composition and keeps tool prompt tokens as a subset', () => {
    const html = renderToStaticMarkup(
      <ContextMeterDetails
        primary="Builder"
        usedTokens={120}
        windowTokens={1_000}
        percent={12}
        usage={{
          contextTokens: 120,
          totalTokens: 120,
          inputTokens: 100,
          freshInputTokens: 20,
          cacheReadInputTokens: 80,
          cacheCreationInputTokens: 0,
          outputTokens: 20,
          visibleOutputTokens: 5,
          reasoningTokens: 15,
          toolUsePromptTokens: 25,
          unclassifiedTokens: 0,
          source: 'provider-last-invocation',
          precision: 'exact'
        }}
      />
    )

    expect(html).toContain('12% used')
    expect(html).toContain('88% free')
    expect(html).toContain('Fresh input')
    expect(html).toContain('Cache read')
    expect(html).toContain('Reasoning')
    expect(html).toContain('Tool definitions inside input')
    expect(html).toContain('Exact snapshot')
    expect(html).toContain('Provider-reported latest model invocation')
  })

  it('labels observed tool traffic as approximate and non-additive', () => {
    const html = renderToStaticMarkup(
      <ContextMeterDetails
        primary="Reviewer"
        usedTokens={42}
        windowTokens={200_000}
        percent={0.021}
        activity={{
          messageCount: 2,
          messageTokens: 20,
          userMessageCount: 1,
          assistantMessageCount: 1,
          toolCallCount: 1,
          toolInputTokens: 5,
          toolResultCount: 1,
          toolResultTokens: 30,
          reasoningSegmentCount: 1,
          reasoningTextTokens: 10,
          readCalls: 1,
          writeCalls: 0,
          searchCalls: 0,
          shellCalls: 0,
          otherCalls: 0,
          filesRead: 1,
          filesWritten: 0,
          tools: [{ name: 'read_file', label: 'Read file', category: 'read', count: 1 }]
        }}
      />
    )

    expect(html).toContain('Observed activity')
    expect(html).toContain('Model → tools')
    expect(html).toContain('Tools → model')
    expect(html).toContain('≈')
    expect(html).toContain('never added on top of provider totals')
  })

  it('describes live growth after compaction as derived rather than exact', () => {
    const html = renderToStaticMarkup(
      <ContextMeterDetails
        primary="Builder"
        usedTokens={22_500}
        windowTokens={200_000}
        percent={11.25}
        usage={{
          observedAt: 1,
          contextTokens: 22_500,
          totalTokens: 22_500,
          inputTokens: 0,
          freshInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 500,
          visibleOutputTokens: 500,
          reasoningTokens: 0,
          toolUsePromptTokens: 0,
          unclassifiedTokens: 22_000,
          source: 'provider-compaction',
          precision: 'derived'
        }}
      />
    )

    expect(html).toContain('Compacted baseline')
    expect(html).toContain('Live output estimate')
    expect(html).toContain('The displayed total is derived')
    expect(html).toContain('only the compaction baseline is exact')
    expect(html).not.toContain('The new total is exact')
  })
})
