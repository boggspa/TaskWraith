import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Options } from 'prettier'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  resetAntigravityGeminiApiKeyConfiguredProbeForTests,
  setAntigravityGeminiApiKeyConfiguredProbe
} from './antigravity/AntigravityGeminiApiKeyConfiguredSignal'
import { createTaskWraithMcpToolDefinitions } from './McpToolCatalog'

/**
 * SERIALIZED TOOL-CONTRACT SNAPSHOT.
 *
 * `createTaskWraithMcpToolDefinitions()` emits the descriptions and JSON
 * schemas that every tool-capable provider actually reads. Its text is
 * assembled from constants imported out of ~20 unrelated modules
 * (MAX_ENSEMBLE_PARTICIPANTS, CANVAS_EVAL_SCRIPT_CAP, BLACKBOARD_MAX_TTL_MINUTES,
 * EMULATOR_STEP_MAX_TOTAL_FRAMES, the selectable provider set, ...), so the
 * advertised contract moves whenever any of them moves. The sibling
 * `McpToolCatalog*.test.ts` suites assert BEHAVIOUR of individual tools; none
 * of them diffs the emitted surface, so until this file existed a caps bump in
 * a far-away module silently rewrote what agents were told, and the only
 * feedback was a stale agent miscalling a tool at runtime. Verified by
 * mutation: changing MAX_ENSEMBLE_PARTICIPANTS in `src/shared/ensembleLimits.ts`
 * (a file with no test sibling, three directories away) reds this file and
 * names `ensemble_roster_edit`.
 *
 * This is a drift detector, not a freeze. A red here means the advertised
 * contract changed; it does not mean the change is wrong. Read the diff, decide
 * whether it was intended, and if it was, regenerate:
 *
 *     UPDATE_MCP_CONTRACT=1 npx vitest run src/main/McpToolCatalogContract.test.ts
 *
 * Then commit the regenerated JSON WITH the change that caused it, so the
 * contract delta is reviewable in the same diff as its cause. Regenerating to
 * clear a red you have not read turns this file into a rubber stamp.
 *
 * Regeneration writes through Prettier on purpose. `JSON.stringify` always
 * expands short arrays that Prettier collapses onto one line, so a plain write
 * would leave the golden unformatted and put `format:ratchet` in the red after
 * every legitimate update.
 *
 * TWO STATES ARE PINNED, because the catalogue is not pure.
 * `selectableProviderIds()` is called with no settings at ~15 sites and
 * consults the live Gemini-API-key probe, so `antigravity` joins those provider
 * enums on a machine where a key is configured — the contract an agent receives
 * depends on machine state.
 *
 *   1. `tools` is the fail-closed base: the probe default `() => false`, which
 *      is what vitest sees because `index.ts` never wires it. `beforeAll`
 *      re-asserts it so the golden cannot drift with ambient state.
 *   2. `antigravityOptIn.changedPaths` is the DELTA to the probe-true state,
 *      not a second full capture. A second capture would double a 306KB file
 *      to say one thing, and the delta says that thing far more directly: the
 *      opt-in must append `antigravity` to provider enums and do NOTHING else.
 *      An opt-in that reworded a description, added a tool, or touched a
 *      non-enum leaf reds here even if every recorded path still matched.
 */

const require = createRequire(import.meta.url)
const prettier = require('prettier') as {
  format(source: string, options: Options): Promise<string>
  resolveConfig(filePath: string): Promise<Options | null>
}

const GOLDEN_PATH = fileURLToPath(
  new URL('./McpToolCatalogContract.generated.json', import.meta.url)
)

const ANTIGRAVITY_PROVIDER_ID = 'antigravity'

type Json = unknown
interface LeafChange {
  path: string
  from: Json
  to: Json
}

/** Sort object keys recursively; array ORDER is contract and is preserved. */
function canonicalize(value: Json): Json {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, Json>
  const out: Record<string, Json> = {}
  for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key])
  return out
}

function canonicalTools(): Record<string, Json> {
  const definitions = createTaskWraithMcpToolDefinitions()
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const definition of definitions) {
    if (seen.has(definition.name)) duplicates.push(definition.name)
    seen.add(definition.name)
  }
  // Keying by name silently collapses a duplicate, which would make the whole
  // snapshot lie. Fail loudly instead of recording a golden that is short a tool.
  expect(duplicates, 'catalogue emitted duplicate tool names').toEqual([])

  const out: Record<string, Json> = {}
  for (const name of [...seen].sort()) {
    const definition = definitions.find((candidate) => candidate.name === name)!
    out[name] = canonicalize({ ...definition })
  }
  return out
}

function isPlainObject(value: Json): value is Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** An enum/required list is one contract value, so report it whole rather than per index. */
function isPrimitiveArray(value: Json): boolean {
  return Array.isArray(value) && value.every((item) => item === null || typeof item !== 'object')
}

