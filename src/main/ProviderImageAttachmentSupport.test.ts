import { describe, expect, it } from 'vitest'
import {
  appendAttachedImageFilesNote,
  describeImageAttachmentOmissionWarning,
  describeImageAttachmentRefusal,
  providerDeliversImageAttachments,
  resolveImagePathsForProvider
} from './ProviderImageAttachmentSupport'

describe('providerDeliversImageAttachments', () => {
  it('admits exactly the lanes with a named delivery mechanism', () => {
    expect(providerDeliversImageAttachments('claude')).toBe(true)
    expect(providerDeliversImageAttachments('codex')).toBe(true)
    expect(providerDeliversImageAttachments('gemini')).toBe(true)
    expect(providerDeliversImageAttachments('kimi')).toBe(true)
    expect(providerDeliversImageAttachments('grok')).toBe(true)
    expect(providerDeliversImageAttachments('mistral')).toBe(true)
    expect(providerDeliversImageAttachments('ollama')).toBe(true)
    expect(providerDeliversImageAttachments('pi', 'openrouter/stealth/ox-alpha')).toBe(true)
    expect(providerDeliversImageAttachments('antigravity', 'gemini-api:gemini-2.5-flash')).toBe(
      true
    )
  })

  it('refuses every lane without one', () => {
    for (const provider of ['cursor', 'muse']) {
      expect(providerDeliversImageAttachments(provider)).toBe(false)
    }
    expect(providerDeliversImageAttachments('antigravity', 'claude-sonnet-4')).toBe(false)
    expect(providerDeliversImageAttachments('antigravity', 'gemini-api:claude-3')).toBe(false)
    expect(providerDeliversImageAttachments('antigravity')).toBe(false)
    expect(providerDeliversImageAttachments('pi', 'openrouter/z-ai/glm-5.2')).toBe(false)
  })

  it('fails closed for unknown provider strings', () => {
    expect(providerDeliversImageAttachments('not-a-provider')).toBe(false)
    expect(providerDeliversImageAttachments('')).toBe(false)
  })
})

describe('describeImageAttachmentOmissionWarning', () => {
  it('names the provider, the count, and that the turn continues', () => {
    const single = describeImageAttachmentOmissionWarning('Ollama', 1)
    expect(single).toContain(
      "TaskWraith's current Ollama transport cannot deliver image attachments"
    )
    expect(single).toContain('the attached image')
    expect(single).toContain('will not be delivered')
    expect(single).toContain('Continuing without it')
    const plural = describeImageAttachmentOmissionWarning('Pi', 3)
    expect(plural).toContain('the 3 attached images')
    expect(plural).toContain('Continuing without them')
    expect(plural).toContain('live capability reports image input')
  })

  it('keeps the refusal alias on the same warn-and-continue copy', () => {
    expect(describeImageAttachmentRefusal('Pi', 1)).toBe(
      describeImageAttachmentOmissionWarning('Pi', 1)
    )
  })
})

describe('resolveImagePathsForProvider', () => {
  it('passes supported lanes through unchanged', () => {
    expect(resolveImagePathsForProvider('codex', ['/tmp/a.png', ''], 'Codex')).toEqual({
      imagePaths: ['/tmp/a.png']
    })
    expect(
      resolveImagePathsForProvider('pi', ['/tmp/a.png'], 'Pi', 'openrouter/stealth/ox-alpha')
    ).toEqual({ imagePaths: ['/tmp/a.png'] })
  })

  it('strips unsupported lanes and returns an omission warning', () => {
    const resolved = resolveImagePathsForProvider(
      'pi',
      ['/tmp/a.png', '/tmp/b.png'],
      'Pi',
      'openrouter/z-ai/glm-5.2'
    )
    expect(resolved.imagePaths).toEqual([])
    expect(resolved.warning).toContain(
      "TaskWraith's current Pi transport cannot deliver image attachments"
    )
    expect(resolved.warning).toContain('Continuing without them')
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
