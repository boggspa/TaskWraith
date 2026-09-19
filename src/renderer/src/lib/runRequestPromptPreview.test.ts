import { describe, expect, it } from 'vitest'
import {
  runRequestDisplayPrompt,
  runRequestPromptPreview,
  type RunRequestPromptSource
} from './runRequestPromptPreview'

const request = (overrides: Partial<RunRequestPromptSource> = {}): RunRequestPromptSource => ({
  prompt: '',
  imageAttachments: [],
  ...overrides
})

const attachments = (name: string): RunRequestPromptSource['imageAttachments'] =>
  [{ name, path: `/tmp/${name}` }] as unknown as RunRequestPromptSource['imageAttachments']

const projectReferences = (
  count: number
): RunRequestPromptSource['projectReferenceContextSelection'] =>
  ({
    referenceIds: Array.from({ length: count }, (_, index) => `ref-${index}`)
  }) as unknown as RunRequestPromptSource['projectReferenceContextSelection']

describe('runRequestPromptPreview', () => {
  it('prefers a displayPrompt that carries content', () => {
    expect(runRequestPromptPreview(request({ prompt: 'delivered', displayPrompt: 'shown' }))).toBe(
      'shown'
    )
  })

  it('trims the chosen text', () => {
    expect(runRequestPromptPreview(request({ prompt: '  delivered  ' }))).toBe('delivered')
  })

  it('falls through an empty displayPrompt to the prompt', () => {
    expect(runRequestPromptPreview(request({ prompt: 'delivered', displayPrompt: '' }))).toBe(
      'delivered'
    )
  })

  // The regression. A whitespace-only displayPrompt is truthy, so a `||` chain
  // evaluated before `.trim()` short-circuits on it and then trims to ''. The row
  // is persisted and painted empty, and eligibleConversationMessages drops any row
  // whose content fails `content.trim()` from provider history — the steer is
  // visible to the user and invisible to the model.
  it.each([
    ['a single space', ' '],
    ['several spaces', '     '],
    ['a tab', '\t'],
    ['a newline', '\n'],
    ['mixed whitespace', ' \t\n ']
  ])('falls through a displayPrompt of %s to the prompt', (_label, displayPrompt) => {
    expect(runRequestPromptPreview(request({ prompt: 'delivered', displayPrompt }))).toBe(
      'delivered'
    )
  })

  it('does not return empty while a prompt carries content', () => {
    expect(
      runRequestPromptPreview(request({ prompt: 'delivered', displayPrompt: '   ' }))
    ).not.toBe('')
  })

  it('falls back to the attachment summary when neither text carries content', () => {
    expect(
      runRequestPromptPreview(
        request({ prompt: '   ', displayPrompt: '  ', imageAttachments: attachments('shot.png') })
      )
    ).toBe('Attached: shot.png')
  })

  it('prefers a whitespace-only prompt fallback over the attachment summary only when the prompt has content', () => {
    expect(
      runRequestPromptPreview(
        request({
          prompt: 'delivered',
          displayPrompt: ' ',
          imageAttachments: attachments('shot.png')
        })
      )
    ).toBe('delivered')
  })

  it('falls back to the project reference summary when there is no text or attachment', () => {
    expect(
      runRequestPromptPreview(request({ projectReferenceContextSelection: projectReferences(2) }))
    ).toBe('2 Project references')
  })

  it('returns empty when the request carries nothing at all', () => {
    expect(runRequestPromptPreview(request())).toBe('')
  })
})

describe('runRequestDisplayPrompt', () => {
  // The sibling already guards with displayPrompt?.trim(). These pin that the two
  // helpers agree about whitespace, which is the divergence the regression came from.
  it('ignores a whitespace-only displayPrompt and uses the final prompt', () => {
    expect(
      runRequestDisplayPrompt(request({ prompt: 'delivered', displayPrompt: '   ' }), 'final')
    ).toBe('final')
  })

  it('prefers a displayPrompt that carries content', () => {
    expect(
      runRequestDisplayPrompt(request({ prompt: 'delivered', displayPrompt: 'shown' }), 'final')
    ).toBe('shown')
  })

  it('agrees with runRequestPromptPreview that whitespace is not content', () => {
    const whitespaceOnly = request({ prompt: 'delivered', displayPrompt: ' \t ' })
    expect(runRequestDisplayPrompt(whitespaceOnly, 'delivered')).toBe('delivered')
    expect(runRequestPromptPreview(whitespaceOnly)).toBe('delivered')
  })
})
