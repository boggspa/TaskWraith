import { readdir, readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const TUI_ROOT = resolve(process.cwd(), 'src/tui')
const MAIN_ROOT = resolve(process.cwd(), 'src/main')

function isProductionSource(name: string): boolean {
  return name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.spec.ts')
}

async function productionTuiFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const children = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return productionTuiFiles(path)
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

function resolvesInsideMain(importer: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false
  const resolved = resolve(dirname(importer), specifier)
  const pathFromMain = relative(MAIN_ROOT, resolved)
  return pathFromMain === '' || (!pathFromMain.startsWith('..') && !pathFromMain.includes('/../'))
}

describe('TUI Host client boundary', () => {
  it('keeps production TUI sources independent from src/main', async () => {
    const importers = await productionTuiFiles(TUI_ROOT)
    const violations = (
      await Promise.all(
        importers.map(async (importer) => {
          const source = await readFile(importer, 'utf8')
          return runtimeModuleSpecifiers(importer, source)
            .filter((specifier) => resolvesInsideMain(importer, specifier))
            .map((specifier) => `${relative(process.cwd(), importer)} -> ${specifier}`)
        })
      )
    ).flat()

    expect(violations).toEqual([])
  })
})
