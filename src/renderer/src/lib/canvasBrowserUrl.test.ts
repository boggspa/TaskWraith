import { describe, expect, it } from 'vitest'
import {
  browserAddressDisplay,
  isNavigableCanvasUrl,
  normalizeBrowserUrlInput
} from './canvasBrowserUrl'

describe('normalizeBrowserUrlInput', () => {
  it('passes absolute http(s) URLs through normalized', () => {
    expect(normalizeBrowserUrlInput('https://example.com')).toBe('https://example.com/')
    expect(normalizeBrowserUrlInput('  http://localhost:3000/app  ')).toBe(
      'http://localhost:3000/app'
    )
    expect(normalizeBrowserUrlInput('HTTPS://Example.COM/Path?q=1#frag')).toBe(
      'https://example.com/Path?q=1#frag'
    )
  })

  it('assumes https for scheme-less public hosts and http for local dev hosts', () => {
    expect(normalizeBrowserUrlInput('example.com')).toBe('https://example.com/')
    expect(normalizeBrowserUrlInput('example.com/docs?x=1')).toBe('https://example.com/docs?x=1')
    expect(normalizeBrowserUrlInput('localhost:3000')).toBe('http://localhost:3000/')
    expect(normalizeBrowserUrlInput('127.0.0.1:5173/app')).toBe('http://127.0.0.1:5173/app')
    expect(normalizeBrowserUrlInput('192.168.1.20:8080')).toBe('http://192.168.1.20:8080/')
  })

  it('rejects non-web schemes instead of fixing them', () => {
    expect(normalizeBrowserUrlInput('file:///etc/passwd')).toBeNull()
    expect(normalizeBrowserUrlInput('javascript:alert(1)')).toBeNull()
    expect(normalizeBrowserUrlInput('chrome://settings')).toBeNull()
    expect(normalizeBrowserUrlInput('sketch://abc')).toBeNull()
  })

  it('rejects empty input, whitespace, and unparseable addresses', () => {
    expect(normalizeBrowserUrlInput('')).toBeNull()
    expect(normalizeBrowserUrlInput('   ')).toBeNull()
    expect(normalizeBrowserUrlInput('not a url')).toBeNull()
    expect(normalizeBrowserUrlInput('http://')).toBeNull()
  })
})

describe('isNavigableCanvasUrl', () => {
  it('accepts live web pages and refuses internal canvas record schemes', () => {
    expect(isNavigableCanvasUrl('https://example.com/')).toBe(true)
    expect(isNavigableCanvasUrl('http://localhost:3000/')).toBe(true)
    expect(isNavigableCanvasUrl('sketch://abc')).toBe(false)
    expect(isNavigableCanvasUrl('html://deadbeef')).toBe(false)
    expect(isNavigableCanvasUrl('device://booted/com.example.App')).toBe(false)
    expect(isNavigableCanvasUrl('window://managed/abc')).toBe(false)
    expect(isNavigableCanvasUrl(undefined)).toBe(false)
    expect(isNavigableCanvasUrl('')).toBe(false)
  })
})

describe('browserAddressDisplay', () => {
  it('compacts the origin boilerplate but keeps path/query/hash', () => {
    expect(browserAddressDisplay('https://example.com/')).toBe('example.com')
    expect(browserAddressDisplay('https://example.com/docs/intro?x=1#top')).toBe(
      'example.com/docs/intro?x=1#top'
    )
    expect(browserAddressDisplay('http://localhost:3000/')).toBe('localhost:3000')
  })

  it('renders nothing for internal record urls', () => {
    expect(browserAddressDisplay('sketch://abc')).toBe('')
    expect(browserAddressDisplay(undefined)).toBe('')
  })
})
