import { describe, expect, it } from 'vitest'

import {
  extractToolInvocationParameters,
  mergeToolResultParameters,
  presentToolInvocation
} from './toolInvocationPresentation'

describe('tool invocation presentation', () => {
  it('retains populated argument bags when another envelope bag is empty', () => {
    expect(
      extractToolInvocationParameters({
        parameters: {},
        arguments: { path: 'src/a.ts', old_string: 'old', new_string: 'new' }
      })
    ).toMatchObject({ path: 'src/a.ts', old_string: 'old', new_string: 'new' })
  })

  it('understands Cursor/ACP rawInput and OpenAI function JSON arguments', () => {
    expect(
      extractToolInvocationParameters({ rawInput: { path: 'src/a.ts', content: 'body' } })
    ).toMatchObject({ path: 'src/a.ts', content: 'body' })
    expect(
      extractToolInvocationParameters({
        function: { arguments: '{"path":"src/b.ts","old_string":"a","new_string":"b"}' }
      })
    ).toMatchObject({ path: 'src/b.ts', old_string: 'a', new_string: 'b' })
    expect(
      extractToolInvocationParameters({
        function: { args: { path: 'src/c.ts', content: 'body' } },
        toolInput: { ignored: true }
      })
    ).toMatchObject({ path: 'src/c.ts', content: 'body' })
    expect(
      extractToolInvocationParameters({ tool_input: { path: 'src/d.ts', content: 'body' } })
    ).toMatchObject({ path: 'src/d.ts', content: 'body' })
  })

  it('merges terminal change evidence without replacing the original write body', () => {
    expect(
      mergeToolResultParameters(
        { path: 'src/a.ts', content: 'source body' },
        { result: { changes: [{ path: 'src/a.ts', additions: 2, deletions: 1 }] }, content: 'done' }
      )
    ).toMatchObject({
      path: 'src/a.ts',
      content: 'source body',
      changes: [{ path: 'src/a.ts', additions: 2, deletions: 1 }]
    })
  })

  it('projects a valid capability invocation to its concrete target', () => {
    expect(
      presentToolInvocation('mcp__TaskWraith__capability_invoke', {
        name: 'replace',
        arguments: { path: 'src/a.ts', old_string: 'before', new_string: 'after' }
      })
    ).toEqual({
      toolName: 'replace',
      parameters: { path: 'src/a.ts', old_string: 'before', new_string: 'after' },
      viaCapabilityGateway: true
    })
  })

  it('keeps an invalid capability envelope visibly outer rather than guessing a target', () => {
    expect(
      presentToolInvocation('capability_invoke', {
        name: 'replace',
        input: { name: 'write_file', path: 'src/a.ts' }
      })
    ).toMatchObject({ toolName: 'capability_invoke', viaCapabilityGateway: false })
  })
})
