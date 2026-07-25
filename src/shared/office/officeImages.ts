/**
 * Raster image helpers for the Word editor's image support. Pure and
 * Buffer-free so both processes share one implementation: base64 codec,
 * magic-byte sniffing (the declared MIME in a data URI is never trusted),
 * and header-level dimension extraction for PNG/JPEG/GIF.
 */

export type RasterMime = 'image/png' | 'image/jpeg' | 'image/gif'

export interface RasterImageInfo {
  mime: RasterMime
  extension: 'png' | 'jpeg' | 'gif'
  widthPx?: number
  heightPx?: number
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const BASE64_LOOKUP = (() => {
  const lookup = new Int16Array(128).fill(-1)
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    lookup[BASE64_ALPHABET.charCodeAt(index)] = index
  }
  return lookup
})()

export function decodeBase64(input: string): Uint8Array | null {
  const clean = input.replace(/[\r\n\s]/g, '')
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean.charCodeAt(index)
    if (clean[index] === '=') break
    const value = char < 128 ? BASE64_LOOKUP[char] : -1
    if (value === -1) return null
    buffer = (buffer << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(bytes)
}

export function encodeBase64(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]
    const b = bytes[index + 1]
    const c = bytes[index + 2]
    out += BASE64_ALPHABET[a >> 2]
    out += BASE64_ALPHABET[((a & 0x03) << 4) | ((b ?? 0) >> 4)]
    out += b === undefined ? '=' : BASE64_ALPHABET[((b & 0x0f) << 2) | ((c ?? 0) >> 6)]
    out += c === undefined ? '=' : BASE64_ALPHABET[c & 0x3f]
  }
  return out
}

const readUInt32BE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>>
  0

const readUInt16BE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset] << 8) | bytes[offset + 1]

const readUInt16LE = (bytes: Uint8Array, offset: number): number =>
  bytes[offset] | (bytes[offset + 1] << 8)

function jpegDimensions(bytes: Uint8Array): { widthPx: number; heightPx: number } | undefined {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2
      continue
    }
    const length = readUInt16BE(bytes, offset + 2)
    if (length < 2) return undefined
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof) {
      return { heightPx: readUInt16BE(bytes, offset + 5), widthPx: readUInt16BE(bytes, offset + 7) }
    }
    offset += 2 + length
  }
  return undefined
}

/** Identifies PNG/JPEG/GIF by magic bytes and extracts header dimensions. */
export function sniffRasterImage(bytes: Uint8Array): RasterImageInfo | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return {
      mime: 'image/png',
      extension: 'png',
      widthPx: readUInt32BE(bytes, 16),
      heightPx: readUInt32BE(bytes, 20)
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mime: 'image/jpeg', extension: 'jpeg', ...jpegDimensions(bytes) }
  }
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return {
      mime: 'image/gif',
      extension: 'gif',
      widthPx: readUInt16LE(bytes, 6),
      heightPx: readUInt16LE(bytes, 8)
    }
  }
  return null
}

export interface ParsedDataUri {
  info: RasterImageInfo
  bytes: Uint8Array
}

/**
 * Validates a raster data URI. The payload's magic bytes are authoritative —
 * a mismatch with the declared MIME resolves to the sniffed type; anything
 * that is not PNG/JPEG/GIF is rejected outright.
 */
export function parseRasterDataUri(uri: string, maxBytes: number): ParsedDataUri | null {
  const match = /^data:(image\/(?:png|jpeg|jpg|gif));base64,([A-Za-z0-9+/=\s]+)$/i.exec(uri)
  if (!match) return null
  // Cheap pre-decode size gate: base64 expands 3→4.
  if (match[2].length > (maxBytes * 4) / 3 + 8) return null
  const bytes = decodeBase64(match[2])
  if (!bytes || bytes.length === 0 || bytes.length > maxBytes) return null
  const info = sniffRasterImage(bytes)
  if (!info) return null
  return { info, bytes }
}

export function rasterDataUriFromBytes(bytes: Uint8Array): string | null {
  const info = sniffRasterImage(bytes)
  if (!info) return null
  return `data:${info.mime};base64,${encodeBase64(bytes)}`
}

/** EMU per pixel at 96 dpi — the OOXML drawing unit. */
export const EMU_PER_PIXEL = 9525
