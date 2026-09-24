import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ComposerPrimaryStack } from './ComposerPrimaryStack'

describe('ComposerPrimaryStack', () => {
  it('passes children through a fragment when enabled is false', () => {
    const html = renderToStaticMarkup(
      <ComposerPrimaryStack enabled={false}>
        <span>child-a</span>
        <span>child-b</span>
      </ComposerPrimaryStack>
    )

    expect(html).toBe('<span>child-a</span><span>child-b</span>')
    expect(html).not.toContain('composer-primary-stack')
    expect(html).not.toContain('<div')
  })

  it('wraps children in div.composer-primary-stack when enabled is true', () => {
    const html = renderToStaticMarkup(
      <ComposerPrimaryStack enabled={true}>
        <span>child-a</span>
        <span>child-b</span>
      </ComposerPrimaryStack>
    )

    expect(html).toBe(
      '<div class="composer-primary-stack"><span>child-a</span><span>child-b</span></div>'
    )
  })

  it('preserves children in both enabled states', () => {
    const children = (
      <>
        <em>keep-me</em>
        <strong>also-me</strong>
      </>
    )
    const disabled = renderToStaticMarkup(
      <ComposerPrimaryStack enabled={false}>{children}</ComposerPrimaryStack>
    )
    const enabled = renderToStaticMarkup(
      <ComposerPrimaryStack enabled={true}>{children}</ComposerPrimaryStack>
    )

    expect(disabled).toContain('<em>keep-me</em>')
    expect(disabled).toContain('<strong>also-me</strong>')
    expect(enabled).toContain('<em>keep-me</em>')
    expect(enabled).toContain('<strong>also-me</strong>')
    expect(enabled.startsWith('<div class="composer-primary-stack">')).toBe(true)
    expect(enabled.endsWith('</div>')).toBe(true)
  })
})
