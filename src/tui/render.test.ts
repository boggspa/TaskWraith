import { describe, expect, it } from 'vitest'
import { Ansi, stripAnsi, visibleWidth } from './ansi'
import { renderTaskWraithTui } from './render'
import { createTaskWraithTuiDemoState } from './state'

function renderedLines(
  width: number,
  height: number,
  overlay: 'none' | 'context' | 'threads' | 'missions' | 'help' | 'tune' | 'setup' = 'none'
): string[] {
  const now = Date.UTC(2026, 6, 27, 4, 55, 37)
  const state = createTaskWraithTuiDemoState(now)
  state.overlay = overlay
  return renderTaskWraithTui(state, {
    width,
    height,
    ansi: new Ansi('none'),
    now,
    animationEnabled: false
  }).split('\n')
}

describe('TaskWraith TUI renderer', () => {
  it('renders a guided setup overlay and keeps the composer unavailable', () => {
    const state = createTaskWraithTuiDemoState(Date.UTC(2026, 7, 24, 4, 0, 0))
    state.overlay = 'setup'
    state.coldStart = {
      kind: 'configure',
      workspaceId: 'workspace-1',
      providerId: 'provider-1',
      threadId: 'thread-1',
      acknowledgedPostureIds: [],
      offers: {
        providerId: 'provider-1',
        offerRevision: 'offer-revision-1',
        models: [
          {
            modelId: 'model-1',
            label: 'Model One',
            available: true,
            reasoning: [
              { reasoningId: 'reasoning-low', label: 'Low', available: true },
              { reasoningId: 'reasoning-high', label: 'High', available: true }
            ]
          },
          { modelId: 'model-2', label: 'Model Two', available: true, reasoning: [] }
        ],
        postures: [
          {
            postureId: 'posture-read',
            label: 'Read',
            available: true,
            requiresExplicitConsent: false,
            ceiling: 'read'
          },
          {
            postureId: 'posture-full',
            label: 'Full access',
            available: true,
            requiresExplicitConsent: true,
            ceiling: 'full_access'
          }
        ]
      }
    }
    state.coldStartModelIndex = 0
    state.coldStartReasoningIndex = 0
    state.coldStartPostureIndex = 1

    const output = stripAnsi(
      renderTaskWraithTui(state, {
        width: 100,
        height: 24,
        ansi: new Ansi('none'),
        animationEnabled: false
      })
    )

    expect(output).toContain('Host setup')
    expect(output).toContain('Model One')
    expect(output).toContain('Model Two')
    expect(output).toContain('Low')
    expect(output).toContain('Full access · consent required · Space')
    expect(output).toContain('Complete Host setup to compose')
  })

  it('uses exactly 80x24 with a transcript canvas and three-row ensemble footer', () => {
    const lines = renderedLines(80, 24)
    expect(lines).toHaveLength(24)
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true)
    expect(lines.join('\n')).toContain('Claude · Lead · Opus 4.8 1M · Ultracode')
    expect(lines.join('\n')).toContain('ᜊ Working…  2s · ≈386 tokens')
    expect(lines.at(-3)?.trimStart()).toMatch(/^ENS Build \+ Review/)
    expect(lines.at(-2)).toContain('AGBench W+1')
    expect(lines.at(-1)?.trimStart()).toMatch(/^› ▏ Ask TaskWraith…/)
  })

  it('keeps the same semantic checksum inside a tall, narrow terminal', () => {
    const lines = renderedLines(64, 30)
    expect(lines).toHaveLength(30)
    expect(lines.every((line) => visibleWidth(line) === 64)).toBe(true)
    expect(lines.at(-3)).toContain('ENS')
    expect(lines.at(-2)).toContain('AGBench')
    expect(lines.at(-1)).toContain('↵ send')
  })

  it('moves full workspace and roster detail into one context lens', () => {
    const output = renderedLines(80, 24, 'context').join('\n')
    expect(output).toContain('Context lens')
    expect(output).toContain('PRIMARY  AGBench  [write]')
    expect(output).toContain('SECONDARY  design-system  [write]')
    expect(output).toContain('Build + Review · Continuous · fan-out Off · 0/32')
    expect(output).toContain('Claude · Lead · Opus 4.8 1M')
    expect(output).toContain('Kimi · Review · K3 · BG')
    expect(output).toContain('Esc close · Ctrl+O toggle')
  })

  it('renders live and historical Host missions with distinct round, routing, and seat state', () => {
    const activeLines = renderedLines(80, 24, 'missions')
    expect(activeLines).toHaveLength(24)
    expect(activeLines.every((line) => visibleWidth(line) === 80)).toBe(true)
    const active = activeLines.join('\n')
    expect(active).toContain('Missions · Active')
    expect(active).toContain('LIVE · generation 1 · cursor 7')
    expect(active).toContain('Complete the TaskWraith TUI')
    expect(active).toContain('demo-round · running')
    expect(active).toContain('continuous · fan-out off · 0/32')
    expect(active).toContain('answered · 11111111-1111-4111-8111-111111111111')
    expect(active).toContain('CLA · Lead · running')
    expect(active).not.toContain('Prove Host protocol foundations')

    const state = createTaskWraithTuiDemoState(Date.UTC(2026, 6, 27, 4, 55, 37))
    state.overlay = 'missions'
    state.missionFilter = 'history'
    const historical = stripAnsi(
      renderTaskWraithTui(state, {
        width: 120,
        height: 30,
        ansi: new Ansi('none'),
        animationEnabled: false
      })
    )
    expect(historical).toContain('Missions · History')
    expect(historical).toContain('Prove Host protocol foundations')
    expect(historical).not.toContain('Complete the TaskWraith TUI')
  })

  it('renders the seat lens for ensembles and the model lens for solo threads', () => {
    const seatLens = renderedLines(80, 24, 'tune')
    expect(seatLens.every((line) => visibleWidth(line) === 80)).toBe(true)
    const seatOutput = seatLens.join('\n')
    expect(seatOutput).toContain('Seats (preview)')
    expect(seatOutput).toContain('Claude · Lead')
    expect(seatOutput).toContain('↑↓ seat · Enter toggle · applies immediately · Esc close')

    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const solo = createTaskWraithTuiDemoState(now)
    solo.overlay = 'tune'
    const { ensemble: _ensemble, ...soloThread } = solo.thread!.thread
    solo.thread = { ...solo.thread!, thread: { ...soloThread, chatKind: 'single' } }
    solo.tuneEffortIndex = 1
    solo.offers = {
      threadId: soloThread.id,
      provider: soloThread.provider,
      currentModel: 'claude-opus-4-8-1m',
      currentReasoningEffort: 'medium',
      models: [
        {
          id: 'claude-opus-4-8-1m',
          label: 'Opus 4.8 1M',
          current: true,
          reasoningEfforts: [{ id: 'low' }, { id: 'medium', isDefault: true }, { id: 'high' }],
          defaultReasoningEffort: 'medium'
        },
        {
          id: 'claude-fable-5',
          label: 'Fable 5',
          retiresAt: '2027-01-01',
          reasoningEfforts: [{ id: 'medium', isDefault: true }],
          defaultReasoningEffort: 'medium'
        }
      ],
      source: 'curated'
    }
    const modelLines = renderTaskWraithTui(solo, {
      width: 80,
      height: 24,
      ansi: new Ansi('none'),
      now,
      animationEnabled: false
    }).split('\n')
    expect(modelLines.every((line) => visibleWidth(line) === 80)).toBe(true)
    const modelOutput = modelLines.join('\n')
    expect(modelOutput).toContain('Model (preview)')
    expect(modelOutput).toContain('Opus 4.8 1M (current)')
    expect(modelOutput).toContain('Fable 5 (retires 2027-01-01)')
    expect(modelOutput).toContain('low · [medium] · high')
    expect(modelOutput).toContain('↑↓ model · ←→ reasoning · Enter apply on next send · Esc close')
  })

  it('shows a staged model selection beside the HUD identity until it is sent', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    const { ensemble: _ensemble, ...soloThread } = state.thread!.thread
    state.thread = { ...state.thread!, thread: { ...soloThread, chatKind: 'single' } }
    state.notice = undefined
    state.pendingSelection = { model: 'claude-fable-5', label: 'Fable 5', reasoningEffort: 'high' }
    const output = renderTaskWraithTui(state, {
      width: 100,
      height: 24,
      ansi: new Ansi('none'),
      now,
      animationEnabled: false
    })
    expect(stripAnsi(output)).toContain('→ Fable 5 high')
  })

  it('turns selected-thread approvals and questions into actionable footer states', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    state.notice = undefined
    state.hostProjection!.approvals = [
      {
        approvalId: 'approval-1',
        commandId: 'command-1',
        threadId: state.selectedThreadId,
        status: 'pending',
        actionKind: 'provider.tool',
        createdAt: now,
        summary: 'Run provider tool'
      }
    ]
    let output = stripAnsi(
      renderTaskWraithTui(state, {
        width: 100,
        height: 24,
        ansi: new Ansi('none'),
        now,
        animationEnabled: false
      })
    )
    expect(output).toContain('APPROVAL · y/n')
    expect(output).toContain('Approval · provider.tool')
    expect(output).toContain('y accept · n decline')

    state.hostProjection!.approvals = []
    state.hostProjection!.questions = [
      {
        questionId: 'question-1',
        threadId: state.selectedThreadId!,
        status: 'open',
        promptPreview: 'Which implementation should I use?',
        askedAt: now
      }
    ]
    output = stripAnsi(
      renderTaskWraithTui(state, {
        width: 100,
        height: 24,
        ansi: new Ansi('none'),
        now,
        animationEnabled: false
      })
    )
    expect(output).toContain('QUESTION · answer below')
    expect(output).toContain('Answer · Which implementation should I use?')
    expect(output).toContain('↵ answer · /dismiss')
  })

  it('keeps the insertion point visible when a one-line prompt exceeds its viewport', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    state.input = 'the beginning is deliberately far away from the live insertion point'
    state.inputCursor = Array.from(state.input).length
    const line = stripAnsi(
      renderTaskWraithTui(state, {
        width: 48,
        height: 24,
        ansi: new Ansi('truecolor'),
        now
      })
        .split('\n')
        .at(-1) ?? ''
    )
    expect(line).toContain('live insertion point▏')
    expect(line).not.toContain('the beginning')
  })

  it('shows preserved bracketed-paste line breaks inside the one-row composer', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    state.input = 'first line\nsecond line'
    state.inputCursor = Array.from(state.input).length
    const line = stripAnsi(
      renderTaskWraithTui(state, {
        width: 64,
        height: 24,
        ansi: new Ansi('truecolor'),
        now
      })
        .split('\n')
        .at(-1) ?? ''
    )
    expect(line).toContain('first line↵second line▏')
    expect(line).not.toContain('\n')
  })

  it('animates only the provider-accented working mark and has a static fallback', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    const frame = (animationFrame: number, animationEnabled: boolean) => {
      state.animationFrame = animationFrame
      return renderTaskWraithTui(state, {
        width: 80,
        height: 24,
        ansi: new Ansi('truecolor'),
        now,
        animationEnabled
      })
    }
    const movingA = frame(0, true)
    const movingB = frame(1, true)
    expect(movingA).not.toBe(movingB)
    expect(stripAnsi(movingA)).toBe(stripAnsi(movingB))
    expect(frame(0, false)).toBe(frame(8, false))
    if (state.thread) state.thread.thread.status = 'complete'
    expect(frame(0, true)).toBe(frame(8, true))
  })

  it('does not transplant desktop-only surface effects into terminal output', () => {
    const output = renderedLines(80, 24).join('\n').toLowerCase()
    for (const forbidden of [
      'glass',
      'blur',
      'refraction',
      'hover',
      'drag-and-drop',
      'modal stack',
      'canvas'
    ]) {
      expect(output).not.toContain(forbidden)
    }
  })

  it('renders an empty-thread identity instead of the no-selection home state when a thread is selected but has no rows', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    if (!state.thread) throw new Error('Demo state is incomplete')
    state.thread.rows = []
    state.thread.thread.status = 'idle'
    state.thread.thread.messageCount = 0
    state.thread.thread.title = 'Empty Idle Thread'

    const output = stripAnsi(
      renderTaskWraithTui(state, {
        width: 80,
        height: 24,
        ansi: new Ansi('none'),
        now,
        animationEnabled: false
      })
    )

    expect(output).not.toContain('No thread selected')
    expect(output).toContain('Empty Idle Thread')
    expect(output).toContain('No messages yet')
  })

  it('strips terminal control bytes from every dynamic presentation label', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    if (!state.thread || !state.snapshot) throw new Error('Demo state is incomplete')
    state.thread.rows[0].speaker = 'You\u001b[2J'
    state.thread.rows[2].tools![0].name = 'Read\u009b2J'
    state.snapshot.workspaces[0].name = 'AGBench\u001b[?25h'
    state.hostProjection!.missions[0].title = 'Mission\u001b[2J'
    state.notice = { text: 'Saved\u001b[H', tone: 'good' }

    const output = renderTaskWraithTui(state, {
      width: 80,
      height: 24,
      ansi: new Ansi('truecolor'),
      now,
      animationEnabled: false
    })

    expect(output).not.toContain('\u001b[2J')
    expect(output).not.toContain('\u001b[?25h')
    expect(output).not.toContain('\u001b[H')
    expect(output).not.toContain('\u009b')
    expect(stripAnsi(output)).toContain('You[2J')
    expect(stripAnsi(output)).toContain('Read2J')
    state.overlay = 'missions'
    const missionOutput = renderTaskWraithTui(state, {
      width: 80,
      height: 24,
      ansi: new Ansi('truecolor'),
      now,
      animationEnabled: false
    })
    expect(missionOutput).not.toContain('\u001b[2J')
    expect(stripAnsi(missionOutput)).toContain('Mission[2J')
  })
})
