import { describe, it, expect } from 'vitest'
import {
  CANVAS_VIEWPORT_PRESETS,
  classifyCanvasHost,
  isCanvasRequestBlocked,
  isLoopbackHost,
  isSafeAppBundlePath,
  isValidBundleId,
  isValidSimUdid,
  readPngDimensions,
  redactUrlQuery,
  resolveViewport,
  validateCanvasUrl
} from './canvasTypes'

describe('validateCanvasUrl', () => {
  it('allows loopback http/https', () => {
    expect(validateCanvasUrl('http://localhost:3000').ok).toBe(true)
    expect(validateCanvasUrl('http://127.0.0.1:5173/path').ok).toBe(true)
    expect(validateCanvasUrl('https://localhost:8080').ok).toBe(true)
  })

  it('blocks non-http(s) schemes', () => {
    expect(validateCanvasUrl('file:///etc/passwd').ok).toBe(false)
    expect(validateCanvasUrl('data:text/html,<h1>x</h1>').ok).toBe(false)
    expect(validateCanvasUrl('javascript:alert(1)').ok).toBe(false)
  })

  it('blocks link-local / cloud-metadata even when allowlisted', () => {
    expect(validateCanvasUrl('http://169.254.169.254/latest/meta-data').ok).toBe(false)
    // An agent-supplied allowlist can NOT re-enable the metadata endpoint.
    expect(validateCanvasUrl('http://169.254.169.254/', ['169.254.169.254']).ok).toBe(false)
  })

  it('permits public http(s) when no allowlist is given (open is user-gated)', () => {
    expect(validateCanvasUrl('https://example.com').ok).toBe(true)
  })

  it('enforces a non-empty allowlist (exact + dotted-suffix)', () => {
    expect(validateCanvasUrl('https://evil.com', ['staging.myapp.com']).ok).toBe(false)
    expect(validateCanvasUrl('https://staging.myapp.com', ['staging.myapp.com']).ok).toBe(true)
    expect(validateCanvasUrl('https://api.staging.myapp.com', ['myapp.com']).ok).toBe(true)
    // suffix match must respect the dot boundary — notmyapp.com is NOT myapp.com
    expect(validateCanvasUrl('https://notmyapp.com', ['myapp.com']).ok).toBe(false)
  })

  it('rejects invalid urls', () => {
    expect(validateCanvasUrl('not a url').ok).toBe(false)
    expect(validateCanvasUrl('').ok).toBe(false)
  })
})

describe('isLoopbackHost', () => {
  it('recognizes loopback', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.5.5.5')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
  })

  it('rejects non-loopback', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.1')).toBe(false)
    expect(isLoopbackHost('example.com')).toBe(false)
  })
})

describe('resolveViewport', () => {
  it('uses presets', () => {
    expect(resolveViewport({ preset: 'mobile' })).toEqual(CANVAS_VIEWPORT_PRESETS.mobile)
    expect(resolveViewport({ preset: 'tablet' })).toEqual(CANVAS_VIEWPORT_PRESETS.tablet)
    expect(resolveViewport({ preset: 'desktop' })).toEqual(CANVAS_VIEWPORT_PRESETS.desktop)
  })

  it('defaults to desktop and clamps explicit dims', () => {
    expect(resolveViewport({})).toEqual(CANVAS_VIEWPORT_PRESETS.desktop)
    expect(resolveViewport({ width: 99999, height: 1 })).toEqual({ width: 3840, height: 240 })
    expect(resolveViewport({ width: 500, height: 700 })).toEqual({ width: 500, height: 700 })
  })

  it('lets explicit dims override the preset base per-axis', () => {
    expect(resolveViewport({ preset: 'mobile', width: 400 })).toEqual({ width: 400, height: 812 })
  })

  it('ignores unknown presets, falling back to desktop', () => {
    expect(resolveViewport({ preset: 'watch' })).toEqual(CANVAS_VIEWPORT_PRESETS.desktop)
  })
})

describe('validateCanvasUrl — IP-class SSRF policy', () => {
  it('blocks RFC1918 / ULA / CGNAT by default, allows when allowlisted', () => {
    expect(validateCanvasUrl('http://192.168.1.1:3000').ok).toBe(false)
    expect(validateCanvasUrl('http://10.0.0.5/').ok).toBe(false)
    expect(validateCanvasUrl('http://172.16.0.1/').ok).toBe(false)
    expect(validateCanvasUrl('http://[fd00::1]/').ok).toBe(false)
    expect(validateCanvasUrl('http://100.64.0.1/').ok).toBe(false)
    expect(validateCanvasUrl('http://192.168.1.1:3000', ['192.168.1.1']).ok).toBe(true)
  })

  it('blocks IPv4-mapped-IPv6 metadata (both dotted and Node hex form) + metadata DNS', () => {
    // Node normalizes [::ffff:169.254.169.254] to a hex IPv6 — must still block.
    expect(validateCanvasUrl('http://[::ffff:169.254.169.254]/').ok).toBe(false)
    expect(validateCanvasUrl('http://metadata.google.internal/').ok).toBe(false)
    expect(validateCanvasUrl('http://[fe80::1]/').ok).toBe(false)
  })

  it('still allows loopback and public', () => {
    expect(validateCanvasUrl('http://127.0.0.1:5173/').ok).toBe(true)
    expect(validateCanvasUrl('https://example.com/').ok).toBe(true)
  })
})

