import { describe, expect, it, vi } from 'vitest'
import {
  OUTLOOK_MCP_TOOL_NAMES,
  OUTLOOK_MUTATING_TOOL_NAMES,
  UNTRUSTED_CONTENT_NOTE,
  createOutlookToolExecutors,
  isOutlookMcpToolName
} from './OutlookToolExecutors'
import type { OutlookConnectorService } from '../outlook/OutlookConnectorService'

function stubConnector(overrides: Partial<OutlookConnectorService> = {}): OutlookConnectorService {
  return {
    listMessages: vi.fn(async () => ({ ok: true, messages: [{ id: 'm1', subject: 'Hi' }] })),
    searchMessages: vi.fn(async () => ({ ok: true, messages: [] })),
    getMessage: vi.fn(async () => ({
      ok: true,
      mail: {
        model: {
          kind: 'mail',
          from: 'a@b.c',
          to: 'd@e.f',
          cc: '',
          bcc: 'secret@hidden.example',
          subject: 'S',
          body: 'B'
        },
        messageId: 'm1',
        warnings: []
      }
    })),
    listEvents: vi.fn(async () => ({
      ok: true,
      events: [{ event: { uid: 'e1', title: 'Standup' }, eventId: 'e1', warnings: [] }]
    })),
    createDraft: vi.fn(async () => ({ ok: true, draftId: 'd1', webLink: 'https://x/y' })),
    createEvent: vi.fn(async () => ({ ok: true, eventId: 'e1', webLink: 'https://x/e' })),
    ...overrides
  } as unknown as OutlookConnectorService
}

const executorsFor = (connector: OutlookConnectorService | null) =>
  createOutlookToolExecutors({ connector: () => connector })

describe('tool surface', () => {
  it('exposes reads and DRAFT writes only — no send tool exists', () => {
    expect([...OUTLOOK_MCP_TOOL_NAMES]).toEqual([
      'outlook_list_messages',
      'outlook_search_messages',
      'outlook_get_message',
      'outlook_list_events',
      'outlook_create_draft',
      'outlook_create_event'
    ])
    // The absence of a send tool is the safety property; assert it directly.
    expect(OUTLOOK_MCP_TOOL_NAMES.some((name) => /send|reply|forward/.test(name))).toBe(false)
    expect(isOutlookMcpToolName('outlook_send_message')).toBe(false)
    expect([...OUTLOOK_MUTATING_TOOL_NAMES]).toEqual([
      'outlook_create_draft',
      'outlook_create_event'
    ])
  })
})

describe('without a connected account', () => {
  it('refuses every tool with an actionable message', async () => {
    const { executeOutlookMcpTool } = executorsFor(null)
    for (const name of OUTLOOK_MCP_TOOL_NAMES) {
      const result = await executeOutlookMcpTool(name, {})
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.result)).toContain('No Microsoft account is connected')
    }
  })
})

describe('reads', () => {
  it('marks message payloads as untrusted third-party content', async () => {
    const { executeOutlookMcpTool } = executorsFor(stubConnector())
    for (const name of [
      'outlook_list_messages',
      'outlook_get_message',
      'outlook_list_events'
    ] as const) {
      const args = name === 'outlook_get_message' ? { messageId: 'm1' } : {}
      const result = await executeOutlookMcpTool(name, {
        ...args,
        startIso: '2026-08-01',
        endIso: '2026-08-02'
      })
      expect(result.isError).toBe(false)
      expect((result.result as { note: string }).note).toBe(UNTRUSTED_CONTENT_NOTE)
    }
  })

  it('clamps the requested page size', async () => {
    const connector = stubConnector()
    const { executeOutlookMcpTool } = executorsFor(connector)
    await executeOutlookMcpTool('outlook_list_messages', { limit: 5_000 })
    expect(vi.mocked(connector.listMessages)).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 })
    )
  })

  it('does not expose bcc when reporting a message', async () => {
    const { executeOutlookMcpTool } = executorsFor(stubConnector())
    const result = await executeOutlookMcpTool('outlook_get_message', { messageId: 'm1' })
    expect(JSON.stringify(result.result)).not.toContain('secret@hidden.example')
  })

  it('requires a query and an event window', async () => {
    const { executeOutlookMcpTool } = executorsFor(stubConnector())
    expect((await executeOutlookMcpTool('outlook_search_messages', { query: '  ' })).isError).toBe(
      true
    )
    expect((await executeOutlookMcpTool('outlook_list_events', {})).isError).toBe(true)
  })

  it('surfaces connector failures as tool errors', async () => {
    const connector = stubConnector({
      listMessages: vi.fn(async () => ({
        ok: false,
        error: 'throttled',
        message: 'Try again shortly.'
      })) as never
    })
    const result = await executorsFor(connector).executeOutlookMcpTool('outlook_list_messages', {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.result)).toContain('Try again shortly.')
  })
})

describe('draft creation', () => {
  it('creates a draft and says plainly that nothing was sent', async () => {
    const connector = stubConnector()
    const result = await executorsFor(connector).executeOutlookMcpTool('outlook_create_draft', {
      subject: 'Weekly update',
      body: 'Here it is.',
      to: 'bob@example.com, carol@example.com'
    })
    expect(result.isError).toBe(false)
    expect(vi.mocked(connector.createDraft)).toHaveBeenCalledWith({
      subject: 'Weekly update',
      body: 'Here it is.',
      to: ['bob@example.com', 'carol@example.com'],
      cc: []
    })
    expect((result.result as { note: string }).note).toContain('has NOT been sent')
  })

  it('drops malformed recipients and de-duplicates the rest', async () => {
    const connector = stubConnector()
    await executorsFor(connector).executeOutlookMcpTool('outlook_create_draft', {
      subject: 'S',
      body: 'B',
      to: 'bob@example.com, not-an-address, BOB@example.com, <script>@x, carol@example.com'
    })
    expect(vi.mocked(connector.createDraft).mock.calls[0][0].to).toEqual([
      'bob@example.com',
      'carol@example.com'
    ])
  })

  it('requires some content', async () => {
    const { executeOutlookMcpTool } = executorsFor(stubConnector())
    const result = await executeOutlookMcpTool('outlook_create_draft', { to: 'a@b.c' })
    expect(result.isError).toBe(true)
  })
})

describe('calendar creation', () => {
  it('creates an entry with no attendees', async () => {
    const connector = stubConnector()
    const result = await executorsFor(connector).executeOutlookMcpTool('outlook_create_event', {
      subject: 'Focus block',
      startIso: '2026-08-01T09:00',
      endIso: '2026-08-01T10:00'
    })
    expect(result.isError).toBe(false)
    expect((result.result as { note: string }).note).toContain('no invitations were sent')
  })

  it('refuses attendees, because Graph would mail invitations on create', async () => {
    const connector = stubConnector()
    const result = await executorsFor(connector).executeOutlookMcpTool('outlook_create_event', {
      subject: 'Kickoff',
      startIso: '2026-08-01T09:00',
      endIso: '2026-08-01T10:00',
      attendees: 'bob@example.com'
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.result)).toContain('never sends')
    expect(vi.mocked(connector.createEvent)).not.toHaveBeenCalled()
  })

  it('requires a subject and a window', async () => {
    const { executeOutlookMcpTool } = executorsFor(stubConnector())
    expect((await executeOutlookMcpTool('outlook_create_event', { subject: 'x' })).isError).toBe(
      true
    )
  })
})
