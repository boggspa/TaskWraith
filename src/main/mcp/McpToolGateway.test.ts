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

  it('does not rank github_ci_status above local git_* for a local-git query', () => {
    const definitions = [
      {
        name: 'git_show',
        description:
          'Show bounded metadata, stats, and optionally patch output for a single git ref.',
        annotations: { openWorldHint: false },
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'git_log',
        description: 'Return bounded structured commit history for the active workspace.',
        annotations: { openWorldHint: false },
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'github_ci_status',
        description:
          'Read GitHub Actions / pull request check state for the active workspace using gh.',
        annotations: { openWorldHint: true },
        inputSchema: { type: 'object', properties: {} }
      }
    ]
    const result = searchGatewayCapabilities({
      query: 'local git metadata',
      limit: 3,
      definitions,
      eligibleToolNames: definitions.map((definition) => definition.name)
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.matches[0]?.name).toBe('git_show')
    const localRank = result.matches.map((match) => match.name)
    const githubIdx = localRank.indexOf('github_ci_status')
    if (githubIdx !== -1) {
      expect(githubIdx).toBeGreaterThan(localRank.indexOf('git_show'))
    }
    // Even a bare "git" query must not treat "github" as a name prefix win.
    const bareGit = searchGatewayCapabilities({
      query: 'git',
      limit: 3,
      definitions,
      eligibleToolNames: definitions.map((definition) => definition.name)
    })
    expect(bareGit.ok).toBe(true)
    if (!bareGit.ok) return
    expect(bareGit.matches[0]?.name.startsWith('git_')).toBe(true)
    const githubScore =
      bareGit.matches.find((match) => match.name === 'github_ci_status')?.score ?? 0
    const topLocalScore = bareGit.matches[0]?.score ?? 0
    expect(githubScore).toBeLessThan(topLocalScore)
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

describe('C2b-ii-d gateway reviewer-verdict eligibility exception', () => {
  // Schema that ACCEPTS the exact reviewer verdict (submit_review_verdict in the action
  // enum + verdict declared) — proves the resolver's eligibility bypass in isolation.
  const acceptingBossmanSchema = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['set_goal', 'quarantine_participant', 'set_review_gate', 'submit_review_verdict']
      },
      gateId: { type: 'string' },
      verdict: { type: 'string', enum: ['passed', 'failed'] }
    },
    additionalProperties: false
  }
  // Schema mirroring the LIVE catalogue (McpToolCatalog action enum has NO
  // submit_review_verdict / verdict) — proves the schema gate is preserved after the
  // eligibility bypass and documents the out-of-lane ii-e (catalogue schema) blocker.
  const liveLikeBossmanSchema = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set_goal', 'quarantine_participant', 'set_review_gate'] },
      gateId: { type: 'string' }
    }
  }
  const defs = (bossmanSchema: Record<string, unknown> | null): GatewayToolDefinition[] => [
    ...(bossmanSchema
      ? [{ name: 'ensemble_bossman_control', inputSchema: bossmanSchema } as GatewayToolDefinition]
      : []),
    { name: 'read_file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }
  ]
  const exact = (verdict: 'passed' | 'failed') => ({
    action: 'submit_review_verdict',
    gateId: 'g1',
    verdict
  })
  const resolve = (
    name: string,
    args: unknown,
    definitions: GatewayToolDefinition[],
    eligible: string[]
  ) => resolveGatewayInvocation({ name, arguments: args, definitions, eligibleToolNames: eligible })

  it('P-D: exact reviewer-verdict resolves ok despite bossman being INELIGIBLE (both verdicts)', () => {
    for (const verdict of ['passed', 'failed'] as const) {
      const res = resolve('ensemble_bossman_control', exact(verdict), defs(acceptingBossmanSchema), [
        'read_file'
      ])
      expect(res.ok, verdict).toBe(true)
      if (res.ok) expect(res.name).toBe('ensemble_bossman_control')
    }
  })

  it('D-SCHEMA: eligibility bypass does NOT bypass schema validation (documents the live-catalogue ii-e blocker)', () => {
    // Bossman resolves + eligibility is bypassed, but a schema WITHOUT submit_review_verdict
    // in the action enum (mirroring the live catalogue) still rejects at validation.
    const res = resolve('ensemble_bossman_control', exact('passed'), defs(liveLikeBossmanSchema), [
      'read_file'
    ])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('target_argument_validation_failed')
  })

  it('N-D: non-exact / near-miss bossman payloads stay ineligible_target (classifier fail-closed)', () => {
    const nearMisses: unknown[] = [
      undefined,
      {},
      { action: 'submit_review_verdict', gateId: 'g1' },
      { action: 'submit_review_verdict', verdict: 'passed' },
      { action: 'submit_review_verdict', gateId: '   ', verdict: 'passed' },
      { action: 'submit_review_verdict', gateId: 'g1', verdict: 'waived' },
      { action: 'submit_review_verdict', gateId: 'g1', verdict: 'passed', reason: 'x' },
      { action: 'set_goal', gateId: 'g1', verdict: 'passed' },
      { action: 'quarantine_participant', gateId: 'g1', verdict: 'passed' },
      { action: 'set_review_gate', gateId: 'g1', verdict: 'passed' },
      'not-an-object'
    ]
    for (const args of nearMisses) {
      const res = resolve('ensemble_bossman_control', args, defs(acceptingBossmanSchema), ['read_file'])
      const label = JSON.stringify(args) ?? 'undefined'
      expect(res.ok, label).toBe(false)
      if (!res.ok) expect(res.code, label).toBe('ineligible_target')
    }
  })

  it('N-D: an exact-looking payload on a DIFFERENT (non-bossman) tool stays ineligible_target', () => {
    // read_file resolves but is NOT eligible here; the classifier is tool-scoped to bossman.
    const res = resolve('read_file', exact('passed'), defs(acceptingBossmanSchema), [])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('ineligible_target')
  })

  it('N-D: unknown target still fails unknown_target BEFORE eligibility (guard order preserved)', () => {
    // No bossman definition present ⇒ the exact payload must still hit unknown_target,
    // proving the bypass did not disturb the definition-resolution guard order.
    const res = resolve('ensemble_bossman_control', exact('passed'), defs(null), ['read_file'])
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('unknown_target')
  })

  it('control: an eligible non-bossman tool still resolves normally (floor unchanged)', () => {
    const res = resolve('read_file', { path: 'README.md' }, defs(acceptingBossmanSchema), ['read_file'])
    expect(res.ok).toBe(true)
  })
})
