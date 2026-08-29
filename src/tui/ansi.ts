import type { TuiThemeTone } from './palette'

export type AnsiColorMode = 'truecolor' | 'ansi256' | 'none'

const ANSI_ESCAPE_PATTERN = String.raw`\u001b\[[0-?]*[ -/]*[@-~]`
const ESCAPE_SEQUENCE = new RegExp(ANSI_ESCAPE_PATTERN, 'g')
const ESCAPE_SEQUENCE_AT_START = new RegExp(`^${ANSI_ESCAPE_PATTERN}`)
const TERMINAL_CONTROL_CHARACTERS = new RegExp(
  String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]`,
  'g'
)

/**
 * "Back to the default foreground."
 *
 * Kept as its own code rather than folded into a combined reset because
 * `Ansi.paint` rewrites every occurrence: inside a painted region the default
 * foreground is the region's ink, not the terminal's. A combined `39;22;27`
 * would hide the 39 from that rewrite, and the hole it left would show up as
 * one stretch of unthemed text per truncated line.
 */
const FOREGROUND_RESET = '\u001b[39m'

/**
 * Attribute reset that deliberately leaves the background alone.
 *
 * Region painting wraps a whole finished line in a background colour. A bare
 * full reset inside that span punches a hole in the fill and the terminal's own
 * ground shows through mid-line — which is exactly what ragged, half-painted
 * chrome looks like. This clears precisely what `Ansi` can set: foreground,
 * bold/dim (22), inverse (27). Nothing else.
 */
const ATTRIBUTE_RESET = `${FOREGROUND_RESET}\u001b[22m\u001b[27m`

/** Full reset. Only ever emitted as the last thing on a finished line. */
const LINE_RESET = '\u001b[0m'

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

export function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return [152, 103, 129]
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16)
  ]
}

export function mixHex(left: string, right: string, amount: number): string {
  const a = hexToRgb(left)
  const b = hexToRgb(right)
  const t = Math.max(0, Math.min(1, amount))
  const channels = a.map((channel, index) => clampByte(channel + (b[index] - channel) * t))
  return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

function rgbToAnsi256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return Math.round(((r - 8) / 247) * 24) + 232
  }
  const toCube = (value: number) => Math.round((value / 255) * 5)
  return 16 + 36 * toCube(r) + 6 * toCube(g) + toCube(b)
}

export function detectAnsiColorMode(
  env: NodeJS.ProcessEnv = process.env,
  isTty = Boolean(process.stdout.isTTY)
): AnsiColorMode {
  if (!isTty || 'NO_COLOR' in env || env.TERM === 'dumb') return 'none'
  const colorTerm = String(env.COLORTERM || '').toLowerCase()
  if (colorTerm.includes('truecolor') || colorTerm.includes('24bit')) return 'truecolor'
  return 'ansi256'
}

export class Ansi {
  /**
   * `tones` is the active theme's state palette.
   *
   * It rides on this object rather than being threaded as a parameter because
   * `Ansi` is already the "how to colour" context every render helper receives,
   * and the alternative was a new argument on sixteen internal signatures.
   *
   * The import above is type-only and therefore erased, so `palette.ts` can go
   * on importing this module's colour maths without a runtime cycle.
   */
  constructor(
    readonly mode: AnsiColorMode,
    readonly tones?: TuiThemeTone
  ) {}

  /** A clone carrying a theme's tones. The renderer makes one per frame. */
  withTones(tones: TuiThemeTone): Ansi {
    return new Ansi(this.mode, tones)
  }

  private foregroundPrefix(hex: string): string {
    const [r, g, b] = hexToRgb(hex)
    return this.mode === 'truecolor'
      ? `\u001b[38;2;${r};${g};${b}m`
      : `\u001b[38;5;${rgbToAnsi256(r, g, b)}m`
  }

  get enabled(): boolean {
    return this.mode !== 'none'
  }

  color(text: string, hex: string): string {
    if (!this.enabled || !text) return text
    return `${this.foregroundPrefix(hex)}${text}${FOREGROUND_RESET}`
  }

  bold(text: string): string {
    return this.enabled && text ? `\u001b[1m${text}\u001b[22m` : text
  }

  dim(text: string): string {
    return this.enabled && text ? `\u001b[2m${text}\u001b[22m` : text
  }

  inverse(text: string): string {
    return this.enabled && text ? `\u001b[7m${text}\u001b[27m` : text
  }

  provider(text: string, accent: string, bold = true): string {
    const colored = this.color(text, accent)
    return bold ? this.bold(colored) : colored
  }

  private backgroundPrefix(hex: string): string {
    const [r, g, b] = hexToRgb(hex)
    return this.mode === 'truecolor'
      ? `\u001b[48;2;${r};${g};${b}m`
      : `\u001b[48;5;${rgbToAnsi256(r, g, b)}m`
  }

  /**
   * Paint a background behind a span of text.
   *
   * Prefer `paint` for chrome: a bare `on()` span leaves the rest of the row on
   * the terminal's own ground, which reads as a rendering fault rather than a
   * highlight. This exists for genuinely span-shaped fills (a selected cell).
   */
  on(text: string, hex: string): string {
    if (!this.enabled || !text) return text
    return `${this.backgroundPrefix(hex)}${text}\u001b[49m`
  }

  /**
   * Finish one already-width-fitted line: region ground behind it, region ink
   * in front of it.
   *
   * Ground and ink travel together on purpose. Painting a ground while leaving
   * the foreground to the terminal is the one combination that can render a
   * theme unreadable — a light theme on a terminal whose default foreground is
   * white writes white on near-white — so a theme that supplies one normally
   * supplies both, and either may be `undefined` to decline.
   *
   * `undefined` for both is the honest no-theme answer, not an error: the line
   * comes back untouched and the terminal's own colours show through, which is
   * the pre-theme behaviour exactly.
   *
   * The line must already be padded to the full region width. An unpadded line
   * paints a stub of colour and leaves a ragged edge where the fill stops.
   */
  paint(line: string, ground: string | undefined, ink: string | undefined): string {
    if (!this.enabled || (!ground && !ink)) return line
    let body = line
    if (ink) {
      const inkPrefix = this.foregroundPrefix(ink)
      body = `${inkPrefix}${body.replaceAll(FOREGROUND_RESET, inkPrefix)}`
    }
    if (ground) body = `${this.backgroundPrefix(ground)}${body}`
    return `${body}${LINE_RESET}`
  }
}

export function stripAnsi(value: string): string {
  return value.replace(ESCAPE_SEQUENCE, '')
}

export function visibleWidth(value: string): number {
  return Array.from(stripAnsi(value)).length
}

export function truncateAnsi(value: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return ''
  if (visibleWidth(value) <= width) return value
  const target = Math.max(0, width - visibleWidth(ellipsis))
  let visible = 0
  let out = ''
  for (let index = 0; index < value.length && visible < target; ) {
    if (value[index] === '\u001b') {
      const match = value.slice(index).match(ESCAPE_SEQUENCE_AT_START)
      if (match) {
        out += match[0]
        index += match[0].length
        continue
      }
    }
    const codePoint = String.fromCodePoint(value.codePointAt(index) as number)
    out += codePoint
    index += codePoint.length
    visible += 1
  }
  const reset = value.includes('\u001b[') ? ATTRIBUTE_RESET : ''
  return `${out}${reset}${ellipsis}`
}

export function padAnsi(value: string, width: number): string {
  const clipped = truncateAnsi(value, width)
  return `${clipped}${' '.repeat(Math.max(0, width - visibleWidth(clipped)))}`
}

export function fitAnsiLine(value: string, width: number): string {
  return padAnsi(value.replace(/[\r\n]/g, ' '), Math.max(1, width))
}

export function sanitizeTerminalText(value: string): string {
  return String(value || '')
    .replaceAll('\u001b', '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(TERMINAL_CONTROL_CHARACTERS, '')
}

export function wrapPlainText(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const output: string[] = []
  for (const paragraph of sanitizeTerminalText(value).split('\n')) {
    if (!paragraph) {
      output.push('')
      continue
    }
    let remaining = paragraph
    while (Array.from(remaining).length > safeWidth) {
      const chars = Array.from(remaining)
      let split = chars
        .slice(0, safeWidth + 1)
        .join('')
        .lastIndexOf(' ')
      if (split <= 0) split = safeWidth
      output.push(chars.slice(0, split).join('').trimEnd())
      remaining = chars.slice(split).join('').trimStart()
    }
    output.push(remaining)
  }
  return output.length ? output : ['']
}

export function joinLeftRight(left: string, right: string, width: number): string {
  const safeWidth = Math.max(1, width)
  const rightWidth = Math.min(visibleWidth(right), safeWidth)
  const fittedRight = truncateAnsi(right, rightWidth, '')
  const leftWidth = Math.max(0, safeWidth - rightWidth - (rightWidth ? 1 : 0))
  const fittedLeft = truncateAnsi(left, leftWidth)
  const gap = Math.max(1, safeWidth - visibleWidth(fittedLeft) - visibleWidth(fittedRight))
  return fitAnsiLine(`${fittedLeft}${' '.repeat(gap)}${fittedRight}`, safeWidth)
}

/**
 * WCAG relative luminance, 0 (black) to 1 (white).
 *
 * Two callers, both load-bearing: classifying a terminal's own background as
 * dark or light (the OSC 11 reply is an arbitrary colour, not a polarity), and
 * scoring whether a provider accent is still legible on a theme's ground.
 */
export function relativeLuminance(hex: string): number {
  const linearize = (channel: number): number => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const [red, green, blue] = hexToRgb(hex)
  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue)
}

/**
 * WCAG contrast ratio between two colours: 1 for identical, 21 for black on
 * white. Order-independent.
 */
export function contrastRatio(left: string, right: string): number {
  const a = relativeLuminance(left)
  const b = relativeLuminance(right)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/**
 * Lift or darken `hex` toward legibility on `ground` **without moving its hue**.
 *
 * Mixing a colour toward pure white or pure black in RGB scales every channel's
 * distance from the extreme by the same factor, so the ratio
 * `(channel - min) / (max - min)` — which is what hue *is* — comes out
 * unchanged. That is the whole reason this walks toward a pole rather than
 * recolouring: TaskWraith provider accents are cross-surface identity, pinned to
 * the desktop `theme.css` and iOS `Theme.swift`. A theme may make Codex purple
 * readable on its ground; it may not make Codex a different colour.
 *
 * Returns the original when it already clears `minimumRatio`, and the closest it
 * could get when even the pole falls short (a mid-grey ground cannot carry every
 * hue at ratio 4.5, and returning something legible-ish beats returning black).
 */
export function adaptToneForGround(hex: string, ground: string, minimumRatio: number): string {
  if (contrastRatio(hex, ground) >= minimumRatio) return hex
  const pole = relativeLuminance(ground) < 0.5 ? '#ffffff' : '#000000'
  let best = hex
  let bestRatio = contrastRatio(hex, ground)
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mixHex(hex, pole, step / 20)
    const ratio = contrastRatio(candidate, ground)
    if (ratio > bestRatio) {
      best = candidate
      bestRatio = ratio
    }
    if (ratio >= minimumRatio) return candidate
  }
  return best
}
