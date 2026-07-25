import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildGeminiFunctionDeclarations,
  jsonSchemaToGeminiSchema,
  type GeminiFunctionDeclaration
} from './GeminiApiToolDeclarations'
import { createTaskWraithMcpToolDefinitions } from './McpToolCatalog'

/**
 * Phase M1 Step 3 — Pins every conversion quirk for the JSONSchema →
 * Gemini Schema bridge that feeds `tryRunGeminiApi`'s function-calling
 * loop. The converter is pure, so each test can assert the exact output
 * without setting up any provider context.
 *
 * The sanity check at the bottom imports the pure MCP catalog module so it
 * exercises the same schemas the bridge advertises without booting Electron.
 */

const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

afterEach(() => {
  warnSpy.mockClear()
})

describe('jsonSchemaToGeminiSchema', () => {
  it('converts a bare object schema with string properties + required', () => {
    const result = jsonSchemaToGeminiSchema({
      type: 'object',
      properties: {
        path: { type: 'string' }
      },
      required: ['path']
    })
    expect(result).toEqual({
      type: 'OBJECT',
      properties: { path: { type: 'STRING' } },
      required: ['path']
    })
  })

  it('uppercases each JSONSchema scalar type to the Gemini enum', () => {
    expect(jsonSchemaToGeminiSchema({ type: 'string' })?.type).toBe('STRING')
    expect(jsonSchemaToGeminiSchema({ type: 'number' })?.type).toBe('NUMBER')
    expect(jsonSchemaToGeminiSchema({ type: 'integer' })?.type).toBe('INTEGER')
    expect(jsonSchemaToGeminiSchema({ type: 'boolean' })?.type).toBe('BOOLEAN')
    expect(jsonSchemaToGeminiSchema({ type: 'array', items: { type: 'string' } })?.type).toBe(
      'ARRAY'
    )
    expect(jsonSchemaToGeminiSchema({ type: 'object', properties: {} })?.type).toBe('OBJECT')
  })

  it('recurses into nested object properties', () => {
    const result = jsonSchemaToGeminiSchema({
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: {
            inner: { type: 'string' }
          },
          required: ['inner']
        }
      }
    })
    expect(result?.properties?.outer).toEqual({
      type: 'OBJECT',
      properties: { inner: { type: 'STRING' } },
      required: ['inner']
    })
  })

  it('recurses into array items', () => {
    const result = jsonSchemaToGeminiSchema({
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } } }
    })
    expect(result?.items).toEqual({
      type: 'OBJECT',
      properties: { id: { type: 'STRING' } }
    })
  })

  it('preserves description on objects, properties, and arrays', () => {
    const result = jsonSchemaToGeminiSchema({
      type: 'object',
      description: 'top-level',
      properties: {
        x: { type: 'string', description: 'an x' }
      }
    })
    expect(result?.description).toBe('top-level')
    expect(result?.properties?.x.description).toBe('an x')
  })

  it('preserves string enums verbatim', () => {
    const result = jsonSchemaToGeminiSchema({
      type: 'string',
      enum: ['gemini', 'codex', 'claude']
    })
    expect(result).toEqual({ type: 'STRING', enum: ['gemini', 'codex', 'claude'] })
  })

  it('strips additionalProperties without leaking a warning', () => {
    const result = jsonSchemaToGeminiSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false
    } as unknown)
    expect(result).toEqual({
      type: 'OBJECT',
      properties: { a: { type: 'STRING' } }
    })
    // additionalProperties is silently dropped — should NOT trigger a warning.
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('coerces oneOf to the first variant and emits a warning', () => {
    const result = jsonSchemaToGeminiSchema({
      oneOf: [{ type: 'string' }, { type: 'integer' }]
    })
    expect(result).toEqual({ type: 'STRING' })
    expect(warnSpy).toHaveBeenCalled()
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/oneOf\/anyOf\/allOf/)
  })

  it('coerces anyOf the same way as oneOf', () => {
    const result = jsonSchemaToGeminiSchema({
      anyOf: [{ type: 'number' }, { type: 'null' }]
    })
    expect(result?.type).toBe('NUMBER')
  })

  it('handles type: ["string", "null"] as nullable STRING', () => {
    const result = jsonSchemaToGeminiSchema({ type: ['string', 'null'] })
    expect(result).toEqual({ type: 'STRING', nullable: true })
  })

  it('drops $ref-only schemas with a warning', () => {
    const result = jsonSchemaToGeminiSchema({ $ref: '#/definitions/X' })
    expect(result).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/\$ref/)
  })

  it('drops properties whose schemas are unconvertible but keeps the rest', () => {
    const result = jsonSchemaToGeminiSchema({
      type: 'object',
      properties: {
        ok: { type: 'string' },
        bad: { $ref: '#/definitions/Other' }
      },
      required: ['ok', 'bad']
    })
    expect(result?.properties?.ok).toEqual({ type: 'STRING' })
    expect(result?.properties?.bad).toBeUndefined()
    // `required` filters down to surviving properties only.
    expect(result?.required).toEqual(['ok'])
  })

  it('infers OBJECT when type is missing but properties is present', () => {
    const result = jsonSchemaToGeminiSchema({ properties: { a: { type: 'string' } } })
    expect(result?.type).toBe('OBJECT')
    expect(result?.properties?.a).toEqual({ type: 'STRING' })
  })

  it('returns undefined when the input is not a plain object', () => {
    expect(jsonSchemaToGeminiSchema(undefined)).toBeUndefined()
    expect(jsonSchemaToGeminiSchema(null)).toBeUndefined()
    expect(jsonSchemaToGeminiSchema('string')).toBeUndefined()
    expect(jsonSchemaToGeminiSchema(42)).toBeUndefined()
    expect(jsonSchemaToGeminiSchema([])).toBeUndefined()
  })

  it('falls back to STRING items when array items are unconvertible', () => {
    const result = jsonSchemaToGeminiSchema({
      type: 'array',
      items: { $ref: '#/definitions/X' }
    })
    expect(result?.type).toBe('ARRAY')
    expect(result?.items).toEqual({ type: 'STRING' })
    expect(warnSpy).toHaveBeenCalled()
  })

  it('produces deterministic output for identical input', () => {
    const a = jsonSchemaToGeminiSchema({
      type: 'object',
      properties: { x: { type: 'string' }, y: { type: 'integer' } },
      required: ['x']
    })
    const b = jsonSchemaToGeminiSchema({
      type: 'object',
      properties: { x: { type: 'string' }, y: { type: 'integer' } },
      required: ['x']
    })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('buildGeminiFunctionDeclarations', () => {
  it('emits an empty OBJECT for tools with no inputSchema', () => {
    const result = buildGeminiFunctionDeclarations([
      { name: 'no_args_tool', description: 'A tool that takes no args.' }
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      name: 'no_args_tool',
      description: 'A tool that takes no args.',
      parameters: { type: 'OBJECT', properties: {} }
    } as GeminiFunctionDeclaration)
  })

  it('emits an empty OBJECT when inputSchema is explicitly null', () => {
    const result = buildGeminiFunctionDeclarations([{ name: 't', inputSchema: null }])
    expect(result[0].parameters).toEqual({ type: 'OBJECT', properties: {} })
  })

  it('skips tools with a missing or empty name and warns', () => {
    const result = buildGeminiFunctionDeclarations([
      { name: '', inputSchema: { type: 'object' } },
      { description: 'no name' } as { name?: string; description?: string },
      { name: 'good', inputSchema: { type: 'object' } }
    ])
    expect(result.map((d) => d.name)).toEqual(['good'])
    expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back to no-arg OBJECT when inputSchema cannot be converted', () => {
    const result = buildGeminiFunctionDeclarations([
      { name: 'broken', inputSchema: { $ref: '#/definitions/X' } }
    ])
    expect(result[0]).toEqual({
      name: 'broken',
      parameters: { type: 'OBJECT', properties: {} }
    })
  })

  it('round-trips every tool in the TaskWraith MCP surface', () => {
    // Pure catalog import, not src/main/index.ts, so this test does not
    // boot Electron just to exercise the advertised MCP schemas.
    const tools = createTaskWraithMcpToolDefinitions()
    const declarations = buildGeminiFunctionDeclarations(tools)

    expect(declarations.map((d) => d.name)).toEqual(tools.map((t) => t.name))
    for (const declaration of declarations) {
      // Every declaration should at minimum have an OBJECT parameters
      // shape. None should be missing the name or have a non-object
      // parameters.
      expect(typeof declaration.name).toBe('string')
      expect(declaration.parameters?.type).toBe('OBJECT')
      // Properties is always an object (possibly empty for no-arg tools).
      expect(typeof declaration.parameters?.properties).toBe('object')
    }
  })

  it('gives a bare array STRING items rather than emitting items-less ARRAY', () => {
    // Live 400 on 2026-07-25: two catalogue schemas declared `{ type: 'array' }`
    // with no `items`. Gemini rejects the WHOLE request for that
    // ("function_declarations[78]...items: missing field"), so every
    // AntiGravity gemini-api run failed with exit 1 before any inference —
    // regardless of which tool the model actually wanted.
    const converted = jsonSchemaToGeminiSchema({ type: 'array' })
    expect(converted).toEqual({ type: 'ARRAY', items: { type: 'STRING' } })
    // An omitted `items` is a schema gap, not an unconvertible one — no warning.
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('never emits an ARRAY without items anywhere in the real catalogue', () => {
    // The sanity check above only inspects the TOP level, which is exactly how
    // the live 400 got through. Walk every nested schema instead.
    const declarations = buildGeminiFunctionDeclarations(createTaskWraithMcpToolDefinitions())
    const offenders: string[] = []
    const walk = (schema: GeminiFunctionDeclaration['parameters'], path: string): void => {
      if (!schema || typeof schema !== 'object') return
      if (schema.type === 'ARRAY' && !schema.items) offenders.push(path)
      if (schema.items) walk(schema.items, `${path}.items`)
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        walk(child, `${path}.${key}`)
      }
    }
    for (const declaration of declarations) walk(declaration.parameters, declaration.name)
    expect(offenders).toEqual([])
  })

  it('warns are silenced for plain conversions (regression guard)', () => {
    buildGeminiFunctionDeclarations([
      {
        name: 'tidy',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id']
        }
      }
    ])
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
