import { describe, expect, it } from 'vitest'
import {
  PROVIDER_RUN_FAILURE_METADATA_KIND,
  STALE_RUN_SETTLEMENT_HINT,
  STALE_RUN_SETTLEMENT_HINT_PLURAL,
  buildBridgeRunFailureMetadata,
  buildStaleRunSettlementNotice,
  describeUnexplainedBridgeRunFailure,
  runFailureNoticeCopyText,
  runFailureNoticeLines,
  runFailureProviderLabel,
  staleRunSettlementNoticeId
} from './RunFailureNotice'
import type { ChatRun } from './store/types'

const NOW = '2026-07-28T12:00:00.000Z'
const REASON =
  'Interrupted with no live RunManager session, bridge transcript, background sub-thread transcript, or non-terminal run-queue job.'

function run(partial: Partial<ChatRun> = {}): ChatRun {
  return {
    runId: '1753700000000-abc123',
    provider: 'ollama',
    startedAt: '2026-07-28T11:00:00.000Z',
    status: 'failed',
    exitCode: 1,
    ...partial
  }
}

describe('runFailureProviderLabel', () => {
  it('labels known providers and never leaves a hole', () => {
    expect(runFailureProviderLabel('ollama')).toBe('Ollama')
    expect(runFailureProviderLabel('claude')).toBe('Claude')
    // Matches the renderer/projection fallback, so a provider-less run still
    // renders "Provider failed" rather than " failed".
    expect(runFailureProviderLabel(undefined)).toBe('Provider')
    expect(runFailureProviderLabel(null)).toBe('Provider')
  })
})

