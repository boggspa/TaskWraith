import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(process.cwd())
const HOST_RUNTIME_ROOT = resolve(REPO_ROOT, 'src/host-runtime')
const FORBIDDEN_SOURCE_ROOTS = [
  resolve(REPO_ROOT, 'src/main'),
  resolve(REPO_ROOT, 'src/renderer'),
  resolve(REPO_ROOT, 'src/tui')
]

function isProductionSource(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.spec.ts')
}

async function productionHostRuntimeFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const children = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return productionHostRuntimeFiles(path)
      return entry.isFile() && isProductionSource(entry.name) ? [path] : []
    })
  )
  return children.flat()
}

function runtimeModuleSpecifiers(path: string, source: string): string[] {
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
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
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return specifiers
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  )
}

function forbiddenImport(importer: string, specifier: string): boolean {
  if (specifier === 'electron' || specifier.startsWith('electron/')) return true
  if (!specifier.startsWith('.')) return false
  const resolved = resolve(dirname(importer), specifier)
  return FORBIDDEN_SOURCE_ROOTS.some((root) => isInside(root, resolved))
}

describe('standalone Host runtime boundary', () => {
  it('does not import Electron or presentation/composition roots', async () => {
    const files = await productionHostRuntimeFiles(HOST_RUNTIME_ROOT)
    const violations = (
      await Promise.all(
        files.map(async (file) => {
          const source = await readFile(file, 'utf8')
          return runtimeModuleSpecifiers(file, source)
            .filter((specifier) => forbiddenImport(file, specifier))
            .map((specifier) => `${relative(REPO_ROOT, file)} -> ${specifier}`)
        })
      )
    ).flat()

    expect(violations).toEqual([])
  })
})
