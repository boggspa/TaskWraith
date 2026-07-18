import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { validateMcpToolArgumentsBeforeApproval } from './McpPreApprovalArgumentValidation'

const definitions = createTaskWraithMcpToolDefinitions()

describe('validateMcpToolArgumentsBeforeApproval', () => {
  it('rejects an empty Boss control call with an actionable example', () => {
    const result = validateMcpToolArgumentsBeforeApproval(
      'ensemble_bossman_control',
      {},
      definitions
    )

    expect(result).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
      issues: [{ path: '#/action', keyword: 'required' }]
    })
    if (result.ok) return
    expect(result.message).toContain('before approval')
    expect(result.message).toContain('"action":"set_round_plan","goal":"Review."')
    expect(result.message).toContain('Do not retry the same invalid invocation')
  })

  it('rejects an unknown Boss action before approval', () => {
    expect(
      validateMcpToolArgumentsBeforeApproval(
        'ensemble_bossman_control',
        { action: 'not_a_real_action' },
        definitions
      )
    ).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
      issues: [{ path: '#/action', keyword: 'enum' }]
    })
  })

  it('accepts a valid populated Boss round-plan call', () => {
    expect(
      validateMcpToolArgumentsBeforeApproval(
        'ensemble_bossman_control',
        { action: 'set_round_plan', goal: 'Review the current task.' },
        definitions
      )
    ).toEqual({ ok: true })
  })

  it('does not impose new schema enforcement on compatibility-heavy direct tools', () => {
    expect(validateMcpToolArgumentsBeforeApproval('read_file', {}, definitions)).toEqual({
      ok: true
    })
  })
})

describe('pre-approval validation integration contracts', () => {
  const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

  it('rejects malformed Claude MCP arguments before either native approval decision', () => {
    const start = indexSource.indexOf('async function canUseClaudeSdkTool(')
    const end = indexSource.indexOf('\nasync function tryRunClaudeSdk(', start)
    const source = indexSource.slice(start, end)
    const preflight = source.indexOf('validateMcpToolArgumentsBeforeApproval(')

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(preflight).toBeGreaterThanOrEqual(0)
    expect(preflight).toBeLessThan(source.indexOf('nativeProviderApprovalPriority('))
    expect(preflight).toBeLessThan(source.indexOf('requestAgenticServiceApproval('))
  })
})
