import { isExactReviewerVerdictInvocation } from '../ReviewerVerdictInvocation'
import { TAXONOMY_CAPABILITY_GATEWAY_TOOL_NAMES } from '../../shared/providerActionTaxonomy'
import { coalesceToolArguments, type ToolArgumentAliasConflict } from './McpToolArgumentCoalesce'

export const CAPABILITY_GATEWAY_TOOL_NAMES = TAXONOMY_CAPABILITY_GATEWAY_TOOL_NAMES
export const [CAPABILITY_SEARCH_TOOL_NAME, CAPABILITY_INVOKE_TOOL_NAME] =
  CAPABILITY_GATEWAY_TOOL_NAMES

/**
 * Virtual tools advertised only by the gateway profile. They deliberately do
 * not belong to the canonical TaskWraith tool catalogue, so an old receipted
 * profile cannot change when progressive disclosure is introduced.
 */
export type CapabilityGatewayToolName = (typeof CAPABILITY_GATEWAY_TOOL_NAMES)[number]

export const CAPABILITY_SEARCH_DEFAULT_LIMIT = 4
export const CAPABILITY_SEARCH_MAX_LIMIT = 6
export const CAPABILITY_SEARCH_MAX_QUERY_LENGTH = 240

const MAX_VALIDATION_ISSUES = 24
const MAX_VALIDATION_DEPTH = 64
const MAX_VALIDATION_NODES = 20_000

export interface GatewayToolDefinition {
  name: string
  description?: string
  annotations?: Record<string, unknown>
  inputSchema?: Record<string, unknown>
}

export function isCapabilityGatewayToolName(value: unknown): value is CapabilityGatewayToolName {
  return (
    typeof value === 'string' &&
    (CAPABILITY_GATEWAY_TOOL_NAMES as readonly string[]).includes(value)
  )
}

/**
 * Providers that stream their own row for a TaskWraith MCP call.
 *
 * Main synthesizes `tool_use`/`tool_result` for MCP invocations because some
 * providers never mention them. Most providers listed here emit a
 * self-sufficient row keyed on THEIR OWN call id, so synthesizing a second one
 * keyed on `<provider>-mcp-<tool>-<ts>-<rand>` renders TWO complete tool cards
 * for one invocation — the renderer pairs use→result by tool_id, and the two
 * ids never match. Codex was fixed when this was found (its app-server
 * `mcpToolCall` items); Pi followed (TaskWraith's managed tools are registered
 * as real Pi tools by the app-owned extension, so Pi reports each through
 * `toolcall_end`). Claude, Kimi and Ollama joined the native-row measurement on
 * 2026-08-18, after the user-visible "every Edit shows twice" duplicate:
 * over the 14-day run-event corpus their plain (non-gateway) brokered calls
 * carried a native twin at 4896/4897 (claude, 515 runs — `mcp__TaskWraith__
 * <tool>` tool_use blocks in the assistant envelope), 1095/1095 (kimi, 73
 * runs — wire-protocol ToolCall; the old "only 3–13% twin" reading predates
 * the gateway migration and no longer holds in any era of the current corpus)
 * and 389/389 (ollama, 69 runs).
 *
 * GROK, MISTRAL AND CURSOR ARE DELIBERATELY ABSENT: the same measurement put
 * their native-twin rates at 0.2%, 1.8% and 0% — the synthesized row IS their
 * transcript, so suppression would delete their MCP tool cards rather than
 * deduplicate them. Measure against run-events before extending this list; a
 * provider that merely COULD report its own calls is not evidence that it
 * does. When measuring, fold the control tool's two advertised spellings
 * (`ensemble_control` v2+ vs canonical `ensemble_bossman_control`) into one
 * name, or every control call reads as untwinned and drags the rate down.
 *
 * KIMI IS THE ENRICHMENT EXCEPTION. Its native ACP wrapper proves that a call
 * happened, but Kimi Code currently omits the MCP arguments from that
 * `session/update`: a real `replace` call persists as `parameters: {}` even
 * though the governed host received `path` + `old_string` + `new_string`.
 * TaskWraith must therefore keep the host receipt too. The renderer's
 * `coalesceMirroredTaskWraithActivities` proves the nested mirror, keeps the
 * enriched host activity (including +N/-N), and copies the native round-trip
 * timing onto it, so the user still sees exactly one row.
 */
const PROVIDERS_WITH_NATIVE_MCP_TRANSCRIPT_ROWS: readonly string[] = [
  'codex',
  'pi',
  'claude',
  'kimi',
  'ollama'
]