describe('runFailureNoticeLines', () => {
  it('splits, collapses whitespace and de-duplicates', () => {
    expect(runFailureNoticeLines('  boom  \n\nboom\nnext   line ')).toEqual([
      { text: 'boom' },
      { text: 'next line' }
    ])
  })

  it('bounds the line count and the line length', () => {
    const many = runFailureNoticeLines(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'))
    expect(many).toHaveLength(6)
    const long = runFailureNoticeLines('x'.repeat(2000))
    expect(long[0].text).toHaveLength(600)
  })

  it('stamps a timestamp on every line when one is supplied', () => {
    expect(runFailureNoticeLines('a\nb', NOW)).toEqual([
      { text: 'a', timestamp: NOW },
      { text: 'b', timestamp: NOW }
    ])
  })
})

describe('runFailureNoticeCopyText', () => {
  it('mirrors the renderer snippet layout (headline, rule, lines, hint)', () => {
    expect(
      runFailureNoticeCopyText(
        'Ollama failed · exit 1',
        [{ text: 'a' }, { text: 'b' }],
        'try again'
      )
    ).toBe('Ollama failed · exit 1\n---\na\nb\ntry again')
  })

  it('omits the hint row when there is no hint', () => {
    expect(runFailureNoticeCopyText('h', [{ text: 'a' }])).toBe('h\n---\na')
  })
})

describe('buildStaleRunSettlementNotice', () => {
  const notice = buildStaleRunSettlementNotice({
    chatId: 'chat-1',
    settlements: [{ run: run(), previousStatus: 'running' }],
    reason: REASON,
    settledAt: NOW
  })

  it('is an error row bound to the settled run', () => {
    expect(notice.role).toBe('error')
    expect(notice.runId).toBe('1753700000000-abc123')
    expect(notice.timestamp).toBe(NOW)
  })

  it('uses a deterministic id so a repeat pass cannot stack duplicates', () => {
    expect(notice.id).toBe(staleRunSettlementNoticeId('chat-1', '1753700000000-abc123'))
    expect(notice.id).toBe('stale-run-error-chat-1-1753700000000-abc123')
  })

  it('names the run, the wedged status and the settlement reason', () => {
    expect(notice.content).toContain('1753700000000-abc123')
    expect(notice.content).toContain('still marked running')
    expect(notice.content).toContain('no live process owner')
    expect(notice.content).toContain(REASON)
    expect(notice.content).toContain(STALE_RUN_SETTLEMENT_HINT)
  })

  it('carries the providerRunFailure card metadata both platforms render', () => {
    expect(notice.metadata).toMatchObject({
      kind: PROVIDER_RUN_FAILURE_METADATA_KIND,
      provider: 'ollama',
      exitCode: 1,
      failureAt: NOW,
      headline: 'Ollama run interrupted',
      hint: STALE_RUN_SETTLEMENT_HINT
    })
    const lines = (notice.metadata as { lines: Array<{ text: string }> }).lines
    expect(lines.length).toBeGreaterThan(1)
    expect(lines[0].text).toContain('1753700000000-abc123')
  })

  it('survives a run with no provider and no exit code', () => {
    const bare = buildStaleRunSettlementNotice({
      chatId: 'c',
      settlements: [
        { run: run({ provider: undefined, exitCode: undefined }), previousStatus: 'queued' }
      ],
      reason: REASON,
      settledAt: NOW
    })
    expect(bare.metadata).toMatchObject({ headline: 'Provider run interrupted' })
    expect(bare.metadata).not.toHaveProperty('provider')
    expect(bare.metadata).not.toHaveProperty('exitCode')
  })

  it('throws rather than emit a card that explains nothing', () => {
    expect(() =>
      buildStaleRunSettlementNotice({
        chatId: 'c',
        settlements: [],
        reason: REASON,
        settledAt: NOW
      })
    ).toThrow()
  })

  describe('grouped settlements', () => {
    const grouped = buildStaleRunSettlementNotice({
      chatId: 'chat-1',
      settlements: [
        { run: run({ runId: 'run-a' }), previousStatus: 'running' },
        { run: run({ runId: 'run-b' }), previousStatus: 'running' },
        { run: run({ runId: 'run-c' }), previousStatus: 'running' },
        { run: run({ runId: 'run-d' }), previousStatus: 'running' }
      ],
      reason: REASON,
      settledAt: NOW
    })

    it('collapses a wave of settlements into ONE card', () => {
      // 13 seats orphaned by one crash must not become 13 byte-identical
      // cards replayed on every chat open — one row carries the whole batch.
      expect(grouped.metadata).toMatchObject({
        kind: PROVIDER_RUN_FAILURE_METADATA_KIND,
        provider: 'ollama',
        headline: 'Ollama · 4 runs interrupted',
        hint: STALE_RUN_SETTLEMENT_HINT_PLURAL
      })
      expect(grouped.content).toContain('4 runs were still marked running')
      expect(grouped.content).toContain(REASON)
    })

    it('binds the row to the batch newest run so insertion anchors correctly', () => {
      expect(grouped.runId).toBe('run-d')
      expect(grouped.id).toBe(staleRunSettlementNoticeId('chat-1', 'run-d'))
    })

    it('names the first ids and summarises the rest', () => {
      expect(grouped.content).toContain('Runs: run-a, run-b, run-c +1 more')
    })

    it('claims a provider / status / exit code only when the whole batch agrees', () => {
      const mixed = buildStaleRunSettlementNotice({
        chatId: 'chat-1',
        settlements: [
          { run: run({ runId: 'run-a', provider: 'ollama' }), previousStatus: 'running' },
          { run: run({ runId: 'run-b', provider: 'codex', exitCode: 7 }), previousStatus: 'queued' }
        ],
        reason: REASON,
        settledAt: NOW
      })
      // A shared headline/hue would let one seat speak for the other.
      expect(mixed.metadata).toMatchObject({ headline: '2 runs interrupted' })
      expect(mixed.metadata).not.toHaveProperty('provider')
      expect(mixed.metadata).not.toHaveProperty('exitCode')
      expect(mixed.content).toContain('2 runs were still marked active')
      expect(mixed.content).toContain('Providers: Ollama, Codex.')
    })
  })
})

describe('describeUnexplainedBridgeRunFailure', () => {
  it('names the tool-call count and the exit code when the turn was silent', () => {
    expect(
      describeUnexplainedBridgeRunFailure({
        toolCallCount: 3,
        hasAssistantText: false,
        exitCode: 1
      })
    ).toBe(
      'The provider ended this turn without a reply after 3 tool calls and without reporting an error (exit 1).'
    )
  })

  it('singularises one tool call and drops the clause at zero', () => {
    expect(
      describeUnexplainedBridgeRunFailure({ toolCallCount: 1, hasAssistantText: false })
    ).toContain('after 1 tool call ')
    expect(describeUnexplainedBridgeRunFailure({ toolCallCount: 0, hasAssistantText: false })).toBe(
      'The provider ended this turn without a reply and without reporting an error.'
    )
  })

  it('flags a partial reply instead of claiming there was none', () => {
    const text = describeUnexplainedBridgeRunFailure({
      toolCallCount: 2,
      hasAssistantText: true,
      exitCode: 1
    })
    expect(text).toContain('in a failure after 2 tool calls')
    expect(text).toContain('may be incomplete')
  })
})

describe('buildBridgeRunFailureMetadata', () => {
  it('builds the card from a real provider error', () => {
    expect(
      buildBridgeRunFailureMetadata({
        provider: 'claude',
        errorMessage: 'ECONNRESET\nsocket hang up',
        failureAt: NOW,
        exitCode: 1
      })
    ).toEqual({
      kind: PROVIDER_RUN_FAILURE_METADATA_KIND,
      provider: 'claude',
      exitCode: 1,
      failureAt: NOW,
      headline: 'Claude failed · exit 1',
      lines: [{ text: 'ECONNRESET' }, { text: 'socket hang up' }]
    })
  })

  it('never emits an empty-bodied card', () => {
    const metadata = buildBridgeRunFailureMetadata({
      provider: 'grok',
      errorMessage: '   ',
      failureAt: NOW
    })
    expect(metadata).toMatchObject({ headline: 'Grok failed' })
    expect(metadata.lines).toEqual([{ text: 'Grok failed' }])
    expect(metadata).not.toHaveProperty('exitCode')
  })
})
