import { existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import ts from 'typescript'

const REPO_ROOT = resolve(process.cwd())
const HOST_NODE_ROOT = resolve(REPO_ROOT, 'src/host-node')
const HOST_RUNTIME_ROOT = resolve(REPO_ROOT, 'src/host-runtime')
const SHARED_ROOT = resolve(REPO_ROOT, 'src/shared')
const HOST_SHARED_ROOT = resolve(REPO_ROOT, 'src/host-shared')
const MAIN_MUSE_ROOT = resolve(REPO_ROOT, 'src/main/muse')
const ROOT_MODULES = [
  resolve(HOST_NODE_ROOT, 'HostNodeMuseProvider.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeProfileRunPort.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeDomainPorts.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeProductionServer.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeProductionFactory.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeMuseResources.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeMuseCatalog.ts'),
  resolve(HOST_NODE_ROOT, 'HostNodeMuseAuthHandoff.ts')
]

/** Deliberate production closure required by the Node Muse adapter. */
const PURE_MUSE_CLOSURE = new Set([
  'MuseCliArgs.ts',
  'MuseCronAssert.ts',
  'MuseExecJson.ts',
  'MuseIsolatedHome.ts',
  'MuseProbe.ts',
  'MuseRun.ts',
  'MuseSessionLog.ts',
  'MuseSkillPin.ts',
  'MuseToolProjection.ts',
  'MuseTypes.ts',
  'MuseUsage.ts'
])

function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !rel.includes('../'))
}

function resolveRelativeModule(containingFile: string, specifier: string): string {
  const base = resolve(dirname(containingFile), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  throw new Error(`Host Node boundary could not resolve ${specifier} from ${containingFile}`)
}

function moduleSpecifier(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
  return node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null
}

function collectImports(source: ts.SourceFile): Array<{ specifier: string; typeOnly: boolean }> {
  const imports: Array<{ specifier: string; typeOnly: boolean }> = []
  const forbiddenCalls: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = moduleSpecifier(node)
      if (specifier) {
        imports.push({
          specifier,
          typeOnly: ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true
        })
      }
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      forbiddenCalls.push(node.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (forbiddenCalls.length) {
    throw new Error(
      `Host Node Muse closure forbids dynamic import/require: ${forbiddenCalls.join(', ')}`
    )
  }
  return imports
}

describe('HostNode import boundary', () => {
  it('uses only Node, host-runtime/shared, and the pinned pure Muse closure', async () => {
    const pending = [...ROOT_MODULES]
    const visited = new Set<string>()
    while (pending.length) {
      const file = pending.pop()
      if (!file || visited.has(file)) continue
      visited.add(file)
      const sourceText = await readFile(file, 'utf8')
      expect(sourceText).not.toMatch(/from\s+['"]electron['"]|require\s*\(\s*['"]electron['"]\s*\)/)
      const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.ES2022, true)
      for (const imported of collectImports(source)) {
        if (imported.specifier.startsWith('node:')) continue
        if (!imported.specifier.startsWith('.')) {
          throw new Error(
            `Host Node Muse closure forbids external runtime import ${imported.specifier}`
          )
        }
        if (imported.typeOnly) continue
        const target = resolveRelativeModule(file, imported.specifier)
        if (
          isWithin(target, HOST_NODE_ROOT) ||
          isWithin(target, HOST_RUNTIME_ROOT) ||
          isWithin(target, SHARED_ROOT) ||
          isWithin(target, HOST_SHARED_ROOT)
        ) {
          pending.push(target)
          continue
        }
        if (
          isWithin(target, MAIN_MUSE_ROOT) &&
          PURE_MUSE_CLOSURE.has(relative(MAIN_MUSE_ROOT, target))
        ) {
          pending.push(target)
          continue
        }
        throw new Error(
          `Host Node Muse closure imports forbidden module ${relative(REPO_ROOT, target)}`
        )
      }
    }

    expect(
      [...visited]
        .filter((path) => isWithin(path, MAIN_MUSE_ROOT))
        .map((path) => relative(MAIN_MUSE_ROOT, path))
        .sort()
    ).toEqual([...PURE_MUSE_CLOSURE].sort())
  })
})