const PROVIDERS_REQUIRING_HOST_MCP_TRANSCRIPT_ENRICHMENT: readonly string[] = ['kimi']

export function providerEmitsNativeMcpTranscriptRows(parentProvider: string): boolean {
  return PROVIDERS_WITH_NATIVE_MCP_TRANSCRIPT_ROWS.includes(parentProvider)
}

/**
 * A gateway call is the exception: the provider's own row names the outer
 * wrapper, so main must still emit the resolved canonical target row for the
 * transcript to retain the real audit identity.
 */
export function shouldEmitCanonicalTargetTranscript(
  parentProvider: string,
  viaGateway: boolean
): boolean {
  return (
    !providerEmitsNativeMcpTranscriptRows(parentProvider) ||
    PROVIDERS_REQUIRING_HOST_MCP_TRANSCRIPT_ENRICHMENT.includes(parentProvider) ||
    viaGateway
  )
}

/** Return fresh definitions so a transport cannot mutate the shared profile. */
export function gatewayToolDefinitions(): GatewayToolDefinition[] {
  return [
    {
      name: CAPABILITY_SEARCH_TOOL_NAME,
      description:
        'Find a small, relevant set of TaskWraith capabilities that are not directly advertised. Returns exact input schemas for matching tools; use capability_invoke to call one.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      },
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            maxLength: CAPABILITY_SEARCH_MAX_QUERY_LENGTH,
            description: 'Short capability or task description, such as "trim video".'
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: CAPABILITY_SEARCH_MAX_LIMIT,
            description: `Maximum matches to return. Defaults to ${CAPABILITY_SEARCH_DEFAULT_LIMIT}.`
          }
        },
        required: ['query'],
        additionalProperties: false
      }
    },
    {
      name: CAPABILITY_INVOKE_TOOL_NAME,
      description:
        'Invoke an exact TaskWraith capability discovered with capability_search. The target tool keeps its own approval policy, guards, locks, budgets, media handling, and audit identity.',
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      },
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            minLength: 1,
            description: 'Exact capability name returned by capability_search.'
          },
          arguments: {
            type: 'object',
            description: 'Arguments validated against the target capability input schema.'
          }
        },
        required: ['name', 'arguments'],
        additionalProperties: false
      }
    }
  ]
}

export interface GatewayCatalogScope {
  definitions: readonly GatewayToolDefinition[]
  eligibleToolNames: Iterable<string>
  auditOnlyToolNames?: Iterable<string>
}

export interface GatewayHiddenToolSelection {
  /** Immutable profile universe, in the order callers want preserved. */
  fullToolNames: readonly string[]
  /** Directly advertised names which must not be rediscovered through the wrapper. */
  directToolNames: Iterable<string>
  /** Optional run-posture ceiling (read-only/plan). Omit for the full profile universe. */
  permissionEligibleToolNames?: Iterable<string>
  /** Additional run-specific block such as disabled network access. */
  isBlocked?: (name: string) => boolean
}

/**
 * Select the immutable hidden tail for one run without consulting the live
 * canonical catalogue. This is the membership boundary used by both discovery
 * and invocation; future tools cannot appear in gateway-v1 until a new profile
 * snapshot explicitly includes them.
 */
export function selectGatewayHiddenToolNames(input: GatewayHiddenToolSelection): string[] {
  const directNames = normalizedEligibleNames(input.directToolNames)
  const permissionNames = input.permissionEligibleToolNames
    ? normalizedEligibleNames(input.permissionEligibleToolNames)
    : null
  const seen = new Set<string>()
  return input.fullToolNames.filter((name) => {
    if (typeof name !== 'string' || !name || seen.has(name)) return false
    seen.add(name)
    return (
      !directNames.has(name) &&
      (!permissionNames || permissionNames.has(name)) &&
      !input.isBlocked?.(name)
    )
  })
}

export interface GatewayCapabilityMatch {
  name: string
  description?: string
  annotations?: Record<string, unknown>
  inputSchema: Record<string, unknown>
  score: number
  exactName: boolean
  matchedTerms: string[]
}

export type GatewayCapabilitySearchErrorCode = 'invalid_query' | 'query_too_long' | 'invalid_limit'

export type GatewayCapabilitySearchResult =
  | {
      ok: true
      query: string
      limit: number
      matches: GatewayCapabilityMatch[]
      totalMatches: number
      truncated: boolean
    }
  | {
      ok: false
      code: GatewayCapabilitySearchErrorCode
      message: string
      matches: []
    }

export interface GatewayCapabilitySearchRequest extends GatewayCatalogScope {
  query: unknown
  limit?: unknown
}

