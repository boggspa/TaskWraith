import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { GitUnpushedCommit } from '../../../main/services/GitCommitStack'
import { MarkdownCommitReference } from './MarkdownCommitReference'
import { MarkdownCommitReferenceContext } from './MarkdownCommitReferenceContext'
import { MarkdownMessage } from './MarkdownMessage'
import {
  buildTraceableCommitIndex,
  resolveTraceableCommitReference
} from '../lib/traceableCommitReferences'

function commit(hash: string, subject = 'Bound commit previews'): GitUnpushedCommit {
  return {
    hash,
    parents: [],
    subject,
    author: { name: 'TaskWraith' },
    filesChanged: 2,
    additions: 14,
    deletions: 5
  }
}

describe('traceable commit references', () => {
  const first = commit('6a561c53e1111111111111111111111111111111')
  const second = commit('6a561c53effffffffffffffffffffffffffffffff')

  it('resolves a full hash as soon as its page arrives', () => {
    const index = buildTraceableCommitIndex([first], false)
    expect(resolveTraceableCommitReference(index, first.hash)).toBe(first)
  })

  it('waits for a complete catalogue before resolving abbreviations', () => {
    expect(
      resolveTraceableCommitReference(buildTraceableCommitIndex([first], false), '6a561c53e')
    ).toBeNull()
    expect(
      resolveTraceableCommitReference(buildTraceableCommitIndex([first], true), '6a561c53e')
    ).toBe(first)
  })

  it('leaves ambiguous abbreviations inert', () => {
    const index = buildTraceableCommitIndex([first, second], true)
    expect(resolveTraceableCommitReference(index, '6a561c53e')).toBeNull()
  })

  it('renders a focusable preview anchor only for a resolved commit', () => {
    const index = buildTraceableCommitIndex([first], true)
    const html = renderToStaticMarkup(
      <MarkdownCommitReferenceContext.Provider
        value={{ workspacePath: '/repo', chatId: 'chat-1', index }}
      >
        <p>
          Commit <MarkdownCommitReference hash="6a561c53e">6a561c53e</MarkdownCommitReference>
        </p>
      </MarkdownCommitReferenceContext.Provider>
    )

    expect(html).toContain('class="markdown-commit-reference"')
    expect(html).toContain(`data-commit-hash="${first.hash}"`)
    expect(html).toContain('aria-label="Preview commit 6a561c53e: Bound commit previews"')
  })

  it('decorates prose and exact inline code but leaves links and fenced code inert', () => {
    const index = buildTraceableCommitIndex([first], true)
    const html = renderToStaticMarkup(
      <MarkdownCommitReferenceContext.Provider value={{ workspacePath: '/repo', index }}>
        <MarkdownMessage
          content={[
            'Landed **6a561c53e** and `' + first.hash + '`.',
            '',
            `[linked ${first.hash}](https://example.test)`,
            '',
            '```text',
            first.hash,
            '```'
          ].join('\n')}
        />
      </MarkdownCommitReferenceContext.Provider>
    )

    expect((html.match(/class="markdown-commit-reference"/g) || []).length).toBe(2)
    expect(html).toContain('<strong><span class="markdown-commit-reference"')
    expect(html).toContain(`<code>${first.hash}</code>`)
    expect(html).toContain(`linked ${first.hash}`)
    expect(html).toContain('message-code-shell')
  })
})
