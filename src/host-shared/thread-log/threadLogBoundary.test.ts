/**
 * The Host reads a thread's log through this directory, and the Host may not
 * import the Electron main process, the renderer or the terminal app. The
 * Host runtime's own boundary test checks only the imports written in its
 * files, not what those files pull in, so the closure is checked here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(process.cwd())
const THREAD_LOG_ROOT = resolve(REPO_ROOT, 'src/host-shared/thread-log')
const ALLOWED_ROOTS = [resolve(REPO_ROOT, 'src/host-shared'), resolve(REPO_ROOT, 'src/shared')]

function isProductionSource(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.testutil.ts')
}

function isWithin(path: string, root: string): boolean {
  const fromRoot = relative(root, path)
  return fromRoot === '' || (!fromRoot.startsWith('..') && !fromRoot.includes('../'))
}

function importSpecifiers(file: string, text = readFileSync(file, 'utf8')): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const [argument] = node.arguments
      // A computed target cannot be audited, so it is not allowed at all.
      specifiers.push(argument && ts.isStringLiteralLike(argument) ? argument.text : '<computed>')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

function resolveRelative(importer: string, specifier: string): string {
  const base = resolve(dirname(importer), specifier)
  for (const candidate of [base, `${base}.ts`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  throw new Error(`Cannot resolve ${specifier} from ${relative(REPO_ROOT, importer)}`)
}

/** Every import the given modules reach, as `importer -> target` for the ones not allowed. */
function closureViolations(roots: readonly string[]): { visited: string[]; violations: string[] } {
  const pending = [...roots]
  const visited = new Set<string>()
  const violations: string[] = []
  while (pending.length > 0) {
    const file = pending.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    for (const specifier of importSpecifiers(file)) {
      if (specifier.startsWith('node:')) continue
      const edge = `${relative(REPO_ROOT, file)} -> ${specifier}`
      if (!specifier.startsWith('.')) {
        violations.push(edge)
        continue
      }
      const target = resolveRelative(file, specifier)
      if (ALLOWED_ROOTS.some((root) => isWithin(target, root))) pending.push(target)
      else violations.push(edge)
    }
  }
  return {
    visited: [...visited].map((file) => relative(REPO_ROOT, file).split(sep).join('/')).sort(),
    violations
  }
}

describe('thread-log import boundary', () => {
  const modules = readdirSync(THREAD_LOG_ROOT)
    .filter(isProductionSource)
    .map((name) => resolve(THREAD_LOG_ROOT, name))

  it('audits the modules the Host is meant to import', () => {
    // A scan that found nothing would pass vacuously.
    expect(modules.map((file) => relative(THREAD_LOG_ROOT, file))).toEqual(
      expect.arrayContaining(['ThreadLogApply.ts', 'ThreadLogBatch.ts'])
    )
  })

  it('reaches only Node builtins, host-shared and shared, through every import', () => {
    const { visited, violations } = closureViolations(modules)
    expect(violations).toEqual([])
    expect(visited).toEqual(
      expect.arrayContaining([
        'src/host-shared/thread-log/ThreadLogApply.ts',
        'src/host-shared/thread-log/ThreadLogBatch.ts'
      ])
    )
  })

  it('would report an import of the main process, a package or a computed target', () => {
    // The rule itself, exercised on sources known to break it.
    expect(
      importSpecifiers(
        'probe.ts',
        "const a = await import(name); const b = require(target); export * from 'electron'"
      )
    ).toEqual(['<computed>', '<computed>', 'electron'])
    const mainImporter = resolve(REPO_ROOT, 'src/main/store/ChatRecordMutation.ts')
    expect(closureViolations([mainImporter]).violations).toEqual(
      expect.arrayContaining(['src/main/store/ChatRecordMutation.ts -> ./types'])
    )
    const packageImporter = resolve(THREAD_LOG_ROOT, 'threadLogBoundary.test.ts')
    expect(closureViolations([packageImporter]).violations).toEqual(
      expect.arrayContaining([
        'src/host-shared/thread-log/threadLogBoundary.test.ts -> typescript',
        'src/host-shared/thread-log/threadLogBoundary.test.ts -> vitest'
      ])
    )
  })
})
