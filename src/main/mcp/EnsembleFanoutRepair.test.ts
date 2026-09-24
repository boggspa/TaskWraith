import { describe, expect, it } from 'vitest'
import { normalizeEnsembleMcpToolArguments } from '../../shared/taskWraithMcpCatalog'
import { ENSEMBLE_GROUP_MENTIONS } from '../../shared/ensembleGroupMention'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import { validateGatewayToolArguments } from './McpToolGateway'
import { attachMcpResultRepairHints, type McpResultRepairHint } from './McpResultRepairHints'

const shapeError = {
  ok: false,
  tool: 'ensemble_fanout',
  error: 'invalid_write_scope',
  message: 'ensemble_fanout: locked-writers writeScopes must be an object keyed by target alias.'
}
const base = {
  targets: ['Validator'],
  prompt: 'Implement the assigned slice.',
  mode: 'locked_writers',
  reason: 'Finish the gate.',
  targetStage: 'workers',
  isolation: 'off'
}
const paths = ['src/one.ts', 'src/two.ts', 'src/three.ts']

function repair(args: Record<string, unknown>, result = shapeError): McpResultRepairHint {
  return (
    attachMcpResultRepairHints({
      toolName: 'ensemble_fanout',
      receivedArguments: args,
      normalizedArguments: normalizeEnsembleMcpToolArguments('ensemble_fanout', args),
      result
    }) as { repair: McpResultRepairHint }
  ).repair
}

describe('fan-out writer-scope recovery', () => {
  it.each([paths, JSON.stringify(paths)])(
    'turns an unkeyed list %j into a replayable suggestion for its single explicit target',
    (writeScopes) => {
      const hint = repair({ ...base, writeScopes })
      expect(hint.requiresInput).toBe(false)
      expect(hint.retryTemplate).toEqual({ ...base, writeScopes: { Validator: paths } })
      const schema = createTaskWraithMcpToolDefinitions().find(
        (tool) => tool.name === 'ensemble_fanout'
      )!.inputSchema
      expect(validateGatewayToolArguments(schema, hint.retryTemplate).ok).toBe(true)
      expect(hint.why).toContain(shapeError.message)
      expect(hint.why).toContain('correct the arguments, and retry ensemble_fanout')
      expect(hint.why).toContain('does not repair writer delegation')
    }
  )

  it('keeps the participant ID, every path and isolation when decoding the observed retry shape', () => {
    const scopes = { 'ensemble-participant-20': paths }
    const args = Object.freeze({ ...base, writeScopes: JSON.stringify(scopes) })
    const hint = repair(args)
    expect(hint.requiresInput).toBe(false)
    expect(hint.retryTemplate).toEqual({ ...base, writeScopes: scopes })
    expect(args.writeScopes).toBe(JSON.stringify(scopes))
  })

  it.each([
    undefined,
    ['*'],
    ...ENSEMBLE_GROUP_MENTIONS.map(({ token }) => [token]),
    ['Validator', 'Reviewer']
  ])(
    'requires the agent to select a writer for targets %j rather than inventing ownership',
    (targets) => {
      const hint = repair({ ...base, targets, writeScopes: paths })
      expect(hint.requiresInput).toBe(true)
      expect(hint.retryTemplate.writeScopes).toEqual({ '<writer-participant-id>': paths })
      expect(hint.why).toContain('Choose the intended writer participant ID')
    }
  )

  it.each([undefined, [], '', '{broken', '[]', {}])(
    'marks missing or malformed scopes %j as needing a concrete path',
    (writeScopes) => {
      const hint = repair({ ...base, writeScopes })
      expect(hint.requiresInput).toBe(true)
      expect(hint.retryTemplate.writeScopes).toEqual({ Validator: ['<workspace-relative-path>'] })
    }
  )

  it('keeps valid scope entries while exposing the exact rejected alias', () => {
    const scopes = { Typo: paths, Reviewer: ['test/review.ts'] }
    const hint = repair(
      { ...base, targets: ['Validator', 'Reviewer'], writeScopes: scopes },
      {
        ...shapeError,
        message:
          'ensemble_fanout: unknown writeScopes key "Typo". Valid target aliases: p1, Validator; p2, Reviewer.'
      }
    )
    expect(hint.requiresInput).toBe(true)
    expect(hint.retryTemplate.writeScopes).toEqual(scopes)
    expect(hint.why).toContain('unknown writeScopes key "Typo"')
    expect(hint.why).toContain('list_ensemble_participants')
  })

  it('retains snake_case target-stage and write scope arguments in canonical form', () => {
    const hint = repair({
      prompt: base.prompt,
      targets: ['@Validator'],
      mode: base.mode,
      isolation: 'worktree',
      target_stage: 'backgrounds',
      write_scopes: JSON.stringify(paths)
    })
    expect(hint.retryTemplate).toEqual({
      prompt: base.prompt,
      targets: ['@Validator'],
      mode: base.mode,
      isolation: 'worktree',
      targetStage: 'backgrounds',
      writeScopes: { Validator: paths }
    })
  })

  it.each(['locked_writers_not_authorized', 'concurrent_lanes_disabled', 'budget_exhausted'])(
    'leaves the host verdict %s alone instead of suggesting an argument retry',
    (error) => {
      const result = { ok: false, error }
      expect(
        attachMcpResultRepairHints({
          toolName: 'ensemble_fanout',
          receivedArguments: { ...base, writeScopes: paths },
          result
        })
      ).toBe(result)
    }
  )
})