describe('classifyCanvasHost', () => {
  it('classifies the key cases', () => {
    expect(classifyCanvasHost('127.0.0.1')).toBe('loopback')
    expect(classifyCanvasHost('localhost')).toBe('loopback')
    expect(classifyCanvasHost('169.254.169.254')).toBe('linklocal')
    expect(classifyCanvasHost('::ffff:169.254.169.254')).toBe('linklocal')
    expect(classifyCanvasHost('10.1.2.3')).toBe('private')
    expect(classifyCanvasHost('example.com')).toBe('public')
    expect(classifyCanvasHost('8.8.8.8')).toBe('public')
  })
})

describe('isCanvasRequestBlocked (per-request subresource gate)', () => {
  it('blocks internal ranges, allows public + loopback + inert', () => {
    expect(isCanvasRequestBlocked('http://169.254.169.254/latest/meta-data')).toBe(true)
    expect(isCanvasRequestBlocked('http://[::ffff:169.254.169.254]/')).toBe(true)
    expect(isCanvasRequestBlocked('http://10.0.0.1/admin')).toBe(true)
    expect(isCanvasRequestBlocked('http://192.168.1.1/', ['192.168.1.1'])).toBe(false)
    expect(isCanvasRequestBlocked('https://cdn.example.com/app.js')).toBe(false)
    expect(isCanvasRequestBlocked('http://localhost:3000/api')).toBe(false)
    expect(isCanvasRequestBlocked('ws://localhost:3000/hmr')).toBe(false)
    expect(isCanvasRequestBlocked('data:text/css,body{}')).toBe(false)
  })
})

describe('redactUrlQuery', () => {
  it('drops query string + fragment from durable URLs', () => {
    expect(redactUrlQuery('http://localhost:3000/app?token=SECRET#frag')).toBe(
      'http://localhost:3000/app'
    )
    expect(redactUrlQuery('https://example.com/?a=1&b=2')).toBe('https://example.com/')
    expect(redactUrlQuery('http://localhost:3000/plain')).toBe('http://localhost:3000/plain')
  })
})

describe('device-driver input validators', () => {
  it('isValidBundleId accepts reverse-DNS ids and rejects injection', () => {
    expect(isValidBundleId('com.example.App')).toBe(true)
    expect(isValidBundleId('io.taskwraith.preview-app')).toBe(true)
    expect(isValidBundleId('noDotsHere')).toBe(false)
    expect(isValidBundleId('com.x; rm -rf /')).toBe(false)
    expect(isValidBundleId('com.x && curl evil')).toBe(false)
    expect(isValidBundleId('com.$(whoami).app')).toBe(false)
    expect(isValidBundleId('')).toBe(false)
  })

  it('isValidSimUdid accepts a UUID or "booted" only', () => {
    expect(isValidSimUdid('booted')).toBe(true)
    expect(isValidSimUdid('AAAAAAAA-1111-2222-3333-444444444444')).toBe(true)
    expect(isValidSimUdid('aaaaaaaa-1111-2222-3333-444444444444')).toBe(true)
    expect(isValidSimUdid('not-a-uuid')).toBe(false)
    expect(isValidSimUdid('booted; ls')).toBe(false)
  })

  it('isSafeAppBundlePath requires an absolute .app with no shell metachars', () => {
    expect(isSafeAppBundlePath('/Users/me/Build/Example.app')).toBe(true)
    expect(isSafeAppBundlePath('relative/Example.app')).toBe(false)
    expect(isSafeAppBundlePath('/Users/me/Example.txt')).toBe(false)
    expect(isSafeAppBundlePath('/x/$(touch pwned).app')).toBe(false)
    expect(isSafeAppBundlePath('/x/`id`.app')).toBe(false)
    expect(isSafeAppBundlePath('/x/a;rm.app')).toBe(false)
  })

  it('readPngDimensions reads IHDR width/height (0 for non-PNG)', () => {
    const png = Buffer.alloc(24)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    png.writeUInt32BE(1170, 16)
    png.writeUInt32BE(2532, 20)
    expect(readPngDimensions(png)).toEqual({ width: 1170, height: 2532 })
    expect(readPngDimensions(Buffer.from('not a png'))).toEqual({ width: 0, height: 0 })
  })
})
