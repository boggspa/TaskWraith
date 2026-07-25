/**
 * Phase M1 Step 3 — JSONSchema → Gemini Schema converter for the
 * function-calling path of `GeminiApiProvider`.
 *
 * The TaskWraith MCP tool surface (29+ tools in `TaskWraithMcpTools.ts`)
 * advertises its inputs in OpenAPI-flavoured JSONSchema. Gemini's
 * `@google/genai` SDK accepts a similar but narrower shape — uppercase
 * `type` enum, no `additionalProperties`, no unions in
 * `FunctionDeclaration`, etc. This module bridges the two without
 * dragging the SDK's `Schema` / `Type` runtime symbols into the main
 * process (so typecheck stays clean when the SDK is absent — see
 * `loadOptionalGeminiSdk` for context).
 *
 * Two callers:
 *   - `GeminiApiProvider.tryRunGeminiApi`, at the start of each turn,
 *     translates the live tool list into the format
 *     `generateContentStream({ config: { tools } })` expects.
 *   - `GeminiApiToolDeclarations.test.ts` pins every conversion quirk so
 *     a future SDK shape change can't silently break the loop.
 *
 * Conversion rules (one place, one set of tests):
 *   - JSONSchema `type: 'object'` → Gemini `'OBJECT'` (uppercase).
 *     Same for STRING, NUMBER, INTEGER, BOOLEAN, ARRAY. Unknown / mixed
 *     types degrade to the first sensible non-null variant.
 *   - `properties`, `items`, `required`, `description`, `enum` carried
 *     across verbatim (recursively).
 *   - `additionalProperties` stripped — Gemini's schema validator rejects
 *     it. Same goes for OpenAPI-isms Gemini doesn't model (`format`,
 *     `pattern`, etc. — left out of the output by omission).
 *   - `oneOf` / `anyOf` / `allOf`: Gemini's `FunctionDeclaration` doesn't
 *     accept unions, so we coerce to the first variant's shape and warn.
 *     This is intentionally lossy: model gets one branch instead of
 *     erroring out at request time. TaskWraith's MCP tools currently don't
 *     use unions, so the warning is mostly a tripwire for future schemas.
 *   - `type: ['string', 'null']` → `{ type: 'STRING', nullable: true }`.
 *     Multi-type arrays coerce to the first non-null entry.
 *   - `$ref` / deeply nested unions: drop the property, log a warning.
 *     Better to lose one optional param than to drop the entire tool.
 *   - Empty / missing `inputSchema`: emit `{ type: 'OBJECT', properties: {} }`
 *     — Gemini accepts no-arg tools this way.
 *   - Pure (no side effects, deterministic) so tests can snapshot output.
 */

/** Subset of Gemini's `Type` enum we ever emit. Mirrors the SDK's
 *  `Type` enum values verbatim so the runtime can pass our output to
 *  `generateContentStream` without translation. We keep this as a
 *  string-literal union (not the SDK's enum) so the file typechecks
 *  even when `@google/genai` is absent — same constraint that drives
 *  the dynamic-import dance in `loadOptionalGeminiSdk`. */
export type GeminiSchemaType = 'OBJECT' | 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'ARRAY'

/** Output shape — minimal Gemini `Schema` clone. Real SDK accepts a
 *  wider surface, but we never emit more than this. */
export interface GeminiSchema {
  type: GeminiSchemaType
  description?: string
  properties?: Record<string, GeminiSchema>
  items?: GeminiSchema
  required?: string[]
  enum?: string[]
  nullable?: boolean
}

/** Output shape — Gemini `FunctionDeclaration` clone. Same minimality
 *  caveat as `GeminiSchema`. */
export interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parameters?: GeminiSchema
}

