/**
 * RFC 5322 / basic-MIME .eml codec for the Mail editor.
 *
 * Import handles the shapes real exports produce (Gmail "Show original",
 * Outlook "Save as", Apple Mail drag-out): folded headers, RFC 2047
 * encoded-words, quoted-printable / base64 transfer encodings, and one level
 * of multipart nesting (picks text/plain, falls back to de-tagged text/html).
 * Export writes a single-part UTF-8 quoted-printable message every client can
 * open. Unrecognized top-level headers round-trip via `extraHeaders`.
 */

import type { MailDocumentModel, MailHeader } from './officeModels'

export interface EmlParseResult {
  model: MailDocumentModel
  warnings: string[]
}

interface RawHeader {
  name: string
  value: string
}

const MODELED_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'bcc',
  'subject',
  'date',
  'mime-version',
  'content-type',
  'content-transfer-encoding'
])

function splitHeadersAndBody(text: string): { headerLines: string[]; body: string } {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const divider = normalized.indexOf('\n\n')
  const headerBlock = divider === -1 ? normalized : normalized.slice(0, divider)
  const body = divider === -1 ? '' : normalized.slice(divider + 2)
  return { headerLines: headerBlock.split('\n'), body }
}

function unfoldHeaders(headerLines: string[]): RawHeader[] {
  const headers: RawHeader[] = []
  for (const line of headerLines) {
    if (line === '') continue
    if ((line.startsWith(' ') || line.startsWith('\t')) && headers.length > 0) {
      headers[headers.length - 1].value += ` ${line.trim()}`
      continue
    }
    const colon = line.indexOf(':')
    if (colon === -1) continue
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() })
  }
  return headers
}

const headerValue = (headers: RawHeader[], name: string): string =>
  headers.find((header) => header.name.toLowerCase() === name)?.value ?? ''

/** RFC 2047 encoded-word decoding: =?charset?B|Q?payload?= */
export function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s+(?==\?))?/g,
    (match, _charset: string, encoding: string, payload: string) => {
      try {
        if (encoding.toLowerCase() === 'b') {
          return decodeUtf8Bytes(base64ToBytes(payload))
        }
        const bytes: number[] = []
        for (let index = 0; index < payload.length; index += 1) {
          const char = payload[index]
          if (char === '_') bytes.push(0x20)
          else if (char === '=' && index + 2 < payload.length + 1) {
            const hex = payload.slice(index + 1, index + 3)
            const code = Number.parseInt(hex, 16)
            if (Number.isFinite(code)) {
              bytes.push(code)
              index += 2
            }
          } else bytes.push(char.charCodeAt(0))
        }
        return decodeUtf8Bytes(Uint8Array.from(bytes))
      } catch {
        return match
      }
    }
  )
}

function base64ToBytes(payload: string): Uint8Array {
  const clean = payload.replace(/[^A-Za-z0-9+/=]/g, '')
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of clean) {
    if (char === '=') break
    const value = alphabet.indexOf(char)
    if (value === -1) continue
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(bytes)
}

function decodeUtf8Bytes(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

export function decodeQuotedPrintable(body: string): string {
  const bytes: number[] = []
  const source = body.replace(/=\n/g, '').replace(/=\r\n/g, '')
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]
    if (char === '=' && index + 2 < source.length + 1) {
      const hex = source.slice(index + 1, index + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        index += 2
        continue
      }
    }
    const code = char.codePointAt(0) ?? 0
    if (code > 0x7f) {
      // Already-decoded unicode text mixed in: encode back to UTF-8 bytes.
      for (const byte of new TextEncoder().encode(char)) bytes.push(byte)
      if (code > 0xffff) index += 1
    } else {
      bytes.push(code)
    }
  }
  return decodeUtf8Bytes(Uint8Array.from(bytes))
}

interface ContentTypeInfo {
  mediaType: string
  boundary?: string
  charset?: string
}

function parseContentType(value: string): ContentTypeInfo {
  const segments = value.split(';')
  const mediaType = (segments[0] ?? '').trim().toLowerCase() || 'text/plain'
  const info: ContentTypeInfo = { mediaType }
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf('=')
    if (eq === -1) continue
    const name = segment.slice(0, eq).trim().toLowerCase()
    const raw = segment.slice(eq + 1).trim()
    const bare = raw.replace(/^"|"$/g, '')
    if (name === 'boundary') info.boundary = bare
    if (name === 'charset') info.charset = bare.toLowerCase()
  }
  return info
}

function decodeBodyPart(body: string, transferEncoding: string): string {
  const encoding = transferEncoding.trim().toLowerCase()
  if (encoding === 'base64') return decodeUtf8Bytes(base64ToBytes(body))
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body)
  return body
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface ExtractedBody {
  text: string
  warnings: string[]
}

