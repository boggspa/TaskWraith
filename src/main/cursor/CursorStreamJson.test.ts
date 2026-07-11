import { describe, it, expect } from 'vitest'
import {
  cursorEffectiveExitCode,
  cursorEventToRunEvents,
  cursorTerminalCompatOutcome,
  cursorTerminalFailureText,
  cursorToolKind,
  parseCursorStreamChunk,
  type CursorStreamLine
} from './CursorStreamJson'

const ev = (json: Record<string, unknown>): CursorStreamLine => ({ json })

describe('CursorStreamJson', () => {
  describe('parseCursorStreamChunk', () => {
    it('splits NDJSON and carries a partial trailing line', () => {
      const a = parseCursorStreamChunk('{"type":"system","subtype":"init"}\n{"type":"assist', '')
      expect(a.lines).toHaveLength(1)
      expect(a.lines[0].json?.type).toBe('system')
      expect(a.carry).toBe('{"type":"assist')
      const b = parseCursorStreamChunk(
        'ant","message":{"content":[{"type":"text","text":"hi"}]}}\n',
        a.carry
      )
      expect(b.lines).toHaveLength(1)
      expect(b.lines[0].json?.type).toBe('assistant')
      expect(b.carry).toBe('')
    })
    it('emits non-JSON lines as nonJson (never crashes)', () => {
      const { lines } = parseCursorStreamChunk('not json here\n', '')
      expect(lines[0].nonJson).toBe('not json here')
    })
  })

  describe('cursorEventToRunEvents', () => {
    it('maps system/init to an init event with session id + model', () => {
      expect(
        cursorEventToRunEvents(
          ev({ type: 'system', subtype: 'init', session_id: 's1', model: 'Composer 2.5 Fast' })
        )
      ).toEqual([
        { type: 'init', sessionId: 's1', model: 'Composer 2.5 Fast', raw: expect.anything() }
      ])
    })

    it('ignores the user echo', () => {
      expect(
        cursorEventToRunEvents(ev({ type: 'user', message: { role: 'user', content: [] } }))
      ).toEqual([])
    })

    it('maps an assistant message to a content event (concatenated text blocks)', () => {
      expect(
        cursorEventToRunEvents(
          ev({
            type: 'assistant',
            session_id: 's1',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Hello ' },
                { type: 'text', text: 'world' }
              ]
            }
          })
        )
      ).toEqual([{ type: 'content', text: 'Hello world', sessionId: 's1', raw: expect.anything() }])
    })

    it('maps thinking delta to thinking, completed to nothing', () => {
      expect(
        cursorEventToRunEvents(ev({ type: 'thinking', subtype: 'delta', text: 'Hmm' }))
      ).toEqual([{ type: 'thinking', text: 'Hmm', sessionId: undefined, raw: expect.anything() }])
      expect(cursorEventToRunEvents(ev({ type: 'thinking', subtype: 'completed' }))).toEqual([])
    })

    it('maps tool_call started to a tool_use with kind + name + input', () => {
      expect(
        cursorEventToRunEvents(
          ev({
            type: 'tool_call',
            subtype: 'started',
            call_id: 'tool_1',
            tool_call: { editToolCall: { args: { path: 'x.ts', contents: 'a' } } }
          })
        )
      ).toEqual([
        {
          type: 'tool_use',
          toolId: 'tool_1',
          toolName: 'edit',
          toolKind: 'edit',
          toolInput: { path: 'x.ts', contents: 'a' },
          raw: expect.anything()
        }
      ])
    })

    it('maps an MCP tool_call to its nested tool name + kind (not the generic "mcp")', () => {
      // CRUX40 real shape: { mcpToolCall: { toolName:'web_fetch',
      // providerIdentifier:'taskwraith', name:'taskwraith-web_fetch', args:{…} } }. The
      // card must read the nested toolName so it renders "Fetched a web page"
      // (web_fetch → fetch) / "Searched web for …" (web_search → search), not "mcp".
      const fetched = cursorEventToRunEvents(
        ev({
          type: 'tool_call',
          subtype: 'started',
          call_id: 'tool_a',
          tool_call: {
            mcpToolCall: {
              providerIdentifier: 'taskwraith',
              toolName: 'web_fetch',
              name: 'taskwraith-web_fetch',
              args: { url: 'https://example.com' }
            }
          }
        })
      )
      expect(fetched[0].toolName).toBe('web_fetch')
      expect(fetched[0].toolKind).toBe('fetch')

      const searched = cursorEventToRunEvents(
        ev({
          type: 'tool_call',
          subtype: 'started',
          call_id: 'tool_b',
          tool_call: { mcpToolCall: { toolName: 'web_search', args: { query: 'weather' } } }
        })
      )
      expect(searched[0].toolName).toBe('web_search')
      expect(searched[0].toolKind).toBe('search')
    })

    it('exposes editToolCall streamContent as `content` for the inline diff', () => {
      // Real 2026.05.28 shape (captured): the edit tool streams the new file
      // content under `streamContent` + the target under `path`, with NO
      // old_string/new_string. The renderer derives a diff from `content`, so
      // the parser must surface streamContent there.
      const out = cursorEventToRunEvents(
        ev({
          type: 'tool_call',
          subtype: 'started',
          call_id: 'edit_1',
          tool_call: {
            editToolCall: { args: { path: '/tmp/note.txt', streamContent: 'line one.\n' } }
          }
        })
      )
      expect(out).toHaveLength(1)
      expect(out[0].type).toBe('tool_use')
      expect(out[0].toolKind).toBe('edit')
      // path preserved + streamContent mirrored to `content` (original kept too).
      expect(out[0].toolInput).toEqual({
        path: '/tmp/note.txt',
        streamContent: 'line one.\n',
        content: 'line one.\n'
      })
    })

    it('maps a successful tool_call completed to a success tool_result', () => {
      const out = cursorEventToRunEvents(
        ev({
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'tool_1',
          tool_call: {
            globToolCall: {
              args: {},
              result: { success: { files: ['a.js', 'b.js'], totalFiles: 2 } }
            }
          }
        })
      )
      expect(out[0].type).toBe('tool_result')
      expect(out[0].toolStatus).toBe('success')
      expect(out[0].toolId).toBe('tool_1')
      expect(out[0].toolOutput).toContain('a.js')
    })

    it('maps a denied tool_call completed to an error tool_result with the message', () => {
      const out = cursorEventToRunEvents(
        ev({
          type: 'tool_call',
          subtype: 'completed',
          call_id: 'tool_9',
          tool_call: {
            editToolCall: {
              args: { path: 'x.txt' },
              result: {
                writePermissionDenied: {
                  path: '',
                  error: 'Write permission denied: Blocked by permissions configuration',
                  isReadonly: false
                }
              }
            }
          }
        })
      )
      expect(out[0].type).toBe('tool_result')
      expect(out[0].toolStatus).toBe('error')
      expect(out[0].toolOutput).toContain('Write permission denied')
    })

    it('maps result/success to a result event with usage + session', () => {
      expect(
        cursorEventToRunEvents(
          ev({
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: 's1',
            result: 'final answer',
            usage: {
              inputTokens: 8129,
              outputTokens: 834,
              cacheReadTokens: 29056,
              cacheWriteTokens: 0
            }
          })
        )
      ).toEqual([
        {
          type: 'result',
          status: 'success',
          sessionId: 's1',
          usage: {
            inputTokens: 8129,
            outputTokens: 834,
            cacheReadTokens: 29056,
            cacheWriteTokens: 0
          },
          text: 'final answer',
          raw: expect.anything()
        }
      ])
    })

    it('marks an is_error result as failed', () => {
      const out = cursorEventToRunEvents(
        ev({
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          result: "This model's maximum context length is 128000 tokens"
        })
      )
      expect(out[0].type).toBe('result')
      expect(out[0].status).toBe('error_max_turns')
      expect(out[0].text).toBe("This model's maximum context length is 128000 tokens")
      expect(cursorTerminalCompatOutcome(out[0])).toEqual({
        failed: true,
        status: 'failed',
        subtype: 'error',
        text: "This model's maximum context length is 128000 tokens"
      })
      expect(cursorEffectiveExitCode(0, true)).toBe(1)
      expect(cursorEffectiveExitCode(0, false)).toBe(0)
    })

    it('preserves a no-text context overflow subtype for failure classification', () => {
      const out = cursorEventToRunEvents(
        ev({ type: 'result', subtype: 'context_length_exceeded', is_error: true })
      )
      expect(out).toHaveLength(1)
      expect(cursorTerminalFailureText(out[0])).toBe('context_length_exceeded')
      expect(cursorEffectiveExitCode(0, cursorTerminalCompatOutcome(out[0])!.failed)).toBe(1)
    })

    it('maps error to a provider_warning', () => {
      expect(cursorEventToRunEvents(ev({ type: 'error', message: 'boom' }))).toEqual([
        { type: 'provider_warning', text: 'boom', raw: expect.anything() }
      ])
    })

    it('surfaces a non-JSON line as content', () => {
      expect(cursorEventToRunEvents({ nonJson: 'banner text' })).toEqual([
        { type: 'content', text: 'banner text\n', raw: 'banner text' }
      ])
    })

    it('ignores genuinely-unknown event types', () => {
      expect(cursorEventToRunEvents(ev({ type: 'telemetry', foo: 1 }))).toEqual([])
      expect(cursorEventToRunEvents(ev({ type: 'word', text: 'x' }))).toEqual([])
    })
  })

  describe('cursorToolKind', () => {
    it('maps Cursor tool bases to AD3 canonical kinds', () => {
      expect(cursorToolKind('read')).toBe('read')
      expect(cursorToolKind('glob')).toBe('search')
      expect(cursorToolKind('grep')).toBe('search')
      expect(cursorToolKind('edit')).toBe('edit')
      expect(cursorToolKind('write')).toBe('edit')
      expect(cursorToolKind('shell')).toBe('execute')
      expect(cursorToolKind('createPlan')).toBe('think')
      expect(cursorToolKind('delete')).toBe('delete')
      expect(cursorToolKind('mysteryTool')).toBeUndefined()
    })
  })
})
