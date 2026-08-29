import { describe, expect, it } from 'vitest'
import {
  createEmptyHostSnapshot,
  type HostParticipantProjection,
  type HostThreadGoalProjection
} from '../shared/hostProtocol'
import { Ansi, stripAnsi, visibleWidth } from './ansi'
import {
  GHOST_BANNER_COLUMNS,
  GHOST_BANNER_ROWS,
  ghostBannerArt,
  resolveGhostBanner
} from './ghostBanner'
import { renderTaskWraithTui } from './render'
import {
  createTaskWraithTuiDemoState,
  type TaskWraithTuiState,
  type TuiConnectionState
} from './state'
import { TUI_GLYPHS_ASCII, TUI_GLYPHS_UNICODE } from './theme'

/**
 * The home screen renders when no thread is selected, so it cannot be reached
 * from the demo state (which always carries one).
 */
function homeState(connection: TuiConnectionState): TaskWraithTuiState {
  return {
    connection,
    input: '',
    inputCursor: 0,
    overlay: 'none',
    overlayIndex: 0,
    scrollOffset: 0,
    missionFilter: 'active'
  } as unknown as TaskWraithTuiState
}

function renderedHome(
  width: number,
  height: number,
  connection: TuiConnectionState = 'connecting',
  glyphs = TUI_GLYPHS_UNICODE
): string[] {
  return renderTaskWraithTui(homeState(connection), {
    width,
    height,
    ansi: new Ansi('none'),
    animationEnabled: false,
    glyphs
  }).split('\n')
}