/** Map JSONSchema lowercase types to Gemini uppercase. */
const TYPE_MAP: Record<string, GeminiSchemaType> = {
  object: 'OBJECT',
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Resolve the JSONSchema `type` field (string OR array-of-strings) into
 *  a single Gemini type + nullable flag. Returns `null` if the type
 *  can't be coerced (e.g. all-null array, `$ref`-only schema). */
function resolveType(raw: unknown): { type: GeminiSchemaType; nullable: boolean } | null {
  if (typeof raw === 'string') {
    const mapped = TYPE_MAP[raw.toLowerCase()]
    return mapped ? { type: mapped, nullable: false } : null
  }
  if (Array.isArray(raw)) {
    let nullable = false
    let chosen: GeminiSchemaType | null = null
    for (const entry of raw) {
      if (typeof entry !== 'string') continue
      if (entry.toLowerCase() === 'null') {
        nullable = true
        continue
      }
      if (!chosen) {
        const mapped = TYPE_MAP[entry.toLowerCase()]
        if (mapped) chosen = mapped
      }
    }
    if (!chosen) return null
    return { type: chosen, nullable }
  }
  return null
}

/** Pick the first variant of a `oneOf` / `anyOf` / `allOf` union as the
 *  schema's representative shape. Returns `null` if the union is empty
 *  or contains no plain-object variants. */
function pickUnionVariant(schema: Record<string, unknown>): unknown | null {
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    const variants = schema[key]
    if (Array.isArray(variants) && variants.length > 0) {
      const first = variants.find((v) => isPlainObject(v))
      if (first) return first
    }
  }
  return null
}

/**
 * Convert a single JSONSchema value into a Gemini schema. Returns
 * `undefined` when the input is unusable (so callers can drop the
 * containing property instead of producing a half-broken schema).
 *
 * Pure. Same input always yields the same output. The only side effect
 * is `console.warn` for lossy coercions — wrap your tests in
 * `vi.spyOn(console, 'warn')` if you care about the message.
 */
