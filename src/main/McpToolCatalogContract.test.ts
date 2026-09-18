import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Options } from 'prettier'
import { beforeAll, describe, expect, it } from 'vitest'
import { resetAntigravityGeminiApiKeyConfiguredProbeForTests } from './antigravity/AntigravityGeminiApiKeyConfiguredSignal'
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
 * Determinism: the catalogue is not pure. `selectableProviderIds()` is called
 * with no settings at ~15 sites and consults the live Gemini-API-key probe, so
 * `antigravity` joins those provider enums on a machine where a key is
 * configured. Under vitest the probe keeps its fail-closed default because
 * `index.ts` never wires it; `beforeAll` re-asserts that explicitly so the
 * golden cannot depend on ambient machine state. The antigravity opt-in surface
 * is therefore deliberately NOT covered here.
 */

const require = createRequire(import.meta.url)
const prettier = require('prettier') as {
  format(source: string, options: Options): Promise<string>
  resolveConfig(filePath: string): Promise<Options | null>
}

const GOLDEN_PATH = fileURLToPath(
  new URL('./McpToolCatalogContract.generated.json', import.meta.url)
)

type Json = unknown

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

function digestOf(tools: Record<string, Json>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(tools)).digest('hex')}`
}

describe('TaskWraith MCP tool contract', () => {
  beforeAll(() => {
    resetAntigravityGeminiApiKeyConfiguredProbeForTests()
  })

  it('emits a byte-identical catalogue on repeated calls', () => {
    // A snapshot over a nondeterministic emitter is a flake generator. If this
    // reds, something time-, random- or ambient-state-dependent reached the
    // advertised contract and the golden below is meaningless until it is gone.
    expect(JSON.stringify(canonicalTools())).toEqual(JSON.stringify(canonicalTools()))
  })

  it('matches the recorded contract', async () => {
    const tools = canonicalTools()
    const digest = digestOf(tools)

    if (process.env.UPDATE_MCP_CONTRACT === '1') {
      const serialized = `${JSON.stringify({ digest, toolCount: Object.keys(tools).length, tools }, null, 2)}\n`
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
  })
})
