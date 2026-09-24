import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('provider steering integration', () => {
  const main = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

  it('binds Codex native turn steering only after the exact operation id', () => {
    const bind = main.indexOf('function bindCodexRunExactOperationId')
    const assignment = main.indexOf('state.turnId = operationId', bind)
    const register = main.indexOf('maybeRegisterCodexLiveSteerTransport(state)', assignment)

    expect(bind).toBeGreaterThan(0)
    expect(assignment).toBeGreaterThan(bind)
    expect(register).toBeGreaterThan(assignment)
  })

  it('uses Claude SDK PostToolBatch instead of generic tool-result projection', () => {
    const query = main.indexOf('const stream = query({')
    const postToolBatch = main.indexOf('createClaudePostToolBatchSteerHook({', query)

    expect(query).toBeGreaterThan(0)
    expect(postToolBatch).toBeGreaterThan(query)
    expect(main.slice(query, postToolBatch + 800)).toContain('PostToolBatch')
  })

  it.each(['grok', 'mistral', 'kimi'])(
    'wires %s through the ACP full-tool-batch callback',
    (provider) => {
      expect(main).toContain(`scheduleQueuedSteerToolBoundary('${provider}', route.appRunId!)`)
    }
  )

  it('wires Ollama after its provider-owned full tool batch', () => {
    expect(main).toContain(
      "onToolBatchBoundary: (runId) => interruptQueuedSteerAtToolBoundary('ollama', runId)"
    )
  })

  it('routes prepared steer payloads through the structured policy', () => {
    const handler = main.indexOf("'steering:inject'")
    const authority = main.indexOf('resolveSoloSteerInjectionAuthority({', handler)
    const classify = main.indexOf('classifyPreparedSoloSteerPayload({', authority)
    const accelerate = main.indexOf(
      "if (payloadDecision.delivery === 'durable-boundary')",
      classify
    )
    const live = main.indexOf('imagePaths: payloadDecision.liveImagePaths', accelerate)

    expect(handler).toBeGreaterThan(0)
    expect(authority).toBeGreaterThan(handler)
    expect(classify).toBeGreaterThan(authority)
    expect(accelerate).toBeGreaterThan(classify)
    expect(live).toBeGreaterThan(accelerate)
  })
})
