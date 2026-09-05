import { describe, expect, it } from 'vitest'
import { ENSEMBLE_FANOUT_WRITE_SCOPES_SCHEMA } from '../shared/ensembleFanoutWriteScopes'
import { createTaskWraithMcpToolDefinitions } from './McpToolCatalog'
import { validateGatewayToolArguments } from './mcp/McpToolGateway'

const schema = createTaskWraithMcpToolDefinitions().find(
  (tool) => tool.name === 'ensemble_fanout'
)!.inputSchema!

describe('fan-out writer-map schema', () => {
  it('uses the shared schema and advertises a keyed example before the first call', () => {
    expect((schema.properties as Record<string, unknown>).writeScopes).toEqual(
      ENSEMBLE_FANOUT_WRITE_SCOPES_SCHEMA
    )
    expect(ENSEMBLE_FANOUT_WRITE_SCOPES_SCHEMA.description).toContain(
      '{"Worker":["src/worker.ts"]}'
    )
  })

  it.each([
    { Worker: ['src/worker.ts'] },
    { Worker: 'src/worker.ts' },
    { Worker: 'workspace' },
    { Worker: { type: 'path', path: 'src/worker.ts' } },
    { Worker: [{ kind: 'glob', path: 'src/**' }, 'test/worker.ts'] },
    { Worker: [null, 'src/worker.ts'] },
    '{"Worker":["src/worker.ts"]}',
    undefined
  ])('accepts writer map %j and its compatibility forms', (writeScopes) => {
    expect(
      validateGatewayToolArguments(schema, {
        prompt: 'Implement the slice.',
        mode: 'locked_writers',
        ...(writeScopes !== undefined ? { writeScopes } : {})
      }).ok
    ).toBe(true)
  })

  it('does not advertise a bare path array as a writer map', () => {
    expect(
      validateGatewayToolArguments(schema, {
        prompt: 'Implement the slice.',
        mode: 'locked_writers',
        writeScopes: ['src/worker.ts']
      }).ok
    ).toBe(false)
  })
})
