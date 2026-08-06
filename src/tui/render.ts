import type {
  TaskWraithControlEnsembleSummary,
  TaskWraithControlModelOffer,
  TaskWraithControlParticipant,
  TaskWraithControlProviderPresentation,
  TaskWraithControlThread,
  TaskWraithControlTranscriptRow
} from '../shared/taskWraithControlProtocol'
import {
  Ansi,
  fitAnsiLine,
  joinLeftRight,
  mixHex,
  padAnsi,
  sanitizeTerminalText,
  truncateAnsi,
  visibleWidth,
  wrapPlainText
} from './ansi'
import type { TaskWraithTuiState } from './state'
import {
  TUI_GLYPHS_UNICODE,
  TUI_LAYOUT,
  TUI_MOTION,
  TUI_TONE,
  resolveTuiDensity,
  tuiStatusGlyph,
  tuiToneHex,
  type TuiGlyphSet,
  type TuiRunStatus,
  type TuiSemanticTone
} from './theme'

export interface TaskWraithTuiRenderOptions {
  width: number
  height: number
  ansi: Ansi
  now?: number
  animationEnabled?: boolean
  /** Glyph vocabulary to draw with. Defaults to the Unicode set. */
  glyphs?: TuiGlyphSet
}

function terminalLabel(value: unknown): string {
  return sanitizeTerminalText(String(value ?? '')).replace(/\n+/g, ' ')
}

function compactLabel(value: string | undefined, fallback = '—'): string {
  const cleaned = terminalLabel(value).trim()
  return cleaned || fallback
}

function permissionLabel(value: string | undefined): string {
  const normalized = terminalLabel(value).trim()
  const known: Record<string, string> = {
    workspace_write: 'Full WS Access',
    read_only: 'Ask',
    full_access: 'Full Access',
    auto_edit: 'Auto Edit',
    plan: 'Plan',
    default: 'Accept Edits'
  }
  return known[normalized.toLowerCase()] ?? compactLabel(normalized)
}

function ensembleModeLabel(value: string): string {
  const normalized = terminalLabel(value).trim().toLowerCase()
  if (normalized === 'continuous') return 'Continuous'
  if (normalized === 'turn-bound' || normalized === 'turn_bound') return 'Turn'
  return compactLabel(normalized)
}

function fanoutLabel(value: string): string {
  const normalized = terminalLabel(value).trim().toLowerCase()
  const known: Record<string, string> = {
    off: 'Off',
    read_only: 'Read-only',
    all: 'All',
    locked_writers_with_boss: 'Locked writers',
    locked_writers_user_preflight: 'Locked writers'
  }
  return known[normalized] ?? compactLabel(normalized)
}

function reasoningLabel(provider: string, value: string | undefined): string {
  const normalized = terminalLabel(value).trim().toLowerCase()
  if (!normalized || normalized === 'off') return ''
  if (provider === 'codex') {
    if (normalized === 'xhigh') return 'Extra High'
    if (normalized === 'low' || normalized === 'light') return 'Light'
    if (normalized === 'ultracode') return 'Ultra'
  }
  if (provider === 'claude') {
    if (normalized === 'xhigh' || normalized === 'extra') return 'Extra'
    if (normalized === 'ultracode') return 'Ultracode'
  }
  if (normalized === 'read_only') return 'Read-only'
  return normalized[0].toUpperCase() + normalized.slice(1)
}

function reasoningLevel(value: string | undefined): number {
  const normalized = String(value || '').toLowerCase()
  if (!normalized || /\b(off|none|disabled)\b/.test(normalized)) return 0
  if (/\b(ultra|ultracode|max|xhigh|extra[\s_-]?high|high)\b/.test(normalized)) return 3
  if (/\b(medium|balanced|standard)\b/.test(normalized)) return 2
  return 1
}

