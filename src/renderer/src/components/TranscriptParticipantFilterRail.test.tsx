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
  TRANSCRIPT_PARTICIPANT_FILTER_DOCK_RESERVE_VAR,
  TRANSCRIPT_PARTICIPANT_FILTER_ITEMS_PER_ROW,
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

function renderRail(
  participants?: EnsembleParticipant[],
  activeFilterKeys: ReadonlySet<string> = new Set()
): string {
  return renderToStaticMarkup(
    <TranscriptParticipantFilterRail
      currentChat={participants ? ensembleChat(participants) : ensembleChat()}
      activeFilterKeys={activeFilterKeys}
      scrollRef={createRef<HTMLDivElement>()}
      contentRef={createRef<HTMLDivElement>()}
      onToggleFilter={() => {}}
    />
  )
}

function rosterOfSize(size: number): EnsembleParticipant[] {
  return Array.from({ length: size }, (_, index) =>
    participant({
      id: `participant-${index + 1}`,
      role: `P${index + 1}`,
      order: index + 1
    })
  )
}

/** Inner markup of each `.transcript-participant-filter-row`, in order. The
 * dock's buttons only nest `<span>`s, so the row's own `</div>` is the first
 * one after its opening tag. */
function rowSegments(html: string): string[] {
  const marker = 'class="transcript-participant-filter-row"'
  const segments: string[] = []
  let from = html.indexOf(marker)
  while (from >= 0) {
    const end = html.indexOf('</div>', from)
    segments.push(html.slice(from, end === -1 ? html.length : end))
    from = html.indexOf(marker, from + marker.length)
  }
  return segments
}

function buttonCount(segment: string): number {
  return segment.match(/<button /g)?.length ?? 0
}

