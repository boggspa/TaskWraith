import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// npm-test surface for scripts/renderer-bundle-guard.cjs (the ci-chain guard
// landed in 0eeba1a4f). The guarded class — a renderer-reachable module with a
// NAMED Node-builtin import kills the electron-vite CLIENT build at rollup's
// bind pass — shipped three times precisely because vitest, both typechecks,
// and dev builds all stay green over it, and `npm run ci` is not the loop
// sessions run before committing. This wrapper puts the same walk in front of
// every plain `npm test`/vitest run. One walker, two surfaces: the .cjs stays
// the single implementation (it runs main() at require time, so it is invoked
// as a CLI here, never required).
const REPO_ROOT = join(__dirname, '..')
const GUARD_CLI = join(__dirname, 'renderer-bundle-guard.cjs')

// If the walk ever reports fewer modules than this, entry discovery itself
// broke and an "ok" would be vacuous. The real closure was ~1000 modules when
// this wrapper landed (2026-08-27); the floor is deliberately loose.
const MIN_EXPECTED_REACHABLE_MODULES = 500

describe('renderer-bundle guard (npm test surface)', () => {
  // Generous per-test timeout: the child walks ~2,500 files and competes with
  // a fully parallel vitest run — under 12 workers it has exceeded the default
  // 5s test timeout while succeeding (2026-08-27, first full-suite run).
  it('passes on the current tree, over a non-vacuous walk', { timeout: 120_000 }, () => {
    let stdout = ''
    try {
      stdout = execFileSync('node', [GUARD_CLI], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 120_000
      })
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string }
      expect.fail(
        `renderer-bundle-guard failed — the electron-vite CLIENT build will die at bind:\n` +
          `${failed.stderr || ''}${failed.stdout || ''}`
      )
    }
    const okMatch = stdout.match(/ok — (\d+) modules reachable/)
    expect(okMatch, `unrecognized guard output:\n${stdout}`).not.toBeNull()
    expect(Number(okMatch![1])).toBeGreaterThanOrEqual(MIN_EXPECTED_REACHABLE_MODULES)
  })
})

describe('known tripwire modules stay namespace-form', () => {
  // Every one of these main-process modules sat in the client import graph on
  // 2026-08-26 and carried (or, for CanvasEvalAudit, still safely namespaces)
  // the named builtin import that killed the build. The graph oscillates with
  // normal development, so their import SHAPE is pinned even while a module is
  // currently unreachable — the ci guard only fires once an edge re-appears,
  // which is one commit too late for these known offenders.
  const tripwires = [
    'src/main/WorkflowAuthorityDigest.ts',
    'src/main/ScheduledTaskRendererAuthority.ts',
    'src/main/RunPermissionPosture.ts',
    'src/main/settings/MainSanitizers.ts',
    'src/main/canvas/CanvasEvalAudit.ts'
  ]

  // Named VALUE import (or re-export) from a Node builtin, node:-prefixed or
  // bare. `import type` statements and `{ type X }`-only clauses are erased at
  // build and deliberately do not match; namespace/default imports do not
  // match. The all-type clauses are stripped first because the main regex
  // cannot distinguish `{ type A }` from `{ a }` on its own.
  const NAMED_BUILTIN_IMPORT_RE =
    /(?:^|\n)[ \t]*(?:import|export)[ \t]+(?!type[\s{])[^'"\n]*\{[^}]*[^}\s,][^}]*\}[^'"\n]*from[ \t]*['"](?:node:)?(?:assert|buffer|child_process|crypto|dns|events|fs|http|https|module|net|os|path|perf_hooks|process|querystring|readline|stream|string_decoder|timers|tls|tty|url|util|v8|vm|worker_threads|zlib)(?:\/[\w-]+)?['"]/
  const ALL_TYPE_CLAUSE_RE =
    /(?:^|\n)[ \t]*(?:import|export)[ \t]+\{(?:[ \t]*type[ \t]+[\w$]+(?:[ \t]+as[ \t]+[\w$]+)?,?)+[ \t]*\}[^\n]*from[^\n]*/g

  const hasNamedBuiltinImport = (source: string): boolean =>
    NAMED_BUILTIN_IMPORT_RE.test(source.replace(ALL_TYPE_CLAUSE_RE, '\n'))

  it.each(tripwires)('%s has no named Node-builtin import', (relativePath) => {
    const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8')
    expect(hasNamedBuiltinImport(source)).toBe(false)
  })

  it('the pin detector actually fires on the historical breakage shape', () => {
    // Self-test so a regex regression cannot green the pins vacuously — these
    // are occurrence 3's literal fatal lines.
    expect(hasNamedBuiltinImport("import { createHash } from 'node:crypto'\n")).toBe(true)
    expect(hasNamedBuiltinImport("import { resolve } from 'node:path'\n")).toBe(true)
    expect(hasNamedBuiltinImport("export { isDeepStrictEqual } from 'util'\n")).toBe(true)
    expect(hasNamedBuiltinImport("import { type Hash, createHmac } from 'node:crypto'\n")).toBe(
      true
    )
    // Sanctioned forms stay quiet.
    expect(hasNamedBuiltinImport("import * as nodeCrypto from 'node:crypto'\n")).toBe(false)
    expect(hasNamedBuiltinImport("import path from 'node:path'\n")).toBe(false)
    expect(hasNamedBuiltinImport("import type { Hash } from 'node:crypto'\n")).toBe(false)
    expect(hasNamedBuiltinImport("import { type Hash, type Hmac } from 'node:crypto'\n")).toBe(
      false
    )
  })
})
