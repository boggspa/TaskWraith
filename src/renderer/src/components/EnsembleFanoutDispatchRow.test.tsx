import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../../main/store/types'
import { EnsembleFanoutDispatchRow } from './EnsembleFanoutDispatchRow'

const panelSource = readFileSync(new URL('./TranscriptPanel.tsx', import.meta.url), 'utf8')
const rowSource = readFileSync(new URL('./EnsembleFanoutDispatchRow.tsx', import.meta.url), 'utf8')
const cssSource = readFileSync(
  new URL('../assets/css/42-ensemble-fanout-dispatch.css', import.meta.url),
  'utf8'
)

function message(): ChatMessage {
  return {
    id: 'fanout-dispatch-1',
    role: 'system',
    content: 'User Fan-Out · 2 participant(s) dispatched concurrently (1 read / 1 write-intent).',
    timestamp: '2026-08-27T13:30:00.000Z',
    metadata: {
      kind: 'ensembleRoundStatus',
      ensembleFanoutWaveId: 'fanout-dispatch-1',
      ensembleFanoutDispatch: {
        label: 'User Fan-Out',
        category: 'user',
        participants: [
          {
            participantId: 'pi-scout',
            provider: 'pi',
            role: 'Researcher',
            model: 'mistral/devstral-2512',
            intent: 'read'
          },
          {
            participantId: 'ollama-builder',
            provider: 'ollama',
            role: 'Builder',
            model: 'qwen3.5:9b',
            intent: 'write'
          }
        ]
      }
    }
  }
}

describe('EnsembleFanoutDispatchRow', () => {
  it('renders an Ensemble Fanout tool row with the relevant provider-branded seats', () => {
    const html = renderToStaticMarkup(<EnsembleFanoutDispatchRow message={message()} />)

    expect(html).toContain('Ensemble Fanout')
    expect(html).toContain('User-directed')
    expect(html).toContain('2 lanes')
    expect(html).toContain('Mistral / Researcher')
    expect(html).toContain('Alibaba / Builder')
    expect(html).toContain('provider-mistral')
    expect(html).toContain('provider-alibaba')
    expect(html).toContain('ensemble-fanout-viewport-glyph-icon')
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('System')
  })

  it('uses singular lane copy for the one-participant write fan-out in the reported row', () => {
    const single = message()
    const payload = single.metadata?.ensembleFanoutDispatch as {
      participants: Array<Record<string, unknown>>
    }
    payload.participants = [payload.participants[1]]

    const html = renderToStaticMarkup(<EnsembleFanoutDispatchRow message={single} />)
    expect(html).toContain('1 lane')
    expect(html).toContain('Alibaba / Builder')
    expect(html).not.toContain('Mistral / Researcher')
  })

  it('rejects malformed metadata so the carrier sentence remains the fallback', () => {
    const malformed = message()
    if (malformed.metadata) {
      malformed.metadata.ensembleFanoutDispatch = {
        label: 'User Fan-Out',
        category: 'user',
        participants: []
      }
    }
    expect(renderToStaticMarkup(<EnsembleFanoutDispatchRow message={malformed} />)).toBe('')
  })

  it('expands to participant intent/model details while reusing the durable viewport language', () => {
    expect(rowSource).toContain('useState(false)')
    expect(rowSource).toContain('ensemble-fanout-dispatch-details')
    expect(rowSource).toContain('participant.intent ===')
    expect(cssSource).toContain('.ensemble-fanout-dispatch-participant {')
  })
})

describe('TranscriptPanel fan-out dispatch wiring', () => {
  it('keeps valid dispatch receipts out of System collapse and routes the tool row first', () => {
    const plainStart = panelSource.indexOf('function plainSystemNoticeMessage(')
    const plainEnd = panelSource.indexOf('function superGroupParticipantKey(', plainStart)
    expect(panelSource.slice(plainStart, plainEnd)).toContain(
      '!isEnsembleFanoutDispatchPayload(msg.metadata?.ensembleFanoutDispatch) &&'
    )

    const dispatch = panelSource.indexOf('isFanoutDispatch ? (')
    const collapse = panelSource.indexOf('systemAutoCollapsible ? (', dispatch)
    expect(dispatch).toBeGreaterThanOrEqual(0)
    expect(collapse).toBeGreaterThan(dispatch)
    expect(panelSource.slice(dispatch, collapse)).toContain('<EnsembleFanoutDispatchRow')
  })
})
