import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A bare `__DEFINE__` reference in a component is a ReferenceError thrown
 * DURING RENDER — it unmounts the whole surface instead of degrading one
 * feature. It fires whenever the define and the running bundle disagree: a dev
 * server started before the define was added (config-level `define` is not
 * picked up by HMR), a packaging path that misses it, or a test harness that
 * never sets it. It cost the transcript surface once already.
 *
 * So: every build-time define is read through lib/featureFlags.ts, behind a
 * `typeof … !== 'undefined'` guard, and this test is what keeps it that way.
 */

const REPO_ROOT = resolve(__dirname, '../../../..')
const RENDERER_SRC = resolve(REPO_ROOT, 'src/renderer/src')
const VITE_CONFIG = resolve(REPO_ROOT, 'electron.vite.config.ts')
const FLAGS_MODULE = join(RENDERER_SRC, 'lib/featureFlags.ts')
const ENV_D_TS = join(RENDERER_SRC, 'env.d.ts')

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** Define symbols declared for the RENDERER. The main-process define block also
 * has symbols; those never reach renderer code. */
function rendererDefineSymbols(): string[] {
  const config = readFileSync(VITE_CONFIG, 'utf8')
  const rendererIndex = config.indexOf('renderer: {')
  expect(rendererIndex, 'renderer section not found in electron.vite.config.ts').toBeGreaterThan(-1)
  const rendererBlock = config.slice(rendererIndex)
  const defineIndex = rendererBlock.indexOf('define: {')
  if (defineIndex === -1) return []
  const afterDefine = rendererBlock.slice(defineIndex)
  const closing = afterDefine.indexOf('\n      },')
  const defineBlock = afterDefine.slice(0, closing === -1 ? undefined : closing)
  return [...new Set(defineBlock.match(/__[A-Z0-9_]+__/g) ?? [])]
}

describe('build-time defines', () => {
  const symbols = rendererDefineSymbols()

  it('finds the renderer define block', () => {
    // Guards the parser above: if the config is reformatted such that this
    // returns nothing, every check below would pass vacuously.
    expect(symbols.length).toBeGreaterThan(0)
  })

  it('declares every renderer define in env.d.ts', () => {
    const envDts = readFileSync(ENV_D_TS, 'utf8')
    for (const symbol of symbols) {
      expect(envDts, `${symbol} is not declared in env.d.ts`).toContain(symbol)
    }
  })

  it('guards every define in featureFlags.ts with a typeof check', () => {
    const flags = readFileSync(FLAGS_MODULE, 'utf8')
    for (const symbol of symbols) {
      if (!flags.includes(symbol)) continue
      expect(flags, `${symbol} is used unguarded in featureFlags.ts`).toContain(
        `typeof ${symbol} !== 'undefined'`
      )
    }
  })

  it('references defines ONLY from featureFlags.ts', () => {
    const offenders: string[] = []
    for (const file of walk(RENDERER_SRC)) {
      if (file === FLAGS_MODULE || file === ENV_D_TS) continue
      if (file.endsWith('.test.ts') || file.endsWith('.test.tsx')) continue
      const source = readFileSync(file, 'utf8')
      for (const symbol of symbols) {
        if (source.includes(symbol)) {
          offenders.push(`${file.slice(REPO_ROOT.length + 1)} references ${symbol}`)
        }
      }
    }
    expect(
      offenders,
      'Import the guarded constant from lib/featureFlags.ts instead — a bare ' +
        'reference throws during render if the define is missing.'
    ).toEqual([])
  })
})
