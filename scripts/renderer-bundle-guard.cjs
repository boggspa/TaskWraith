#!/usr/bin/env node

/**
 * Renderer-bundle bind guard.
 *
 * The electron-vite CLIENT build has broken three times (last fixed in
 * cefa4b242) on one failure class: a module reachable from src/renderer/**
 * through VALUE imports carries a NAMED import of a Node builtin. Vite
 * replaces builtins with the empty `__vite-browser-external` stub in the
 * client bundle, and rollup resolves named imports during its bind pass —
 * before tree-shaking — so the build dies even though the renderer never
 * calls the symbol. Nothing else in CI sees it: vitest, both typechecks and
 * `electron-vite dev` all stay green over a broken production build.
 *
 * This guard asserts the closure property directly, and only that property:
 *
 *   No file transitively reachable from src/renderer/** via value imports
 *   may contain a named import (or named re-export) from a Node builtin.
 *
 * Tolerated, exactly as the real build tolerates them:
 *   - `import type` / `export type` / all-type clauses (erased before bind);
 *   - namespace imports (`import * as nodeCrypto from 'node:crypto'`) — the
 *     sanctioned pattern for main modules that renderer code can reach: the
 *     member resolves at call time, which only ever happens in main
 *     (build-time it degrades to a warning, e.g. canvas/CanvasEvalAudit);
 *   - default and side-effect imports of builtins (bind-safe against the
 *     stub's default export).
 *
 * scripts/architecture-guard.cjs ratchets the DIRECT renderer->main edge
 * count; it cannot see this class, because every breakage rode a
 * grandfathered direct edge (App.tsx -> PromptComposition) whose MAIN-side
 * subtree later grew a bad hop (e.g. McpToolProfiles -> McpToolGateway).
 * Static import() chains are not followed (they split into separate chunks
 * and fail differently); the property here is rollup's static bind pass.
 *
 * On failure the guard prints the offending import and one full chain from a
 * renderer file, plus the two ways out: cut the renderer-reachable edge, or
 * namespace-import the builtin in the offending module.
 */

const fs = require('fs')
const path = require('path')
const { builtinModules } = require('module')

const REPO_ROOT = path.resolve(__dirname, '..')
const SRC_ROOT = path.join(REPO_ROOT, 'src')
const RENDERER_PREFIX = path.join(SRC_ROOT, 'renderer') + path.sep
const RENDERER_ALIAS_ROOT = path.join(SRC_ROOT, 'renderer', 'src')

const BUILTINS = new Set(builtinModules)

function isBuiltinSpecifier(specifier) {
  if (specifier.startsWith('node:')) return true
  // Bare builtins may carry subpaths (fs/promises).
  const head = specifier.split('/')[0]
  return BUILTINS.has(head) || BUILTINS.has(specifier)
}

function listSourceFiles(root) {
  const out = []
  const pending = [root]
  while (pending.length > 0) {
    const dir = pending.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue
        pending.push(full)
        continue
      }
      if (!/\.(ts|tsx|mts|cts)$/.test(entry.name)) continue
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue
      if (entry.name.endsWith('.d.ts')) continue
      out.push(full)
    }
  }
  return out
}

