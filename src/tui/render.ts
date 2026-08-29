import type {
  TaskWraithControlModelOffer,
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
import { resolveGhostBanner } from './ghostBanner'
import { tuiSeatsRoster, type TaskWraithTuiState } from './state'
import {
  TUI_GLYPHS_UNICODE,
  TUI_LAYOUT,
  TUI_MOTION,
  TUI_TONE,
  resolveTuiDensity,
  tuiGlyphsAreUnicode,
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

function selectedPendingApproval(state: TaskWraithTuiState) {
  const threadId = state.selectedThreadId
  if (!threadId) return undefined
  return [...(state.hostProjection?.approvals ?? [])]
    .filter((approval) => approval.status === 'pending' && approval.threadId === threadId)
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.approvalId.localeCompare(right.approvalId)
    )[0]
}

function selectedOpenQuestion(state: TaskWraithTuiState) {
  const threadId = state.selectedThreadId
  if (!threadId) return undefined
  return [...(state.hostProjection?.questions ?? [])]
    .filter((question) => question.status === 'open' && question.threadId === threadId)
    .sort(
      (left, right) =>
        left.askedAt - right.askedAt || left.questionId.localeCompare(right.questionId)
    )[0]
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

function workingPresentation(thread: TaskWraithControlThread): {
  provider: TaskWraithControlProviderPresentation
  model?: string
  reasoning?: string
} {
  return {
    provider: thread.provider,
    model: thread.provider.modelLabel ?? thread.provider.model,
    reasoning: thread.reasoning
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

/**
 * Home-screen connection copy.
 *
 * Every string here names the *Host* rather than Electron: the TUI has spawned
 * an ordinary Node `taskwraith-host` since the pure-Node cutover, and the App
 * need never be running. Separator and ellipsis come from the glyph set so the
 * line degrades with the rest of the chrome under `--ascii`.
 */
function homeConnectionStatus(state: TaskWraithTuiState, glyphs: TuiGlyphSet): string {
  const sep = ` ${glyphs.separator} `
  if (state.connection === 'connecting') return `Looking for the TaskWraith Host${glyphs.ellipsis}`
  if (state.connection === 'reconnecting') {
    return `Reconnecting to the TaskWraith Host${glyphs.ellipsis}`
  }
  if (state.connection === 'offline') return `Host offline${sep}retrying`
  if (state.connection === 'incompatible-protocol') {
    return `Host protocol mismatch${sep}update TaskWraith`
  }
  return 'No thread selected'
}

function renderHome(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const canvasHeight = Math.max(1, height)
  const lines = Array.from({ length: canvasHeight }, () => '')
  const center = Math.max(1, Math.floor(width / 2))
  const place = (row: number, text: string) => {
    if (row < 0 || row >= lines.length) return
    const left = Math.max(0, center - Math.floor(visibleWidth(text) / 2))
    lines[row] = fitAnsiLine(`${' '.repeat(left)}${text}`, width)
  }
  const banner = resolveGhostBanner({
    width,
    height: canvasHeight,
    variant: tuiGlyphsAreUnicode(glyphs) ? 'unicode' : 'ascii',
    markGlyph: glyphs.ghost
  })
  // Every banner row shares one visible width, so centring each row by its own
  // width centres the block. `place` must not be given a per-row offset here.
  const block = [
    ...banner.lines.map((line) => ansi.provider(line, TUI_TONE.ensemble)),
    '',
    ansi.bold('TaskWraith'),
    '',
    ansi.dim(homeConnectionStatus(state, glyphs)),
    '',
    ansi.dim(`Ctrl+K threads ${glyphs.separator} /help commands`)
  ]
  const start = Math.max(0, Math.floor((canvasHeight - block.length) / 2))
  block.forEach((text, index) => {
    if (text) place(start + index, text)
  })
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
  const identity = [terminalLabel(thread.title) || 'Chat', thread.provider.displayProvider]
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
  lines.push(borderedLine(ansi.dim('Esc close · Ctrl+O toggle'), width, ansi, glyphs))
  lines.push(borderBottom(width, ansi, glyphs))
  return lines.slice(0, Math.max(1, height))
}

function renderSetupOverlay(
  state: TaskWraithTuiState,
  width: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const cold = state.coldStart
  const step = cold?.kind ?? 'idle'
  const title = state.coldStartIntent === 'new-thread' ? 'New solo thread' : 'Host setup'
  const lines = [borderTitle(title, width, ansi, glyphs)]
  const hint =
    step === 'idle'
      ? 'Enter an absolute workspace path, then press Enter.'
      : step === 'workspace'
        ? state.coldStartIntent === 'new-thread'
          ? 'Use ↑/↓ to choose a provider, then Enter. Esc cancels.'
          : 'Press Enter to choose an available provider.'
        : step === 'auth'
          ? cold?.kind === 'auth' && cold.operationId
            ? 'Complete the provider flow; Enter refreshes status.'
            : 'Press Enter to begin the available user-owned auth flow.'
          : step === 'offers'
            ? 'Press Enter to create a thread.'
            : step === 'thread'
              ? 'Press Enter to configure this thread.'
              : step === 'configure'
                ? 'Space acknowledges the selected posture; Enter applies it.'
                : step === 'ready'
                  ? 'Thread is ready.'
                  : 'Host setup is unavailable; this session is read-only.'
  lines.push(borderedLine(ansi.dim(hint), width, ansi, glyphs))
  if (cold?.kind === 'idle') {
    lines.push(
      borderedLine(
        ` path  ${sanitizeTerminalText(state.input) || ansi.dim('/absolute/path')}`,
        width,
        ansi,
        glyphs
      )
    )
  }
  if (cold?.kind === 'workspace' && state.coldStartProviderChoices?.length) {
    state.coldStartProviderChoices.forEach((provider, index) => {
      const marker = index === (state.coldStartProviderIndex ?? 0) ? glyphs.promptCaret : ' '
      lines.push(
        borderedLine(
          `${marker} ${provider.label} · ${provider.status.replace('_', ' ')}`,
          width,
          ansi,
          glyphs
        )
      )
    })
  }
  if (cold?.kind === 'auth') {
    lines.push(borderedLine(ansi.dim(` provider  ${cold.providerId}`), width, ansi, glyphs))
    cold.flows.forEach((flow, index) => {
      const marker = index === (state.coldStartAuthFlowIndex ?? 0) ? glyphs.promptCaret : ' '
      lines.push(borderedLine(`${marker} ${flow.label}`, width, ansi, glyphs))
    })
  }
  if (cold?.kind === 'offers' || cold?.kind === 'thread' || cold?.kind === 'configure') {
    lines.push(borderedLine(ansi.dim(` provider  ${cold.providerId}`), width, ansi, glyphs))
  }
  if (cold?.kind === 'configure') {
    const models = cold.offers.models.filter((candidate) => candidate.available)
    const postures = cold.offers.postures.filter((candidate) => candidate.available)
    const selectedModel = models[state.coldStartModelIndex ?? 0]
    const reasoning = selectedModel?.reasoning.filter((candidate) => candidate.available) ?? []
    lines.push(borderedLine(ansi.dim(' model  ↑/↓'), width, ansi, glyphs))
    lines.push(
      ...renderSetupChoiceWindow(
        models.map((model) => model.label),
        state.coldStartModelIndex ?? 0,
        width,
        ansi,
        glyphs
      )
    )
    lines.push(borderedLine(ansi.dim(' reasoning  Tab'), width, ansi, glyphs))
    lines.push(
      ...renderSetupChoiceWindow(
        reasoning.map((offer) => offer.label),
        state.coldStartReasoningIndex ?? 0,
        width,
        ansi,
        glyphs
      )
    )
    lines.push(borderedLine(ansi.dim(' posture  ←/→'), width, ansi, glyphs))
    lines.push(
      ...renderSetupChoiceWindow(
        postures.map(
          (posture) =>
            `${posture.label}${
              posture.requiresExplicitConsent
                ? cold.acknowledgedPostureIds.includes(posture.postureId)
                  ? ' · acknowledged'
                  : ' · consent required · Space'
                : ''
            }`
        ),
        state.coldStartPostureIndex ?? 0,
        width,
        ansi,
        glyphs
      )
    )
  }
  lines.push(borderBottom(width, ansi, glyphs))
  return lines
}

function renderSetupChoiceWindow(
  labels: readonly string[],
  selectedIndex: number,
  width: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  if (!labels.length) return [borderedLine(ansi.dim('  unavailable'), width, ansi, glyphs)]
  const selected = Math.max(0, Math.min(selectedIndex, labels.length - 1))
  const start = Math.max(0, Math.min(labels.length - 3, selected - 1))
  return labels.slice(start, start + 3).map((label, offset) => {
    const index = start + offset
    const marker = index === selected ? glyphs.promptCaret : ' '
    return borderedLine(`${marker} ${label}`, width, ansi, glyphs)
  })
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

function missionRunStatus(status: string): TuiRunStatus {
  if (status === 'active') return 'working'
  if (status === 'blocked') return 'needs-input'
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'skipped'
  return 'idle'
}

function renderMissionsOverlay(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const projection = state.hostProjection
  const filter = state.missionFilter ?? 'active'
  const filterLabel = filter === 'active' ? 'Active' : filter === 'history' ? 'History' : 'All'
  const lines = [borderTitle(`Missions · ${filterLabel}`, width, ansi, glyphs)]
  if (!projection) {
    lines.push(
      borderedLine(ansi.dim('No coherent Host projection is available.'), width, ansi, glyphs)
    )
  } else {
    lines.push(
      overlayValue(
        'projection',
        `${projection.freshness.toUpperCase()} · generation ${projection.generation} · cursor ${projection.cursor}`,
        width,
        ansi,
        glyphs,
        projection.freshness === 'live' ? TUI_TONE.good : TUI_TONE.warning
      )
    )
    const missions = [...projection.missions]
      .filter((mission) => {
        const active = mission.status === 'active' || mission.status === 'blocked'
        if (filter === 'active') return active
        if (filter === 'history') return !active
        return true
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
    if (!missions.length) {
      lines.push(
        borderedLine(
          ansi.dim(filter === 'active' ? 'No active missions.' : 'No historical missions.'),
          width,
          ansi,
          glyphs
        )
      )
    } else {
      const safeIndex = Math.max(0, Math.min(state.overlayIndex, missions.length - 1))
      const listCapacity = Math.max(1, Math.min(5, Math.floor((height - 7) / 2)))
      const windowStart = Math.max(0, safeIndex - Math.floor(listCapacity / 2))
      for (
        let index = windowStart;
        index < Math.min(missions.length, windowStart + listCapacity);
        index += 1
      ) {
        const mission = missions[index]
        const selected = index === safeIndex
        const marker = tuiStatusGlyph(missionRunStatus(mission.status), glyphs)
        const title = truncateAnsi(terminalLabel(mission.title), Math.max(8, width - 31))
        const row = `${selected ? glyphs.selection : ' '} ${marker} ${title} ${ansi.dim(
          terminalLabel(mission.status)
        )}`
        lines.push(borderedLine(selected ? ansi.inverse(row) : row, width, ansi, glyphs))
      }

      const selected = missions[safeIndex]
      const activeRound = selected.activeRoundId
        ? projection.rounds.find((round) => round.roundId === selected.activeRoundId)
        : [...projection.rounds]
            .filter((round) => round.threadId === selected.threadId)
            .sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))[0]
      lines.push(
        overlayValue(
          'selected',
          `${terminalLabel(selected.missionId)} · ${terminalLabel(selected.status)}`,
          width,
          ansi,
          glyphs
        )
      )
      if (activeRound) {
        lines.push(
          overlayValue(
            'round',
            `${terminalLabel(activeRound.roundId)} · ${terminalLabel(activeRound.status)}`,
            width,
            ansi,
            glyphs
          )
        )
        const providerOutcomes = activeRound.providerRunIds
          .map((runId) => projection.runs.find((run) => run.runId === runId))
          .filter((run): run is (typeof projection.runs)[number] => Boolean(run))
          .map((run) => `${run.providerId}:${run.providerOutcome}`)
        if (providerOutcomes.length) {
          lines.push(
            overlayValue(
              'providers',
              providerOutcomes.join(` ${glyphs.separator} `),
              width,
              ansi,
              glyphs
            )
          )
        }
      }
      const recentQuestionReceipt = [...projection.questions]
        .filter(
          (question) =>
            question.threadId === selected.threadId &&
            question.status !== 'open' &&
            Boolean(question.receiptId)
        )
        .sort(
          (left, right) => (right.answeredAt ?? right.askedAt) - (left.answeredAt ?? left.askedAt)
        )[0]
      if (recentQuestionReceipt?.receiptId) {
        lines.push(
          overlayValue(
            'receipt',
            `${terminalLabel(recentQuestionReceipt.status)} · ${terminalLabel(
              recentQuestionReceipt.receiptId
            )}`,
            width,
            ansi,
            glyphs,
            TUI_TONE.good
          )
        )
      }
    }
  }
  const footer = borderedLine(
    ansi.dim('↑↓ mission · ←→/Tab filter · Enter thread · Esc close'),
    width,
    ansi,
    glyphs
  )
  const bottom = borderBottom(width, ansi, glyphs)
  return [...lines.slice(0, Math.max(1, height - 2)), footer, bottom].slice(0, Math.max(1, height))
}

function renderHelpOverlay(
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  // Separators come from the glyph set: this overlay is one of the surfaces
  // the packaged `--ascii` smoke renders, and a hard-coded `·`/`—` mojibakes
  // on a terminal that never advertised UTF-8.
  const sep = ` ${glyphs.separator} `
  const lines = [
    borderTitle('Commands', width, ansi, glyphs),
    overlayValue('Ctrl+O', 'context lens', width, ansi, glyphs),
    overlayValue('Ctrl+K', 'thread picker', width, ansi, glyphs),
    overlayValue('Ctrl+R', 'live and historical missions', width, ansi, glyphs),
    overlayValue('Ctrl+G · /tune', `tune lens${sep}model/reasoning`, width, ansi, glyphs),
    overlayValue('PgUp/PgDn', 'scroll transcript', width, ansi, glyphs),
    overlayValue('Enter', 'send prompt / choose item', width, ansi, glyphs),
    overlayValue('Ctrl+C', 'clear input, then quit', width, ansi, glyphs),
    overlayValue(
      '/model',
      `stage a model for the next send${sep}/model <id>${sep}/m`,
      width,
      ansi,
      glyphs
    ),
    overlayValue(
      '/think',
      `stage reasoning effort${sep}/think <level>${sep}/reasoning`,
      width,
      ansi,
      glyphs
    ),
    overlayValue('/new', `fresh solo thread${sep}/new <provider>`, width, ansi, glyphs),
    overlayValue(
      '/provider',
      `choose a provider for a new solo thread${sep}/provider <id>`,
      width,
      ansi,
      glyphs
    ),
    overlayValue('/status', 'Host, connection, and thread detail', width, ansi, glyphs),
    overlayValue('/clear', 'clear the local transcript view', width, ansi, glyphs),
    overlayValue(
      '/git',
      `workspace git status/diff/log lens${sep}/git diff [path]`,
      width,
      ansi,
      glyphs
    ),
    overlayValue('/seats', `ensemble seat lens${sep}Enter toggles a seat`, width, ansi, glyphs),
    overlayValue(
      '/threads',
      `switch thread${sep}/context for workspace detail`,
      width,
      ansi,
      glyphs
    ),
    overlayValue(
      '/missions',
      `mission control${sep}/history for completed runs`,
      width,
      ansi,
      glyphs
    ),
    overlayValue('/cancel', `stop the active run${sep}/dismiss a question`, width, ansi, glyphs),
    overlayValue('/quit', 'leave the CLI; the Host keeps running', width, ansi, glyphs),
    borderedLine(
      ansi.dim(`Esc close${sep}Ctrl+P reopen${sep}the TaskWraith Host owns thread state`),
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
  const offers = state.offers
  const lines = [borderTitle('Model (preview)', width, ansi, glyphs)]
  if (state.offersLoading) {
    lines.push(borderedLine(ansi.dim('Fetching offers from the Host…'), width, ansi, glyphs))
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

/**
 * The /git overlay: a capability-gated READ (status | diff | log), never a
 * mutation. The three non-negotiables: capability-unavailable is a calm
 * configuration state (never a red failure), a Host-truncated result is
 * plainly bannered (never rendered as if complete), and every line is
 * width-bounded and glyph-laddered so 80x24 + ASCII/NO_COLOR hold.
 */
function renderGitOverlay(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const lines = [borderTitle('Git', width, ansi, glyphs)]
  const capacity = Math.max(1, height - 3)
  const git = state.git
  const footer = borderedLine(
    ansi.dim('s status · d diff · l log · r refresh · Esc close'),
    width,
    ansi,
    glyphs
  )

  // Demo mode: show a notice; never fabricate a plausible repo state.
  if (state.connection === 'demo') {
    lines.push(
      borderedLine(
        ansi.dim('git reads need a live Host — this demo session has none.'),
        width,
        ansi,
        glyphs
      )
    )
    lines.push(footer)
    lines.push(borderBottom(width, ansi, glyphs))
    return lines.slice(0, Math.max(1, height))
  }

  if (!git) {
    lines.push(borderedLine(ansi.dim('No git read yet.'), width, ansi, glyphs))
    lines.push(footer)
    lines.push(borderBottom(width, ansi, glyphs))
    return lines.slice(0, Math.max(1, height))
  }

  // Header: branch + short head + scope tabs (active scope inverted).
  const result = git.outcome?.available ? git.outcome.result : undefined
  const branch = result?.branch ?? null
  const head = result?.head ? result.head.slice(0, 7) : null
  const identity = branch
    ? `${glyphs.gitBranch} ${terminalLabel(branch)}${head ? ` ${ansi.dim(`@ ${head}`)}` : ''}`
    : ansi.dim('no branch')
  const tabs = (['status', 'diff', 'log'] as const)
    .map((tab) => (tab === git.scope ? ansi.inverse(` ${tab} `) : ` ${tab} `))
    .join(ansi.dim('·'))
  lines.push(borderedLine(joinLeftRight(identity, tabs, width - 2), width, ansi, glyphs))

  const body: string[] = []
  if (git.loading) {
    body.push(borderedLine(ansi.dim(`reading ${git.scope}…`), width, ansi, glyphs))
  } else if (git.error) {
    body.push(
      borderedLine(
        tone(ansi, terminalLabel(`git read failed · ${git.error}`), 'error'),
        width,
        ansi,
        glyphs
      )
    )
  } else if (!git.outcome) {
    body.push(borderedLine(ansi.dim('No git read yet.'), width, ansi, glyphs))
  } else if (!git.outcome.available) {
    // A Host without git is a normal configuration — calm, not a failure.
    body.push(borderedLine(ansi.dim('git is unavailable on this Host'), width, ansi, glyphs))
  } else if (git.outcome.result.scope === 'status') {
    const status = git.outcome.result
    // A truncated status must be bannered exactly like a truncated diff: a
    // clean-looking partial file list must never read as the whole tree.
    if (status.truncated) {
      body.push(
        borderedLine(
          tone(ansi, 'truncated by the Host (128 KiB cap) — showing a partial view', 'warning'),
          width,
          ansi,
          glyphs
        )
      )
    }
    const staged = status.files.filter((file) => file.staged).length
    const unstaged = status.files.filter((file) => file.unstaged).length
    const untracked = status.files.filter((file) => file.kind === 'untracked').length
    body.push(
      borderedLine(
        ansi.dim(`staged ${staged} · unstaged ${unstaged} · untracked ${untracked}`),
        width,
        ansi,
        glyphs
      )
    )
    const rowCapacity = Math.max(1, capacity - 2)
    for (const file of status.files.slice(0, rowCapacity)) {
      const marker =
        file.kind === 'created'
          ? tone(ansi, glyphs.diffAdd, 'good')
          : file.kind === 'deleted'
            ? tone(ansi, glyphs.diffRemove, 'error')
            : file.kind === 'untracked'
              ? '?'
              : file.kind === 'conflicted'
                ? tone(ansi, glyphs.statusNeedsInput, 'warning')
                : file.kind === 'renamed'
                  ? glyphs.pendingChange
                  : file.kind === 'ignored'
                    ? glyphs.statusPending
                    : '~'
      const flags = `${file.staged ? 'S' : glyphs.statusPending}${file.unstaged ? 'U' : glyphs.statusPending}`
      const renamedFrom = file.originalPath
        ? ` ${ansi.dim(`(from ${terminalLabel(file.originalPath)}` + ')')}`
        : ''
      const row = `${marker} ${truncateAnsi(terminalLabel(file.path), Math.max(8, width - 10))}${ansi.dim(` ${flags}`)}${renamedFrom}`
      body.push(borderedLine(row, width, ansi, glyphs))
    }
    if (status.files.length > rowCapacity) {
      body.push(
        borderedLine(ansi.dim(`… ${status.files.length - rowCapacity} more`), width, ansi, glyphs)
      )
    }
    if (!status.files.length) {
      body.push(borderedLine(ansi.dim('working tree clean'), width, ansi, glyphs))
    }
  } else {
    // diff / log: bounded text lines. A Host-truncated result is bannered at
    // the top — a partial view must never read as the whole diff.
    const text = git.outcome.result.text
    const rawLines = text.split('\n')
    if (git.outcome.result.truncated) {
      body.push(
        borderedLine(
          tone(ansi, 'truncated by the Host (128 KiB cap) — showing a partial view', 'warning'),
          width,
          ansi,
          glyphs
        )
      )
    }
    const textCapacity = Math.max(1, capacity - (git.outcome.result.truncated ? 3 : 1))
    for (const rawLine of rawLines.slice(0, textCapacity)) {
      const line = truncateAnsi(terminalLabel(rawLine), Math.max(8, width - 4))
      const toned =
        rawLine.startsWith('+') && !rawLine.startsWith('++')
          ? tone(ansi, line, 'good')
          : rawLine.startsWith('-') && !rawLine.startsWith('--')
            ? tone(ansi, line, 'error')
            : rawLine.startsWith('@')
              ? ansi.dim(line)
              : rawLine.startsWith('diff --git')
                ? ansi.bold(line)
                : line
      body.push(borderedLine(toned, width, ansi, glyphs))
    }
    if (rawLines.length > textCapacity) {
      body.push(
        borderedLine(
          ansi.dim(`… ${rawLines.length - textCapacity} more lines`),
          width,
          ansi,
          glyphs
        )
      )
    }
  }
  for (const line of body.slice(0, capacity)) lines.push(line)
  lines.push(footer)
  lines.push(borderBottom(width, ansi, glyphs))
  return lines.slice(0, Math.max(1, height))
}

/**
 * The /seats lens: ensemble seat control on the selected thread. The roster
 * renders from the coherent Host projection (never a captured copy), the
 * Host's typed toggle refusal renders in plain language, and the desktop-only
 * round boundary is stated where a seat-toggling user would look. Calm states
 * (no capability, solo thread, no projected roster) are not errors.
 */
function renderSeatsOverlay(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const sep = ` ${glyphs.separator} `
  const lines = [borderTitle('Seats', width, ansi, glyphs)]
  const capacity = Math.max(1, height - 3)
  const seats = state.seats
  const footer = borderedLine(
    ansi.dim(`up/down seat${sep}Enter/Space toggle${sep}r refresh${sep}Esc close`),
    width,
    ansi,
    glyphs
  )
  const finish = (body: string[]): string[] => {
    for (const line of body.slice(0, capacity)) lines.push(line)
    lines.push(footer)
    lines.push(borderBottom(width, ansi, glyphs))
    return lines.slice(0, Math.max(1, height))
  }

  // Demo mode: show a notice; never fabricate a plausible roster.
  if (state.connection === 'demo') {
    return finish([
      borderedLine(
        ansi.dim(`seat control needs a live Host${sep}this demo session has none`),
        width,
        ansi,
        glyphs
      )
    ])
  }

  if (!seats) {
    return finish([borderedLine(ansi.dim('No seat lens is open.'), width, ansi, glyphs)])
  }

  const thread = state.hostProjection?.threads.find((candidate) => candidate.id === seats.threadId)
  const roster = tuiSeatsRoster(state)
  if (thread) {
    lines.push(
      borderedLine(
        joinLeftRight(
          truncateAnsi(terminalLabel(thread.title), Math.max(8, width - 14)),
          ansi.dim(`${roster.length} seat${roster.length === 1 ? '' : 's'}`),
          // borderedLine's content area is the canvas minus its two borders.
          width - 4
        ),
        width,
        ansi,
        glyphs
      )
    )
  }

  const body: string[] = []
  if (seats.unavailable) {
    body.push(borderedLine(ansi.dim(seats.unavailable), width, ansi, glyphs))
    body.push(
      borderedLine(
        ansi.dim('the connected Host does not advertise the ensemble capability'),
        width,
        ansi,
        glyphs
      )
    )
  } else if (seats.loading) {
    body.push(borderedLine(ansi.dim(`reading seats${glyphs.ellipsis}`), width, ansi, glyphs))
  } else if (seats.error) {
    body.push(
      borderedLine(
        tone(ansi, terminalLabel(`seat read failed${sep}${seats.error}`), 'error'),
        width,
        ansi,
        glyphs
      )
    )
  } else if (!thread) {
    body.push(borderedLine(ansi.dim('the Host does not project this thread'), width, ansi, glyphs))
  } else if (thread.chatKind !== 'ensemble') {
    body.push(
      borderedLine(
        ansi.dim(`this thread is solo${sep}seats exist on ensemble threads`),
        width,
        ansi,
        glyphs
      )
    )
  } else if (!roster.length) {
    body.push(
      borderedLine(
        ansi.dim('the Host projects no participants for this thread'),
        width,
        ansi,
        glyphs
      )
    )
  } else {
    // Seat control is real here; round execution is not. Someone who can
    // toggle seats will reasonably assume they can start a round — say so.
    body.push(
      borderedLine(
        ansi.dim(`rounds run in the desktop app${sep}sending a prompt here is refused`),
        width,
        ansi,
        glyphs
      )
    )
    const safeIndex = Math.max(0, Math.min(state.overlayIndex, roster.length - 1))
    const rowCapacity = Math.max(1, capacity - 3)
    const windowStart = Math.max(0, safeIndex - Math.floor(rowCapacity / 2))
    for (
      let index = windowStart;
      index < Math.min(roster.length, windowStart + rowCapacity);
      index += 1
    ) {
      const participant = roster[index]!
      const selected = index === safeIndex
      const provider = state.hostProjection?.providers.find(
        (candidate) => candidate.providerId === participant.providerId
      )
      const identity = [
        participant.role,
        provider?.displayProvider || participant.providerId,
        participant.modelId
      ]
        .filter(Boolean)
        .join(' ')
      const details = [
        ...(participant.stage && participant.stage !== 'any' ? [participant.stage] : []),
        participant.enabled ? 'enabled' : 'disabled',
        ...(participant.active ? ['active'] : []),
        ...(participant.status ? [participant.status] : [])
      ].join(sep)
      const seatGlyph = participant.enabled ? glyphs.seatEnabled : glyphs.seatDisabled
      const row = `${selected ? glyphs.selection : ' '} ${seatGlyph} ${truncateAnsi(
        terminalLabel(identity),
        Math.max(8, width - 24)
      )} ${ansi.dim(terminalLabel(details))}`
      body.push(borderedLine(selected ? ansi.inverse(row) : row, width, ansi, glyphs))
    }
    if (roster.length > windowStart + rowCapacity || windowStart > 0) {
      const hidden = roster.length - Math.min(roster.length, windowStart + rowCapacity)
      body.push(borderedLine(ansi.dim(`${glyphs.ellipsis} ${hidden} more`), width, ansi, glyphs))
    }
  }
  // The Host's typed refusal survives as lens state, not a fading notice.
  if (seats.actionError) {
    body.push(
      borderedLine(tone(ansi, terminalLabel(seats.actionError), 'warning'), width, ansi, glyphs)
    )
  }
  return finish(body)
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
  if (state.overlay === 'setup') {
    return renderSetupOverlay(state, width, ansi, glyphs).slice(0, Math.max(1, height))
  }
  if (state.overlay === 'threads') {
    return renderThreadsOverlay(state, width, height, ansi, glyphs)
  }
  if (state.overlay === 'missions') {
    return renderMissionsOverlay(state, width, height, ansi, glyphs)
  }
  if (state.overlay === 'tune') {
    return renderTuneOverlay(state, width, height, ansi, glyphs)
  }
  if (state.overlay === 'git') {
    return renderGitOverlay(state, width, height, ansi, glyphs)
  }
  if (state.overlay === 'seats') {
    return renderSeatsOverlay(state, width, height, ansi, glyphs)
  }
  return renderHelpOverlay(width, height, ansi, glyphs)
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
  const pendingApproval = selectedPendingApproval(state)
  const openQuestion = selectedOpenQuestion(state)
  const status = pendingApproval
    ? tone(ansi, 'APPROVAL · y/n', 'warning')
    : openQuestion
      ? tone(ansi, 'QUESTION · answer below', 'warning')
      : thread.status === 'needs-input'
        ? tone(ansi, 'Open TaskWraith to answer', 'warning')
        : thread.status === 'failed'
          ? tone(ansi, 'FAILED', 'error')
          : thread.status === 'queued'
            ? ansi.dim('QUEUED')
            : ''
  // A staged model/reasoning choice rides the next send; wear the provider
  // accent because it names the identity the next turn will run as.
  const pending = state.pendingSelection
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
  const pendingApproval = selectedPendingApproval(state)
  const openQuestion = selectedOpenQuestion(state)
  const setupRequired = Boolean(state.coldStart && state.coldStart.kind !== 'ready')
  // Glyph-set aware: ↵/· on Unicode, \/. on ASCII so chrome never mojibakes.
  const sep = ` ${glyphs.separator} `
  const right = setupRequired
    ? ansi.dim(state.coldStartIntent === 'new-thread' ? 'Choose a provider' : 'Host setup required')
    : pendingApproval
      ? ansi.dim(`y accept${sep}n decline`)
      : openQuestion
        ? density.composerHints === 'none'
          ? ansi.dim(`${glyphs.newline} answer`)
          : ansi.dim(`${glyphs.newline} answer${sep}/dismiss`)
        : density.composerHints === 'full'
          ? ansi.dim(`${glyphs.newline} send${sep}^O context${sep}^K threads`)
          : density.composerHints === 'short'
            ? ansi.dim(`${glyphs.newline} send${sep}^O context`)
            : ansi.dim(`${glyphs.newline} send`)
  const leftAvailable = Math.max(1, width - visibleWidth(right) - 1)
  const inputAvailable = Math.max(1, leftAvailable - visibleWidth(prompt) - 1)
  const input = setupRequired
    ? `${ansi.color(glyphs.cursor, accent)} ${ansi.dim('Complete Host setup to compose')}`
    : state.input
      ? renderComposerInput(state.input, state.inputCursor, inputAvailable, ansi, accent, glyphs)
      : `${ansi.color(glyphs.cursor, accent)} ${ansi.dim(
          state.connection === 'offline'
            ? // The App is not the dependency here: `tw` talks to an ordinary
              // Node Host it can start itself, so offline means "reconnecting".
              `Waiting for the TaskWraith Host${glyphs.ellipsis}`
            : pendingApproval
              ? `Approval · ${terminalLabel(pendingApproval.actionKind)}`
              : openQuestion
                ? `Answer · ${terminalLabel(openQuestion.promptPreview)}`
                : 'Ask TaskWraith…'
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
  const footerRows = TUI_LAYOUT.soloFooterRows
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
  footer.push(renderHud(state, thread, width, options.ansi, now, glyphs))
  footer.push(renderComposer(state, width, options.ansi, glyphs))
  const lines = [...canvas, ...footer].slice(0, height)
  while (lines.length < height) lines.push('')
  return lines.map((line) => fitAnsiLine(line, width)).join('\n')
}
