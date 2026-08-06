import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord } from './store/types'
import { buildArchivedChatExport } from './ArchivedChatExport'

function chat(messages: ChatMessage[]): ChatRecord {
  return {
    appChatId: 'archived-1',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: 'Archived review',
    workspaceId: 'workspace-1',
    workspacePath: '/Users/chris/project',
    createdAt: 1,
    updatedAt: 2,
    archived: true,
    messages,
    runs: []
  }
}

function message(role: ChatMessage['role'], content: string): ChatMessage {
  return {
    id: `${role}-1`,
    role,
    content,
    timestamp: '2026-08-07T10:00:00.000Z'
  }
}

describe('buildArchivedChatExport', () => {
  const record = chat([
    message('user', 'Please review /Users/chris/project.'),
    message('assistant', 'The review is complete.')
  ])

  it('builds scrubbed Markdown and plain-text exports', () => {
    const markdown = buildArchivedChatExport(record, 'markdown', {
      homeDir: '/Users/chris'
    })
    const text = buildArchivedChatExport(record, 'text')

    expect(markdown.extension).toBe('md')
    expect(markdown.content).toContain('# Archived review')
    expect(markdown.content).toContain('<workspace>')
    expect(text.extension).toBe('txt')
    expect(text.content).toBe('Please review /Users/chris/project.\n\nThe review is complete.')
  })

  it('builds escaped HTML and a readable Word document', () => {
    const html = buildArchivedChatExport(
      chat([message('user', '<script>alert(1)</script>')]),
      'html'
    )
    const docx = buildArchivedChatExport(record, 'docx')

    expect(html.extension).toBe('html')
    expect(html.content).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html.content).not.toContain('<script>alert(1)</script>')
    expect(docx.extension).toBe('docx')
    expect(docx.encoding).toBe('binary')
    expect(Buffer.isBuffer(docx.content)).toBe(true)
    expect((docx.content as Buffer).subarray(0, 2).toString()).toBe('PK')
  })
})
