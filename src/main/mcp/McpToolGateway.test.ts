import { describe, expect, it } from 'vitest'
import { createTaskWraithMcpToolDefinitions } from '../McpToolCatalog'
import {
  CAPABILITY_GATEWAY_TOOL_NAMES,
  CAPABILITY_INVOKE_TOOL_NAME,
  CAPABILITY_SEARCH_DEFAULT_LIMIT,
  CAPABILITY_SEARCH_MAX_LIMIT,
  CAPABILITY_SEARCH_MAX_QUERY_LENGTH,
  CAPABILITY_SEARCH_TOOL_NAME,
  findGatewayCapabilityByName,
  gatewayToolDefinitions,
  isCapabilityGatewayToolName,
  resolveGatewayInvocation,
  selectGatewayHiddenToolNames,
  shouldEmitCanonicalTargetTranscript,
  searchGatewayCapabilities,
  validateGatewayToolArguments,
  type GatewayToolDefinition
} from './McpToolGateway'

const DEFINITIONS: GatewayToolDefinition[] = [
  {
    name: 'video_thumbnail',
    description: 'Create a still thumbnail image from a video clip.',
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string' },
        timeSeconds: { type: 'number', minimum: 0 }
      },
      required: ['inputPath'],
      additionalProperties: false
    }
  },
  {
    name: 'video_encode_clip',
    description: 'Trim and encode a video segment to a new file.',
    inputSchema: {
      type: 'object',
      properties: {
        inputPath: { type: 'string' },
        outputPath: { type: 'string' }
      },
      required: ['inputPath', 'outputPath']
    }
  },
  {
    name: 'inspect_chat_attachment',
    description: 'Inspect attached media and file metadata.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] }
  },
  {
    name: 'audit_record_finding',
    description: 'Write an audit finding.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: CAPABILITY_SEARCH_TOOL_NAME,
    description: 'Search capabilities.',
    inputSchema: { type: 'object', properties: {} }
  }
]

const ALL_NAMES = DEFINITIONS.map((definition) => definition.name)

describe('McpToolGateway virtual definitions', () => {
  it('publishes exactly two virtual tools with bounded schemas', () => {
    expect(CAPABILITY_GATEWAY_TOOL_NAMES).toEqual([
      CAPABILITY_SEARCH_TOOL_NAME,
      CAPABILITY_INVOKE_TOOL_NAME
    ])
    const definitions = gatewayToolDefinitions()
    expect(definitions.map((definition) => definition.name)).toEqual(CAPABILITY_GATEWAY_TOOL_NAMES)
    expect(definitions[0].inputSchema).toMatchObject({
      required: ['query'],
      additionalProperties: false,
      properties: {
        query: { minLength: 1, maxLength: CAPABILITY_SEARCH_MAX_QUERY_LENGTH },
        limit: { type: 'integer', minimum: 1, maximum: CAPABILITY_SEARCH_MAX_LIMIT }
      }
    })
    expect(definitions[1].inputSchema).toMatchObject({
      required: ['name', 'arguments'],
      additionalProperties: false,
      properties: { arguments: { type: 'object' } }
    })
  })

  it('returns fresh definitions and recognizes only exact gateway names', () => {
    const first = gatewayToolDefinitions()
    const second = gatewayToolDefinitions()
    expect(first).not.toBe(second)
    expect(first[0]).not.toBe(second[0])
    expect(isCapabilityGatewayToolName('capability_search')).toBe(true)
    expect(isCapabilityGatewayToolName('capability_invoke')).toBe(true)
    expect(isCapabilityGatewayToolName('Capability_Search')).toBe(false)
    expect(isCapabilityGatewayToolName('read_file')).toBe(false)
  })

  it('synthesizes Codex transcript rows only for resolved canonical targets', () => {
    expect(shouldEmitCanonicalTargetTranscript('codex', false)).toBe(false)
    expect(shouldEmitCanonicalTargetTranscript('codex', true)).toBe(true)
    expect(shouldEmitCanonicalTargetTranscript('claude', false)).toBe(true)
  })
})

