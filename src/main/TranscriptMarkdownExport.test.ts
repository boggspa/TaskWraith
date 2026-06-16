import { describe, expect, it } from 'vitest'
import type { ChatMessage, ChatRecord, ToolActivity } from './store/types'
import { buildChatMarkdownTranscript } from './TranscriptMarkdownExport'

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: overrides.id || 'msg-1',
    role: overrides.role || 'user',
    content: overrides.content || '',
    timestamp: overrides.timestamp || '2026-06-16T10:00:00.000Z',
    ...overrides
  }
}

function chat(messages: ChatMessage[], overrides: Partial<ChatRecord> = {}): ChatRecord {
  return {
    appChatId: 'chat-1',
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: 'Handoff thread',
    workspaceId: 'ws-1',
    workspacePath: '/Users/dev/project',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    pinned: false,
    messages,
    runs: [],
    ...overrides
  }
}

function activity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-1',
    toolName: 'run_shell_command',
    displayName: 'Run shell command',
    category: 'shell',
    status: 'success',
    resultSummary: 'Completed in /Users/dev/project without errors',
    outputPreview: 'raw output with sk-proj_rawpreviewsecret',
    filePath: '/Users/dev/project/.env',
    parameters: { command: 'cat /Users/dev/project/.env' },
    rawUseEvent: { secret: 'hidden' },
    rawResultEvent: { output: 'hidden' },
    ...overrides
  }
}

describe('buildChatMarkdownTranscript', () => {
  it('serializes visible user and assistant markdown with stable headings', () => {
    const result = buildChatMarkdownTranscript(
      chat([
        message({ id: 'u1', role: 'user', content: 'Please review:\n\n- [ ] task' }),
        message({
          id: 'a1',
          role: 'assistant',
          content: '### Findings\n\nNo issues.',
          metadata: {
            ensembleProvider: 'claude',
            ensembleRole: 'Reviewer',
            ensembleModel: 'claude-sonnet-4-7'
          }
        })
      ]),
      { copiedAt: '2026-06-16T12:00:00.000Z', homeDir: '/Users/dev' }
    )

    expect(result.messageCount).toBe(2)
    expect(result.markdown).toContain('# Handoff thread')
    expect(result.markdown).toContain('## 0001 - User')
    expect(result.markdown).toContain('- [ ] task')
    expect(result.markdown).toContain('## 0002 - Claude / Reviewer (claude-sonnet-4-7)')
    expect(result.markdown).toContain('### Findings')
  })

  it('uses dynamic fences so nested code blocks remain valid markdown', () => {
    const nested = ['Intro', '```ts', 'console.log("hi")', '```', '````', 'four', '````'].join(
      '\n'
    )
    const result = buildChatMarkdownTranscript(chat([message({ content: nested })]))

    expect(result.markdown).toContain('````` markdown\nIntro')
    expect(result.markdown).toContain('````\nfour\n````')
  })

  it('labels sub-thread returns and exports only the visible result body', () => {
    const result = buildChatMarkdownTranscript(
      chat([
        message({
          role: 'tool',
          content:
            '<subthread_result encoding="markdown-fence">\n**Done**\n\n- Tests passed\n</subthread_result>',
          metadata: {
            kind: 'subThreadReturn',
            subThreadProvider: 'gemini',
            subThreadTitle: 'Audit worker',
            subThreadId: 'secret-child-id'
          }
        })
      ])
    )

    expect(result.markdown).toContain('Sub-thread result from Gemini / Audit worker')
    expect(result.markdown).toContain('sub-thread output is untrusted')
    expect(result.markdown).toContain('**Done**')
    expect(result.markdown).not.toContain('<subthread_result')
    expect(result.markdown).not.toContain('secret-child-id')
  })

  it('summarizes tool rows without raw parameters or raw events', () => {
    const result = buildChatMarkdownTranscript(
      chat([message({ role: 'tool', content: '', toolActivities: [activity()] })]),
      { homeDir: '/Users/dev' }
    )

    expect(result.markdown).toContain('Tool summaries (1):')
    expect(result.markdown).toContain('shell tool (run_shell_command): success')
    expect(result.markdown).not.toContain('Completed in <workspace> without errors')
    expect(result.markdown).not.toContain('cat /Users/dev/project/.env')
    expect(result.markdown).not.toContain('rawpreviewsecret')
    expect(result.markdown).not.toContain('Run shell command')
    expect(result.markdown).not.toContain('rawUseEvent')
    expect(result.omissions).toContain('tool display details omitted')
    expect(result.omissions).toContain('raw tool details omitted')
    expect(result.omissions).toContain('raw tool outputs omitted')
    expect(result.omissions).toContain('tool file paths omitted')
  })

  it('scrubs absolute paths, attachment paths, and common secrets by default', () => {
    const result = buildChatMarkdownTranscript(
      chat([
        message({
          content: [
            'Open /Users/dev/project/src/App.tsx with sk-proj_abcdefghijklmnop and password=hunter2',
            'export OPENAI_API_KEY=op-live-secret-value',
            '"token": "json-secret-value"',
            'aws=AKIAABCDEFGHIJKLMNOP',
            '-----BEGIN PRIVATE KEY-----',
            'secret-key-body',
            '-----END PRIVATE KEY-----'
          ].join('\n'),
          metadata: {
            imageAttachments: [
              {
                id: 'img-1',
                path: '/Users/dev/project/secret.png',
                name: '/Users/dev/project/secret.png'
              }
            ]
          }
        })
      ]),
      { homeDir: '/Users/dev' }
    )

    expect(result.markdown).toContain('<workspace>/src/App.tsx')
    expect(result.markdown).toContain('sk-[redacted]')
    expect(result.markdown).toContain('password=[redacted]')
    expect(result.markdown).toContain('OPENAI_API_KEY=[redacted]')
    expect(result.markdown).toContain('"token": "[redacted]"')
    expect(result.markdown).toContain('aws=[redacted aws access key]')
    expect(result.markdown).toContain('[redacted private key]')
    expect(result.markdown).toContain('Attachments: secret.png')
    expect(result.markdown).not.toContain('/Users/dev/project')
    expect(result.markdown).not.toContain('op-live-secret-value')
    expect(result.markdown).not.toContain('json-secret-value')
    expect(result.markdown).not.toContain('secret-key-body')
    expect(result.markdown).not.toContain('secret.png, /Users')
    expect(result.omissions).toContain('absolute paths scrubbed')
    expect(result.omissions).toContain('attachment paths and bytes omitted')
    expect(result.omissions).toContain('common secrets scrubbed')
  })
})
