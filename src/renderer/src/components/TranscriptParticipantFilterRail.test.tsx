import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'
import { PI_MODEL_LABELS } from '../../../shared/piBrandTable'
import {
  TRANSCRIPT_SYSTEM_FILTER_KEY,
  transcriptParticipantFilterKey
} from '../lib/transcriptParticipantFilter'
import { TranscriptParticipantFilterRail } from './TranscriptParticipantFilterRail'

function participant(overrides: Partial<EnsembleParticipant>): EnsembleParticipant {
  return {
    id: 'participant-codex',
    provider: 'codex',
    enabled: true,
    role: 'Builder',
    instructions: '',
    order: 1,
    ...overrides
  }
}

function ensembleChat(
  participants: EnsembleParticipant[] = [
    participant({
      id: 'boss',
      role: 'Lead',
      order: 1,
      pooledAgentId: 'pooled-agent-lead'
    }),
    participant({
      id: 'captain',
      provider: 'claude',
      role: 'Reviewer',
      order: 2
    })
  ]
): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    title: 'Ensemble',
    chatKind: 'ensemble',
    provider: 'codex',
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      enabled: true,
      maxParticipants: participants.length,
      bossmanParticipantId: 'boss',
      secondInCommandParticipantId: 'captain',
      participants
    }
  } as ChatRecord
}

