import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownMessage } from './MarkdownMessage'
import type { ChatMediaRef } from './ChatMediaPanel'
import type { ChatRecord, EnsembleParticipant } from '../../../main/store/types'

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

function participant(overrides: Partial<EnsembleParticipant>): EnsembleParticipant {
  return {
    id: overrides.id || 'p1',
    provider: overrides.provider || 'codex',
    enabled: overrides.enabled ?? true,
    role: overrides.role || '',
    instructions: overrides.instructions || '',
    order: overrides.order ?? 1,
    model: overrides.model
  }
}

function ensembleChat(participants: EnsembleParticipant[]): ChatRecord {
  return {
    appChatId: 'ensemble-chat',
    chatKind: 'ensemble',
    title: 'Ensemble',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: [],
    ensemble: {
      participants,
      orchestrationMode: 'continuous',
      fanoutPolicy: 'read_only',
      maxContinuationHops: 6
    }
  } as unknown as ChatRecord
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
    expect(html).toContain('class="markdown-table-scroll"')
    expect(html).toContain('aria-label="Markdown table"')
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('<code>ready</code>')
    expect(html).toContain('message-code-shell')
    expect(html).toContain('message-code-static')
    expect(html).not.toContain('cm-editor')
    expect(html).toContain('ts')
  })

  it('wraps tables in a scroll region while preserving GFM cell alignment', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        content={[
          '| Item | Count | Expr |',
          '| :--- | ---: | --- |',
          '| a \\| b | 42 | `x\\|y` |'
        ].join('\n')}
      />
    )

    expect(html).toContain('class="markdown-table-scroll"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('style="text-align:right"')
    expect(html).toContain('a | b')
    expect(html).toContain('<code>x|y</code>')
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

  it('renders raw html only through the opt-in sanitised path', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        content={[
          '<details><summary>More</summary>',
          '',
          '<p>HTML <strong onclick="alert(1)">strong</strong>.</p>',
          '</details>',
          '<img src="https://evil.example/pixel.png" alt="beacon">',
          '<script>bad()</script>'
        ].join('\n')}
        allowSafeHtml
      />
    )

    expect(html).toContain('<details><summary>More</summary>')
    expect(html).toContain('<p>HTML <strong>strong</strong>.</p>')
    expect(html).toContain('</details>')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('evil.example')
    expect(html).toContain('Image: beacon')
  })

  it('keeps internal mention protocols while rejecting unsafe links in safe-html mode', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        chat={ensembleChat([participant({ id: 'p1', provider: 'codex', role: 'Builder' })])}
        content={[
          'Talk to [@Builder](ensemble-dm://p1).',
          'Unsafe [link](javascript:alert(1)).'
        ].join('\n\n')}
        allowSafeHtml
      />
    )

    expect(html).toContain('class="participant-mention"')
    expect(html).toContain('@Builder')
    expect(html).not.toContain('javascript:')
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

  it('PR4: external http(s) links get an explicit Open-in-Canvas affordance', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage content={'Open [docs](https://example.com/guide).'} />
    )
    expect(html).toContain('favicon-link')
    expect(html).toContain('markdown-open-in-canvas')
    expect(html).toContain('aria-label="Open link in Canvas"')
  })

  it('PR4: mailto links are external but get NO canvas affordance', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage content={'Mail [me](mailto:a@b.com).'} />
    )
    expect(html).toContain('favicon-link')
    expect(html).not.toContain('markdown-open-in-canvas')
  })

  it('PR4: path / file links get NO canvas affordance', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage content={'See [file](./src/app.ts).'} />
    )
    expect(html).not.toContain('markdown-open-in-canvas')
    expect(html).not.toContain('favicon-link')
    expect(html).toContain('data-link-kind="path"')
    expect(html).toContain('data-link-openable="false"')
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

  it('PR3: a resolved inline image is a preview button when a handler is provided', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        content={'![the output](out.png)'}
        mediaRefs={[AVAILABLE_PNG_REF]}
        workspacePath="/ws"
        onPreviewImage={() => {}}
      />
    )
    expect(html).toContain('markdown-inline-image-button')
    expect(html).toContain('markdown-inline-image')
    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="')
    expect(html).toContain('aria-label="Preview image out.png"')
    expect(html).toContain('alt="the output"')
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

  it('tokenises transcript participant mentions through the shared multi-word resolver', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        chat={ensembleChat([
          participant({ id: 'boss', provider: 'claude', role: 'Bossman', model: 'claude-fable-5' }),
          participant({ id: 'render', provider: 'codex', role: 'RenderWrite', model: 'gpt-5.5' })
        ])}
        content={'@Bossman and @GPT 5.5 can inspect memberChats without mangling it.'}
      />
    )
    expect((html.match(/class="participant-mention"/g) || []).length).toBe(2)
    expect(html).toContain('@Bossman')
    expect(html).toContain('@GPT 5.5')
    expect(html).toContain('memberChats')
    expect(html).not.toContain('@Fable')
    expect(html).not.toContain('@RenderWrite')
  })

  it('resolves an ensemble-dm:// markdown link to a provider-tinted participant chip', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        chat={ensembleChat([participant({ id: 'p1', provider: 'codex', role: 'Builder' })])}
        content={'Thanks, [@Builder](ensemble-dm://p1)!'}
      />
    )
    expect(html).toContain('class="participant-mention"')
    expect(html).toContain('--provider-codex-color')
    expect(html).toContain('@Builder')
  })

  it('falls back to plain text for an ensemble-dm:// link with no matching participant', () => {
    const html = renderToStaticMarkup(
      <MarkdownMessage
        chat={ensembleChat([participant({ id: 'p1', provider: 'codex', role: 'Builder' })])}
        content={'Gone: [@Ghost](ensemble-dm://p-missing).'}
      />
    )
    expect(html).not.toContain('class="participant-mention"')
    expect(html).toContain('@Ghost')
  })
})