function extractBody(headers: RawHeader[], body: string, depth: number): ExtractedBody {
  const contentType = parseContentType(headerValue(headers, 'content-type'))
  const transferEncoding = headerValue(headers, 'content-transfer-encoding')

  if (contentType.mediaType.startsWith('multipart/') && contentType.boundary && depth < 3) {
    const marker = `--${contentType.boundary}`
    const segments = body.split(new RegExp(`^${escapeRegExp(marker)}(?:--)?[ \\t]*$`, 'm'))
    const parts: { headers: RawHeader[]; body: string }[] = []
    for (const segment of segments.slice(1)) {
      const trimmed = segment.replace(/^\n/, '')
      if (!trimmed.trim()) continue
      const { headerLines, body: partBody } = splitHeadersAndBody(trimmed)
      parts.push({ headers: unfoldHeaders(headerLines), body: partBody })
    }
    const scored = parts
      .map((part) => ({ part, type: parseContentType(headerValue(part.headers, 'content-type')) }))
      .filter(({ type }) => !type.mediaType.startsWith('multipart/') || depth < 2)
    const plain = scored.find(({ type }) => type.mediaType === 'text/plain')
    if (plain) return extractBody(plain.part.headers, plain.part.body, depth + 1)
    const nestedMultipart = scored.find(({ type }) => type.mediaType.startsWith('multipart/'))
    if (nestedMultipart) {
      return extractBody(nestedMultipart.part.headers, nestedMultipart.part.body, depth + 1)
    }
    const html = scored.find(({ type }) => type.mediaType === 'text/html')
    if (html) {
      const decoded = extractBody(html.part.headers, html.part.body, depth + 1)
      return {
        text: stripHtmlTags(decoded.text),
        warnings: [...decoded.warnings, 'HTML-only email; converted to plain text.']
      }
    }
    return { text: '', warnings: ['No readable text part found; attachments are not imported.'] }
  }

  const decoded = decodeBodyPart(body, transferEncoding)
  if (contentType.mediaType === 'text/html') {
    return { text: stripHtmlTags(decoded), warnings: ['HTML email converted to plain text.'] }
  }
  const warnings: string[] = []
  if (
    contentType.charset &&
    !['utf-8', 'us-ascii', 'ascii', 'utf8'].includes(contentType.charset)
  ) {
    warnings.push(`Charset ${contentType.charset} decoded as UTF-8 best-effort.`)
  }
  return { text: decoded, warnings }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function parseEml(text: string): EmlParseResult {
  const { headerLines, body } = splitHeadersAndBody(text)
  const headers = unfoldHeaders(headerLines)
  const extracted = extractBody(headers, body, 0)

  const extraHeaders: MailHeader[] = headers
    .filter((header) => !MODELED_HEADERS.has(header.name.toLowerCase()))
    .map((header) => ({ name: header.name, value: header.value }))

  const model: MailDocumentModel = {
    kind: 'mail',
    from: decodeEncodedWords(headerValue(headers, 'from')),
    to: decodeEncodedWords(headerValue(headers, 'to')),
    cc: decodeEncodedWords(headerValue(headers, 'cc')),
    bcc: decodeEncodedWords(headerValue(headers, 'bcc')),
    subject: decodeEncodedWords(headerValue(headers, 'subject')),
    body: extracted.text.replace(/\n+$/, '')
  }
  const date = headerValue(headers, 'date')
  if (date) model.date = date
  if (extraHeaders.length > 0) model.extraHeaders = extraHeaders
  return { model, warnings: extracted.warnings }
}

/** Quoted-printable encoding with soft line breaks at 76 chars (RFC 2045 6.7). */
export function encodeQuotedPrintable(text: string): string {
  const bytes = new TextEncoder().encode(text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'))
  let encoded = ''
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]
    if (byte === 0x0d && bytes[index + 1] === 0x0a) {
      encoded += '\r\n'
      index += 1
      continue
    }
    const isPrintable = (byte >= 33 && byte <= 126 && byte !== 61) || byte === 32 || byte === 9
    encoded += isPrintable
      ? String.fromCharCode(byte)
      : `=${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  // Soft-wrap lines to 76 chars without splitting an =XX escape.
  const lines = encoded.split('\r\n').map((line) => {
    let wrapped = ''
    let current = line
    while (current.length > 75) {
      let cut = 75
      if (current[cut - 1] === '=') cut -= 1
      else if (current[cut - 2] === '=') cut -= 2
      wrapped += `${current.slice(0, cut)}=\r\n`
      current = current.slice(cut)
    }
    // Trailing whitespace must be encoded at line end.
    const finished = current.replace(/([ \t])$/, (char) => (char === ' ' ? '=20' : '=09'))
    return wrapped + finished
  })
  return lines.join('\r\n')
}

/** RFC 2047 B-encoding for non-ASCII header values. */
function encodeHeaderValue(value: string): string {
  if (!/[^\u0020-\u007E]/.test(value)) return value
  const base64 = bytesToBase64(new TextEncoder().encode(value))
  return `=?utf-8?B?${base64}?=`
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]
    const b = bytes[index + 1]
    const c = bytes[index + 2]
    out += alphabet[a >> 2]
    out += alphabet[((a & 0x03) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : alphabet[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : alphabet[c & 0x3f]
  }
  return out
}

export interface BuildEmlOptions {
  /** RFC 5322 Date header; injectable for deterministic tests. */
  date?: string
}

export function buildEml(model: MailDocumentModel, options: BuildEmlOptions = {}): string {
  const lines: string[] = []
  const push = (name: string, value: string): void => {
    if (value.trim()) lines.push(`${name}: ${encodeHeaderValue(value.trim())}`)
  }
  push('From', model.from)
  push('To', model.to)
  push('Cc', model.cc)
  push('Bcc', model.bcc)
  lines.push(`Subject: ${encodeHeaderValue(model.subject)}`)
  const date = options.date ?? model.date
  if (date) lines.push(`Date: ${date}`)
  for (const header of model.extraHeaders ?? []) {
    if (MODELED_HEADERS.has(header.name.toLowerCase())) continue
    lines.push(`${header.name}: ${header.value}`)
  }
  lines.push('MIME-Version: 1.0')
  lines.push('Content-Type: text/plain; charset=utf-8')
  lines.push('Content-Transfer-Encoding: quoted-printable')
  lines.push('')
  lines.push(encodeQuotedPrintable(model.body))
  return lines.join('\r\n') + '\r\n'
}
