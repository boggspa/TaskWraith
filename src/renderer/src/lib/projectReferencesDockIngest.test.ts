import { describe, expect, it } from 'vitest'

import { classifyDroppedPath, classifyPastedReferenceText } from './projectReferencesDockIngest'

describe('classifyPastedReferenceText', () => {
  it('rejects empty and whitespace-only input', () => {
    expect(classifyPastedReferenceText('')).toBeNull()
    expect(classifyPastedReferenceText('   \n\t  ')).toBeNull()
  })

  it('prefers GitHub normalization into a connector locator', () => {
    expect(classifyPastedReferenceText('electron/electron')).toEqual({
      kind: 'connector',
      locator: 'github://electron/electron'
    })
    expect(classifyPastedReferenceText('https://github.com/a/b.git')).toEqual({
      kind: 'connector',
      locator: 'github://a/b'
    })
    expect(classifyPastedReferenceText('https://github.com/a/b/blob/main/docs/spec.md')).toEqual({
      kind: 'connector',
      locator: 'github://a/b/docs/spec.md@main'
    })
    expect(classifyPastedReferenceText('  github://owner/repo  ')).toEqual({
      kind: 'connector',
      locator: 'github://owner/repo'
    })
  })

  it('classifies safe http(s) URLs without credentials', () => {
    expect(classifyPastedReferenceText('https://example.com/brief')).toEqual({
      kind: 'url',
      locator: 'https://example.com/brief'
    })
    expect(classifyPastedReferenceText('http://localhost:3000/docs')).toEqual({
      kind: 'url',
      locator: 'http://localhost:3000/docs'
    })
  })

  it('rejects http(s) URLs that carry userinfo credentials', () => {
    expect(classifyPastedReferenceText('https://user:pass@example.com/secret')).toBeNull()
    expect(classifyPastedReferenceText('http://token@example.com/')).toBeNull()
  })

  it('classifies absolute unix, windows, and UNC paths', () => {
    expect(classifyPastedReferenceText('/Users/me/notes.md')).toEqual({
      kind: 'file',
      locator: '/Users/me/notes.md'
    })
    expect(classifyPastedReferenceText('C:\\Work\\brief.docx')).toEqual({
      kind: 'file',
      locator: 'C:\\Work\\brief.docx'
    })
    expect(classifyPastedReferenceText('\\\\server\\share\\docs')).toEqual({
      kind: 'file',
      locator: '\\\\server\\share\\docs'
    })
    expect(classifyPastedReferenceText('//server/share/docs')).toEqual({
      kind: 'file',
      locator: '//server/share/docs'
    })
  })

  it('treats owner/repo-shaped relative text as a GitHub connector', () => {
    expect(classifyPastedReferenceText('relative/file.md')).toEqual({
      kind: 'connector',
      locator: 'github://relative/file.md'
    })
  })

  it('rejects relative non-github text and absolute paths with .. segments', () => {
    expect(classifyPastedReferenceText('./local.md')).toBeNull()
    expect(classifyPastedReferenceText('/Users/me/../etc/passwd')).toBeNull()
    expect(classifyPastedReferenceText('C:\\Work\\..\\Secrets\\key.txt')).toBeNull()
  })

  it('rejects non-github, non-url, non-absolute junk', () => {
    expect(classifyPastedReferenceText('not a repo at all !!')).toBeNull()
    expect(classifyPastedReferenceText('ftp://example.com/a')).toBeNull()
  })
})

describe('classifyDroppedPath', () => {
  it('requires an absolute path', () => {
    expect(classifyDroppedPath('relative/file.md', false)).toBeNull()
    expect(classifyDroppedPath('./local', true)).toBeNull()
    expect(classifyDroppedPath('', false)).toBeNull()
  })

  it('rejects paths with .. segments', () => {
    expect(classifyDroppedPath('/Users/me/../etc', false)).toBeNull()
    expect(classifyDroppedPath('C:\\Work\\..\\Secrets', true)).toBeNull()
  })

  it('maps isDirectory to folder vs file for absolute paths', () => {
    expect(classifyDroppedPath('/Users/me/project', true)).toEqual({
      kind: 'folder',
      locator: '/Users/me/project'
    })
    expect(classifyDroppedPath('/Users/me/notes.md', false)).toEqual({
      kind: 'file',
      locator: '/Users/me/notes.md'
    })
    expect(classifyDroppedPath('C:\\Work\\docs', true)).toEqual({
      kind: 'folder',
      locator: 'C:\\Work\\docs'
    })
    expect(classifyDroppedPath('\\\\server\\share\\file.txt', false)).toEqual({
      kind: 'file',
      locator: '\\\\server\\share\\file.txt'
    })
  })
})