interface SearchCandidate {
  definition: GatewayToolDefinition
  nameTokens: string[]
  descriptionTokens: string[]
  normalizedName: string
  compactName: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function lexicalTokens(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function uniqueTokens(tokens: readonly string[]): string[] {
  return [...new Set(tokens)]
}

function stableDefinitions(definitions: readonly GatewayToolDefinition[]): GatewayToolDefinition[] {
  const sorted = definitions
    .filter((definition) => typeof definition.name === 'string' && definition.name.length > 0)
    .slice()
    .sort((left, right) => {
      const byName = compareText(left.name, right.name)
      if (byName !== 0) return byName
      const byDescription = compareText(left.description || '', right.description || '')
      if (byDescription !== 0) return byDescription
      return compareText(
        JSON.stringify(left.inputSchema || {}),
        JSON.stringify(right.inputSchema || {})
      )
    })
  const seen = new Set<string>()
  return sorted.filter((definition) => {
    if (seen.has(definition.name)) return false
    seen.add(definition.name)
    return true
  })
}

function normalizedEligibleNames(names: Iterable<string>): Set<string> {
  const result = new Set<string>()
  for (const name of names) {
    if (typeof name === 'string' && name.length > 0) result.add(name)
  }
  return result
}

function normalizedAuditOnlyNames(names?: Iterable<string>): Set<string> {
  return normalizedEligibleNames(names || [])
}

function isAuditOnlyTool(name: string, auditOnlyNames: ReadonlySet<string>): boolean {
  return name.startsWith('audit_') || auditOnlyNames.has(name)
}

function isDiscoverableTool(
  name: string,
  eligibleNames: ReadonlySet<string>,
  auditOnlyNames: ReadonlySet<string>
): boolean {
  return (
    eligibleNames.has(name) &&
    !isCapabilityGatewayToolName(name) &&
    !isAuditOnlyTool(name, auditOnlyNames)
  )
}

function toSearchCandidate(definition: GatewayToolDefinition): SearchCandidate {
  const nameTokens = lexicalTokens(definition.name)
  return {
    definition,
    nameTokens,
    descriptionTokens: lexicalTokens(definition.description || ''),
    normalizedName: nameTokens.join(' '),
    compactName: nameTokens.join('')
  }
}

/**
 * Whole-token name boundary: "git" must not treat "github ci status" as a
 * startsWith hit (that was ranking github_ci_status near local git_* tools).
 */
function nameStartsWithQueryTokens(normalizedName: string, normalizedQuery: string): boolean {
  return normalizedName === normalizedQuery || normalizedName.startsWith(`${normalizedQuery} `)
}

/**
 * Compact-name boost only for multi-token queries (e.g. "git show" → "gitshow").
 * Single-token includes("git") inside "githubcistatus" is a false positive.
 */
function compactNameMatchesQuery(
  compactName: string,
  compactQuery: string,
  queryTokenCount: number
): boolean {
  if (compactName === compactQuery) return true
  if (queryTokenCount < 2) return false
  return compactName.startsWith(compactQuery)
}

function bestNameTokenPrefixScore(nameTokens: readonly string[], term: string): number {
  let best = 0
  for (const token of nameTokens) {
    if (!token.startsWith(term) || token === term) continue
    // Scale by term/token length so "git"→"github" is weak (160) vs exact (500).
    const scaled = Math.round(320 * (term.length / token.length))
    if (scaled > best) best = scaled
  }
  return best
}

function scoreCandidate(
  candidate: SearchCandidate,
  queryTokens: readonly string[]
): { score: number; exactName: boolean; matchedTerms: string[] } | null {
  const normalizedQuery = queryTokens.join(' ')
  const compactQuery = queryTokens.join('')
  const exactName =
    normalizedQuery === candidate.normalizedName || compactQuery === candidate.compactName
  let score = exactName ? 10_000 : 0
  const matchedTerms: string[] = []

  if (!exactName && nameStartsWithQueryTokens(candidate.normalizedName, normalizedQuery)) {
    score += 2_000
  }
  if (
    !exactName &&
    compactNameMatchesQuery(candidate.compactName, compactQuery, queryTokens.length)
  ) {
    score += 1_000
  }

  // Prefer workspace-local tools when the query says so (vs open-world remotes).
  const wantsLocal =
    queryTokens.includes('local') ||
    queryTokens.includes('workspace') ||
    queryTokens.includes('repo')
  if (wantsLocal) {
    const openWorld = candidate.definition.annotations?.openWorldHint === true
    score += openWorld ? -120 : 180
  }

  for (const term of queryTokens) {
    let termScore = 0
    if (candidate.nameTokens.includes(term)) {
      termScore = 500
    } else {
      const prefixScore = bestNameTokenPrefixScore(candidate.nameTokens, term)
      if (prefixScore > 0) {
        termScore = prefixScore
      } else if (candidate.nameTokens.some((token) => token.includes(term))) {
        termScore = 180
      } else if (candidate.descriptionTokens.includes(term)) {
        termScore = 90
      } else if (candidate.descriptionTokens.some((token) => token.startsWith(term))) {
        termScore = 45
      }
    }
    if (termScore > 0) {
      matchedTerms.push(term)
      score += termScore
    }
  }

  if (matchedTerms.length === 0 && !exactName) return null
  if (matchedTerms.length === queryTokens.length) score += 500 + queryTokens.length * 20
  return { score, exactName, matchedTerms }
}

/**
 * Deterministic bounded lexical discovery. An empty or punctuation-only query
 * is rejected instead of being treated as "match everything".
 */
export function searchGatewayCapabilities(
  request: GatewayCapabilitySearchRequest
): GatewayCapabilitySearchResult {
  if (typeof request.query !== 'string' || !request.query.trim()) {
    return {
      ok: false,
      code: 'invalid_query',
      message: 'capability_search requires a non-empty lexical query.',
      matches: []
    }
  }
  const query = request.query.trim()
  if (query.length > CAPABILITY_SEARCH_MAX_QUERY_LENGTH) {
    return {
      ok: false,
      code: 'query_too_long',
      message: `capability_search query must be at most ${CAPABILITY_SEARCH_MAX_QUERY_LENGTH} characters.`,
      matches: []
    }
  }
  const queryTokens = uniqueTokens(lexicalTokens(query))
  if (queryTokens.length === 0) {
    return {
      ok: false,
      code: 'invalid_query',
      message: 'capability_search requires at least one letter or number.',
      matches: []
    }
  }
  const limit = request.limit === undefined ? CAPABILITY_SEARCH_DEFAULT_LIMIT : request.limit
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > CAPABILITY_SEARCH_MAX_LIMIT
  ) {
    return {
      ok: false,
      code: 'invalid_limit',
      message: `capability_search limit must be an integer from 1 to ${CAPABILITY_SEARCH_MAX_LIMIT}.`,
      matches: []
    }
  }

  const eligibleNames = normalizedEligibleNames(request.eligibleToolNames)
  const auditOnlyNames = normalizedAuditOnlyNames(request.auditOnlyToolNames)
  const ranked = stableDefinitions(request.definitions)
    .map(toSearchCandidate)
    .map((candidate) => {
      const match = scoreCandidate(candidate, queryTokens)
      if (!match) return null

      if (isDiscoverableTool(candidate.definition.name, eligibleNames, auditOnlyNames)) {
        return { candidate, ...match }
      }

      if (
        match.exactName &&
        !isCapabilityGatewayToolName(candidate.definition.name) &&
        !isAuditOnlyTool(candidate.definition.name, auditOnlyNames)
      ) {
        return {
          candidate: {
            ...candidate,
            definition: {
              ...candidate.definition,
              annotations: {
                ...(candidate.definition.annotations || {}),
                direct: true,
                notice: 'already advertised — call it directly.'
              }
            }
          },
          ...match
        }
      }

      return null
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort(
      (left, right) =>
        right.score - left.score ||
        compareText(left.candidate.definition.name, right.candidate.definition.name)
    )

  const matches = ranked.slice(0, limit).map(({ candidate, score, exactName, matchedTerms }) => ({
    name: candidate.definition.name,
    ...(candidate.definition.description ? { description: candidate.definition.description } : {}),
    ...(candidate.definition.annotations ? { annotations: candidate.definition.annotations } : {}),
    inputSchema: candidate.definition.inputSchema || { type: 'object', properties: {} },
    score,
    exactName,
    matchedTerms
  }))

  return {
    ok: true,
    query,
    limit,
    matches,
    totalMatches: ranked.length,
    truncated: ranked.length > matches.length
  }
}

/** Exact, case-sensitive catalogue lookup with deterministic duplicate handling. */
export function findGatewayCapabilityByName(
  definitions: readonly GatewayToolDefinition[],
  name: string
): GatewayToolDefinition | null {
  return stableDefinitions(definitions).find((definition) => definition.name === name) || null
}

export interface GatewayArgumentValidationIssue {
  path: string
  keyword: string
  message: string
}

export type GatewayArgumentValidationResult =
  | { ok: true }
  | {
      ok: false
      code: 'invalid_schema' | 'invalid_arguments'
      issues: GatewayArgumentValidationIssue[]
      message: string
    }

interface ValidationState {
  issues: GatewayArgumentValidationIssue[]
  visitedNodes: number
}

type JsonSchema = boolean | Record<string, unknown>

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$comment',
  '$id',
  '$schema',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'default',
  'deprecated',
  'description',
  'enum',
  'examples',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'not',
  'oneOf',
  'pattern',
  'properties',
  'readOnly',
  'required',
  'title',
  'type',
  'uniqueItems',
  'writeOnly'
])

const JSON_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string'
])

