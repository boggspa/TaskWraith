import { describe, it, expect } from 'vitest'
import { buildCursorCliArgs, cursorWriteCapable } from './CursorCliArgs'

describe('cursorWriteCapable', () => {
  it('is read-only for plan / empty / unset', () => {
    expect(cursorWriteCapable('plan')).toBe(false)
    expect(cursorWriteCapable('')).toBe(false)
    expect(cursorWriteCapable(null)).toBe(false)
    expect(cursorWriteCapable(undefined)).toBe(false)
  })
  it('is write-capable for any other mode', () => {
    expect(cursorWriteCapable('default')).toBe(true)
    expect(cursorWriteCapable('acceptEdits')).toBe(true)
  })
})

describe('buildCursorCliArgs', () => {
  const base = { prompt: 'do a thing', workspace: '/ws' }
  const discordPrompt = [
    'Summarize build status.',
    '',
    'External Discord channel snapshot context.',
    '<discord_messages channel="123" encoding="markdown-fence">',
    '``` text',
    '[2026-06-16T12:00:00.000Z] alice: CI failed on linux.',
    '```',
    '</discord_messages>'
  ].join('\n')

  it('always uses headless stream-json with --trust + --workspace', () => {
    const args = buildCursorCliArgs(base)
    expect(args).toContain('-p')
    expect(args.join(' ')).toContain('--output-format stream-json')
    expect(args).toContain('--trust')
    expect(args.join(' ')).toContain('--workspace /ws')
    // prompt is the trailing positional
    expect(args[args.length - 1]).toBe('do a thing')
  })

  it('preserves Discord context prompt text as the trailing positional prompt', () => {
    const args = buildCursorCliArgs({ ...base, prompt: discordPrompt, approvalMode: 'default' })

    expect(args[args.length - 1]).toBe(discordPrompt)
    expect(args[args.length - 1]).toContain('External Discord channel snapshot context')
  })

  it('read-only mode passes --mode plan', () => {
    const args = buildCursorCliArgs({ ...base, approvalMode: 'plan' })
    expect(args.join(' ')).toContain('--mode plan')
  })

  it('write-capable mode omits --mode plan', () => {
    const args = buildCursorCliArgs({ ...base, approvalMode: 'acceptEdits' })
    expect(args).not.toContain('plan')
  })

  it('NEVER passes --force or --yolo (read-only OR write)', () => {
    for (const mode of ['plan', 'default', 'acceptEdits', '']) {
      const args = buildCursorCliArgs({ ...base, approvalMode: mode })
      expect(args).not.toContain('--force')
      expect(args).not.toContain('-f')
      expect(args).not.toContain('--yolo')
    }
  })

  it('forwards only Composer 2.5 model ids', () => {
    expect(buildCursorCliArgs({ ...base, model: 'composer-2.5' }).join(' ')).toContain(
      '--model composer-2.5'
    )
    expect(buildCursorCliArgs({ ...base, model: 'composer-2.5-fast' }).join(' ')).toContain(
      '--model composer-2.5-fast'
    )
  })

  it('drops non-Composer / sentinel / leaked model ids', () => {
    for (const m of ['gpt-5', 'cli-default', 'flash-lite', 'sonnet-4', '']) {
      expect(buildCursorCliArgs({ ...base, model: m })).not.toContain('--model')
    }
  })

  it('appends --resume for a real chat id, not for empty', () => {
    expect(buildCursorCliArgs({ ...base, providerSessionId: 'chat_123' }).join(' ')).toContain(
      '--resume chat_123'
    )
    expect(buildCursorCliArgs({ ...base, providerSessionId: '   ' })).not.toContain('--resume')
  })

  it('adds --approve-mcps only for write-capable runs with the TaskWraith MCP bridge active', () => {
    // Write-capable + bridge → flag present.
    expect(
      buildCursorCliArgs({ ...base, approvalMode: 'acceptEdits', webBridgeActive: true })
    ).toContain('--approve-mcps')
    // Write-capable but bridge NOT active (e.g. config write failed) → no flag.
    expect(
      buildCursorCliArgs({ ...base, approvalMode: 'acceptEdits', webBridgeActive: false })
    ).not.toContain('--approve-mcps')
    // Plan mode never executes MCP tools → never flag it, even if asked.
    expect(
      buildCursorCliArgs({ ...base, approvalMode: 'plan', webBridgeActive: true })
    ).not.toContain('--approve-mcps')
    // Default (no webBridgeActive) → no flag.
    expect(buildCursorCliArgs({ ...base, approvalMode: 'acceptEdits' })).not.toContain(
      '--approve-mcps'
    )
  })

  it('still never passes --force / --yolo with the TaskWraith MCP bridge active', () => {
    const args = buildCursorCliArgs({ ...base, approvalMode: 'default', webBridgeActive: true })
    expect(args).not.toContain('--force')
    expect(args).not.toContain('--yolo')
  })
})
