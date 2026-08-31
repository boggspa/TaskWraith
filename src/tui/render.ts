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
import { activeGoalModeLabel } from '../shared/activeGoalPresentation'
import {
  contextPercent,
  formatContextTokens,
  isContextWindowProviderId,
  resolveContextWindow
} from '../shared/contextWindows'
import { resolveTaskWraithProviderPresentation } from '../shared/taskWraithProviderPresentation'
import { resolveGhostBanner } from './ghostBanner'
import { filterTuiSlashCommands } from './slashCommands'
import { tuiSeatsRoster, visibleThreadRows, type TaskWraithTuiState } from './state'
import { queuedDraftsForThread } from './promptQueue'
import { providerLoginGuidance } from './providerLoginFlow'
import { permissionToneHex } from './permissionTone'
import { resolveTuiHomePosture, tuiModelChoices } from './modelPicker'
import {
  TUI_AUTO_THEME_NAME,
  TUI_DEFAULT_THEME_NAME,
  TUI_UNPAINTED_THEME,
  resolveTuiTheme,
  tuiThemeNames,
  type TuiTheme,
  type TuiThemeTone
} from './palette'
import {
  TUI_GLYPHS_UNICODE,
  TUI_LAYOUT,
  TUI_MOTION,
  resolveTuiDensity,
  tuiGlyphsAreUnicode,
  tuiStatusGlyph,
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
  /**
   * Palette to paint the frame in. Defaults to the unpainted theme, which
   * inherits the terminal's own colours and renders byte-identically to the
   * pre-theme surface.
   */
  theme?: TuiTheme
}

function terminalLabel(value: unknown): string {
  return sanitizeTerminalText(String(value ?? '')).replace(/\n+/g, ' ')
}

// Diff/code lines must preserve indentation while still stripping terminal
// controls. `sanitizeTerminalText` intentionally collapses whitespace for
// prose, which would make an inline hunk unreadable.
function terminalCodeLine(value: unknown): string {
  return (
    String(value ?? '')
      .replaceAll('\u001b', '')
      .replace(/\r\n?/g, ' ')
      // eslint-disable-next-line no-control-regex -- provider code previews reject C0/C1 controls.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, (character) =>
        character === '\t' ? '  ' : ''
      )
  )
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
    full_access: 'Full Access (YOLO)',
    auto_edit: 'Full WS Access',
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
        ? ansi.color(glyphs.reasoningOn, mixHex(accent, tones(ansi).highlight, index * 0.12))
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

/**
 * The active theme's state tones.
 *
 * `renderTaskWraithTui` hands every helper a toned `Ansi`, so the fallback only
 * covers a helper reached some other way. It resolves to the unpainted theme's
 * tones — the house palette — which is what these sites read before themes
 * existed, and keeps the literals in `palette.ts` where they belong.
 */
function tones(ansi: Ansi): TuiThemeTone {
  return ansi.tones ?? TUI_UNPAINTED_THEME.tone
}

function tone(ansi: Ansi, text: string, value: TuiSemanticTone): string {
  const palette = tones(ansi)
  const hex =
    value === 'good'
      ? palette.good
      : value === 'warning'
        ? palette.warning
        : value === 'error'
          ? palette.error
          : undefined
  return hex ? ansi.color(text, hex) : text
}

