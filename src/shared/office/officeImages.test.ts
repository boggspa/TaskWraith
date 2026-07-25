import { describe, expect, it } from 'vitest'
import {
  EMU_PER_PIXEL,
  decodeBase64,
  encodeBase64,
  parseRasterDataUri,
  rasterDataUriFromBytes,
  sniffRasterImage
} from './officeImages'

/** Real 1×1 transparent PNG. */
export const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const gifBytes = (width: number, height: number): Uint8Array =>
  Uint8Array.from([
    0x47,
    0x49,
    0x46,
    0x38,
    0x39,
    0x61,
    width & 0xff,
    width >> 8,
    height & 0xff,
    height >> 8,
    0,
    0,
    0
  ])

const jpegBytes = (width: number, height: number): Uint8Array =>
  Uint8Array.from([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00, // APP0 length 4
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08, // SOF0, length 17, precision 8
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xd9 // EOI
  ])

describe('base64', () => {
  it('round-trips binary data', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes)
  })

  it('rejects non-base64 input', () => {
    expect(decodeBase64('not*base64!')).toBeNull()
  })
})

describe('sniffRasterImage', () => {
  it('identifies PNG with IHDR dimensions', () => {
    const png = decodeBase64(ONE_BY_ONE_PNG_BASE64)!
    expect(sniffRasterImage(png)).toEqual({
      mime: 'image/png',
      extension: 'png',
      widthPx: 1,
      heightPx: 1
    })
  })

  it('identifies GIF with LE dimensions', () => {
    expect(sniffRasterImage(gifBytes(320, 200))).toEqual({
      mime: 'image/gif',
      extension: 'gif',
      widthPx: 320,
      heightPx: 200
    })
  })

  it('identifies JPEG via SOF scan', () => {
    expect(sniffRasterImage(jpegBytes(640, 480))).toEqual({
      mime: 'image/jpeg',
      extension: 'jpeg',
      widthPx: 640,
      heightPx: 480
    })
  })

  it('rejects non-raster payloads', () => {
    expect(sniffRasterImage(new TextEncoder().encode('<svg xmlns="x"/>'))).toBeNull()
    expect(sniffRasterImage(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBeNull()
  })
})

describe('parseRasterDataUri', () => {
  it('accepts a valid PNG data URI', () => {
    const parsed = parseRasterDataUri(`data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`, 1_000_000)
    expect(parsed?.info.mime).toBe('image/png')
    expect(parsed?.info.widthPx).toBe(1)
    expect(parsed?.bytes.length).toBeGreaterThan(20)
  })

  it('trusts magic bytes over the declared mime', () => {
    // GIF bytes labelled as png: sniffed type wins.
    const uri = `data:image/png;base64,${encodeBase64(gifBytes(2, 3))}`
    expect(parseRasterDataUri(uri, 1_000_000)?.info.mime).toBe('image/gif')
  })

  it('rejects SVG, missing base64 marker, oversized payloads and junk', () => {
    expect(parseRasterDataUri('data:image/svg+xml;base64,PHN2Zy8+', 1_000_000)).toBeNull()
    expect(parseRasterDataUri('data:image/png,rawtext', 1_000_000)).toBeNull()
    expect(parseRasterDataUri(`data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`, 10)).toBeNull()
    expect(parseRasterDataUri('https://example.com/x.png', 1_000_000)).toBeNull()
  })
})

describe('rasterDataUriFromBytes', () => {
  it('emits a URI matching the sniffed type', () => {
    expect(rasterDataUriFromBytes(gifBytes(1, 1))).toMatch(/^data:image\/gif;base64,/)
    expect(rasterDataUriFromBytes(new TextEncoder().encode('nope'))).toBeNull()
  })
})

describe('EMU_PER_PIXEL', () => {
  it('is the OOXML 96-dpi constant', () => {
    expect(EMU_PER_PIXEL).toBe(9525)
  })
})