describe('searchGatewayCapabilities', () => {
  it.each([undefined, null, '', '   ', '---'])('never enumerates the catalogue for empty query %j', (query) => {
    const result = searchGatewayCapabilities({
      query,
      definitions: DEFINITIONS,
      eligibleToolNames: ALL_NAMES
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_query', matches: [] })
  })

  it('rejects overlong queries and limits outside the fixed bound', () => {
    expect(
      searchGatewayCapabilities({
        query: 'x'.repeat(CAPABILITY_SEARCH_MAX_QUERY_LENGTH + 1),
        definitions: DEFINITIONS,
        eligibleToolNames: ALL_NAMES
      })
    ).toMatchObject({ ok: false, code: 'query_too_long', matches: [] })

    for (const limit of [0, CAPABILITY_SEARCH_MAX_LIMIT + 1, 1.5, '2']) {
      expect(
        searchGatewayCapabilities({
          query: 'video',
          limit,
          definitions: DEFINITIONS,
          eligibleToolNames: ALL_NAMES
        })
      ).toMatchObject({ ok: false, code: 'invalid_limit', matches: [] })
    }
  })

  it('returns a bounded natural-language match set with exact target schemas', () => {
    const result = searchGatewayCapabilities({
      query: 'trim video thumbnail',
      limit: 2,
      definitions: DEFINITIONS,
      eligibleToolNames: ALL_NAMES
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.matches.map((match) => match.name)).toEqual([
      'video_thumbnail',
      'video_encode_clip'
    ])
    expect(result.matches).toHaveLength(2)
    expect(result.matches[0].inputSchema).toEqual(DEFINITIONS[0].inputSchema)
    expect(result.matches[0].matchedTerms).toEqual(['video', 'thumbnail'])
  })

  it('puts an exact normalized name match first and applies the default limit', () => {
    const filler = Array.from({ length: 8 }, (_, index) => ({
      name: `video_tool_${index}`,
      description: 'Video helper.',
      inputSchema: { type: 'object', properties: {} }
    }))
    const definitions = [...DEFINITIONS, ...filler]
    const result = searchGatewayCapabilities({
      query: 'video thumbnail',
      definitions,
      eligibleToolNames: definitions.map((definition) => definition.name)
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.limit).toBe(CAPABILITY_SEARCH_DEFAULT_LIMIT)
    expect(result.matches).toHaveLength(CAPABILITY_SEARCH_DEFAULT_LIMIT)
    expect(result.matches[0]).toMatchObject({ name: 'video_thumbnail', exactName: true })
    expect(result.truncated).toBe(true)
    expect(result.totalMatches).toBeGreaterThan(result.matches.length)
  })

  it('is deterministic across catalogue and eligibility order', () => {
    const forward = searchGatewayCapabilities({
      query: 'video',
      definitions: DEFINITIONS,
      eligibleToolNames: ALL_NAMES
    })
    const reverse = searchGatewayCapabilities({
      query: 'video',
      definitions: [...DEFINITIONS].reverse(),
      eligibleToolNames: [...ALL_NAMES].reverse()
    })
    expect(reverse).toEqual(forward)
  })

  it('never discloses ineligible, audit-only, or gateway definitions', () => {
    const suppliedAuditName = 'review_verdict'
    const definitions = [
      ...DEFINITIONS,
      {
        name: suppliedAuditName,
        description: 'Video audit verdict.',
        inputSchema: { type: 'object', properties: {} }
      }
    ]
    const result = searchGatewayCapabilities({
      query: 'video audit search inspect',
      limit: CAPABILITY_SEARCH_MAX_LIMIT,
      definitions,
      eligibleToolNames: definitions.map((definition) => definition.name),
      auditOnlyToolNames: [suppliedAuditName]
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.matches.map((match) => match.name)).toEqual([
      'inspect_chat_attachment',
      'video_encode_clip',
      'video_thumbnail'
    ])
    expect(result.matches.some((match) => match.name.startsWith('audit_'))).toBe(false)
    expect(result.matches.some((match) => isCapabilityGatewayToolName(match.name))).toBe(false)

    const ineligible = searchGatewayCapabilities({
      query: 'attachment',
      definitions,
      eligibleToolNames: ['video_thumbnail']
    })
    expect(ineligible).toMatchObject({ ok: true, matches: [] })
  })
})

describe('selectGatewayHiddenToolNames', () => {
  it('uses the immutable profile universe, excludes direct tools, and preserves order', () => {
    expect(
      selectGatewayHiddenToolNames({
        fullToolNames: ['read_file', 'video_probe', 'future_live_tool', 'video_thumbnail'],
        directToolNames: ['read_file', 'future_live_tool']
      })
    ).toEqual(['video_probe', 'video_thumbnail'])
  })

  it('intersects the hidden tail with the run posture and dynamic blocks', () => {
    expect(
      selectGatewayHiddenToolNames({
        fullToolNames: ['read_file', 'web_fetch', 'video_probe', 'video_encode_clip'],
        directToolNames: ['read_file'],
        permissionEligibleToolNames: ['read_file', 'web_fetch', 'video_probe'],
        isBlocked: (name) => name === 'web_fetch'
      })
    ).toEqual(['video_probe'])
  })

  it('deduplicates a malformed profile snapshot without admitting live-catalog additions', () => {
    expect(
      selectGatewayHiddenToolNames({
        fullToolNames: ['video_probe', 'video_probe'],
        directToolNames: [],
        permissionEligibleToolNames: ['video_probe', 'new_canonical_tool']
      })
    ).toEqual(['video_probe'])
  })
})

describe('findGatewayCapabilityByName', () => {
  it('uses exact case-sensitive names', () => {
    expect(findGatewayCapabilityByName(DEFINITIONS, 'video_thumbnail')?.name).toBe('video_thumbnail')
    expect(findGatewayCapabilityByName(DEFINITIONS, 'VIDEO_THUMBNAIL')).toBeNull()
    expect(findGatewayCapabilityByName(DEFINITIONS, ' video_thumbnail ')).toBeNull()
  })

  it('handles duplicate names deterministically', () => {
    const terse = { name: 'same', description: 'A', inputSchema: { type: 'object' } }
    const verbose = { name: 'same', description: 'Z', inputSchema: { type: 'object' } }
    expect(findGatewayCapabilityByName([verbose, terse], 'same')).toEqual(terse)
    expect(findGatewayCapabilityByName([terse, verbose], 'same')).toEqual(terse)
  })
})

describe('validateGatewayToolArguments', () => {
  it('validates required properties, primitive types, enums, and extra properties', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 2, maxLength: 8 },
        mode: { type: 'string', enum: ['read', 'write'] },
        count: { type: 'integer', minimum: 1, maximum: 3 }
      },
      required: ['path', 'mode'],
      additionalProperties: false
    }
    expect(validateGatewayToolArguments(schema, { path: 'ok', mode: 'read', count: 2 })).toEqual({
      ok: true
    })
    const invalid = validateGatewayToolArguments(schema, {
      path: 'x',
      mode: 'other',
      count: 2.5,
      surprise: true
    })
    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.code).toBe('invalid_arguments')
    expect(invalid.issues.map((issue) => issue.keyword)).toEqual(
      expect.arrayContaining(['minLength', 'enum', 'type', 'additionalProperties'])
    )
  })

  it('validates nested arrays, union types, oneOf, and schema-valued additional properties', () => {
    const schema = {
      type: 'object',
      properties: {
        targets: {
          oneOf: [
            { type: 'string' },
            { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string', maxLength: 4 } }
          ]
        },
        flexible: { type: ['string', 'object'] }
      },
      additionalProperties: { type: 'boolean' }
    }
    expect(
      validateGatewayToolArguments(schema, {
        targets: ['one', 'two'],
        flexible: {},
        enabled: true
      })
    ).toEqual({ ok: true })
    const invalid = validateGatewayToolArguments(schema, {
      targets: ['one'],
      flexible: 3,
      enabled: 'yes'
    })
    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['#/targets', '#/flexible', '#/enabled'])
    )
  })

  it('supports boolean schemas, combinators, constants, patterns, and uniqueness', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { allOf: [{ type: 'string' }, { pattern: '^tw-' }] },
        kind: { anyOf: [{ const: 'file' }, { const: 'folder' }] },
        tags: { type: 'array', uniqueItems: true, items: { type: 'string' } },
        forbidden: false
      }
    }
    expect(
      validateGatewayToolArguments(schema, { id: 'tw-1', kind: 'file', tags: ['a', 'b'] })
    ).toEqual({ ok: true })
    const invalid = validateGatewayToolArguments(schema, {
      id: 'other',
      kind: 'url',
      tags: ['a', 'a'],
      forbidden: true
    })
    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.issues.map((issue) => issue.keyword)).toEqual(
      expect.arrayContaining(['pattern', 'anyOf', 'uniqueItems', 'falseSchema'])
    )
  })

  it('fails closed for malformed or unsupported target schemas', () => {
    const unsupported = validateGatewayToolArguments(
      { type: 'object', dependentRequired: { a: ['b'] } },
      {}
    )
    expect(unsupported).toMatchObject({
      ok: false,
      code: 'invalid_schema',
      issues: [{ keyword: 'dependentRequired' }]
    })
    expect(validateGatewayToolArguments({ type: 'wat' }, {})).toMatchObject({
      ok: false,
      code: 'invalid_schema'
    })
  })

  it('supports every input-schema construct in the current canonical catalogue', () => {
    const definitions = createTaskWraithMcpToolDefinitions()
    expect(definitions.length).toBeGreaterThan(100)
    for (const definition of definitions) {
      const result = validateGatewayToolArguments(definition.inputSchema, {})
      if (!result.ok) {
        expect(result.code, `${definition.name}: ${JSON.stringify(result.issues)}`).not.toBe(
          'invalid_schema'
        )
        const required = definition.inputSchema?.required
        if (Array.isArray(required) && required.length > 0) {
          expect(result.code, definition.name).toBe('invalid_arguments')
          expect(result.issues.some((issue) => issue.keyword === 'required'), definition.name).toBe(
            true
          )
        }
      }
    }
  })
})

