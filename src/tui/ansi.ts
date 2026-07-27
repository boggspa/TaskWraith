export type AnsiColorMode = 'truecolor' | 'ansi256' | 'none'

const ANSI_ESCAPE_PATTERN = String.raw`\u001b\[[0-?]*[ -/]*[@-~]`
const ESCAPE_SEQUENCE = new RegExp(ANSI_ESCAPE_PATTERN, 'g')
const ESCAPE_SEQUENCE_AT_START = new RegExp(`^${ANSI_ESCAPE_PATTERN}`)
const TERMINAL_CONTROL_CHARACTERS = new RegExp(
  String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]`,
  'g'
)

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
  constructor(readonly mode: AnsiColorMode) {}

  get enabled(): boolean {
    return this.mode !== 'none'
  }

  color(text: string, hex: string): string {
    if (!this.enabled || !text) return text
    const [r, g, b] = hexToRgb(hex)
    const prefix =
      this.mode === 'truecolor'
        ? `\u001b[38;2;${r};${g};${b}m`
        : `\u001b[38;5;${rgbToAnsi256(r, g, b)}m`
    return `${prefix}${text}\u001b[39m`
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
  const reset = value.includes('\u001b[') ? '\u001b[0m' : ''
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
