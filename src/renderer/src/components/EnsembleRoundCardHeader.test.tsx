import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatMessage } from '../../../main/store/types'
import { EnsembleRoundCardHeader } from './EnsembleRoundCardHeader'

function roundHeaderMessage(expanded = false): ChatMessage {
  return {
    id: 'ensemble-round-header-r3',
    role: 'system',
    content: '',
    timestamp: '2026-07-11T08:00:00.000Z',
    metadata: {
      kind: 'ensembleRoundHeader',
      ensembleRoundId: 'r3',
      ensembleRoundHeader: {
        roundId: 'r3',
        roundIndex: 3,
        roundCount: 4,
        expanded,
        providers: ['codex', 'claude'],
        roles: ['Worker', 'Reviewer'],
        bodyMessageCount: 2,
        summary: 'Reviewed the release changes.',
        promptPreview: 'Review the release.'
      }
    }
  } as ChatMessage
}

function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(selector)
  const end = css.indexOf('}', start)
  return start === -1 ? '' : css.slice(start, end + 1)
}

describe('EnsembleRoundCardHeader', () => {
  it('keeps the semantic round disclosure without a leading marker', () => {
    const html = renderToStaticMarkup(
      <EnsembleRoundCardHeader message={roundHeaderMessage()} onSetExpanded={() => {}} />
    )

    expect(html).toContain('class="ensemble-round-card-toggle"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('Round 3')
    expect(html).toContain(' / 4')
    expect(html).toContain('2 messages')
    expect(html).toContain('Reviewed the release changes.')
    expect(html).toContain('provider-codex')
    expect(html).toContain('provider-claude')
    expect(html).not.toContain('ensemble-round-card-chevron')
    expect(html).not.toContain('▸')
    expect(html).not.toContain('▾')
  })

  it('keeps the round row satellite in the transcript', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/renderer/src/assets/css/09-ensemble-work-session.css'),
      'utf8'
    ).replace(/\r\n/g, '\n')
    const toggle = cssBlock(css, '.ensemble-round-card-toggle {')
    const expanded = cssBlock(
      css,
      '.ensemble-round-card-header.is-expanded .ensemble-round-card-toggle {'
    )

    expect(toggle).toContain('border: 0')
    expect(toggle).toContain('border-radius: 0')
    expect(toggle).toContain('background: transparent')
    expect(css).not.toContain('.ensemble-round-card-toggle:hover {')
    expect(expanded).not.toContain('background:')
    expect(expanded).not.toContain('border-color:')
    expect(css).not.toContain('.ensemble-round-card-chevron')
  })

  it('uses each Pi participant model hue without collapsing same-seat speakers', () => {
    const message = roundHeaderMessage()
    const data = message.metadata?.ensembleRoundHeader as Record<string, unknown>
    data.attributions = [
      {
        participantId: 'pi-deepseek',
        provider: 'pi',
        role: 'Scout',
        model: 'deepseek/deepseek-v4-pro'
      },
      {
        participantId: 'pi-mistral',
        provider: 'pi',
        role: 'Reviewer',
        model: 'mistral/devstral-2512'
      }
    ]

    const html = renderToStaticMarkup(
      <EnsembleRoundCardHeader message={message} onSetExpanded={() => {}} />
    )
    expect(html).toContain('provider-deepseek')
    expect(html).toContain('provider-mistral')
    expect(html).toContain('data-provider-hue="deepseek"')
    expect(html).toContain('data-provider-hue="mistral"')
    expect(html.match(/class="ensemble-round-card-provider provider-/g)).toHaveLength(2)
  })
})