describe('resolveGatewayInvocation', () => {
  const base = {
    definitions: DEFINITIONS,
    eligibleToolNames: ALL_NAMES
  }

  it.each([
    [{ ...base, name: '', arguments: {} }, 'invalid_target_name'],
    [{ ...base, name: CAPABILITY_SEARCH_TOOL_NAME, arguments: {} }, 'gateway_recursion'],
    [{ ...base, name: CAPABILITY_INVOKE_TOOL_NAME, arguments: {} }, 'gateway_recursion'],
    [{ ...base, name: 'audit_record_finding', arguments: {} }, 'audit_only_target'],
    [{ ...base, name: 'missing_capability', arguments: {} }, 'unknown_target'],
    [
      { ...base, name: 'video_thumbnail', arguments: {}, eligibleToolNames: ['video_encode_clip'] },
      'ineligible_target'
    ],
    [{ ...base, name: 'video_thumbnail', arguments: null }, 'invalid_arguments_object'],
    [{ ...base, name: 'video_thumbnail', arguments: [] }, 'invalid_arguments_object'],
    [{ ...base, name: 'video_thumbnail', arguments: 'nope' }, 'invalid_arguments_object']
  ])('rejects an invalid invocation with code %s', (request, code) => {
    expect(resolveGatewayInvocation(request)).toMatchObject({ ok: false, code })
  })

  it('rejects explicitly supplied audit-only names that do not use the audit prefix', () => {
    const definition = {
      name: 'review_verdict',
      inputSchema: { type: 'object', properties: {} }
    }
    expect(
      resolveGatewayInvocation({
        definitions: [definition],
        eligibleToolNames: [definition.name],
        auditOnlyToolNames: [definition.name],
        name: definition.name,
        arguments: {}
      })
    ).toMatchObject({ ok: false, code: 'audit_only_target' })
  })

  it('returns the exact target identity and validated arguments on success', () => {
    const args = { inputPath: 'clip.mov', timeSeconds: 2 }
    const result = resolveGatewayInvocation({
      ...base,
      name: ' video_thumbnail ',
      arguments: args
    })
    expect(result).toEqual({
      ok: true,
      target: DEFINITIONS[0],
      name: 'video_thumbnail',
      arguments: args
    })
  })

  it('returns structured target argument failures', () => {
    const result = resolveGatewayInvocation({
      ...base,
      name: 'video_thumbnail',
      arguments: { timeSeconds: -1, extra: true }
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'target_argument_validation_failed',
      issues: expect.arrayContaining([
        expect.objectContaining({ path: '#/inputPath', keyword: 'required' }),
        expect.objectContaining({ path: '#/timeSeconds', keyword: 'minimum' }),
        expect.objectContaining({ path: '#/extra', keyword: 'additionalProperties' })
      ])
    })
  })

  it('fails closed when the target schema itself is unsupported', () => {
    const target = {
      name: 'future_tool',
      inputSchema: { type: 'object', unevaluatedProperties: false }
    }
    expect(
      resolveGatewayInvocation({
        definitions: [target],
        eligibleToolNames: [target.name],
        name: target.name,
        arguments: {}
      })
    ).toMatchObject({ ok: false, code: 'invalid_target_schema' })
  })
})
