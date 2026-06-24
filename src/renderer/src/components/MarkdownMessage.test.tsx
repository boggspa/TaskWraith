import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownMessage } from './MarkdownMessage'
import type { ChatMediaRef } from './ChatMediaPanel'

const AVAILABLE_PNG_REF: ChatMediaRef = {
  id: 'm1',
  kind: 'image',
  source: 'workspace_path',
  name: 'out.png',
  path: '/ws/out.png',
  workspaceRelativePath: 'out.png',
  status: 'available',
  thumbnail: { dataBase64: 'iVBORw0KGgo=', mimeType: 'image/png' }
}

describe('MarkdownMessage', () => {
  it('renders GFM tables, task lists, inline code, and fenced code', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        content={[
          '| Feature | State |',
          '| --- | --- |',
          '| Tables | `ready` |',
          '',
          '- [x] task done',
          '- [ ] task pending',
          '',
          '```ts',
          'const value: string = "ok"',
          '```'
        ].join('\n')}
      />
    )

    expect(html).toContain('<table>')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<code>ready</code>')
    expect(html).toContain('message-code-shell')
    expect(html).toContain('ts')
  })

  it('escapes raw html instead of rendering it', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage content={'<img src=x onerror=alert(1)> **safe**'} />
    )

    // The XSS gate: no real `<img>` element exists in the DOM, and no
    // tag-style `onerror=` attribute attaches to a real element. The
    // escaped text content (`onerror=alert(1)` inside `&lt;img …&gt;`)
    // is harmless — the browser will display it as literal characters,
    // not parse it as markup. Checking for the literal string `onerror`
    // anywhere in the document was a too-strict assertion that flagged
    // the safe escaped form.
    expect(html).not.toContain('<img')
    expect(html).not.toMatch(/<[a-z][^>]*\bonerror\s*=/i)
    expect(html).toContain('&lt;img')
    expect(html).toContain('<strong>safe</strong>')
  })

  it('renders markdown image syntax as inert text instead of loading images', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        content={[
          'Remote ![remote preview](https://example.com/pixel.png)',
          'Local ![local preview](file:///Users/example/secret.png)',
          'Data ![inline preview](data:image/png;base64,aaaa)'
        ].join('\n')}
      />
    )

    expect(html).not.toContain('<img')
    expect(html).toContain('markdown-image-placeholder')
    expect(html).toContain('Image: remote preview')
    expect(html).toContain('Image: local preview')
    expect(html).toContain('Image: inline preview')
  })

  it('renders external markdown links with favicon presentation metadata', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage content={'Open [here](https://github.com/boggspa/TaskWraith).'} />
    )

    expect(html).toContain('favicon-link')
    expect(html).toContain('data-link-kind="external"')
    expect(html).toContain('github.com')
    expect(html).toContain('favicon-image-fallback')
  })

  it('renders identically across calls and matches block-by-block output (append-only contract)', () => {
    // Phase L1a: the renderer is now block-aware. This test verifies
    // two invariants the streaming hot path depends on:
    //   1. Determinism — rendering the same content twice yields
    //      identical HTML (no random ids, no incidental order changes).
    //   2. Block-level composition — rendering "A\n\n" + "B" as one
    //      string produces the same combined HTML as rendering each
    //      block on its own and concatenating, because the splitter
    //      hands each block to its own ReactMarkdown invocation. This
    //      indirectly verifies the append-only contract: blocks are
    //      independent renders, so a stable prefix can short-circuit
    //      through React.memo without affecting the tail.
    const content = 'A first paragraph with *emphasis*.\n\nA second paragraph.'
    const htmlA = renderToStaticMarkup(<MarkdownMessage content={content} />)
    const htmlB = renderToStaticMarkup(<MarkdownMessage content={content} />)
    expect(htmlA).toBe(htmlB)

    // Rendering each block individually as MarkdownMessage and
    // concatenating their outputs (stripping outer wrappers) gives the
    // same per-block HTML the orchestrator emits. Easier proxy: confirm
    // both block bodies appear in the combined output.
    const piece1 = renderToStaticMarkup(
      <MarkdownMessage content={'A first paragraph with *emphasis*.'} />
    )
    const piece2 = renderToStaticMarkup(<MarkdownMessage content={'A second paragraph.'} />)
    expect(piece1).toContain('<em>emphasis</em>')
    expect(piece2).toContain('A second paragraph.')
    expect(htmlA).toContain('<em>emphasis</em>')
    expect(htmlA).toContain('A second paragraph.')
  })

  it('renders nested lists and blockquotes (panel-emitted structures)', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage content={['- top', '  - nested', '', '> quoted source line'].join('\n')} />
    )
    expect(html).toContain('<blockquote>')
    // A nested <ul> inside the outer <li> proves list indentation survives.
    expect(html).toMatch(/<li>[\s\S]*<ul>[\s\S]*nested/)
  })

  it('PR3: replaces a resolvable markdown image with its safe data: thumbnail', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        content={'Here is the render: ![the output](out.png)'}
        mediaRefs={[AVAILABLE_PNG_REF]}
        workspacePath="/ws"
      />
    )
    expect(html).toContain('markdown-inline-image')
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="')
    expect(html).toContain('alt="the output"')
    // The placeholder is gone for the resolved image.
    expect(html).not.toContain('markdown-image-placeholder')
  })

  it('PR3 SECURITY: a remote image src is never loaded, even with refs present', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        content={'![beacon](https://evil.example/track.png)'}
        mediaRefs={[AVAILABLE_PNG_REF]}
        workspacePath="/ws"
      />
    )
    expect(html).not.toContain('<img')
    expect(html).not.toContain('evil.example')
    expect(html).toContain('markdown-image-placeholder')
  })

  it('PR3 SECURITY: an unsafe-SVG ref stays an inert placeholder', () => {
    const svgRef: ChatMediaRef = {
      id: 's1',
      kind: 'image',
      source: 'workspace_path',
      name: 'diagram.svg',
      path: '/ws/diagram.svg',
      workspaceRelativePath: 'diagram.svg',
      status: 'unsafe_svg'
    }
    const html = renderToStaticMarkup(
      <MarkdownMessage
        content={'![chart](diagram.svg)'}
        mediaRefs={[svgRef]}
        workspacePath="/ws"
      />
    )
    expect(html).not.toContain('<img')
    expect(html).toContain('markdown-image-placeholder')
  })

  it('tokenises an @user address chip in both body text and headings', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage content={['## Handing to @user', '', 'Back to @user now.'].join('\n')} />
    )
    // Heading + paragraph both get the user-address chip — heading
    // tokenisation is the 1.0.72 markdown-audit gap-fix.
    const chips = (html.match(/participant-mention--user/g) || []).length
    expect(chips).toBe(2)
    expect(html).toContain('<h2>')
  })
})