function resolveSpecifier(fromFile, specifier) {
  let base = null
  if (specifier.startsWith('.')) {
    base = path.resolve(path.dirname(fromFile), specifier)
  } else if (specifier === '@renderer' || specifier.startsWith('@renderer/')) {
    base = path.join(RENDERER_ALIAS_ROOT, specifier.slice('@renderer'.length + 1))
  } else {
    return null
  }
  for (const candidate of [
    base + '.ts',
    base + '.tsx',
    base + '.mts',
    base + '.cts',
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    base
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
}

// import/export ... from 'spec'  |  import 'spec'
const STATEMENT_RE =
  /(?:^|\n)[ \t]*(import|export)\s+([\s\S]*?)?\s*from\s*['"]([^'"]+)['"]|(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g

function parseFile(file) {
  const source = fs.readFileSync(file, 'utf8')
  const valueEdges = []
  const namedBuiltinImports = []
  let match
  STATEMENT_RE.lastIndex = 0
  while ((match = STATEMENT_RE.exec(source))) {
    const specifier = match[3] ?? match[4]
    if (!specifier) continue
    const keyword = match[1]
    const clause = match[2]
    if (match[4] !== undefined) {
      // Side-effect import: a value edge, no named bindings.
      const resolved = resolveSpecifier(file, specifier)
      if (resolved) valueEdges.push(resolved)
      continue
    }
    const trimmedClause = (clause || '').trim()
    if (/^type[\s{]/.test(trimmedClause)) continue // import type / export type — erased
    const braced = trimmedClause.match(/\{([\s\S]*?)\}/)
    const namedValues = braced
      ? braced[1]
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
          .filter((entry) => !/^type\s/.test(entry))
      : []
    if (
      braced &&
      namedValues.length === 0 &&
      !/[\w*]/.test(trimmedClause.replace(/\{[\s\S]*\}/, ''))
    ) {
      continue // { type A, type B } only — erased
    }
    if (isBuiltinSpecifier(specifier)) {
      const starReexport = keyword === 'export' && trimmedClause.startsWith('*')
      if (namedValues.length > 0 || starReexport) {
        const line = source.slice(0, match.index + 1).split('\n').length
        namedBuiltinImports.push({
          specifier,
          names: starReexport ? ['* (re-export)'] : namedValues,
          line
        })
      }
      continue
    }
    const resolved = resolveSpecifier(file, specifier)
    if (resolved) valueEdges.push(resolved)
  }
  return { valueEdges, namedBuiltinImports }
}

function relative(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/')
}

function main() {
  const files = listSourceFiles(SRC_ROOT)
  const parsed = new Map()
  for (const file of files) parsed.set(file, parseFile(file))

  const roots = files.filter((file) => file.startsWith(RENDERER_PREFIX))
  const parent = new Map()
  const queue = []
  for (const root of roots) {
    if (!parent.has(root)) {
      parent.set(root, null)
      queue.push(root)
    }
  }
  while (queue.length > 0) {
    const current = queue.shift()
    const info = parsed.get(current)
    if (!info) continue
    for (const next of info.valueEdges) {
      if (parent.has(next) || !parsed.has(next)) continue
      parent.set(next, current)
      queue.push(next)
    }
  }

  const offenders = []
  for (const [file] of parent) {
    const info = parsed.get(file)
    if (!info || info.namedBuiltinImports.length === 0) continue
    const chain = []
    for (let node = file; node !== null; node = parent.get(node)) chain.push(relative(node))
    chain.reverse()
    offenders.push({ file, imports: info.namedBuiltinImports, chain })
  }

  if (offenders.length === 0) {
    console.log(
      `[renderer-bundle-guard] ok — ${parent.size} modules reachable from renderer, no named Node-builtin imports`
    )
    return
  }

  console.error(
    `[renderer-bundle-guard] FAIL — ${offenders.length} module(s) reachable from src/renderer via value imports carry NAMED Node-builtin imports.`
  )
  console.error(
    'The electron-vite CLIENT build will die at rollup bind on these (vitest/typecheck/dev all stay green — see cefa4b242).\n'
  )
  for (const offender of offenders.sort((a, b) => a.file.localeCompare(b.file))) {
    console.error(`  ${relative(offender.file)}`)
    for (const named of offender.imports) {
      console.error(
        `    line ${named.line}: { ${named.names.join(', ')} } from '${named.specifier}'`
      )
    }
    console.error(`    reachable via:\n      ${offender.chain.join('\n      -> ')}`)
  }
  console.error(
    '\nFix one of two ways: cut the renderer-reachable value-import edge (shared constants belong in src/shared,'
  )
  console.error(
    "not in main runtime modules), or namespace-import the builtin in the offending module (import * as nodeCrypto from 'node:crypto')"
  )
  console.error('and keep its members out of anything the renderer actually calls.')
  process.exit(1)
}

main()