function addIssue(state: ValidationState, path: string, keyword: string, message: string): void {
  if (state.issues.length >= MAX_VALIDATION_ISSUES) return
  state.issues.push({ path, keyword, message })
}

function escapeJsonPointer(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1')
}

function childPath(path: string, key: string | number): string {
  return `${path}/${escapeJsonPointer(String(key))}`
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'boolean' || isRecord(value)
}

function inspectNonNegativeIntegerKeyword(
  schema: Record<string, unknown>,
  keyword: string,
  path: string,
  state: ValidationState
): void {
  if (!(keyword in schema)) return
  const value = schema[keyword]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    addIssue(state, childPath(path, keyword), keyword, `${keyword} must be a non-negative integer.`)
  }
}

function inspectNumericKeyword(
  schema: Record<string, unknown>,
  keyword: string,
  path: string,
  state: ValidationState,
  positiveOnly = false
): void {
  if (!(keyword in schema)) return
  const value = schema[keyword]
  if (typeof value !== 'number' || !Number.isFinite(value) || (positiveOnly && value <= 0)) {
    addIssue(
      state,
      childPath(path, keyword),
      keyword,
      `${keyword} must be ${positiveOnly ? 'a positive' : 'a finite'} number.`
    )
  }
}

function inspectSchema(schema: unknown, path: string, state: ValidationState, depth: number): void {
  state.visitedNodes += 1
  if (state.visitedNodes > MAX_VALIDATION_NODES) {
    addIssue(state, path, 'schema', 'Schema exceeds the validation node budget.')
    return
  }
  if (depth > MAX_VALIDATION_DEPTH) {
    addIssue(state, path, 'schema', 'Schema exceeds the maximum nesting depth.')
    return
  }
  if (typeof schema === 'boolean') return
  if (!isRecord(schema)) {
    addIssue(state, path, 'schema', 'Schema must be an object or boolean.')
    return
  }

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      addIssue(
        state,
        childPath(path, keyword),
        keyword,
        `Unsupported JSON Schema keyword: ${keyword}.`
      )
    }
  }

  if ('type' in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (
      types.length === 0 ||
      types.some((type) => typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type)) ||
      new Set(types).size !== types.length
    ) {
      addIssue(
        state,
        childPath(path, 'type'),
        'type',
        'type must name one or more unique JSON types.'
      )
    }
  }

  if ('properties' in schema) {
    if (!isRecord(schema.properties)) {
      addIssue(state, childPath(path, 'properties'), 'properties', 'properties must be an object.')
    } else {
      for (const [name, propertySchema] of Object.entries(schema.properties)) {
        inspectSchema(
          propertySchema,
          childPath(childPath(path, 'properties'), name),
          state,
          depth + 1
        )
      }
    }
  }

  if ('required' in schema) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((name) => typeof name !== 'string') ||
      new Set(schema.required).size !== schema.required.length
    ) {
      addIssue(
        state,
        childPath(path, 'required'),
        'required',
        'required must be an array of unique strings.'
      )
    }
  }

  if ('items' in schema) {
    if (!isSchema(schema.items)) {
      addIssue(state, childPath(path, 'items'), 'items', 'items must be a schema.')
    } else {
      inspectSchema(schema.items, childPath(path, 'items'), state, depth + 1)
    }
  }

  if ('additionalProperties' in schema) {
    if (!isSchema(schema.additionalProperties)) {
      addIssue(
        state,
        childPath(path, 'additionalProperties'),
        'additionalProperties',
        'additionalProperties must be a boolean or schema.'
      )
    } else if (typeof schema.additionalProperties !== 'boolean') {
      inspectSchema(
        schema.additionalProperties,
        childPath(path, 'additionalProperties'),
        state,
        depth + 1
      )
    }
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (!(keyword in schema)) continue
    const branches = schema[keyword]
    if (
      !Array.isArray(branches) ||
      branches.length === 0 ||
      branches.some((branch) => !isSchema(branch))
    ) {
      addIssue(
        state,
        childPath(path, keyword),
        keyword,
        `${keyword} must be a non-empty array of schemas.`
      )
    } else {
      branches.forEach((branch, index) =>
        inspectSchema(branch, childPath(childPath(path, keyword), index), state, depth + 1)
      )
    }
  }

  if ('not' in schema) {
    if (!isSchema(schema.not)) {
      addIssue(state, childPath(path, 'not'), 'not', 'not must be a schema.')
    } else {
      inspectSchema(schema.not, childPath(path, 'not'), state, depth + 1)
    }
  }

  if ('enum' in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    addIssue(state, childPath(path, 'enum'), 'enum', 'enum must be a non-empty array.')
  }
  if ('pattern' in schema) {
    if (typeof schema.pattern !== 'string') {
      addIssue(state, childPath(path, 'pattern'), 'pattern', 'pattern must be a string.')
    } else {
      try {
        new RegExp(schema.pattern, 'u')
      } catch {
        addIssue(
          state,
          childPath(path, 'pattern'),
          'pattern',
          'pattern must be a valid regular expression.'
        )
      }
    }
  }

  for (const keyword of [
    'maxItems',
    'maxLength',
    'maxProperties',
    'minItems',
    'minLength',
    'minProperties'
  ]) {
    inspectNonNegativeIntegerKeyword(schema, keyword, path, state)
  }
  for (const keyword of ['exclusiveMaximum', 'exclusiveMinimum', 'maximum', 'minimum']) {
    inspectNumericKeyword(schema, keyword, path, state)
  }
  inspectNumericKeyword(schema, 'multipleOf', path, state, true)
  if ('uniqueItems' in schema && typeof schema.uniqueItems !== 'boolean') {
    addIssue(state, childPath(path, 'uniqueItems'), 'uniqueItems', 'uniqueItems must be a boolean.')
  }
}

function jsonValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => jsonValueEqual(value, right[index]))
    )
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort(compareText)
    const rightKeys = Object.keys(right).sort(compareText)
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && jsonValueEqual(left[key], right[key])
      )
    )
  }
  return false
}

function matchesJsonType(value: unknown, type: string): boolean {
  switch (type) {
    case 'array':
      return Array.isArray(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
    case 'null':
      return value === null
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'object':
      return isRecord(value)
    case 'string':
      return typeof value === 'string'
    default:
      return false
  }
}

function validateBranch(schema: JsonSchema, value: unknown, path: string, depth: number): boolean {
  const branchState: ValidationState = { issues: [], visitedNodes: 0 }
  validateValue(schema, value, path, branchState, depth)
  return branchState.issues.length === 0
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  state: ValidationState,
  depth: number
): void {
  state.visitedNodes += 1
  if (state.visitedNodes > MAX_VALIDATION_NODES) {
    addIssue(state, path, 'validation', 'Arguments exceed the validation node budget.')
    return
  }
  if (depth > MAX_VALIDATION_DEPTH) {
    addIssue(state, path, 'validation', 'Arguments exceed the maximum nesting depth.')
    return
  }
  if (schema === true) return
  if (schema === false) {
    addIssue(state, path, 'falseSchema', 'Value is forbidden by the schema.')
    return
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf as JsonSchema[]) {
      validateValue(branch, value, path, state, depth + 1)
    }
  }
  if (Array.isArray(schema.anyOf)) {
    const matches = (schema.anyOf as JsonSchema[]).filter((branch) =>
      validateBranch(branch, value, path, depth + 1)
    ).length
    if (matches === 0)
      addIssue(state, path, 'anyOf', 'Value must match at least one allowed schema.')
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = (schema.oneOf as JsonSchema[]).filter((branch) =>
      validateBranch(branch, value, path, depth + 1)
    ).length
    if (matches !== 1)
      addIssue(state, path, 'oneOf', 'Value must match exactly one allowed schema.')
  }
  if (isSchema(schema.not) && validateBranch(schema.not, value, path, depth + 1)) {
    addIssue(state, path, 'not', 'Value matches a forbidden schema.')
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => jsonValueEqual(entry, value))) {
    addIssue(state, path, 'enum', 'Value is not one of the allowed enum values.')
  }
  if ('const' in schema && !jsonValueEqual(schema.const, value)) {
    addIssue(state, path, 'const', 'Value does not match the required constant.')
  }

  const declaredTypes = Array.isArray(schema.type)
    ? (schema.type as string[])
    : typeof schema.type === 'string'
      ? [schema.type]
      : []
  if (declaredTypes.length > 0 && !declaredTypes.some((type) => matchesJsonType(value, type))) {
    addIssue(state, path, 'type', `Value must have JSON type ${declaredTypes.join(' or ')}.`)
    return
  }

  if (typeof value === 'string') {
    const length = [...value].length
    if (typeof schema.minLength === 'number' && length < schema.minLength) {
      addIssue(
        state,
        path,
        'minLength',
        `String must contain at least ${schema.minLength} characters.`
      )
    }
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) {
      addIssue(
        state,
        path,
        'maxLength',
        `String must contain at most ${schema.maxLength} characters.`
      )
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      addIssue(state, path, 'pattern', 'String does not match the required pattern.')
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      addIssue(state, path, 'minimum', `Number must be at least ${schema.minimum}.`)
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      addIssue(state, path, 'maximum', `Number must be at most ${schema.maximum}.`)
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      addIssue(
        state,
        path,
        'exclusiveMinimum',
        `Number must be greater than ${schema.exclusiveMinimum}.`
      )
    }
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) {
      addIssue(
        state,
        path,
        'exclusiveMaximum',
        `Number must be less than ${schema.exclusiveMaximum}.`
      )
    }
    if (
      typeof schema.multipleOf === 'number' &&
      Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-12
    ) {
      addIssue(state, path, 'multipleOf', `Number must be a multiple of ${schema.multipleOf}.`)
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      addIssue(state, path, 'minItems', `Array must contain at least ${schema.minItems} items.`)
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      addIssue(state, path, 'maxItems', `Array must contain at most ${schema.maxItems} items.`)
    }
    if (schema.uniqueItems === true) {
      const duplicate = value.some((entry, index) =>
        value.slice(0, index).some((prior) => jsonValueEqual(prior, entry))
      )
      if (duplicate) addIssue(state, path, 'uniqueItems', 'Array items must be unique.')
    }
    if (isSchema(schema.items)) {
      value.forEach((entry, index) =>
        validateValue(schema.items as JsonSchema, entry, childPath(path, index), state, depth + 1)
      )
    }
  }

  if (isRecord(value)) {
    const keys = Object.keys(value)
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) {
      addIssue(
        state,
        path,
        'minProperties',
        `Object must contain at least ${schema.minProperties} properties.`
      )
    }
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) {
      addIssue(
        state,
        path,
        'maxProperties',
        `Object must contain at most ${schema.maxProperties} properties.`
      )
    }
    if (Array.isArray(schema.required)) {
      for (const requiredName of schema.required as string[]) {
        if (!Object.prototype.hasOwnProperty.call(value, requiredName)) {
          addIssue(
            state,
            childPath(path, requiredName),
            'required',
            `Required argument '${requiredName}' is missing.`
          )
        }
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const [name, entry] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, name)) {
        validateValue(
          properties[name] as JsonSchema,
          entry,
          childPath(path, name),
          state,
          depth + 1
        )
      } else if (schema.additionalProperties === false) {
        addIssue(
          state,
          childPath(path, name),
          'additionalProperties',
          `Unknown argument '${name}' is not allowed.`
        )
      } else if (isRecord(schema.additionalProperties)) {
        validateValue(schema.additionalProperties, entry, childPath(path, name), state, depth + 1)
      }
    }
  }
}