function reasoningLadder(
  value: string | undefined,
  accent: string,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string {
  const level = reasoningLevel(value)
  return [0, 1, 2]
    .map((index) =>
      index < level
        ? ansi.color(glyphs.reasoningOn, mixHex(accent, TUI_TONE.highlight, index * 0.12))
        : ansi.dim(glyphs.reasoningOff)
    )
    .join('')
}

export function formatTuiDuration(milliseconds: number | undefined): string {
  if (!Number.isFinite(milliseconds) || Number(milliseconds) < 0) return '—'
  const seconds = Math.max(0, Math.floor(Number(milliseconds) / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return `${minutes}m ${String(remainder).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

function currentWallTime(thread: TaskWraithControlThread): number | undefined {
  const projected = thread.wallTimeMs
  if (!Number.isFinite(projected)) return undefined
  return Number(projected)
}

function tone(ansi: Ansi, text: string, value: TuiSemanticTone): string {
  const hex = tuiToneHex(value)
  return hex ? ansi.color(text, hex) : text
}

function borderedLine(
  content: string,
  width: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet,
  left = `${glyphs.boxVertical} `,
  right = ` ${glyphs.boxVertical}`
): string {
  const innerWidth = Math.max(1, width - visibleWidth(left) - visibleWidth(right))
  return fitAnsiLine(`${ansi.dim(left)}${padAnsi(content, innerWidth)}${ansi.dim(right)}`, width)
}

function borderTitle(title: string, width: number, ansi: Ansi, glyphs: TuiGlyphSet): string {
  const prefix = `${glyphs.boxTopLeft}${glyphs.boxHorizontal} ${title} `
  return fitAnsiLine(
    `${ansi.dim(prefix)}${ansi.dim(
      glyphs.boxHorizontal.repeat(Math.max(0, width - visibleWidth(prefix) - 1))
    )}${ansi.dim(glyphs.boxTopRight)}`,
    width
  )
}

function borderBottom(width: number, ansi: Ansi, glyphs: TuiGlyphSet): string {
  return fitAnsiLine(
    ansi.dim(
      `${glyphs.boxBottomLeft}${glyphs.boxHorizontal.repeat(Math.max(0, width - 2))}${glyphs.boxBottomRight}`
    ),
    width
  )
}

function transcriptSpeaker(row: TaskWraithControlTranscriptRow, ansi: Ansi): string {
  const speaker = terminalLabel(row.speaker)
  if (row.role === 'user') return ansi.bold(speaker || 'You')
  if (row.provider) return ansi.provider(speaker, row.provider.accent)
  if (row.role === 'error') return ansi.provider(speaker || 'Error', TUI_TONE.error)
  if (row.role === 'tool') return ansi.dim(speaker || 'Tool')
  return ansi.bold(speaker || 'TaskWraith')
}

function renderToolLine(
  tool: NonNullable<TaskWraithControlTranscriptRow['tools']>[number],
  ansi: Ansi,
  width: number,
  glyphs: TuiGlyphSet
): string {
  const glyph =
    tool.status === 'running'
      ? glyphs.toolRunning
      : tool.status === 'error'
        ? glyphs.toolFailed
        : glyphs.toolDone
  const accent =
    tool.status === 'running'
      ? TUI_TONE.warning
      : tool.status === 'error'
        ? TUI_TONE.error
        : TUI_TONE.good
  const delta =
    tool.additions !== undefined || tool.deletions !== undefined
      ? `  +${tool.additions ?? 0} -${tool.deletions ?? 0}`
      : ''
  const detail = tool.detail ? ` ${glyphs.separator} ${terminalLabel(tool.detail)}` : ''
  const gutter = ' '.repeat(TUI_LAYOUT.transcriptDetailGutter)
  return fitAnsiLine(
    `${gutter}${ansi.color(glyph, accent)} ${ansi.dim(`${terminalLabel(tool.name)}${detail}${delta}`)}`,
    width
  )
}

function renderTranscriptRow(
  row: TaskWraithControlTranscriptRow,
  width: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const bodyWidth = Math.max(TUI_LAYOUT.minProseWidth, width - 2)
  const gutter = ' '.repeat(TUI_LAYOUT.transcriptGutter)
  const detailGutter = ' '.repeat(TUI_LAYOUT.transcriptDetailGutter)
  const lines: string[] = [fitAnsiLine(`${gutter}${transcriptSpeaker(row, ansi)}`, width)]
  const bodyTone =
    row.role === 'system' || row.role === 'tool'
      ? (value: string) => ansi.dim(value)
      : row.role === 'error'
        ? (value: string) => ansi.color(value, TUI_TONE.error)
        : (value: string) => value
  for (const line of wrapPlainText(row.text || '', bodyWidth)) {
    lines.push(fitAnsiLine(`${gutter}${bodyTone(line)}`, width))
  }
  if (row.thinking) {
    const status =
      row.thinking.status === 'running' ? glyphs.thinkingRunning : glyphs.thinkingSettled
    lines.push(
      fitAnsiLine(
        `${detailGutter}${ansi.color(status, row.provider?.accent ?? TUI_TONE.ensemble)} ${ansi.dim(
          terminalLabel(row.thinking.title)
        )}`,
        width
      )
    )
  }
  for (const tool of row.tools ?? []) {
    lines.push(renderToolLine(tool, ansi, width, glyphs))
  }
  lines.push('')
  return lines
}

function activeParticipant(
  ensemble: TaskWraithControlEnsembleSummary | undefined
): TaskWraithControlParticipant | undefined {
  return ensemble?.participants.find((participant) => participant.active)
}

function workingPresentation(thread: TaskWraithControlThread): {
  provider: TaskWraithControlProviderPresentation
  role?: string
  model?: string
  reasoning?: string
} {
  const participant = activeParticipant(thread.ensemble)
  if (!participant) {
    return {
      provider: thread.provider,
      model: thread.provider.modelLabel ?? thread.provider.model,
      reasoning: thread.reasoning
    }
  }
  return {
    provider: {
      runtimeProvider: participant.provider,
      displayProvider: participant.displayProvider,
      hueKey: participant.hueKey,
      accent: participant.accent,
      shortCode: participant.shortCode,
      ...(participant.model ? { model: participant.model, modelLabel: participant.model } : {})
    },
    role: participant.role,
    model: participant.model,
    reasoning: participant.reasoning
  }
}

function shimmerWorking(
  text: string,
  accent: string,
  ansi: Ansi,
  frame: number,
  enabled: boolean
): string {
  if (!ansi.enabled || !enabled) return ansi.provider(text, accent)
  const characters = Array.from(text)
  const loopLength = characters.length + TUI_MOTION.shimmerTailPadding
  return characters
    .map((character, index) => {
      const distance = Math.abs((((index - frame) % loopLength) + loopLength) % loopLength)
      const amount =
        distance <= 1
          ? TUI_MOTION.shimmerPeak
          : distance === TUI_MOTION.shimmerFalloff
            ? TUI_MOTION.shimmerMid
            : 0
      return ansi.color(character, mixHex(accent, TUI_TONE.highlight, amount))
    })
    .join('')
}

function renderWorkingBlock(
  thread: TaskWraithControlThread,
  width: number,
  ansi: Ansi,
  animationFrame: number,
  animationEnabled: boolean,
  glyphs: TuiGlyphSet
): string[] {
  if (thread.status !== 'working') return []
  const current = workingPresentation(thread)
  const identity = [
    current.provider.displayProvider,
    current.role,
    current.model ?? current.provider.modelLabel,
    reasoningLabel(current.provider.runtimeProvider, current.reasoning)
  ]
    .map(terminalLabel)
    .filter(Boolean)
  const wallTime = formatTuiDuration(currentWallTime(thread))
  const tokens =
    thread.tokenEstimate !== undefined
      ? `≈${Math.max(0, Math.round(thread.tokenEstimate)).toLocaleString('en-GB')} tokens`
      : undefined
  const status = shimmerWorking(
    `${glyphs.ghost} Working${glyphs.ellipsis}`,
    current.provider.accent,
    ansi,
    animationFrame,
    animationEnabled
  )
  return [
    fitAnsiLine(` ${ansi.provider(identity.join(' · '), current.provider.accent)}`, width),
    fitAnsiLine(
      `  ${status}${ansi.dim(`  ${[wallTime, tokens].filter(Boolean).join(' · ')}`)}`,
      width
    ),
    ''
  ]
}

function renderHome(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const lines = Array.from({ length: Math.max(1, height) }, () => '')
  const center = Math.max(1, Math.floor(width / 2))
  const start = Math.max(0, Math.floor(height / 2) - 5)
  const place = (row: number, text: string, offset = 0) => {
    if (row < 0 || row >= lines.length) return
    const left = Math.max(0, center - Math.floor(visibleWidth(text) / 2) + offset)
    lines[row] = fitAnsiLine(`${' '.repeat(left)}${text}`, width)
  }
  place(start, ansi.dim(`${glyphs.separator}                 ${glyphs.star}`), -5)
  place(start + 1, ansi.dim(`       ${glyphs.separator}`))
  place(start + 3, ansi.provider(glyphs.ghost, TUI_TONE.ensemble))
  place(start + 5, ansi.bold('TaskWraith'))
  const status =
    state.connection === 'connecting'
      ? 'Looking for the Electron host…'
      : state.connection === 'reconnecting'
        ? 'Reconnecting to the TaskWraith host…'
        : state.connection === 'offline'
          ? 'Electron host offline · retrying locally'
          : state.connection === 'incompatible-protocol'
            ? 'Open TaskWraith to update the App · protocol mismatch'
            : 'No thread selected'
  place(start + 6, ansi.dim(status))
  place(start + 8, ansi.dim('Ctrl+K threads · Ctrl+P commands'))
  return lines
}

function renderEmptyThread(
  thread: TaskWraithControlThread,
  width: number,
  height: number,
  ansi: Ansi
): string[] {
  const lines = Array.from({ length: Math.max(1, height) }, () => '')
  const center = Math.max(1, Math.floor(width / 2))
  const start = Math.max(0, Math.floor(height / 2) - 3)
  const place = (row: number, text: string, offset = 0) => {
    if (row < 0 || row >= lines.length) return
    const left = Math.max(0, center - Math.floor(visibleWidth(text) / 2) + offset)
    lines[row] = fitAnsiLine(`${' '.repeat(left)}${text}`, width)
  }
  const kindLabel = thread.chatKind === 'ensemble' ? 'Ensemble' : 'Chat'
  const identity = [terminalLabel(thread.title) || kindLabel, thread.provider.displayProvider]
    .map(terminalLabel)
    .filter(Boolean)
    .join(' · ')
  place(start, ansi.provider(identity, thread.provider.accent))
  place(start + 2, ansi.dim('No messages yet'))
  place(start + 4, ansi.dim('Ctrl+K threads · Ctrl+P commands'))
  return lines
}

function renderTranscriptCanvas(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  animationEnabled: boolean,
  glyphs: TuiGlyphSet
): string[] {
  const snapshot = state.thread
  if (!snapshot) return renderHome(state, width, height, ansi, glyphs)
  const allLines = snapshot.rows.flatMap((row) => renderTranscriptRow(row, width, ansi, glyphs))
  allLines.push(
    ...renderWorkingBlock(
      snapshot.thread,
      width,
      ansi,
      state.animationFrame,
      animationEnabled,
      glyphs
    )
  )
  if (!allLines.length) return renderEmptyThread(snapshot.thread, width, height, ansi)
  const offset = Math.max(0, state.scrollOffset)
  const end = Math.max(0, allLines.length - offset)
  const start = Math.max(0, end - height)
  const visible = allLines.slice(start, end)
  const topPad = Math.max(0, height - visible.length)
  return [...Array.from({ length: topPad }, () => ''), ...visible]
}

function overlayValue(
  label: string,
  value: string,
  width: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet,
  valueAccent?: string
): string {
  const labelWidth = resolveTuiDensity(width).overlayLabelWidth
  const left = ansi.dim(label.padEnd(labelWidth))
  const right = valueAccent ? ansi.color(value, valueAccent) : value
  return borderedLine(`${left}${right}`, width, ansi, glyphs)
}

function renderContextOverlay(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const context = state.thread?.context
  const thread = state.thread?.thread
  if (!context || !thread) {
    return [
      borderTitle('Context lens', width, ansi, glyphs),
      borderedLine(ansi.dim('No thread context is available.'), width, ansi, glyphs),
      borderBottom(width, ansi, glyphs)
    ]
  }
  const lines: string[] = [borderTitle('Context lens', width, ansi, glyphs)]
  const workspaces = context.workspaces
  if (!workspaces.length) {
    lines.push(overlayValue('workspace', 'Global scope', width, ansi, glyphs))
  } else {
    workspaces.forEach((workspace, index) => {
      const tier = workspace.primary ? 'PRIMARY' : 'SECONDARY'
      const value = `${tier}  ${terminalLabel(workspace.name)}  [${workspace.access}]`
      lines.push(overlayValue(index ? '' : 'workspace', value, width, ansi, glyphs))
    })
  }
  const provider = context.provider
  const providerValue = [provider.displayProvider, provider.modelLabel ?? provider.model]
    .map(terminalLabel)
    .filter(Boolean)
    .join(' · ')
  lines.push(overlayValue('provider', providerValue, width, ansi, glyphs, provider.accent))
  const reasoning = compactLabel(reasoningLabel(provider.runtimeProvider, context.reasoning))
  lines.push(
    overlayValue(
      'reasoning',
      `${reasoningLadder(context.reasoning, provider.accent, ansi, glyphs)} ${reasoning}`,
      width,
      ansi,
      glyphs
    )
  )
  lines.push(overlayValue('permission', permissionLabel(context.permission), width, ansi, glyphs))
  lines.push(
    overlayValue(
      'run',
      [
        formatTuiDuration(currentWallTime(thread)),
        context.tokenEstimate !== undefined
          ? `≈${context.tokenEstimate.toLocaleString('en-GB')} tokens`
          : undefined,
        terminalLabel(context.costText)
      ]
        .filter(Boolean)
        .join(' · '),
      width,
      ansi,
      glyphs
    )
  )
  if (context.ensemble) {
    const ensemble = context.ensemble
    lines.push(
      overlayValue(
        'roster',
        `${terminalLabel(ensemble.preset)} · ${ensembleModeLabel(
          ensemble.mode
        )} · fan-out ${fanoutLabel(ensemble.fanout)} · ${ensemble.continuationHops}/${ensemble.maxContinuationHops}`,
        width,
        ansi,
        glyphs,
        TUI_TONE.ensemble
      )
    )
    const room = Math.max(0, height - lines.length - 3)
    const participants = ensemble.participants.slice(0, room)
    participants.forEach((participant, index) => {
      const status: TuiRunStatus = participant.active
        ? 'working'
        : participant.next
          ? 'next'
          : 'idle'
      const marker = participant.enabled ? tuiStatusGlyph(status, glyphs) : glyphs.seatDisabled
      const suffix = participant.stage === 'background' ? ' · BG' : ''
      const identity = `${index + 1} ${marker} ${terminalLabel(
        participant.displayProvider
      )} · ${terminalLabel(participant.role)}${
        participant.model ? ` · ${terminalLabel(participant.model)}` : ''
      }${suffix}`
      lines.push(
        participant.enabled
          ? overlayValue(index ? '' : 'cast', identity, width, ansi, glyphs, participant.accent)
          : overlayValue(index ? '' : 'cast', ansi.dim(identity), width, ansi, glyphs)
      )
    })
    if (participants.length < ensemble.participants.length) {
      lines.push(
        overlayValue(
          '',
          `+${ensemble.participants.length - participants.length} more participants`,
          width,
          ansi,
          glyphs
        )
      )
    }
  }
  lines.push(borderedLine(ansi.dim('Esc close · Ctrl+O toggle'), width, ansi, glyphs))
  lines.push(borderBottom(width, ansi, glyphs))
  return lines.slice(0, Math.max(1, height))
}

function threadRunStatus(thread: TaskWraithControlThread): TuiRunStatus {
  if (thread.status === 'working') return 'working'
  if (thread.status === 'needs-input') return 'needs-input'
  if (thread.status === 'failed') return 'failed'
  if (thread.status === 'queued') return 'queued'
  return 'idle'
}

function threadStatusMark(thread: TaskWraithControlThread, glyphs: TuiGlyphSet): string {
  return tuiStatusGlyph(threadRunStatus(thread), glyphs)
}

function renderThreadsOverlay(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const threads = (state.snapshot?.threads ?? []).filter((thread) => !thread.archived)
  const lines = [borderTitle('Threads', width, ansi, glyphs)]
  const capacity = Math.max(1, height - 3)
  if (!threads.length) {
    lines.push(borderedLine(ansi.dim('No active threads.'), width, ansi, glyphs))
  } else {
    const safeIndex = Math.max(0, Math.min(state.overlayIndex, threads.length - 1))
    const windowStart = Math.max(0, safeIndex - Math.floor(capacity / 2))
    for (
      let index = windowStart;
      index < Math.min(threads.length, windowStart + capacity);
      index += 1
    ) {
      const thread = threads[index]
      const selected = index === safeIndex
      const marker = threadStatusMark(thread, glyphs)
      const provider = ansi.provider(
        terminalLabel(thread.provider.shortCode),
        thread.provider.accent
      )
      const title = truncateAnsi(terminalLabel(thread.title), Math.max(8, width - 30))
      const workspace =
        state.snapshot?.workspaces.find((candidate) => candidate.id === thread.workspaceId)?.name ??
        'Global'
      const line = `${selected ? glyphs.selection : ' '} ${marker} ${provider}  ${title}  ${ansi.dim(
        terminalLabel(workspace)
      )}`
      lines.push(borderedLine(selected ? ansi.inverse(line) : line, width, ansi, glyphs))
    }
  }
  lines.push(borderedLine(ansi.dim('↑↓ choose · Enter open · Esc close'), width, ansi, glyphs))
  lines.push(borderBottom(width, ansi, glyphs))
  return lines.slice(0, Math.max(1, height))
}

function renderHelpOverlay(
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const lines = [
    borderTitle('Commands', width, ansi, glyphs),
    overlayValue('Ctrl+O', 'context lens', width, ansi, glyphs),
    overlayValue('Ctrl+K', 'thread picker', width, ansi, glyphs),
    overlayValue('Ctrl+G', 'tune lens — model/reasoning or seats', width, ansi, glyphs),
    overlayValue('Ctrl+P', 'commands', width, ansi, glyphs),
    overlayValue('PgUp/PgDn', 'scroll transcript', width, ansi, glyphs),
    overlayValue('Enter', 'send prompt / choose item', width, ansi, glyphs),
    overlayValue('Ctrl+C', 'clear input, then quit', width, ansi, glyphs),
    overlayValue('/model', 'stage a model/reasoning switch (solo)', width, ansi, glyphs),
    overlayValue('/seats', 'enable or disable ensemble seats', width, ansi, glyphs),
    overlayValue('/cancel', 'request cancellation of the active run', width, ansi, glyphs),
    overlayValue('/quit', 'leave the sidecar; the host keeps running', width, ansi, glyphs),
    borderedLine(
      ansi.dim('Esc close · state is still governed by Electron main'),
      width,
      ansi,
      glyphs
    ),
    borderBottom(width, ansi, glyphs)
  ]
  return lines.slice(0, Math.max(1, height))
}

function tuneModelSuffix(offer: TaskWraithControlModelOffer, ansi: Ansi): string {
  const notes: string[] = []
  if (offer.current) notes.push('current')
  if (offer.isDefault) notes.push('default')
  if (offer.retiresAt) notes.push(`retires ${offer.retiresAt}`)
  if (offer.disabled) notes.push(offer.disabledReason || 'unavailable')
  return notes.length ? ` ${ansi.dim(`(${notes.join(' · ')})`)}` : ''
}

function renderTuneOverlay(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const thread = state.thread?.thread
  if (!thread) {
    return [
      borderTitle('Tune lens', width, ansi, glyphs),
      borderedLine(ansi.dim('Open a thread before tuning.'), width, ansi, glyphs),
      borderBottom(width, ansi, glyphs)
    ]
  }
  if (thread.ensemble) {
    const seats = thread.ensemble.participants
    const lines = [borderTitle('Seats (preview)', width, ansi, glyphs)]
    if (!seats.length) {
      lines.push(borderedLine(ansi.dim('This ensemble has no seats.'), width, ansi, glyphs))
    } else {
      const capacity = Math.max(1, height - 3)
      const safeIndex = Math.max(0, Math.min(state.overlayIndex, seats.length - 1))
      const windowStart = Math.max(0, safeIndex - Math.floor(capacity / 2))
      for (
        let index = windowStart;
        index < Math.min(seats.length, windowStart + capacity);
        index += 1
      ) {
        const seat = seats[index]
        const selected = index === safeIndex
        const mark = seat.enabled ? glyphs.seatEnabled : glyphs.seatDisabled
        const identity = `${terminalLabel(seat.displayProvider)} · ${terminalLabel(seat.role)}${
          seat.model ? ` · ${terminalLabel(seat.model)}` : ''
        }${seat.stage === 'background' ? ' · BG' : ''}`
        const body = seat.enabled
          ? `${ansi.color(mark, seat.accent)} ${ansi.provider(identity, seat.accent)}`
          : ansi.dim(`${mark} ${identity}`)
        const line = `${selected ? glyphs.selection : ' '} ${body}`
        lines.push(borderedLine(selected ? ansi.inverse(line) : line, width, ansi, glyphs))
      }
    }
    lines.push(
      borderedLine(
        ansi.dim('↑↓ seat · Enter toggle · applies immediately · Esc close'),
        width,
        ansi,
        glyphs
      )
    )
    lines.push(borderBottom(width, ansi, glyphs))
    return lines.slice(0, Math.max(1, height))
  }
  const offers = state.offers
  const lines = [borderTitle('Model (preview)', width, ansi, glyphs)]
  if (state.offersLoading) {
    lines.push(borderedLine(ansi.dim('Fetching offers from the App…'), width, ansi, glyphs))
  } else if (!offers) {
    lines.push(borderedLine(ansi.dim('No model offers are available.'), width, ansi, glyphs))
  } else if (offers.locked) {
    lines.push(borderedLine(ansi.dim(terminalLabel(offers.locked)), width, ansi, glyphs))
  } else {
    lines.push(
      overlayValue(
        'provider',
        terminalLabel(offers.provider.displayProvider),
        width,
        ansi,
        glyphs,
        offers.provider.accent
      )
    )
    const models = offers.models
    const capacity = Math.max(1, height - 5)
    const safeIndex = Math.max(0, Math.min(state.overlayIndex, models.length - 1))
    const windowStart = Math.max(0, safeIndex - Math.floor(capacity / 2))
    for (
      let index = windowStart;
      index < Math.min(models.length, windowStart + capacity);
      index += 1
    ) {
      const offer = models[index]
      const selected = index === safeIndex
      const label = terminalLabel(offer.label ?? offer.id)
      const body = offer.disabled
        ? ansi.dim(label)
        : ansi.provider(label, offers.provider.accent, Boolean(offer.current))
      const line = `${selected ? glyphs.selection : ' '} ${body}${tuneModelSuffix(offer, ansi)}`
      lines.push(borderedLine(selected ? ansi.inverse(line) : line, width, ansi, glyphs))
    }
    const ladder = models[safeIndex]?.reasoningEfforts ?? []
    if (ladder.length) {
      const effortIndex = Math.max(0, Math.min(state.tuneEffortIndex, ladder.length - 1))
      const efforts = ladder
        .map((effort, index) => {
          const label = terminalLabel(effort.id)
          if (effort.disabled) return ansi.dim(label)
          return index === effortIndex
            ? ansi.provider(`[${label}]`, offers.provider.accent, true)
            : label
        })
        .join(` ${ansi.dim(glyphs.separator)} `)
      lines.push(overlayValue('reasoning', efforts, width, ansi, glyphs))
    }
  }
  lines.push(
    borderedLine(
      ansi.dim('↑↓ model · ←→ reasoning · Enter apply on next send · Esc close'),
      width,
      ansi,
      glyphs
    )
  )
  lines.push(borderBottom(width, ansi, glyphs))
  return lines.slice(0, Math.max(1, height))
}

function renderOverlay(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  if (state.overlay === 'context') {
    return renderContextOverlay(state, width, height, ansi, glyphs)
  }
  if (state.overlay === 'threads') {
    return renderThreadsOverlay(state, width, height, ansi, glyphs)
  }
  if (state.overlay === 'tune') {
    return renderTuneOverlay(state, width, height, ansi, glyphs)
  }
  return renderHelpOverlay(width, height, ansi, glyphs)
}

function participantRunStatus(participant: TaskWraithControlParticipant): TuiRunStatus {
  if (participant.active) return 'working'
  if (participant.next) return 'next'
  const completed = ['answered', 'yielded', 'completed', 'success'].includes(
    participant.status || ''
  )
  if (completed) return 'done'
  const failed = ['failed', 'unreachable', 'cancelled'].includes(participant.status || '')
  if (failed) return 'failed'
  if (participant.status === 'skipped') return 'skipped'
  if (participant.status === 'sleeping') return 'sleeping'
  return 'idle'
}

function participantToken(
  participant: TaskWraithControlParticipant,
  ansi: Ansi,
  width: number,
  glyphs: TuiGlyphSet
): string {
  const marker = tuiStatusGlyph(participantRunStatus(participant), glyphs)
  const density = resolveTuiDensity(width)
  // Compact baton shows short codes only; normal/expanded include role.
  // (Was width>=100 and width>=72 with identical arms — density collapses that.)
  const identity = density.providerFullName
    ? `${terminalLabel(participant.shortCode)} ${terminalLabel(participant.role)}`
    : terminalLabel(participant.shortCode)
  const suffix = participant.stage === 'background' ? ' BG' : ''
  return `${ansi.color(marker, participant.accent)} ${ansi.provider(identity, participant.accent, participant.active)}${ansi.dim(suffix)}`
}

function renderEnsembleBaton(
  ensemble: TaskWraithControlEnsembleSummary,
  width: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string {
  const density = resolveTuiDensity(width)
  const participants = ensemble.participants.filter((participant) => participant.enabled)
  const active = participants.find((participant) => participant.active)
  const next = participants.find((participant) => participant.next)
  if (density.tier === 'compact') {
    const visible = [active, next].filter(
      (participant, index, list): participant is TaskWraithControlParticipant =>
        Boolean(participant) && list.indexOf(participant) === index
    )
    const hidden = Math.max(0, participants.length - visible.length)
    const right = `${visible
      .map((participant) => participantToken(participant, ansi, width, glyphs))
      .join(ansi.dim(` ${glyphs.selection} `))}${hidden ? ansi.dim(` +${hidden}`) : ''}`
    return joinLeftRight(ansi.provider('ENS', TUI_TONE.ensemble), right, width)
  }
  const roomForCast = density.batonCastSlots
  const cast = participants.slice(0, roomForCast)
  if (active && !cast.includes(active)) cast[cast.length - 1] = active
  if (next && !cast.includes(next) && cast.length > 1) cast[cast.length - 1] = next
  const unique = cast.filter(
    (participant, index) => cast.findIndex((candidate) => candidate.id === participant.id) === index
  )
  const hidden = Math.max(0, participants.length - unique.length)
  const left = density.batonExpandedLabel
    ? `${ansi.provider('ENSEMBLE', TUI_TONE.ensemble)} ${terminalLabel(
        ensemble.preset
      )} · ${ensembleModeLabel(ensemble.mode)}`
    : `${ansi.provider('ENS', TUI_TONE.ensemble)} ${terminalLabel(ensemble.preset)}`
  const right = `${unique.map((participant) => participantToken(participant, ansi, width, glyphs)).join(ansi.dim(`  ${glyphs.selection}  `))}${hidden ? ansi.dim(`  +${hidden}`) : ''} ${ansi.dim(`${ensemble.continuationHops}/${ensemble.maxContinuationHops}`)}`
  return joinLeftRight(left, right, width)
}

function renderHud(
  state: TaskWraithTuiState,
  thread: TaskWraithControlThread | undefined,
  width: number,
  ansi: Ansi,
  now: number,
  glyphs: TuiGlyphSet
): string {
  const density = resolveTuiDensity(width)
  if (!thread) {
    const connection =
      state.connection === 'connecting'
        ? tone(ansi, 'CONNECTING', 'warning')
        : state.connection === 'reconnecting'
          ? tone(ansi, 'RECONNECTING', 'warning')
          : state.connection === 'offline'
            ? tone(ansi, 'OFFLINE', 'error')
            : state.connection === 'incompatible-protocol'
              ? tone(ansi, 'Open TaskWraith to update the App', 'error')
              : tone(ansi, state.connection.toUpperCase(), 'neutral')
    // Wave 4.2b: deferred thread.select has no thread yet — still show the Host ask.
    if (state.notice && (!state.notice.expiresAt || state.notice.expiresAt > now)) {
      return joinLeftRight(
        ansi.bold('TaskWraith'),
        tone(ansi, terminalLabel(state.notice.text), state.notice.tone),
        width
      )
    }
    return joinLeftRight(ansi.bold('TaskWraith'), connection, width)
  }
  const workspace =
    state.snapshot?.workspaces.find((candidate) => candidate.id === thread.workspaceId)?.name ??
    'Global'
  const grantCount = Math.max(0, (state.thread?.context.workspaces.length ?? 0) - 1)
  const access = state.thread?.context.workspaces[0]?.access === 'write' ? 'W' : 'R'
  const left = density.hudModel
    ? `${ansi.bold(terminalLabel(workspace))} ${ansi.dim(
        `${access}${grantCount ? `+${grantCount}` : ''}`
      )}`
    : ansi.bold(truncateAnsi(terminalLabel(workspace), 18))
  if (state.notice && (!state.notice.expiresAt || state.notice.expiresAt > now)) {
    return joinLeftRight(
      left,
      tone(ansi, terminalLabel(state.notice.text), state.notice.tone),
      width
    )
  }
  const presentation = workingPresentation(thread)
  const provider = density.providerFullName
    ? terminalLabel(presentation.provider.displayProvider)
    : terminalLabel(presentation.provider.shortCode)
  const model = density.hudModel
    ? terminalLabel(presentation.model ?? presentation.provider.modelLabel)
    : undefined
  const rawReasoning = presentation.reasoning ?? thread.reasoning
  const reasoning = reasoningLabel(presentation.provider.runtimeProvider, rawReasoning)
  const reasoningText = reasoning
    ? `${
        density.reasoningLadder
          ? reasoningLadder(rawReasoning, presentation.provider.accent, ansi, glyphs)
          : ansi.color(glyphs.reasoningOn, presentation.provider.accent)
      } ${reasoning}`
    : ''
  const elapsed = formatTuiDuration(currentWallTime(thread))
  const status =
    thread.status === 'needs-input'
      ? tone(ansi, 'Open TaskWraith to answer', 'warning')
      : thread.status === 'failed'
        ? tone(ansi, 'FAILED', 'error')
        : thread.status === 'queued'
          ? ansi.dim('QUEUED')
          : ''
  // A staged model/reasoning choice rides the next send; wear the provider
  // accent because it names the identity the next turn will run as.
  const pending =
    state.pendingSelection && !thread.ensemble
      ? ansi.color(
          `${glyphs.pendingChange} ${terminalLabel(
            state.pendingSelection.label ?? state.pendingSelection.model
          )}${
            state.pendingSelection.reasoningEffort
              ? ` ${terminalLabel(state.pendingSelection.reasoningEffort)}`
              : ''
          }`,
          presentation.provider.accent
        )
      : undefined
  const cost = terminalLabel(thread.costText)
  const right = [
    ansi.provider(provider, presentation.provider.accent),
    model,
    pending,
    reasoningText,
    status,
    elapsed !== '—' ? elapsed : undefined,
    cost
  ]
    .filter(Boolean)
    .join(ansi.dim(density.segmentSpacing === 'padded' ? ` ${glyphs.separator} ` : ' '))
  return joinLeftRight(left, right, width)
}

function renderComposer(
  state: TaskWraithTuiState,
  width: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string {
  const accent = state.thread?.thread.provider.accent ?? TUI_TONE.ensemble
  const prompt = ansi.provider(glyphs.promptCaret, accent)
  const density = resolveTuiDensity(width)
  // Glyph-set aware: ↵/· on Unicode, \/. on ASCII so chrome never mojibakes.
  const sep = ` ${glyphs.separator} `
  const right =
    density.composerHints === 'full'
      ? ansi.dim(`${glyphs.newline} send${sep}^O context${sep}^K threads`)
      : density.composerHints === 'short'
        ? ansi.dim(`${glyphs.newline} send${sep}^O context`)
        : ansi.dim(`${glyphs.newline} send`)
  const leftAvailable = Math.max(1, width - visibleWidth(right) - 1)
  const inputAvailable = Math.max(1, leftAvailable - visibleWidth(prompt) - 1)
  const input = state.input
    ? renderComposerInput(state.input, state.inputCursor, inputAvailable, ansi, accent, glyphs)
    : `${ansi.color(glyphs.cursor, accent)} ${ansi.dim(
        state.connection === 'offline' ? 'Start TaskWraith to compose' : 'Ask TaskWraith…'
      )}`
  return joinLeftRight(`${prompt} ${input}`, right, width)
}

function renderComposerInput(
  value: string,
  cursor: number,
  width: number,
  ansi: Ansi,
  accent: string,
  glyphs: TuiGlyphSet
): string {
  const characters = Array.from(sanitizeTerminalText(value)).map((character) =>
    character === '\n' ? glyphs.newline : character
  )
  const safeCursor = Math.max(0, Math.min(characters.length, cursor))
  if (width <= 1) return ansi.color(glyphs.cursor, accent)
  const textBudget = width - 1
  let start = Math.max(0, safeCursor - Math.floor(textBudget * 0.7))
  const end = Math.min(characters.length, start + textBudget)
  start = Math.max(0, Math.min(start, end - textBudget))
  const visible = characters.slice(start, end)
  if (start > 0 && visible.length) visible[0] = glyphs.ellipsis
  if (end < characters.length && visible.length) {
    visible[visible.length - 1] = glyphs.ellipsis
  }
  const localCursor = Math.max(0, Math.min(visible.length, safeCursor - start))
  return `${visible.slice(0, localCursor).join('')}${ansi.color(
    glyphs.cursor,
    accent
  )}${visible.slice(localCursor).join('')}`
}

export function renderTaskWraithTui(
  state: TaskWraithTuiState,
  options: TaskWraithTuiRenderOptions
): string {
  const width = Math.max(24, Math.floor(options.width))
  const height = Math.max(8, Math.floor(options.height))
  const now = options.now ?? Date.now()
  const animationEnabled = options.animationEnabled !== false
  const glyphs = options.glyphs ?? TUI_GLYPHS_UNICODE
  const thread = state.thread?.thread
  const footerRows = thread?.ensemble ? TUI_LAYOUT.ensembleFooterRows : TUI_LAYOUT.soloFooterRows
  const canvasHeight = Math.max(1, height - footerRows)
  let canvas =
    state.overlay === 'none'
      ? renderTranscriptCanvas(state, width, canvasHeight, options.ansi, animationEnabled, glyphs)
      : renderOverlay(state, width, canvasHeight, options.ansi, glyphs)
  if (canvas.length > canvasHeight) canvas = canvas.slice(0, canvasHeight)
  if (canvas.length < canvasHeight) {
    canvas = [...canvas, ...Array.from({ length: canvasHeight - canvas.length }, () => '')]
  }
  const footer: string[] = []
  if (thread?.ensemble) {
    footer.push(renderEnsembleBaton(thread.ensemble, width, options.ansi, glyphs))
  }
  footer.push(renderHud(state, thread, width, options.ansi, now, glyphs))
  footer.push(renderComposer(state, width, options.ansi, glyphs))
  const lines = [...canvas, ...footer].slice(0, height)
  while (lines.length < height) lines.push('')
  return lines.map((line) => fitAnsiLine(line, width)).join('\n')
}