function renderedLines(
  width: number,
  height: number,
  overlay:
    | 'none'
    | 'context'
    | 'threads'
    | 'missions'
    | 'help'
    | 'tune'
    | 'setup'
    | 'git'
    | 'seats' = 'none',
  git?: TaskWraithTuiState['git']
): string[] {
  const now = Date.UTC(2026, 6, 27, 4, 55, 37)
  const state = createTaskWraithTuiDemoState(now)
  state.overlay = overlay
  if (git) {
    state.connection = 'connected'
    state.git = git
  }
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

  it('titles a cancellable /new flow as a new solo thread', () => {
    const state = createTaskWraithTuiDemoState(Date.UTC(2026, 7, 24, 4, 0, 0))
    state.overlay = 'setup'
    state.coldStartIntent = 'new-thread'
    state.coldStart = {
      kind: 'workspace',
      workspaceId: 'demo-workspace'
    }
    state.coldStartProviderChoices = [
      { providerId: 'claude', status: 'ready', label: 'Claude' },
      { providerId: 'kimi', status: 'auth_required', label: 'Kimi' }
    ]
    state.coldStartProviderIndex = 0
    const output = stripAnsi(
      renderTaskWraithTui(state, {
        width: 80,
        height: 24,
        ansi: new Ansi('none'),
        animationEnabled: false
      })
    )
    expect(output).toContain('New solo thread')
    expect(output).toContain('Esc cancels')
    expect(output).toContain('Claude · ready')
    expect(output).toContain('Kimi · auth required')
    expect(output).toContain('Choose a provider')
  })

  it('uses exactly 80x24 with a transcript canvas and two-row solo footer', () => {
    const lines = renderedLines(80, 24)
    expect(lines).toHaveLength(24)
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true)
    expect(lines.join('\n')).toContain('Claude · Opus 4.8 1M · Ultracode')
    expect(lines.join('\n')).toContain('ᜊ Working…  2s · ≈386 tokens')
    expect(lines.join('\n')).not.toContain('ENS')
    expect(lines.join('\n')).not.toMatch(/ENSEMBLE/)
    expect(lines.at(-2)).toContain('AGBench W+1')
    expect(lines.at(-1)?.trimStart()).toMatch(/^› ▏ Ask TaskWraith…/)
  })

  it('keeps the same semantic checksum inside a tall, narrow terminal', () => {
    const lines = renderedLines(64, 30)
    expect(lines).toHaveLength(30)
    expect(lines.every((line) => visibleWidth(line) === 64)).toBe(true)
    expect(lines.join('\n')).not.toContain('ENS')
    expect(lines.at(-2)).toContain('AGBench')
    expect(lines.at(-1)).toContain('↵ send')
  })

  it('moves full workspace and roster detail into one context lens', () => {
    const output = renderedLines(80, 24, 'context').join('\n')
    expect(output).toContain('Context lens')
    expect(output).toContain('PRIMARY  AGBench  [write]')
    expect(output).toContain('SECONDARY  design-system  [write]')
    expect(output).toContain('Claude · Opus 4.8 1M')
    expect(output).not.toContain('fan-out')
    expect(output).not.toContain('Build + Review')
    expect(output).toContain('Esc close · Ctrl+O toggle')
  })

  it('renders live and historical Host missions without ensemble roster chrome', () => {
    const activeLines = renderedLines(80, 24, 'missions')
    expect(activeLines).toHaveLength(24)
    expect(activeLines.every((line) => visibleWidth(line) === 80)).toBe(true)
    const active = activeLines.join('\n')
    expect(active).toContain('Missions · Active')
    expect(active).toContain('LIVE · generation 1 · cursor 7')
    expect(active).toContain('Complete the TaskWraith TUI')
    expect(active).toContain('demo-round · running')
    expect(active).not.toContain('fan-out')
    expect(active).not.toContain('CLA · Lead')
    expect(active).toContain('answered · 11111111-1111-4111-8111-111111111111')
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

  it('renders the model lens for solo threads and Host-projected ensembles', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const solo = createTaskWraithTuiDemoState(now)
    solo.overlay = 'tune'
    solo.tuneEffortIndex = 1
    solo.offers = {
      threadId: solo.thread!.thread.id,
      provider: solo.thread!.thread.provider,
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

    const ensemble = createTaskWraithTuiDemoState(now)
    ensemble.overlay = 'tune'
    ensemble.thread = {
      ...ensemble.thread!,
      thread: {
        ...ensemble.thread!.thread,
        chatKind: 'ensemble',
        ensemble: {
          preset: 'Build + Review',
          mode: 'continuous',
          fanout: 'off',
          continuationHops: 0,
          maxContinuationHops: 32,
          backgroundCount: 0,
          participants: [
            {
              id: 'lead',
              provider: 'claude',
              displayProvider: 'Claude',
              hueKey: 'claude',
              accent: '#d97757',
              shortCode: 'CLD',
              role: 'Lead',
              order: 1,
              stage: 'worker',
              status: 'running',
              active: true,
              next: false,
              enabled: true
            }
          ]
        }
      }
    }
    ensemble.offers = solo.offers
    const ensembleTune = stripAnsi(
      renderTaskWraithTui(ensemble, {
        width: 80,
        height: 24,
        ansi: new Ansi('none'),
        now,
        animationEnabled: false
      })
    )
    expect(ensembleTune).toContain('Model (preview)')
    expect(ensembleTune).not.toContain('Seats (preview)')
  })

  it('shows a staged model selection beside the HUD identity until it is sent', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
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
    state.thread.rows[1].tools![0].name = 'Read\u009b2J'
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

  it('keeps every ghost banner row a column-exact line of printable characters', () => {
    // The home screen centres the banner as a block by centring each row on its
    // own visible width, which is only correct while every row shares a width.
    for (const variant of ['unicode', 'ascii'] as const) {
      const art = ghostBannerArt(variant)
      expect(art).toHaveLength(GHOST_BANNER_ROWS)
      for (const row of art) {
        expect(visibleWidth(row)).toBe(GHOST_BANNER_COLUMNS)
        const control = [...row].filter((character) => {
          const codePoint = character.codePointAt(0) ?? 0
          return codePoint < 32 || codePoint === 127
        })
        expect(control).toEqual([])
      }
    }
  })

  it('draws the Monoline Ghost banner and Host-accurate copy on the home screen', () => {
    const lines = renderedHome(80, 24, 'connecting')
    const output = lines.join('\n')

    expect(lines).toHaveLength(24)
    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true)
    for (const row of ghostBannerArt('unicode')) {
      expect(output).toContain(row.trim())
    }
    expect(output).toContain('TaskWraith')
    expect(output).toContain('Looking for the TaskWraith Host')
    expect(output).toContain('/help commands')
    // The TUI has spawned an ordinary Node Host since the pure-Node cutover.
    expect(output).not.toContain('Electron')
    expect(output).not.toContain('retrying locally')
  })

  it('degrades the ghost banner to pure ASCII without changing its geometry', () => {
    const lines = renderedHome(80, 24, 'offline', TUI_GLYPHS_ASCII)
    const output = lines.join('\n')

    expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true)
    for (const row of ghostBannerArt('ascii')) {
      expect(output).toContain(row.trim())
    }
    expect(output).toContain('Host offline')
    // Nothing Unicode may survive `--ascii` — banner, separators, or status.
    const nonAscii = [...output].filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint !== 10 && (codePoint < 32 || codePoint > 126)
    })
    expect(nonAscii).toEqual([])
  })

  it('falls back to the single ghost mark when the terminal cannot hold the banner', () => {
    const eyes = ghostBannerArt('unicode')[4].trim()

    const narrow = renderedHome(24, 24).join('\n')
    expect(narrow).not.toContain(eyes)
    expect(narrow).toContain(TUI_GLYPHS_UNICODE.ghost)

    const short = renderedHome(80, 12).join('\n')
    expect(short).not.toContain(eyes)
    expect(short).toContain(TUI_GLYPHS_UNICODE.ghost)

    expect(
      resolveGhostBanner({ width: 24, height: 24, variant: 'unicode', markGlyph: 'x' })
    ).toEqual({ kind: 'mark', lines: ['x'], width: 1 })
    expect(
      resolveGhostBanner({ width: 80, height: 24, variant: 'unicode', markGlyph: 'x' }).kind
    ).toBe('full')
  })

  it('names the Host rather than the App while the composer is offline', () => {
    const output = renderedHome(80, 24, 'offline').join('\n')
    expect(output).toContain('Waiting for the TaskWraith Host')
    expect(output).not.toContain('Start TaskWraith to compose')
  })

  it('documents the inline-argument slash commands in the help overlay', () => {
    const lines = renderedLines(80, 24, 'help')
    const output = lines.join('\n')

    for (const entry of [
      '/model <id>',
      '/m',
      '/think <level>',
      '/reasoning',
      '/new',
      '/provider',
      '/status',
      '/clear',
      '/threads',
      '/tune',
      '/missions',
      '/seats',
      '/cancel',
      '/quit'
    ]) {
      expect(output).toContain(entry)
    }
    // The overlay must stay inside the canvas: a clipped bottom border reads as
    // a broken frame, and the two-row footer leaves the least room.
    expect(output).toContain('the TaskWraith Host owns thread state')
    expect(lines.some((line) => line.startsWith('└'))).toBe(true)
    expect(output).not.toContain('Electron')
    expect(output).not.toContain('sidecar')
  })

  it('renders the git overlay status rows, branch and scope tabs within 80 columns', () => {
    const lines = renderedLines(80, 24, 'git', {
      scope: 'status',
      outcome: {
        available: true,
        result: {
          scope: 'status',
          branch: 'main',
          head: '0123456789abcdef0123456789abcdef01234567',
          truncated: false,
          files: [
            {
              path: 'src/tui/render.ts',
              index: 'M',
              workingTree: 'M',
              kind: 'modified',
              staged: false,
              unstaged: true
            },
            {
              path: 'src/tui/new-file.ts',
              index: 'A',
              workingTree: 'A',
              kind: 'created',
              staged: true,
              unstaged: false
            },
            {
              path: 'notes.txt',
              index: '?',
              workingTree: '?',
              kind: 'untracked',
              staged: false,
              unstaged: false
            }
          ]
        }
      }
    })
    const output = lines.join('\n')
    expect(output).toContain('main')
    expect(output).toContain('0123456')
    expect(output).toContain('src/tui/render.ts')
    expect(output).toContain('staged 1')
    expect(output).toContain('untracked 1')
    for (const line of lines) {
      expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(80)
    }
  })

  it('banners a Host-truncated diff plainly and never presents it as complete', () => {
    const lines = renderedLines(80, 24, 'git', {
      scope: 'diff',
      outcome: {
        available: true,
        result: {
          scope: 'diff',
          branch: 'main',
          head: '0123456789abcdef0123456789abcdef01234567',
          truncated: true,
          text: 'diff --git a/big.ts b/big.ts\n@@ -1 +1 @@\n+partial'
        }
      }
    })
    const output = lines.join('\n')
    expect(output).toContain('truncated')
    expect(output).toContain('partial view')
  })

  it('banners a truncated status result too — a partial tree must never read as complete', () => {
    const lines = renderedLines(80, 24, 'git', {
      scope: 'status',
      outcome: {
        available: true,
        result: {
          scope: 'status',
          branch: 'main',
          head: '0123456789abcdef0123456789abcdef01234567',
          truncated: true,
          files: [
            {
              path: 'src/tui/render.ts',
              index: 'M',
              workingTree: 'M',
              kind: 'modified',
              staged: false,
              unstaged: true
            }
          ]
        }
      }
    })
    const output = lines.join('\n')
    expect(output).toContain('truncated')
    expect(output).toContain('partial view')
    expect(output).toContain('src/tui/render.ts')
  })

  it('renders capability-unavailable calmly, and degrades to ASCII without the unicode branch glyph', () => {
    const unavailable = renderedLines(80, 24, 'git', {
      scope: 'status',
      outcome: { available: false, reason: 'capability-unavailable' }
    }).join('\n')
    expect(unavailable).toContain('git is unavailable on this Host')
    expect(unavailable).not.toContain('failed')

    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    state.connection = 'connected'
    state.overlay = 'git'
    state.git = {
      scope: 'status',
      outcome: {
        available: true,
        result: {
          scope: 'status',
          branch: 'main',
          head: '0123456789abcdef0123456789abcdef01234567',
          truncated: false,
          files: []
        }
      }
    }
    const ascii = renderTaskWraithTui(state, {
      width: 80,
      height: 24,
      ansi: new Ansi('none'),
      now,
      animationEnabled: false,
      glyphs: TUI_GLYPHS_ASCII
    })
    expect(ascii).not.toContain(TUI_GLYPHS_UNICODE.gitBranch)
    expect(ascii).toContain(TUI_GLYPHS_ASCII.gitBranch)
  })

  /**
   * The /seats lens rendered from an injected coherent projection. The demo
   * state's providers family carries claude/grok, so provider display names
   * resolve exactly as they do for the live lens.
   */
  function renderedSeatsLens(
    width: number,
    height: number,
    seats: TaskWraithTuiState['seats'],
    options: {
      ascii?: boolean
      chatKind?: 'single' | 'ensemble'
      participants?: HostParticipantProjection[]
    } = {}
  ): string[] {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    state.connection = 'connected'
    state.overlay = 'seats'
    state.selectedThreadId = 'ens-thread'
    const projection = state.hostProjection
    if (!projection) throw new Error('demo state must carry a host projection')
    projection.threads = [
      {
        id: 'ens-thread',
        workspaceId: 'demo-workspace',
        title: 'Ensemble thread',
        chatKind: options.chatKind ?? 'ensemble',
        archived: false,
        pinned: false,
        updatedAt: now,
        messageCount: 3,
        providerId: 'claude'
      }
    ]
    projection.participants = options.participants ?? []
    state.seats = seats
    return renderTaskWraithTui(state, {
      width,
      height,
      ansi: new Ansi('none'),
      now,
      animationEnabled: false,
      glyphs: options.ascii ? TUI_GLYPHS_ASCII : TUI_GLYPHS_UNICODE
    }).split('\n')
  }

  function lensParticipant(
    id: string,
    order: number,
    enabled: boolean,
    overrides: Partial<HostParticipantProjection> = {}
  ): HostParticipantProjection {
    return {
      id,
      threadId: 'ens-thread',
      providerId: order % 2 === 0 ? 'claude' : 'grok',
      role: order % 2 === 0 ? 'Captain' : 'Reviewer',
      order,
      enabled,
      active: false,
      ...overrides
    }
  }

  it('renders the seats lens rows, seat glyphs and the desktop-only label within 80 columns', () => {
    const lines = renderedSeatsLens(
      80,
      24,
      { threadId: 'ens-thread' },
      {
        participants: [
          lensParticipant('p1', 0, true, {
            modelId: 'claude-opus-5',
            stage: 'worker'
          }),
          lensParticipant('p2', 1, false, {
            modelId: 'grok-4.6',
            stage: 'reviewer'
          })
        ]
      }
    )
    const output = lines.join('\n')
    expect(output).toContain('Seats')
    expect(output).toContain('Ensemble thread')
    expect(output).toContain('Captain')
    expect(output).toContain('Claude')
    expect(output).toContain('claude-opus-5')
    expect(output).toContain('worker')
    expect(output).toContain('Grok')
    expect(output).toContain('reviewer')
    expect(output).toContain('enabled')
    expect(output).toContain('disabled')
    expect(output).toContain(TUI_GLYPHS_UNICODE.seatEnabled)
    expect(output).toContain(TUI_GLYPHS_UNICODE.seatDisabled)
    expect(output).toContain('2 seats')
    // Round execution stays desktop-only; the lens says so where a
    // seat-toggling user would look.
    expect(output).toContain('rounds run in the desktop app')
    expect(output).toContain('Enter/Space toggle')
    for (const line of lines) {
      expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(80)
    }
  })

  it('degrades the seats lens to ASCII glyphs and carries no color codes under NO_COLOR', () => {
    const lines = renderedSeatsLens(
      80,
      24,
      { threadId: 'ens-thread' },
      {
        ascii: true,
        participants: [lensParticipant('p1', 0, true), lensParticipant('p2', 1, false)]
      }
    )
    const output = lines.join('\n')
    expect(output).not.toContain(TUI_GLYPHS_UNICODE.seatEnabled)
    expect(output).not.toContain(TUI_GLYPHS_UNICODE.seatDisabled)
    // NO_COLOR: the renderer was given Ansi('none'), so no escape may appear.
    expect(output).not.toContain('')
    // The overlay region (box-bordered lines at column 0) is pure ASCII:
    // every separator and glyph came from the ASCII ladder.
    const overlayLines = lines.filter((line) => line.startsWith('+') || line.startsWith('|'))
    expect(overlayLines.length).toBeGreaterThan(2)
    for (const line of overlayLines) {
      const nonAscii = [...line].filter((character) => {
        const codePoint = character.codePointAt(0) ?? 0
        return codePoint < 32 || codePoint > 126
      })
      expect(nonAscii).toEqual([])
    }
  })

  it('renders capability-unavailable and solo-thread states calmly, never as failures', () => {
    const unavailable = renderedSeatsLens(80, 24, {
      threadId: 'ens-thread',
      unavailable: 'seat control is unavailable on this Host'
    }).join('\n')
    expect(unavailable).toContain('seat control is unavailable on this Host')
    expect(unavailable).toContain('does not advertise the ensemble capability')
    expect(unavailable).not.toContain('failed')

    const solo = renderedSeatsLens(80, 24, { threadId: 'ens-thread' }, { chatKind: 'single' }).join(
      '\n'
    )
    expect(solo).toContain('seats exist on ensemble threads')
    expect(solo).not.toContain('failed')
    expect(solo).not.toContain('rounds run in the desktop app')
  })

  it('renders the Host refusal in the lens, not only as a fading notice', () => {
    const output = renderedSeatsLens(
      80,
      24,
      {
        threadId: 'ens-thread',
        actionError: 'Host refused · an ensemble thread keeps at least one enabled seat'
      },
      { participants: [lensParticipant('p1', 0, true)] }
    ).join('\n')
    expect(output).toContain('at least one enabled seat')
    // A refused seat shows its pre-toggle state: still enabled.
    expect(output).toContain('enabled')
  })

  it('windows a long roster and banners the hidden seats', () => {
    const participants = Array.from({ length: 30 }, (_, index) =>
      lensParticipant(`p${index}`, index, index % 3 !== 0)
    )
    const lines = renderedSeatsLens(80, 24, { threadId: 'ens-thread' }, { participants })
    const output = lines.join('\n')
    expect(output).toContain('more')
    expect(output).toContain('30 seats')
    expect(lines.length).toBeLessThanOrEqual(24)
    for (const line of lines) {
      expect(visibleWidth(stripAnsi(line))).toBeLessThanOrEqual(80)
    }
  })
  it('names the Host, not the App, while the tune lens is fetching offers', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    state.overlay = 'tune'
    state.offersLoading = true
    state.offers = undefined
    const frame = renderTaskWraithTui(state, {
      width: 110,
      height: 34,
      ansi: new Ansi('none'),
      now,
      animationEnabled: false
    })
    // The standalone Node Host serves this catalogue itself — there is no App
    // in the loop, and saying otherwise sends a solo-CLI user hunting for one.
    expect(frame).toContain('Fetching offers from the Host')
    expect(frame).not.toContain('from the App')
  })
  it('marks the workspace new threads will land in inside the /workspace picker', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const state = createTaskWraithTuiDemoState(now)
    state.overlay = 'workspaces'
    state.activeWorkspaceId = 'ws-2'
    state.snapshot = {
      ...state.snapshot!,
      workspaces: [
        { id: 'ws-1', name: 'GUIGemini', path: '/tmp/guigemini', pinned: false, updatedAt: 0 },
        { id: 'ws-2', name: 'AGBench', path: '/tmp/agbench', pinned: true, updatedAt: 0 }
      ]
    }
    const frame = renderTaskWraithTui(state, {
      width: 110,
      height: 34,
      ansi: new Ansi('none'),
      now,
      animationEnabled: false
    })
    // The marker must sit on the PICKED workspace, never the first registered
    // one -- naming the wrong target is the failure this lens exists to prevent.
    const marked = frame.split('\n').find((line) => line.includes('new threads land here'))
    expect(marked).toContain('AGBench')
    expect(marked).not.toContain('GUIGemini')
  })
  it('shows the thread goal read-only and flags a Host-truncated objective', () => {
    const now = Date.UTC(2026, 6, 27, 4, 55, 37)
    const goal: HostThreadGoalProjection = {
      id: 'goal-1',
      objective: 'Ship the standalone goal lens.',
      status: 'blocked',
      mode: 'taskwraith_steered',
      blockedReason: 'waiting on review',
      acceptanceCriteria: ['The TUI shows the objective.'],
      wallMs: 94_440_000,
      activeMs: 94_440_000,
      objectiveTruncated: true
    }
    const state = createTaskWraithTuiDemoState(now)
    state.overlay = 'goal'
    state.selectedThreadId = 'thread-goal'
    state.hostProjection = {
      ...createEmptyHostSnapshot({
        generation: 1,
        cursor: 1,
        freshness: 'live',
        generatedAt: new Date(0).toISOString()
      }),
      threads: [
        {
          id: 'thread-goal',
          workspaceId: null,
          title: 'Goal thread',
          chatKind: 'single',
          archived: false,
          pinned: false,
          updatedAt: 0,
          messageCount: 0,
          goal
        }
      ]
    }
    const frame = renderTaskWraithTui(state, {
      width: 110,
      height: 34,
      ansi: new Ansi('none'),
      now,
      animationEnabled: false
    })
    expect(frame).toContain('Ship the standalone goal lens.')
    expect(frame).toContain('waiting on review')
    expect(frame).toContain('The TUI shows the objective.')
    expect(frame).toContain('Guided by TaskWraith')
    // Ledgers span days, so hours must never roll up into a bare minute count.
    expect(frame).toContain('26h 14m')
    // A clipped objective must never read as the whole objective.
    expect(frame).toContain('truncated by the Host')
    // The App authors goals; the lens must not imply the CLI can steer one.
    expect(frame).toContain('read-only')

    state.hostProjection.threads[0] = { ...state.hostProjection.threads[0], goal: undefined }
    const empty = renderTaskWraithTui(state, {
      width: 110,
      height: 34,
      ansi: new Ansi('none'),
      now,
      animationEnabled: false
    })
    expect(empty).toContain('no durable goal')
    expect(empty).not.toContain('Ship the standalone goal lens.')
  })
})
