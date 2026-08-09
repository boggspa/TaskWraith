import { createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'
import { MAX_ENSEMBLE_PARTICIPANTS } from '../../../shared/ensembleLimits'
import { PI_MODEL_LABELS } from '../../../shared/piBrandTable'
import {
  TRANSCRIPT_SYSTEM_FILTER_KEY,
  transcriptParticipantFilterKey
} from '../lib/transcriptParticipantFilter'
import {
  TRANSCRIPT_PARTICIPANT_FILTER_ROWS_PER_COLUMN,
  TranscriptParticipantFilterRail
} from './TranscriptParticipantFilterRail'

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
      captainParticipantIds: participants
        .filter((participant) => participant.id.startsWith('captain'))
        .map((participant) => participant.id),
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
    expect(html).toContain('data-row-offset="23"')
    expect(html).toContain('transcript-participant-filter-grid')
    expect(html).toContain('transcript-participant-filter-system-row')
    expect(html).toContain('transcript-participant-filter-side-stack')
    expect(html).toContain('>1</span>')
    expect(html).toContain('>2</span>')
    expect(html).not.toContain('#1')
    expect(html).not.toContain('#2')
    expect(html).toContain('data-provider-logo="codex"')
    expect(html).toContain('data-provider-logo="claude"')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain('transcript-participant-filter-pooled-icon')
    expect(html).not.toContain('provider-glyph-codex')
    expect(html).not.toContain('provider-glyph-claude')
    expect(html).toContain('title="Boss"')
    expect(html).toContain('title="Captain"')
    expect(html).toContain('is-system')
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2)
    expect(html).toContain('Remove transcript filter for Boss Lead (Codex, 1)')
    expect(html).toContain('Show only transcript messages from Captain Reviewer (Claude, 2)')
    expect(html).toContain('Remove transcript filter for system messages')
  })

  it('renders all three configured Captains', () => {
    const html = renderToStaticMarkup(
      <TranscriptParticipantFilterRail
        currentChat={ensembleChat([
          participant({ id: 'boss', role: 'Boss', order: 1 }),
          participant({ id: 'captain-1', role: 'First', order: 2 }),
          participant({ id: 'captain-2', role: 'Second', order: 3 }),
          participant({ id: 'captain-3', role: 'Third', order: 4 })
        ])}
        activeFilterKeys={new Set()}
        scrollRef={createRef<HTMLDivElement>()}
        contentRef={createRef<HTMLDivElement>()}
        onToggleFilter={() => {}}
      />
    )

    expect(html.match(/title="Captain"/g)).toHaveLength(3)
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
    expect(html).toContain('data-row-offset="19"')
    expect(html).toMatch(/data-filter-ordinal="1"[\s\S]*?grid-row-start:20;grid-column-start:1/)
    expect(html).toMatch(/data-filter-ordinal="6"[\s\S]*?grid-row-start:25;grid-column-start:1/)
  })

  it('uses two 25-row filter columns for a full roster', () => {
    expect(MAX_ENSEMBLE_PARTICIPANTS).toBe(TRANSCRIPT_PARTICIPANT_FILTER_ROWS_PER_COLUMN * 2)
    const participants = Array.from({ length: MAX_ENSEMBLE_PARTICIPANTS }, (_, index) =>
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

    expect(html).toContain('data-column-count="2"')
    expect(html).toContain('data-row-offset="0"')
    expect(html).toContain('data-filter-ordinal="1"')
    expect(html).toContain('data-filter-ordinal="25"')
    expect(html).toContain('data-filter-ordinal="26"')
    expect(html).toContain('data-filter-ordinal="50"')
    expect(html).toMatch(/data-filter-ordinal="25"[\s\S]*?grid-row-start:25;grid-column-start:1/)
    expect(html).toMatch(/data-filter-ordinal="26"[\s\S]*?grid-row-start:1;grid-column-start:2/)
    expect(html).toMatch(/data-filter-ordinal="50"[\s\S]*?grid-row-start:25;grid-column-start:2/)
    expect(html).toContain('System messages')
  })

  it('keeps the CSS grid row count aligned with participant placement', () => {
    const css = readFileSync(
      new URL('../assets/css/02-transcript-messages-fx.css', import.meta.url),
      'utf8'
    )
    expect(css).toContain(
      `grid-template-rows: repeat(${TRANSCRIPT_PARTICIPANT_FILTER_ROWS_PER_COLUMN}, 24px);`
    )
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

  it('uses the AntiGravity provider mark when a linked pooled Agent has a custom ghost icon', () => {
    const html = renderToStaticMarkup(
      <TranscriptParticipantFilterRail
        currentChat={ensembleChat([
          participant({
            id: 'pooled-antigravity',
            provider: 'antigravity',
            role: 'FlashScout',
            order: 2,
            pooledAgentId: 'pooled-agent-flash-scout',
            pooledAgentIdentity: {
              schemaVersion: 1,
              agentId: 'pooled-agent-flash-scout',
              nickname: 'Flash Scout',
              iconKind: 'asset',
              hue: 256,
              assetKey: 'ghost:ghost-guy-mark-monoline'
            }
          })
        ])}
        activeFilterKeys={new Set()}
        scrollRef={createRef<HTMLDivElement>()}
        contentRef={createRef<HTMLDivElement>()}
        onToggleFilter={() => {}}
      />
    )

    expect(html).toContain('data-provider-logo="antigravity"')
    expect(html).toContain('provider-logo-antigravity.png')
    expect(html).not.toContain('ghost:ghost-guy-mark-monoline')
    expect(html).not.toContain('transcript-participant-filter-pooled-icon')
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
