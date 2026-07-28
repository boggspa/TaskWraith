import { describe, expect, it } from 'vitest'
import {
  appendAttachedImageFilesNote,
  describeImageAttachmentRefusal,
  providerDeliversImageAttachments
} from './ProviderImageAttachmentSupport'

describe('providerDeliversImageAttachments', () => {
  it('admits exactly the lanes with a named delivery mechanism', () => {
    expect(providerDeliversImageAttachments('claude')).toBe(true)
    expect(providerDeliversImageAttachments('codex')).toBe(true)
    expect(providerDeliversImageAttachments('gemini')).toBe(true)
    expect(providerDeliversImageAttachments('kimi')).toBe(true)
  })

  it('refuses every lane without one', () => {
    for (const provider of ['ollama', 'cursor', 'grok', 'pi', 'mistral', 'antigravity']) {
      expect(providerDeliversImageAttachments(provider)).toBe(false)
    }
  })

  it('fails closed for unknown provider strings', () => {
    expect(providerDeliversImageAttachments('not-a-provider')).toBe(false)
    expect(providerDeliversImageAttachments('')).toBe(false)
  })
})

describe('describeImageAttachmentRefusal', () => {
  it('names the provider, the count, and the remedy', () => {
    const single = describeImageAttachmentRefusal('Ollama', 1)
    expect(single).toContain('Ollama cannot receive image attachments')
    expect(single).toContain('the attached image')
    expect(single).toContain('not dispatched')
    const plural = describeImageAttachmentRefusal('Pi', 3)
    expect(plural).toContain('the 3 attached images')
    expect(plural).toContain('Claude, Codex, Gemini, or Kimi')
  })
})

describe('appendAttachedImageFilesNote', () => {
  it('appends a readable listing after the prompt', () => {
    const note = appendAttachedImageFilesNote('What is in this picture?', ['/tmp/media/sketch.png'])
    expect(note.startsWith('What is in this picture?')).toBe(true)
    expect(note).toContain('attached an image file')
    expect(note).toContain('- /tmp/media/sketch.png')
  })

  it('counts multiple files and skips blanks', () => {
    const note = appendAttachedImageFilesNote('Compare these.', ['/a/one.png', '   ', '/b/two.jpg'])
    expect(note).toContain('2 image files')
    expect(note).toContain('- /a/one.png')
    expect(note).toContain('- /b/two.jpg')
  })

  it('returns the prompt untouched with no usable paths', () => {
    expect(appendAttachedImageFilesNote('Hello', ['  '])).toBe('Hello')
    expect(appendAttachedImageFilesNote('Hello', [])).toBe('Hello')
  })
})