export function jsonSchemaToGeminiSchema(input: unknown): GeminiSchema | undefined {
  if (!isPlainObject(input)) return undefined

  // Resolve unions first so the rest of the function operates on a
  // single shape. We warn ONCE per union — recursing into nested
  // properties handles the rest.
  let working: Record<string, unknown> = input
  if ('oneOf' in input || 'anyOf' in input || 'allOf' in input) {
    const picked = pickUnionVariant(input)
    if (picked && isPlainObject(picked)) {
      console.warn(
        '[GeminiApiToolDeclarations] oneOf/anyOf/allOf union coerced to first variant — Gemini FunctionDeclaration does not support schema unions.'
      )
      // Merge the union variant's fields on top of the parent (e.g. if
      // the parent already specified `description`, prefer the parent).
      working = { ...picked, ...input }
    }
  }

  // Schemas that are pure $ref (no type, no properties) can't be
  // represented in Gemini's schema; the caller should drop the property.
  if ('$ref' in working && working['$ref'] != null && !working.type && !working.properties) {
    console.warn(
      '[GeminiApiToolDeclarations] $ref-only schema dropped (Gemini does not support $ref).'
    )
    return undefined
  }

  // Resolve type. If absent, infer from shape: presence of `properties`
  // implies OBJECT, `items` implies ARRAY. Default to STRING as the
  // safest "scalar" fallback when nothing else is known.
  let resolvedType = resolveType(working.type)
  if (!resolvedType) {
    if (working.properties && isPlainObject(working.properties)) {
      resolvedType = { type: 'OBJECT', nullable: false }
    } else if (working.items) {
      resolvedType = { type: 'ARRAY', nullable: false }
    } else if (Array.isArray(working.enum) && working.enum.length > 0) {
      resolvedType = { type: 'STRING', nullable: false }
    } else {
      // No type, no shape hint — can't usefully describe this. Caller drops.
      return undefined
    }
  }

  const out: GeminiSchema = { type: resolvedType.type }
  if (resolvedType.nullable) out.nullable = true

  if (typeof working.description === 'string') {
    out.description = working.description
  }

  // Enums: only string enums survive (Gemini schema only models string enums).
  if (Array.isArray(working.enum)) {
    const stringEnum = working.enum
      .filter((v): v is string | number | boolean => v !== null && v !== undefined)
      .map((v) => String(v))
    if (stringEnum.length > 0) {
      out.enum = stringEnum
    }
  }

  if (out.type === 'OBJECT' && isPlainObject(working.properties)) {
    const properties: Record<string, GeminiSchema> = {}
    for (const [propName, propSchema] of Object.entries(working.properties)) {
      const converted = jsonSchemaToGeminiSchema(propSchema)
      if (converted) {
        properties[propName] = converted
      } else {
        console.warn(
          `[GeminiApiToolDeclarations] dropped unconvertible property "${propName}" from object schema.`
        )
      }
    }
    out.properties = properties

    // Preserve `required`, but only for property names that survived
    // conversion. Otherwise Gemini would reject the schema (required
    // refers to a property that doesn't exist).
    if (Array.isArray(working.required)) {
      const required = working.required.filter(
        (name): name is string => typeof name === 'string' && name in properties
      )
      if (required.length > 0) {
        out.required = required
      }
    }
    // `additionalProperties` stripped silently — Gemini doesn't support.
  }

  // EVERY ARRAY must carry `items`, including one whose source schema omits it.
  // JSON Schema treats a bare `{ type: 'array' }` as "any element", but Gemini
  // rejects it — and it rejects the ENTIRE request, so one bare array anywhere
  // in the catalogue 400s every tool-advertising run with
  // `function_declarations[N]...items: missing field` rather than degrading that
  // one parameter. This guard used to be `&& working.items`, which skipped the
  // branch (and its fallback) precisely in the omitted case.
  if (out.type === 'ARRAY') {
    const converted = working.items ? jsonSchemaToGeminiSchema(working.items) : undefined
    if (converted) {
      out.items = converted
    } else {
      // Array of unknown shape — emit a generic STRING fallback so the
      // declaration still parses. The model will see "array of strings"
      // which is less precise but better than dropping the parameter.
      out.items = { type: 'STRING' }
      if (working.items) {
        console.warn(
          '[GeminiApiToolDeclarations] array items schema unconvertible; falling back to STRING.'
        )
      }
    }
  }

  return out
}

/**
 * Convert TaskWraith's MCP tool list into Gemini's `FunctionDeclaration[]`.
 *
 * Tools missing a `name` (or whose name isn't a string) are dropped with
 * a warning — silently losing one tool is better than rejecting all of
 * them at request time. Tools without an `inputSchema` get a no-arg
 * `OBJECT` shape (Gemini's idiom for "this tool takes no parameters").
 */
export function buildGeminiFunctionDeclarations(
  mcpTools: ReadonlyArray<{ name?: string; description?: string; inputSchema?: unknown }>
): GeminiFunctionDeclaration[] {
  const declarations: GeminiFunctionDeclaration[] = []
  for (const tool of mcpTools) {
    if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) {
      console.warn('[GeminiApiToolDeclarations] tool missing name — skipped.')
      continue
    }
    const declaration: GeminiFunctionDeclaration = { name: tool.name }
    if (typeof tool.description === 'string' && tool.description) {
      declaration.description = tool.description
    }
    if (tool.inputSchema === undefined || tool.inputSchema === null) {
      // No schema → no-arg tool.
      declaration.parameters = { type: 'OBJECT', properties: {} }
    } else {
      const converted = jsonSchemaToGeminiSchema(tool.inputSchema)
      if (converted) {
        declaration.parameters = converted
      } else {
        // The schema was present but unconvertible. Fall back to no-arg
        // shape rather than dropping the tool entirely.
        console.warn(
          `[GeminiApiToolDeclarations] tool "${tool.name}" has an unconvertible inputSchema — declared as no-arg.`
        )
        declaration.parameters = { type: 'OBJECT', properties: {} }
      }
    }
    declarations.push(declaration)
  }
  return declarations
}