describe('TranscriptParticipantFilterRail', () => {
  it('renders participant and system filter controls with active state', () => {
    const html = renderRail(
      undefined,
      new Set([transcriptParticipantFilterKey('boss'), TRANSCRIPT_SYSTEM_FILTER_KEY])
    )

    expect(html).toContain('aria-label="Transcript participant filters"')
    expect(html).toContain('data-row-count="1"')
    expect(html).toContain('transcript-participant-filter-row')
    expect(html).not.toContain('transcript-participant-filter-grid')
    expect(html).not.toContain('transcript-participant-filter-system-row')
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
    const html = renderRail([
      participant({ id: 'boss', role: 'Boss', order: 1 }),
      participant({ id: 'captain-1', role: 'First', order: 2 }),
      participant({ id: 'captain-2', role: 'Second', order: 3 }),
      participant({ id: 'captain-3', role: 'Third', order: 4 })
    ])

    expect(html.match(/title="Captain"/g)).toHaveLength(3)
  })

  it('lays out a small roster as one row with the system chip trailing it', () => {
    const html = renderRail(rosterOfSize(6))

    expect(html).toContain('data-row-count="1"')
    const rows = rowSegments(html)
    expect(rows).toHaveLength(1)
    // 6 participants + the trailing system chip live in the SAME row — the
    // dock has no separate system row.
    expect(buttonCount(rows[0])).toBe(7)
    expect(rows[0]).toContain('is-system')
    expect(rows[0]).toMatch(/data-filter-ordinal="1"[\s\S]*data-filter-ordinal="6"/)
  })

  it('balances an over-cap roster into even rows instead of 25 + remainder', () => {
    const html = renderRail(rosterOfSize(TRANSCRIPT_PARTICIPANT_FILTER_ITEMS_PER_ROW + 1))

    expect(html).toContain('data-row-count="2"')
    const rows = rowSegments(html)
    expect(rows).toHaveLength(2)
    expect(buttonCount(rows[0])).toBe(13)
    // 13 participants + the trailing system chip.
    expect(buttonCount(rows[1])).toBe(14)
    expect(rows[0]).toContain('data-filter-ordinal="13"')
    expect(rows[1]).toContain('data-filter-ordinal="14"')
    expect(rows[1]).toContain('is-system')
  })

  it('uses two 25-item filter rows for a full roster', () => {
    expect(MAX_ENSEMBLE_PARTICIPANTS).toBe(TRANSCRIPT_PARTICIPANT_FILTER_ITEMS_PER_ROW * 2)
    const html = renderRail(rosterOfSize(MAX_ENSEMBLE_PARTICIPANTS))

    expect(html).toContain('data-row-count="2"')
    const rows = rowSegments(html)
    expect(rows).toHaveLength(2)
    expect(buttonCount(rows[0])).toBe(25)
    expect(buttonCount(rows[1])).toBe(26)
    expect(rows[0]).toContain('data-filter-ordinal="1"')
    expect(rows[0]).toContain('data-filter-ordinal="25"')
    expect(rows[1]).toContain('data-filter-ordinal="26"')
    expect(rows[1]).toContain('data-filter-ordinal="50"')
    expect(html).toContain('System messages')
  })

  it('keeps the dock CSS in lockstep with the component contract', () => {
    const transcriptCss = readFileSync(
      new URL('../assets/css/02-transcript-messages-fx.css', import.meta.url),
      'utf8'
    )
    const composerCss = readFileSync(
      new URL('../assets/css/03-composer-welcome-activity.css', import.meta.url),
      'utf8'
    )
    const reserve = `var(${TRANSCRIPT_PARTICIPANT_FILTER_DOCK_RESERVE_VAR}, 0px)`

    // The dock is pane-anchored (not body-portaled/fixed) and flows as rows.
    expect(transcriptCss).toContain('.transcript-participant-filter-row {')
    expect(transcriptCss).toContain('--participant-filter-dock-bottom-gap:')
    // The composer lifts by the JS-written reserve in BOTH docked states
    // (plain and workspace-terminal-open).
    expect(composerCss.split(reserve).length - 1).toBeGreaterThanOrEqual(2)
    // The transcript's bottom reserve grows with the dock so the last message
    // clears the composer + dock stack.
    const underPadding = transcriptCss.slice(
      transcriptCss.indexOf('--composer-scroll-under-padding:'),
      transcriptCss.indexOf('--composer-terminal-scroll-under-padding:')
    )
    expect(underPadding).toContain(reserve)
    // The dock itself climbs above the open workspace terminal.
    const terminalRule = transcriptCss.slice(
      transcriptCss.indexOf('.workspace-terminal-open .transcript-participant-filter-rail {')
    )
    expect(terminalRule.slice(0, terminalRule.indexOf('}'))).toContain(
      'var(--workspace-terminal-height)'
    )
    // Welcome mode has no transcript to filter — the dock stays hidden there.
    const welcomeRule = transcriptCss.slice(
      transcriptCss.indexOf('.welcome-mode .transcript-participant-filter-rail {')
    )
    expect(welcomeRule.slice(0, welcomeRule.indexOf('}'))).toContain('display: none')
  })

  it('uses the official Ollama brand mark for Ollama-backed filter rows', () => {
    const html = renderRail([
      participant({
        id: 'local-qwen',
        provider: 'ollama',
        role: 'Local',
        model: 'qwen3.5:9b',
        order: 1
      })
    ])

    expect(html).toContain('data-provider-logo="ollama"')
    expect(html).toContain('<img class="provider-brand-logo-image')
    expect(html).not.toContain('provider-glyph-ollama')
  })

  it('uses the AntiGravity provider mark when a linked pooled Agent has a custom ghost icon', () => {
    const html = renderRail([
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
    ])

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

    const html = renderRail(
      modelsByHue.map(([model], index) =>
        participant({
          id: `pi-${index}`,
          provider: 'pi',
          role: `Pi ${index + 1}`,
          model,
          order: index + 1
        })
      ),
      new Set(['participant:pi-0'])
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