/**
 * Validate a tool invocation against the supported JSON Schema subset. Schema
 * inspection happens first and fails closed if a future catalogue introduces a
 * keyword this gateway does not understand.
 */
export function validateGatewayToolArguments(
  inputSchema: Record<string, unknown> | undefined,
  args: Record<string, unknown>
): GatewayArgumentValidationResult {
  const schema: JsonSchema = inputSchema || { type: 'object', properties: {} }
  const schemaState: ValidationState = { issues: [], visitedNodes: 0 }
  inspectSchema(schema, '#', schemaState, 0)
  if (schemaState.issues.length > 0) {
    return {
      ok: false,
      code: 'invalid_schema',
      issues: schemaState.issues,
      message: 'The target capability has an unsupported or invalid input schema.'
    }
  }

  const argumentState: ValidationState = { issues: [], visitedNodes: 0 }
  validateValue(schema, args, '#', argumentState, 0)
  if (argumentState.issues.length > 0) {
    return {
      ok: false,
      code: 'invalid_arguments',
      issues: argumentState.issues,
      message: 'The capability arguments do not match the target input schema.'
    }
  }
  return { ok: true }
}

export type GatewayInvocationErrorCode =
  | 'invalid_target_name'
  | 'gateway_recursion'
  | 'audit_only_target'
  | 'unknown_target'
  | 'ineligible_target'
  | 'invalid_arguments_object'
  | 'invalid_target_schema'
  | 'target_argument_validation_failed'
  | 'ambiguous_argument_alias'