describe('TranscriptParticipantFilterRail', () => {
  it('renders participant and system filter controls with active state', () => {
    const html = renderToStaticMarkup(
      <TranscriptParticipantFilterRail
        currentChat={ensembleChat()}
        activeFilterKeys={
          new Set([transcriptParticipantFilterKey('boss'), TRANSCRIPT_SYSTEM_FILTER_KEY])
        }
        scrollRef={createRef<HTMLDivElement>()}
        contentRef={createRef<HTMLDivElement>()}
        onToggleFilter={() => {}}
      />
    )

    expect(html).toContain('aria-label="Transcript participant filters"')
    expect(html).toContain('data-column-count="1"')
    expect(html).toContain('data-row-offset="8"')
    expect(html).toContain('transcript-participant-filter-grid')
    expect(html).toContain('transcript-participant-filter-system-row')
    expect(html).toContain('transcript-participant-filter-side-stack')
    expect(html).toContain('>1</span>')
    expect(html).toContain('>2</span>')
    expect(html).not.toContain('#1')
    expect(html).not.toContain('#2')
    expect(html).toContain('transcript-participant-filter-pooled-icon')
    expect(html).toContain('data-provider-logo="claude"')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain('provider-glyph-claude')
    expect(html).toContain('title="Boss"')
    expect(html).toContain('title="Captain"')
    expect(html).toContain('is-system')
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2)
    expect(html).toContain('Remove transcript filter for Boss Lead (Codex, 1)')
    expect(html).toContain('Show only transcript messages from Captain Reviewer (Claude, 2)')
    expect(html).toContain('Remove transcript filter for system messages')
  })

  it('bottom-aligns an underfilled participant column above the system filter', () => {
    const participants = Array.from({ length: 6 }, (_, index) =>
      participant({
        id: `participant-${index + 1}`,
        role: `P${index + 1}`,
        order: index + 1
      })
    )
    const html = renderToStaticMarkup(
      <TranscriptParticipantFilterRail
        currentChat={ensembleChat(participants)}
        activeFilterKeys={new Set()}
        scrollRef={createRef<HTMLDivElement>()}
        contentRef={createRef<HTMLDivElement>()}
        onToggleFilter={() => {}}
      />
    )

    expect(html).toContain('data-column-count="1"')
    expect(html).toContain('data-row-offset="4"')
    expect(html).toMatch(/data-filter-ordinal="1"[\s\S]*?grid-row-start:5;grid-column-start:1/)
    expect(html).toMatch(/data-filter-ordinal="6"[\s\S]*?grid-row-start:10;grid-column-start:1/)
  })

  it('adds a third ten-row filter column for a full 30-participant roster', () => {
    const participants = Array.from({ length: 30 }, (_, index) =>
      participant({
        id: `participant-${index + 1}`,
        role: `P${index + 1}`,
        order: index + 1
      })
    )
    const html = renderToStaticMarkup(
      <TranscriptParticipantFilterRail
        currentChat={ensembleChat(participants)}
        activeFilterKeys={new Set()}
        scrollRef={createRef<HTMLDivElement>()}
        contentRef={createRef<HTMLDivElement>()}
        onToggleFilter={() => {}}
      />
    )

    expect(html).toContain('data-column-count="3"')
    expect(html).toContain('data-row-offset="0"')
    expect(html).toContain('data-filter-ordinal="1"')
    expect(html).toContain('data-filter-ordinal="10"')
    expect(html).toContain('data-filter-ordinal="11"')
    expect(html).toContain('data-filter-ordinal="20"')
    expect(html).toContain('data-filter-ordinal="21"')
    expect(html).toContain('data-filter-ordinal="30"')
    expect(html).toMatch(/data-filter-ordinal="11"[\s\S]*?grid-row-start:1;grid-column-start:2/)
    expect(html).toMatch(/data-filter-ordinal="20"[\s\S]*?grid-row-start:10;grid-column-start:2/)
    expect(html).toMatch(/data-filter-ordinal="21"[\s\S]*?grid-row-start:1;grid-column-start:3/)
    expect(html).toMatch(/data-filter-ordinal="30"[\s\S]*?grid-row-start:10;grid-column-start:3/)
    expect(html).toContain('System messages')
  })

  it('uses the official Ollama brand mark for Ollama-backed filter rows', () => {
    const html = renderToStaticMarkup(
      <TranscriptParticipantFilterRail
        currentChat={ensembleChat([
          participant({
            id: 'local-qwen',
            provider: 'ollama',
            role: 'Local',
            model: 'qwen3.5:9b',
            order: 1
          })
        ])}
        activeFilterKeys={new Set()}
        scrollRef={createRef<HTMLDivElement>()}
        contentRef={createRef<HTMLDivElement>()}
        onToggleFilter={() => {}}
      />
    )

    expect(html).toContain('data-provider-logo="ollama"')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain('provider-glyph-ollama')
  })

  it('spoofs every Pi participant filter accent from its upstream model', () => {
    const modelsByHue = [
      ['deepseek/deepseek-v4-flash', 'deepseek'],
      ['zai/glm-5.2', 'zai'],
      ['qwen-token-plan/qwen3.7-max', 'qwen'],
      ['minimax/MiniMax-M3', 'minimax'],
      ['mistral/devstral-2512', 'mistral'],
      ['groq/openai/gpt-oss-120b', 'groq'],
      ['cerebras/zai-glm-4.7', 'cerebras']
    ] as const
    expect(Object.keys(PI_MODEL_LABELS)).toEqual(
      expect.arrayContaining(modelsByHue.map(([model]) => model))
    )

    const html = renderToStaticMarkup(
      <TranscriptParticipantFilterRail
        currentChat={ensembleChat(
          modelsByHue.map(([model], index) =>
            participant({
              id: `pi-${index}`,
              provider: 'pi',
              role: `Pi ${index + 1}`,
              model,
              order: index + 1
            })
          )
        )}
        activeFilterKeys={new Set(['participant:pi-0'])}
        scrollRef={createRef<HTMLDivElement>()}
        contentRef={createRef<HTMLDivElement>()}
        onToggleFilter={() => {}}
      />
    )

    for (const [, hue] of modelsByHue) {
      expect(html).toContain(`provider-${hue}`)
      expect(html).toContain(`data-provider-hue="${hue}"`)
      expect(html).toContain(
        `--participant-filter-accent:var(--provider-${hue}-color, var(--accent))`
      )
    }
    expect(html).not.toContain('data-provider-hue="pi"')
  })

  it('does not render for non-ensemble chats', () => {
    const html = renderToStaticMarkup(
      <TranscriptParticipantFilterRail
        currentChat={{ chatKind: 'single' } as ChatRecord}
        activeFilterKeys={new Set()}
        scrollRef={createRef<HTMLDivElement>()}
        contentRef={createRef<HTMLDivElement>()}
        onToggleFilter={() => {}}
      />
    )

    expect(html).toBe('')
  })
})