function leafChanges(before: Json, after: Json, path: string): LeafChange[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (isPrimitiveArray(before) && isPrimitiveArray(after))
    return [{ path, from: before, to: after }]
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: LeafChange[] = []
    for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
      out.push(...leafChanges(before[index], after[index], `${path}[${index}]`))
    }
    return out
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const out: LeafChange[] = []
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    for (const key of keys) out.push(...leafChanges(before[key], after[key], `${path}.${key}`))
    return out
  }
  return [{ path, from: before, to: after }]
}

function digestOf(value: Json): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}

/** Capture the catalogue with the Gemini-API-key probe forced on, then restore it. */
function toolsWithAntigravityOptIn(): Record<string, Json> {
  setAntigravityGeminiApiKeyConfiguredProbe(() => true)
  try {
    return canonicalTools()
  } finally {
    resetAntigravityGeminiApiKeyConfiguredProbeForTests()
  }
}

function antigravityChangedPaths(): LeafChange[] {
  const base = canonicalTools()
  const optIn = toolsWithAntigravityOptIn()
  return leafChanges(base, optIn, '$')
}

describe('TaskWraith MCP tool contract', () => {
  beforeAll(() => {
    resetAntigravityGeminiApiKeyConfiguredProbeForTests()
  })

  afterEach(() => {
    // Belt and braces: a leaked probe would silently rewrite the base capture
    // for every test after it, which is exactly the class of bug this file exists to catch.
    resetAntigravityGeminiApiKeyConfiguredProbeForTests()
  })

  it('emits a byte-identical catalogue on repeated calls', () => {
    // A snapshot over a nondeterministic emitter is a flake generator. If this
    // reds, something time-, random- or ambient-state-dependent reached the
    // advertised contract and the golden below is meaningless until it is gone.
    expect(JSON.stringify(canonicalTools())).toEqual(JSON.stringify(canonicalTools()))
  })

  it('changes only provider enums when the antigravity opt-in is active', () => {
    const changes = antigravityChangedPaths()

    // NOT VACUOUS: if the opt-in stopped reaching the catalogue at all, an
    // "every change looks right" assertion over an empty list would pass while
    // proving nothing. Pin that the surface actually moves first.
    expect(changes.length, 'antigravity opt-in changed nothing in the catalogue').toBeGreaterThan(0)

    const base = canonicalTools()
    const optIn = toolsWithAntigravityOptIn()
    expect(Object.keys(optIn), 'opt-in must not add or remove tools').toEqual(Object.keys(base))

    for (const change of changes) {
      expect(Array.isArray(change.from), `non-array leaf changed at ${change.path}`).toBe(true)
      // The opt-in is an APPEND to a provider enum and nothing else: same values
      // in the same order, with antigravity added at the end.
      expect(change.to, `unexpected opt-in change at ${change.path}`).toEqual([
        ...(change.from as Json[]),
        ANTIGRAVITY_PROVIDER_ID
      ])
      expect(change.path, `opt-in touched a non-enum leaf at ${change.path}`).toMatch(/\.enum$/)
    }
  })

  it('matches the recorded contract', async () => {
    const tools = canonicalTools()
    const digest = digestOf(tools)
    const changedPaths = antigravityChangedPaths()
    const antigravityOptIn = { digest: digestOf(changedPaths), changedPaths }

    if (process.env.UPDATE_MCP_CONTRACT === '1') {
      const serialized = `${JSON.stringify(
        { digest, toolCount: Object.keys(tools).length, antigravityOptIn, tools },
        null,
        2
      )}\n`
      const options = (await prettier.resolveConfig(GOLDEN_PATH)) ?? {}
      writeFileSync(
        GOLDEN_PATH,
        await prettier.format(serialized, { ...options, filepath: GOLDEN_PATH }),
        'utf8'
      )
    }

    expect(
      existsSync(GOLDEN_PATH),
      'contract golden missing; generate it with UPDATE_MCP_CONTRACT=1'
    ).toBe(true)

    const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as {
      digest: string
      toolCount: number
      antigravityOptIn: { digest: string; changedPaths: LeafChange[] }
      tools: Record<string, Json>
    }

    // Name-set first: an added or removed tool is a different class of change
    // from an edited one, and reporting it separately keeps the failure legible.
    const current = Object.keys(tools)
    const recorded = Object.keys(golden.tools)
    expect(
      current.filter((name) => !recorded.includes(name)),
      'tools ADDED'
    ).toEqual([])
    expect(
      recorded.filter((name) => !current.includes(name)),
      'tools REMOVED'
    ).toEqual([])

    // Per-tool, so a failure names the tool instead of diffing the whole surface.
    for (const name of current.filter((candidate) => recorded.includes(candidate))) {
      expect(tools[name], `contract changed for tool: ${name}`).toEqual(golden.tools[name])
    }

    expect(golden.toolCount).toBe(current.length)
    expect(digest).toBe(golden.digest)

    // The opt-in surface drifts independently of the base: a provider added to
    // LIVE_SELECTABLE_PROVIDER_IDS moves both, but a change to the antigravity
    // admission rule moves only this.
    expect(antigravityOptIn.changedPaths, 'antigravity opt-in surface changed').toEqual(
      golden.antigravityOptIn.changedPaths
    )
    expect(antigravityOptIn.digest).toBe(golden.antigravityOptIn.digest)
  })
})