export type GatewayInvocationResolution =
  | {
      ok: true
      target: GatewayToolDefinition
      name: string
      arguments: Record<string, unknown>
    }
  | {
      ok: false
      code: GatewayInvocationErrorCode
      message: string
      issues?: GatewayArgumentValidationIssue[]
      conflicts?: ToolArgumentAliasConflict[]
    }

export interface GatewayInvocationRequest extends GatewayCatalogScope {
  name: unknown
  arguments: unknown
}

/** Resolve and validate a hidden target without executing or changing its identity. */
export function resolveGatewayInvocation(
  request: GatewayInvocationRequest
): GatewayInvocationResolution {
  if (typeof request.name !== 'string' || !request.name.trim()) {
    return {
      ok: false,
      code: 'invalid_target_name',
      message: 'capability_invoke requires a non-empty exact target name.'
    }
  }
  const name = request.name.trim()
  if (isCapabilityGatewayToolName(name)) {
    return {
      ok: false,
      code: 'gateway_recursion',
      message: 'Capability gateway tools cannot invoke themselves.'
    }
  }
  const auditOnlyNames = normalizedAuditOnlyNames(request.auditOnlyToolNames)
  if (isAuditOnlyTool(name, auditOnlyNames)) {
    return {
      ok: false,
      code: 'audit_only_target',
      message: `Audit-only capability '${name}' cannot be invoked through the gateway.`
    }
  }
  const target = findGatewayCapabilityByName(request.definitions, name)
  if (!target) {
    return {
      ok: false,
      code: 'unknown_target',
      message: `Unknown TaskWraith capability: ${name}`
    }
  }
  const eligibleNames = normalizedEligibleNames(request.eligibleToolNames)
  // C2b-ii-d (G-SINGLE) — arg-scoped gateway-eligibility exception for the ONE exact
  // reviewer verdict. ensemble_bossman_control is a DIRECT tool (excluded from the
  // hidden/eligible set = full − direct), so a read-only/plan capability_invoke would
  // die here as ineligible_target even for a gate's own reviewer reconciling its own
  // gate. Delegated to the ONE shared classifier (never re-inlined): ONLY canonical
  // ensemble_bossman_control with the exact {action:'submit_review_verdict', gateId,
  // verdict} inner payload bypasses the eligibility membership check. Any other action /
  // extra key / near-miss / non-object fails CLOSED via the classifier → normal
  // ineligible_target. This relaxes ELIGIBILITY ONLY — the target must still resolve
  // (unknown_target above is untouched), args must still be an object (isRecord below),
  // and validateGatewayToolArguments (schema / route / lineage) still runs; no advertise
  // / auto-allow / direct / hidden set is widened.
  if (!eligibleNames.has(name) && !isExactReviewerVerdictInvocation(name, request.arguments)) {
    return {
      ok: false,
      code: 'ineligible_target',
      message: `Capability '${name}' is not eligible for this run.`
    }
  }
  if (!isRecord(request.arguments)) {
    return {
      ok: false,
      code: 'invalid_arguments_object',
      message: 'capability_invoke arguments must be a JSON object.'
    }
  }

  // Coalesce inner target args against THIS run-selected definition before
  // schema validation. Eligibility, audit-only, recursion, and the reviewer-
  // verdict exception have already been decided above; aliases must not change
  // target identity or the wrapper contract.
  const argumentCoalesce = coalesceToolArguments(name, request.arguments, {
    inputSchema: target.inputSchema
  })
  if (!argumentCoalesce.ok) {
    return {
      ok: false,
      code: argumentCoalesce.code,
      message: argumentCoalesce.message,
      conflicts: argumentCoalesce.conflicts
    }
  }
  const coalescedArguments = isRecord(argumentCoalesce.arguments)
    ? argumentCoalesce.arguments
    : request.arguments

  const validation = validateGatewayToolArguments(target.inputSchema, coalescedArguments)
  if (!validation.ok) {
    return {
      ok: false,
      code:
        validation.code === 'invalid_schema'
          ? 'invalid_target_schema'
          : 'target_argument_validation_failed',
      message: validation.message,
      issues: validation.issues
    }
  }

  return {
    ok: true,
    target,
    name,
    arguments: coalescedArguments
  }
}