function permissionColor(ansi: Ansi, postureId: string | undefined): string {
  return permissionToneHex(postureId, tones(ansi).permission)
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

function transcriptSpeaker(
  row: TaskWraithControlTranscriptRow,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string {
  const speaker = terminalLabel(row.speaker)
  if (row.role === 'user') return ansi.bold(speaker || 'You')
  if (row.provider) {
    const identity = [
      row.provider.displayProvider || speaker,
      row.model ?? row.provider.modelLabel ?? row.provider.model,
      reasoningLabel(row.provider.runtimeProvider, row.reasoning)
    ]
      .map(terminalLabel)
      .filter(Boolean)
    return ansi.provider(identity.join(` ${glyphs.separator} `), row.provider.accent)
  }
  if (row.role === 'error') return ansi.provider(speaker || 'Error', tones(ansi).error)
  if (row.role === 'tool') return ansi.dim(speaker || 'Tool')
  return ansi.bold(speaker || 'TaskWraith')
}

const TUI_TOOL_DIFF_PREVIEW_LINES = 10
const TUI_TOOL_COMMAND_PREVIEW_LINES = 3

function renderToolHeader(
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
      ? tones(ansi).warning
      : tool.status === 'error'
        ? tones(ansi).error
        : tones(ansi).good
  const delta =
    tool.additions !== undefined || tool.deletions !== undefined
      ? `  ${ansi.color(`+${tool.additions ?? 0}`, tones(ansi).good)} ${ansi.color(`-${tool.deletions ?? 0}`, tones(ansi).error)}`
      : ''
  const file = tool.file ? ` ${glyphs.separator} ${terminalLabel(tool.file)}` : ''
  const detail = tool.detail ? ` ${glyphs.separator} ${terminalLabel(tool.detail)}` : ''
  const label = tool.command ? 'Ran a command' : terminalLabel(tool.name)
  const gutter = ' '.repeat(TUI_LAYOUT.transcriptDetailGutter)
  return fitAnsiLine(
    `${gutter}${ansi.color(glyph, accent)} ${ansi.provider(
      `${label}${file}${detail}`,
      tones(ansi).ensemble
    )}${delta}`,
    width
  )
}

function renderToolDiff(
  diff: NonNullable<TaskWraithControlTranscriptRow['tools']>[number]['diff'],
  width: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  if (!diff) return []
  const gutter = ' '.repeat(TUI_LAYOUT.transcriptDetailGutter)
  const lines: string[] = []
  let renderedLines = 0
  let hiddenLines = 0
  for (const hunk of diff.hunks) {
    if (renderedLines >= TUI_TOOL_DIFF_PREVIEW_LINES) {
      hiddenLines += hunk.lines.length
      continue
    }
    lines.push(fitAnsiLine(`${gutter}${ansi.dim(terminalLabel(hunk.header))}`, width))
    for (const line of hunk.lines) {
      if (renderedLines >= TUI_TOOL_DIFF_PREVIEW_LINES) {
        hiddenLines += 1
        continue
      }
      const oldLine = line.oldLine === undefined ? '    ' : String(line.oldLine).padStart(4)
      const newLine = line.newLine === undefined ? '    ' : String(line.newLine).padStart(4)
      const marker =
        line.type === 'add' ? glyphs.diffAdd : line.type === 'del' ? glyphs.diffRemove : ' '
      const lineTone =
        line.type === 'add' ? tones(ansi).good : line.type === 'del' ? tones(ansi).error : undefined
      const code = `${ansi.dim(`${oldLine} ${newLine}`)} ${lineTone ? ansi.color(marker, lineTone) : marker}${terminalCodeLine(line.text)}`
      lines.push(fitAnsiLine(`${gutter}${code}`, width))
      renderedLines += 1
    }
  }
  if (hiddenLines > 0 || diff.truncated) {
    const suffix =
      hiddenLines > 0
        ? `${hiddenLines} more diff line${hiddenLines === 1 ? '' : 's'}`
        : 'diff preview capped'
    lines.push(fitAnsiLine(`${gutter}${ansi.dim(`${glyphs.ellipsis} ${suffix}`)}`, width))
  }
  return lines
}

function renderToolCommand(
  command: NonNullable<TaskWraithControlTranscriptRow['tools']>[number]['command'],
  width: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  if (!command) return []
  const gutter = ' '.repeat(TUI_LAYOUT.transcriptDetailGutter)
  const lines: string[] = []
  if (command.command) {
    lines.push(
      fitAnsiLine(
        `${gutter}${ansi.color('$', tones(ansi).ensemble)} ${terminalCodeLine(command.command)}`,
        width
      )
    )
  }
  const outputLines = command.output?.replace(/\r\n?/g, '\n').split('\n') ?? []
  const visibleOutput = outputLines.slice(0, TUI_TOOL_COMMAND_PREVIEW_LINES)
  for (const output of visibleOutput) {
    lines.push(fitAnsiLine(`${gutter}  ${ansi.dim(terminalCodeLine(output))}`, width))
  }
  if (command.exitCode !== undefined) {
    const exitTone = command.exitCode === 0 ? tones(ansi).good : tones(ansi).error
    lines.push(fitAnsiLine(`${gutter}  ${ansi.color(`exit ${command.exitCode}`, exitTone)}`, width))
  }
  const hiddenOutput = Math.max(0, outputLines.length - visibleOutput.length)
  if (hiddenOutput > 0 || command.truncated) {
    const suffix =
      hiddenOutput > 0
        ? `${hiddenOutput} more output line${hiddenOutput === 1 ? '' : 's'}`
        : 'output preview capped'
    lines.push(fitAnsiLine(`${gutter}  ${ansi.dim(`${glyphs.ellipsis} ${suffix}`)}`, width))
  }
  return lines
}

function renderToolLines(
  tool: NonNullable<TaskWraithControlTranscriptRow['tools']>[number],
  ansi: Ansi,
  width: number,
  glyphs: TuiGlyphSet
): string[] {
  return [
    renderToolHeader(tool, ansi, width, glyphs),
    ...renderToolDiff(tool.diff, width, ansi, glyphs),
    ...renderToolCommand(tool.command, width, ansi, glyphs)
  ]
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
  const lines: string[] = [fitAnsiLine(`${gutter}${transcriptSpeaker(row, ansi, glyphs)}`, width)]
  const bodyTone =
    row.role === 'system' || row.role === 'tool'
      ? (value: string) => ansi.dim(value)
      : row.role === 'error'
        ? (value: string) => ansi.color(value, tones(ansi).error)
        : (value: string) => value
  for (const line of wrapPlainText(row.text || '', bodyWidth)) {
    lines.push(fitAnsiLine(`${gutter}${bodyTone(line)}`, width))
  }
  if (row.thinking) {
    const status =
      row.thinking.status === 'running' ? glyphs.thinkingRunning : glyphs.thinkingSettled
    lines.push(
      fitAnsiLine(
        `${detailGutter}${ansi.color(status, row.provider?.accent ?? tones(ansi).ensemble)} ${ansi.dim(
          terminalLabel(row.thinking.title)
        )}`,
        width
      )
    )
  }
  for (const tool of row.tools ?? []) lines.push(...renderToolLines(tool, ansi, width, glyphs))
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
      return ansi.color(character, mixHex(accent, tones(ansi).highlight, amount))
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
  return 'connected'
}

function homeWorkspace(state: TaskWraithTuiState) {
  const workspaces = state.snapshot?.workspaces ?? []
  return workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? workspaces[0]
}

function homeIdentity(state: TaskWraithTuiState) {
  const selectedThread = state.thread?.thread
  const continuedThread =
    state.homeContinuationThreadId === selectedThread?.id ? selectedThread : undefined
  if (continuedThread) {
    return {
      presentation: continuedThread.provider,
      modelLabel: terminalLabel(
        continuedThread.provider.modelLabel ??
          continuedThread.provider.model ??
          continuedThread.provider.displayProvider
      ),
      reasoning: continuedThread.reasoning ?? 'Default'
    }
  }
  const home = state.homeTune
  const choice = home ? tuiModelChoices(home.providers)[home.modelIndex] : undefined
  const provider = choice?.provider
  const model = choice?.model
  if (!provider || !model) {
    const thread = state.thread?.thread
    if (!thread) return undefined
    return {
      presentation: thread.provider,
      modelLabel: terminalLabel(
        thread.provider.modelLabel ?? thread.provider.model ?? thread.provider.displayProvider
      ),
      reasoning: thread.reasoning ?? 'Default'
    }
  }
  const reasoning = model.reasoning.filter((candidate) => candidate.available)[
    home?.reasoningIndex ?? -1
  ]
  return {
    presentation: resolveTaskWraithProviderPresentation(
      provider.status.providerId,
      model.modelId,
      model.label
    ),
    modelLabel: terminalLabel(model.label),
    reasoning: reasoning?.label ?? reasoning?.reasoningId ?? 'Default'
  }
}

function homeReasoningPresentation(
  provider: string,
  value: string
): {
  label: string
  shimmer: boolean
} {
  const normalized = terminalLabel(value).trim().toLowerCase()
  const words = normalized.replace(/[_-]+/g, ' ')
  const label =
    normalized === 'max'
      ? 'MAX'
      : normalized === 'ultra'
        ? 'ULTRA'
        : normalized === 'ultracode'
          ? 'ULTRACODE'
          : normalized === 'xhigh' || words === 'extra high'
            ? 'Extra High'
            : reasoningLabel(provider, value) || 'Default'
  return {
    label,
    shimmer: ['extra', 'extra high', 'max', 'ultra', 'ultracode'].includes(label.toLowerCase())
  }
}

function renderHomeIdentity(
  state: TaskWraithTuiState,
  ansi: Ansi,
  animationEnabled: boolean,
  glyphs: TuiGlyphSet
): string {
  const separator = ansi.dim(` ${glyphs.separator} `)
  const parts = [ansi.bold('TaskWraith')]
  const identity = homeIdentity(state)
  if (identity) {
    const provider = terminalLabel(identity.presentation.displayProvider)
    const model = identity.modelLabel
    const providerAndModel = model.toLowerCase().startsWith(provider.toLowerCase())
      ? model
      : `${provider} ${model}`
    parts.push(ansi.provider(providerAndModel, identity.presentation.accent))
    const effort = homeReasoningPresentation(
      identity.presentation.runtimeProvider,
      identity.reasoning
    )
    parts.push(
      effort.shimmer
        ? ansi.bold(
            shimmerWorking(
              effort.label,
              identity.presentation.accent,
              ansi,
              state.animationFrame,
              animationEnabled
            )
          )
        : ansi.color(effort.label, identity.presentation.accent)
    )
  }
  const workspace = homeWorkspace(state)
  if (workspace) parts.push(ansi.bold(terminalLabel(workspace.name)))
  return parts.join(separator)
}

function renderHomeStatus(state: TaskWraithTuiState, ansi: Ansi, glyphs: TuiGlyphSet): string {
  if (
    state.connection !== 'connected' &&
    state.connection !== 'demo' &&
    state.connection !== 'replay'
  ) {
    return ansi.dim(homeConnectionStatus(state, glyphs))
  }
  const workspace = homeWorkspace(state)
  const threadStatus = state.thread?.thread.status
  return [
    `${ansi.color(glyphs.statusActive, tones(ansi).good)} ${ansi.color('connected', tones(ansi).good)}`,
    workspace ? 'workspace ready' : 'global scope',
    ansi.dim(
      threadStatus === 'working' ? 'active run' : state.thread ? 'thread ready' : 'no active run'
    )
  ].join(ansi.dim(` ${glyphs.separator} `))
}

function homeBlock(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  animationEnabled: boolean,
  glyphs: TuiGlyphSet
) {
  const banner = resolveGhostBanner({
    width,
    height,
    variant: tuiGlyphsAreUnicode(glyphs) ? 'unicode' : 'ascii',
    markGlyph: glyphs.ghost
  })
  return {
    bannerKind: banner.kind,
    lines: [
      ...banner.lines.map((line) => ansi.bold(line.trimEnd())),
      '',
      renderHomeIdentity(state, ansi, animationEnabled, glyphs),
      renderHomeStatus(state, ansi, glyphs),
      `Type ${ansi.color('/help', tones(ansi).permission.info)} for commands or ${ansi.color(
        'Ctrl+K',
        tones(ansi).permission.info
      )} to switch threads`
    ]
  }
}

function renderHome(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  animationEnabled: boolean,
  glyphs: TuiGlyphSet
): string[] {
  const canvasHeight = Math.max(1, height)
  const lines = Array.from({ length: canvasHeight }, () => '')
  const place = (row: number, text: string) => {
    if (row < 0 || row >= lines.length) return
    lines[row] = fitAnsiLine(`  ${text}`, width)
  }
  const block = homeBlock(state, width, canvasHeight, ansi, animationEnabled, glyphs)
  const start =
    block.bannerKind === 'full'
      ? 1
      : Math.max(0, Math.floor((canvasHeight - block.lines.length) / 3))
  block.lines.forEach((text, index) => {
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
  if (!snapshot) return renderHome(state, width, height, ansi, animationEnabled, glyphs)
  const allLines =
    state.homeContinuationThreadId === snapshot.thread.id
      ? [
          ...homeBlock(state, width, height, ansi, animationEnabled, glyphs).lines.map((line) =>
            fitAnsiLine(`  ${line}`, width)
          ),
          ''
        ]
      : []
  allLines.push(...snapshot.rows.flatMap((row) => renderTranscriptRow(row, width, ansi, glyphs)))
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
  lines.push(
    overlayValue(
      'permission',
      permissionLabel(context.permission),
      width,
      ansi,
      glyphs,
      permissionColor(ansi, context.permission)
    )
  )
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
    const postures = cold.offers.postures
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
        postures.map((posture) =>
          ansi.color(
            `${posture.label}${
              !posture.available
                ? ` · unavailable${posture.detail ? ` · ${terminalLabel(posture.detail)}` : ''}`
                : ''
            }${
              posture.requiresExplicitConsent
                ? cold.acknowledgedPostureIds.includes(posture.postureId)
                  ? ' · acknowledged'
                  : ' · consent required · Space'
                : ''
            }`,
            permissionColor(ansi, posture.postureId)
          )
        ),
        state.coldStartPostureIndex ?? 0,
        width,
        ansi,
        glyphs,
        5
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
  glyphs: TuiGlyphSet,
  windowSize = 3
): string[] {
  if (!labels.length) return [borderedLine(ansi.dim('  unavailable'), width, ansi, glyphs)]
  const selected = Math.max(0, Math.min(selectedIndex, labels.length - 1))
  const size = Math.max(1, windowSize)
  const start = Math.max(0, Math.min(labels.length - size, selected - Math.floor(size / 2)))
  return labels.slice(start, start + size).map((label, offset) => {
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
  const threads = visibleThreadRows(state)
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
      const marker = thread.archived ? glyphs.statusSkipped : threadStatusMark(thread, glyphs)
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
  lines.push(
    borderedLine(
      ansi.dim(
        state.showArchivedThreads
          ? '↑↓ choose · Enter restores an archived chat · a hides · Esc close'
          : '↑↓ choose · Enter open · a reveals archived · Esc close'
      ),
      width,
      ansi,
      glyphs
    )
  )
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
        projection.freshness === 'live' ? tones(ansi).good : tones(ansi).warning
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
            tones(ansi).good
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

/**
 * The /workspace picker. New threads inherit a workspace that was never chosen
 * — the open thread's, else the FIRST registered one in raw file order — so the
 * lens names the resolved target explicitly rather than leaving a silent pick
 * to be discovered after a chat lands in the wrong repository.
 */
function renderWorkspacesOverlay(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const workspaces = state.snapshot?.workspaces ?? []
  const lines = [borderTitle('Workspaces', width, ansi, glyphs)]
  const capacity = Math.max(1, height - 3)
  if (!workspaces.length) {
    lines.push(borderedLine(ansi.dim('No workspaces are registered.'), width, ansi, glyphs))
    lines.push(
      borderedLine(ansi.dim('/workspace <absolute-path> registers one.'), width, ansi, glyphs)
    )
    lines.push(borderBottom(width, ansi, glyphs))
    return lines.slice(0, Math.max(1, height))
  }
  // Mirrors resolveWorkspaceId in TaskWraithTui: an explicit pick wins, then the
  // open thread's workspace, then the arbitrary first row. Kept in step so the
  // marked row is always the one a new thread would actually use.
  const activeId =
    workspaces.find((workspace) => workspace.id === state.activeWorkspaceId)?.id ??
    state.thread?.thread.workspaceId ??
    workspaces[0]?.id
  const safeIndex = Math.max(0, Math.min(state.overlayIndex, workspaces.length - 1))
  const windowStart = Math.max(0, safeIndex - Math.floor(capacity / 2))
  for (
    let index = windowStart;
    index < Math.min(workspaces.length, windowStart + capacity);
    index += 1
  ) {
    const workspace = workspaces[index]
    const selected = index === safeIndex
    const active = workspace.id === activeId
    const name = truncateAnsi(terminalLabel(workspace.name), Math.max(8, width - 34))
    const suffix = active ? ansi.dim('  new threads land here') : ''
    const line = `${selected ? glyphs.selection : ' '} ${name}${suffix}`
    lines.push(borderedLine(line, width, ansi, glyphs))
  }
  lines.push(
    borderedLine(
      ansi.dim('↑↓ choose · Enter set · /workspace <path> adds · Esc close'),
      width,
      ansi,
      glyphs
    )
  )
  lines.push(borderBottom(width, ansi, glyphs))
  return lines.slice(0, Math.max(1, height))
}

/** `26h 14m` / `3m` — goal ledgers routinely span days, so hours never roll up. */
function goalDuration(ms: number | undefined): string | undefined {
  if (typeof ms !== 'number' || ms <= 0) return undefined
  const minutes = Math.floor(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

/**
 * The /goal lens. The App authors goals; this Host reads them, so the lens is
 * read-only by construction and says so rather than implying the CLI can steer
 * a goal it cannot author.
 */
function renderGoalOverlay(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const lines = [borderTitle('Goal', width, ansi, glyphs)]
  const threadId = state.selectedThreadId
  const goal = threadId
    ? state.hostProjection?.threads.find((candidate) => candidate.id === threadId)?.goal
    : undefined
  if (!threadId) {
    lines.push(borderedLine(ansi.dim('Open a thread to see its goal.'), width, ansi, glyphs))
    lines.push(borderBottom(width, ansi, glyphs))
    return lines.slice(0, Math.max(1, height))
  }
  if (!goal) {
    lines.push(
      borderedLine(ansi.dim('This thread has no durable goal.'), width, ansi, glyphs),
      borderedLine(
        ansi.dim('Goals are authored in the TaskWraith app; the CLI reads them.'),
        width,
        ansi,
        glyphs
      ),
      borderBottom(width, ansi, glyphs)
    )
    return lines.slice(0, Math.max(1, height))
  }

  const tone =
    goal.status === 'blocked'
      ? tones(ansi).warning
      : goal.status === 'active'
        ? tones(ansi).good
        : undefined
  lines.push(overlayValue('status', terminalLabel(goal.status), width, ansi, glyphs, tone))
  lines.push(
    overlayValue(
      'mode',
      terminalLabel(activeGoalModeLabel(goal.mode as never)),
      width,
      ansi,
      glyphs
    )
  )
  const wall = goalDuration(goal.wallMs)
  const active = goalDuration(goal.activeMs)
  if (wall) {
    const value = active && active !== wall ? `${wall} ${glyphs.separator} active ${active}` : wall
    lines.push(overlayValue('elapsed', value, width, ansi, glyphs))
  }
  if (goal.blockedReason) {
    lines.push(overlayValue('blocked', terminalLabel(goal.blockedReason), width, ansi, glyphs))
  }

  const density = resolveTuiDensity(width)
  const bodyWidth = Math.max(8, width - density.overlayLabelWidth - 4)
  lines.push(overlayValue('objective', '', width, ansi, glyphs))
  for (const line of wrapPlainText(goal.objective, bodyWidth)) {
    lines.push(borderedLine(`  ${line}`, width, ansi, glyphs))
  }
  if (goal.objectiveTruncated) {
    // A clipped objective must never read as the whole objective.
    lines.push(
      borderedLine(ansi.dim(`  ${glyphs.ellipsis} truncated by the Host`), width, ansi, glyphs)
    )
  }
  if (goal.acceptanceCriteria?.length) {
    lines.push(overlayValue('acceptance', '', width, ansi, glyphs))
    for (const criterion of goal.acceptanceCriteria) {
      for (const [index, line] of wrapPlainText(criterion, bodyWidth - 2).entries()) {
        lines.push(borderedLine(`  ${index === 0 ? '- ' : '  '}${line}`, width, ansi, glyphs))
      }
    }
  }
  lines.push(
    borderedLine(ansi.dim('read-only · authored in the app · Esc close'), width, ansi, glyphs)
  )
  lines.push(borderBottom(width, ansi, glyphs))
  return lines.slice(0, Math.max(1, height))
}

/**
 * The /theme picker.
 *
 * Selection previews by repainting the whole frame, which is why there is no
 * sample swatch here: the surrounding chrome IS the swatch, and a small colour
 * chip beside a name is a worse preview than the thing itself. Vibe debounces
 * its preview by 100ms because a Textual theme change rebuilds a stylesheet;
 * ours rebuilds a string, so it repaints on the keystroke.
 */
function renderThemeOverlay(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const names = [TUI_AUTO_THEME_NAME, ...tuiThemeNames()]
  const committed = state.themeName ?? TUI_DEFAULT_THEME_NAME
  const lines = [borderTitle('Theme', width, ansi, glyphs)]
  const capacity = Math.max(1, height - 3)
  const safeIndex = Math.max(0, Math.min(state.overlayIndex, names.length - 1))
  const windowStart = Math.max(0, safeIndex - Math.floor(capacity / 2))
  const labelWidth = Math.max(...names.map((name) => visibleWidth(name)))
  for (
    let index = windowStart;
    index < Math.min(names.length, windowStart + capacity);
    index += 1
  ) {
    const name = names[index]
    const selected = index === safeIndex
    const isCommitted = name === committed
    const theme = name === TUI_AUTO_THEME_NAME ? undefined : resolveTuiTheme(name)
    // Grok flags which of its themes need 24-bit colour. Worth surfacing at the
    // moment of choice rather than after the ground silently fails to appear.
    const unavailable = theme?.requiresTruecolor && ansi.mode !== 'truecolor'
    const summary = theme ? theme.summary : 'Follow the terminal’s own light or dark appearance.'
    const note = unavailable ? ' (needs truecolor)' : ''
    const label = `${name}${' '.repeat(Math.max(0, labelWidth - visibleWidth(name)))}`
    const marked = isCommitted ? ansi.bold(label) : label
    const line = `${selected ? glyphs.selection : ' '} ${marked}  ${ansi.dim(`${summary}${note}`)}`
    lines.push(borderedLine(line, width, ansi, glyphs))
  }
  lines.push(borderedLine(ansi.dim('↑↓ preview · Enter keep · Esc revert'), width, ansi, glyphs))
  lines.push(borderBottom(width, ansi, glyphs))
  return lines.slice(0, Math.max(1, height))
}

function renderHelpOverlay(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const sep = ` ${glyphs.separator} `
  const commands = filterTuiSlashCommands(state.commandPaletteQuery ?? state.input)
  const capacity = Math.max(1, height - 4)
  const safeIndex = Math.max(0, Math.min(state.overlayIndex, Math.max(0, commands.length - 1)))
  const windowStart = Math.max(
    0,
    Math.min(Math.max(0, commands.length - capacity), safeIndex - Math.floor(capacity / 2))
  )
  const lines = [borderTitle('Commands', width, ansi, glyphs)]
  if (!commands.length) {
    lines.push(borderedLine(ansi.dim('No matching slash commands.'), width, ansi, glyphs))
  } else {
    for (
      let index = windowStart;
      index < Math.min(commands.length, windowStart + capacity);
      index += 1
    ) {
      const command = commands[index]
      const label = command.aliases.length
        ? `${command.usage}${sep}${command.aliases.join(` ${glyphs.separator} `)}`
        : command.usage
      const caution = command.destructive ? `${sep}confirm after completion` : ''
      const row = overlayValue(label, `${command.description}${caution}`, width, ansi, glyphs)
      lines.push(index === safeIndex ? ansi.inverse(row) : row)
    }
  }
  lines.push(
    borderedLine(
      ansi.dim(`↑↓ / PgUp/PgDn choose${sep}Enter open${sep}Tab complete${sep}Esc close`),
      width,
      ansi,
      glyphs
    )
  )
  lines.push(
    borderedLine(
      ansi.dim(`Ctrl+P reopens${sep}the TaskWraith Host owns thread state`),
      width,
      ansi,
      glyphs
    )
  )
  lines.push(borderBottom(width, ansi, glyphs))
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
  const home = state.homeTune
  if (home) {
    const lines = [borderTitle(thread ? 'Model' : 'Default model', width, ansi, glyphs)]
    if (home.loading) {
      lines.push(borderedLine(ansi.dim('Fetching ready-provider offers…'), width, ansi, glyphs))
    } else if (home.error) {
      lines.push(
        borderedLine(tone(ansi, terminalLabel(home.error), 'warning'), width, ansi, glyphs)
      )
    } else {
      const choices = tuiModelChoices(home.providers)
      const choice = choices[home.modelIndex]
      const provider = choice?.provider
      const model = choice?.model
      const presentation = resolveTaskWraithProviderPresentation(
        provider?.status.providerId,
        model?.modelId,
        model?.label
      )
      const capacity = Math.max(1, height - 4)
      const start = Math.max(0, home.modelIndex - Math.floor(capacity / 2))
      for (let index = start; index < Math.min(choices.length, start + capacity); index += 1) {
        const candidate = choices[index]
        const selected = index === home.modelIndex
        const candidatePresentation = resolveTaskWraithProviderPresentation(
          candidate.provider.status.providerId,
          candidate.model.modelId,
          candidate.model.label
        )
        const providerLabel = terminalLabel(candidate.provider.status.label)
        const modelLabel = terminalLabel(candidate.model.label)
        const label = modelLabel.toLowerCase().startsWith(providerLabel.toLowerCase())
          ? modelLabel
          : `${providerLabel} ${modelLabel}`
        const current =
          thread?.provider.runtimeProvider === candidate.provider.status.providerId &&
          thread.provider.model === candidate.model.modelId
        const suffix = [current ? 'current' : '', candidate.model.default ? 'Host default' : '']
          .filter(Boolean)
          .join(' · ')
        const line = `${selected ? glyphs.selection : ' '} ${ansi.provider(
          label,
          candidatePresentation.accent,
          current
        )}${suffix ? ` ${ansi.dim(`(${suffix})`)}` : ''}`
        lines.push(borderedLine(selected ? ansi.inverse(line) : line, width, ansi, glyphs))
      }
      const reasoning = model?.reasoning.filter((candidate) => candidate.available) ?? []
      const reasoningRows = [
        home.reasoningIndex === -1
          ? ansi.provider('[provider default]', presentation.accent)
          : 'provider default',
        ...reasoning.map((candidate, index) =>
          index === home.reasoningIndex
            ? ansi.provider(`[${terminalLabel(candidate.label)}]`, presentation.accent)
            : terminalLabel(candidate.label)
        )
      ].join(` ${ansi.dim(glyphs.separator)} `)
      lines.push(overlayValue('reasoning', reasoningRows, width, ansi, glyphs))
    }
    lines.push(
      borderedLine(
        ansi.dim(
          `↑↓ model · ←→ reasoning · Enter ${thread ? 'switch' : 'save default'} · Esc close`
        ),
        width,
        ansi,
        glyphs
      )
    )
    lines.push(borderBottom(width, ansi, glyphs))
    return lines.slice(0, Math.max(1, height))
  }
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

function renderProviderLoginOverlay(
  state: TaskWraithTuiState,
  width: number,
  height: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string[] {
  const login = state.providerLogin
  const lines = [borderTitle('Provider setup', width, ansi, glyphs)]
  if (!login || login.loading) {
    lines.push(
      borderedLine(ansi.dim('Reading provider status from the Host…'), width, ansi, glyphs)
    )
  } else if (login.error) {
    lines.push(borderedLine(tone(ansi, terminalLabel(login.error), 'error'), width, ansi, glyphs))
  }
  if (login?.providers.length) {
    const selectedIndex = Math.max(
      0,
      login.providers.findIndex((provider) => provider.providerId === login.selectedProviderId)
    )
    const capacity = Math.max(1, Math.min(8, height - 8))
    const start = Math.max(0, selectedIndex - Math.floor(capacity / 2))
    for (
      let index = start;
      index < Math.min(login.providers.length, start + capacity);
      index += 1
    ) {
      const provider = login.providers[index]
      const selected = index === selectedIndex
      const statusTone =
        provider.status === 'ready'
          ? 'good'
          : provider.status === 'auth_required'
            ? 'warning'
            : provider.status === 'unavailable'
              ? 'error'
              : 'neutral'
      const row = `${selected ? glyphs.selection : ' '} ${terminalLabel(provider.label)} ${tone(
        ansi,
        provider.status.replace('_', ' '),
        statusTone
      )}`
      lines.push(borderedLine(selected ? ansi.inverse(row) : row, width, ansi, glyphs))
    }
    const provider = login.providers[selectedIndex]
    if (login.authStatus) {
      lines.push(
        overlayValue(
          'auth',
          terminalLabel(login.authStatus.state.replace('_', ' ')),
          width,
          ansi,
          glyphs
        )
      )
    }
    if (login.flows.length) {
      const flows = login.flows
        .map((flow, index) =>
          index === login.flowIndex
            ? ansi.inverse(`[${terminalLabel(flow.label)}]`)
            : terminalLabel(flow.label)
        )
        .join(` ${ansi.dim(glyphs.separator)} `)
      lines.push(overlayValue('flow', flows, width, ansi, glyphs))
      const detail = login.flows[login.flowIndex]?.detail
      if (detail) lines.push(borderedLine(ansi.dim(terminalLabel(detail)), width, ansi, glyphs))
    } else if (!login.loading) {
      for (const wrapped of wrapPlainText(
        providerLoginGuidance(provider),
        Math.max(8, width - 4)
      )) {
        lines.push(borderedLine(ansi.dim(terminalLabel(wrapped)), width, ansi, glyphs))
      }
    }
  }
  lines.push(
    borderedLine(
      ansi.dim('↑↓ provider · Tab flow · Enter sign in/refresh · r refresh · Esc close'),
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
  if (state.overlay === 'setup') {
    return renderSetupOverlay(state, width, ansi, glyphs).slice(0, Math.max(1, height))
  }
  if (state.overlay === 'login') {
    return renderProviderLoginOverlay(state, width, height, ansi, glyphs)
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
  if (state.overlay === 'workspaces') {
    return renderWorkspacesOverlay(state, width, height, ansi, glyphs)
  }
  if (state.overlay === 'theme') {
    return renderThemeOverlay(state, width, height, ansi, glyphs)
  }
  if (state.overlay === 'goal') {
    return renderGoalOverlay(state, width, height, ansi, glyphs)
  }
  return renderHelpOverlay(state, width, height, ansi, glyphs)
}

function renderContextMeter(
  thread: TaskWraithControlThread,
  width: number,
  ansi: Ansi
): string | undefined {
  const used = thread.tokenEstimate
  const provider = thread.provider.runtimeProvider
  if (!Number.isFinite(used) || Number(used) < 0 || !isContextWindowProviderId(provider)) {
    return undefined
  }
  const window = resolveContextWindow(provider, thread.provider.model)
  const percent = Math.round(contextPercent(Number(used), window))
  if (width < 96) return ansi.dim(`ctx ${percent}%`)
  const formatHudContextTokens = (value: number): string =>
    formatContextTokens(value).replace(/\.0M$/, 'M')
  return ansi.dim(
    `context: ${percent}% (≈${formatHudContextTokens(Math.round(Number(used)))}/${formatHudContextTokens(window)})`
  )
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
    const workspace = homeWorkspace(state)
    const left = workspace
      ? ansi.bold(terminalLabel(workspace.path || workspace.name))
      : ansi.bold('TaskWraith')
    // Wave 4.2b: deferred thread.select has no thread yet — still show the Host ask.
    if (state.notice && (!state.notice.expiresAt || state.notice.expiresAt > now)) {
      return joinLeftRight(
        left,
        tone(ansi, terminalLabel(state.notice.text), state.notice.tone),
        width
      )
    }
    return joinLeftRight(left, connection, width)
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
  const queuedDrafts = queuedDraftsForThread(state, thread.id)
  const blockedDraft = queuedDrafts.find((draft) => draft.phase === 'blocked')
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
  const contextMeter = renderContextMeter(thread, width, ansi)
  const right = [
    ansi.provider(provider, presentation.provider.accent),
    model,
    pending,
    reasoningText,
    status,
    blockedDraft
      ? tone(
          ansi,
          `QUEUE BLOCKED${blockedDraft.error ? ` · ${terminalLabel(blockedDraft.error)}` : ''}`,
          'error'
        )
      : queuedDrafts.length
        ? ansi.dim(`${queuedDrafts.length} QUEUED`)
        : undefined,
    elapsed !== '—' ? elapsed : undefined,
    cost,
    contextMeter
  ]
    .filter(Boolean)
    .join(ansi.dim(density.segmentSpacing === 'padded' ? ` ${glyphs.separator} ` : ' '))
  return joinLeftRight(left, right, width)
}

function selectedPermissionPostureId(state: TaskWraithTuiState): string {
  const threadPermission = state.thread?.context.permission
  if (threadPermission) return threadPermission
  const cold = state.coldStart
  if (cold?.kind === 'configure') {
    return cold.offers.postures[state.coldStartPostureIndex ?? 0]?.postureId ?? 'default'
  }
  if (state.homeTune) {
    return (
      resolveTuiHomePosture(
        state.homeTune.providers,
        state.homeTune.modelIndex,
        state.homePermission
      )?.postureId ?? 'default'
    )
  }
  return 'default'
}

function renderComposerDivider(
  state: TaskWraithTuiState,
  width: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet,
  withLabel: boolean
): string {
  const postureId = selectedPermissionPostureId(state)
  const color = permissionColor(ansi, postureId)
  const rule = glyphs.boxHorizontal
  if (!withLabel) return fitAnsiLine(ansi.color(rule.repeat(width), color), width)
  const label = ` ${permissionLabel(postureId)} `
  const tail = 2
  const lead = Math.max(0, width - visibleWidth(label) - tail)
  return fitAnsiLine(ansi.color(`${rule.repeat(lead)}${label}${rule.repeat(tail)}`, color), width)
}

function renderComposer(
  state: TaskWraithTuiState,
  width: number,
  ansi: Ansi,
  glyphs: TuiGlyphSet
): string {
  const accent =
    state.thread?.thread.provider.accent ??
    permissionColor(ansi, selectedPermissionPostureId(state))
  const prompt = ansi.provider(glyphs.promptCaret, accent)
  const density = resolveTuiDensity(width)
  const pendingApproval = selectedPendingApproval(state)
  const openQuestion = selectedOpenQuestion(state)
  const setupRequired = Boolean(state.coldStart && state.coldStart.kind !== 'ready')
  const queuedDrafts = queuedDraftsForThread(state, state.selectedThreadId)
  const homeChoice = state.homeTune
    ? tuiModelChoices(state.homeTune.providers)[state.homeTune.modelIndex]
    : undefined
  const canCyclePermission = Boolean(
    state.connection === 'connected' &&
    ((state.selectedThreadId && state.thread) ||
      (!state.selectedThreadId &&
        homeChoice?.provider.offers.postures.some((posture) => posture.available)))
  )
  const live = Boolean(
    state.selectedThreadId &&
    state.hostProjection &&
    state.hostProjection.freshness === 'live' &&
    (state.hostProjection.runs.some(
      (run) =>
        run.threadId === state.selectedThreadId &&
        run.endedAt === undefined &&
        (run.providerOutcome === 'running' ||
          run.providerOutcome === 'requires_action' ||
          run.providerOutcome === 'unknown')
    ) ||
      state.hostProjection.rounds.some(
        (round) =>
          round.threadId === state.selectedThreadId &&
          round.endedAt === undefined &&
          (round.status === 'running' || round.status === 'unknown')
      ))
  )
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
        : live
          ? ansi.dim(
              `${glyphs.newline} queue${sep}Esc steer${
                queuedDrafts.length ? `${sep}${queuedDrafts.length} waiting` : ''
              }`
            )
          : density.composerHints === 'full'
            ? ansi.dim(
                `${glyphs.newline} send${
                  canCyclePermission ? `${sep}Shift+Tab permissions` : ''
                }${sep}^O context${sep}^K threads`
              )
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
  const theme = options.theme ?? TUI_UNPAINTED_THEME
  // One toned clone per frame, handed to every helper in place of the caller's
  // bare instance. This is how the theme's state tones reach thirteen colour
  // sites without a new argument on sixteen internal signatures.
  const ansi = options.ansi.withTones(theme.tone)
  const thread = state.thread?.thread
  const footerRows = TUI_LAYOUT.soloFooterRows
  const canvasHeight = Math.max(1, height - footerRows)
  let canvas =
    state.overlay === 'none'
      ? renderTranscriptCanvas(state, width, canvasHeight, ansi, animationEnabled, glyphs)
      : renderOverlay(state, width, canvasHeight, ansi, glyphs)
  if (canvas.length > canvasHeight) canvas = canvas.slice(0, canvasHeight)
  if (canvas.length < canvasHeight) {
    canvas = [...canvas, ...Array.from({ length: canvasHeight - canvas.length }, () => '')]
  }
  const footer: string[] = []
  footer.push(renderComposerDivider(state, width, ansi, glyphs, true))
  footer.push(renderComposer(state, width, ansi, glyphs))
  footer.push(renderComposerDivider(state, width, ansi, glyphs, false))
  footer.push(renderHud(state, thread, width, ansi, now, glyphs))

  // Region grounds, deepest first. An overlay raises the canvas to `surface`
  // rather than drawing a floating panel over `background`: the TUI has no
  // z-order to cast a shadow with, so depth has to be carried by the fill the
  // overlay replaces the canvas with.
  const ground = theme.ground
  const ink = theme.ink?.primary
  const canvasGround = state.overlay === 'none' ? ground?.background : ground?.surface

  const lines = [...canvas, ...footer].slice(0, height)
  const grounds = [
    ...canvas.map(() => canvasGround),
    ground?.surface,
    ground?.surface,
    ground?.surface,
    ground?.panel
  ].slice(0, height)
  while (lines.length < height) {
    lines.push('')
    grounds.push(canvasGround)
  }
  return lines
    .map((line, index) => ansi.paint(fitAnsiLine(line, width), grounds[index], ink))
    .join('\n')
}
