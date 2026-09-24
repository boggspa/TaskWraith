import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = resolve(process.cwd())
const CORE_FILES = [
  'src/main/services/RunCoordinator.ts',
  'src/main/run/RunDispatchFacade.ts',
  'src/main/RunEventBus.ts'
]

function runtimeImports(path: string, source: string): string[] {
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
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return specifiers
}

describe('Host run event boundary', () => {
  it('keeps core dispatch and event-bus modules free of Electron imports', async () => {
    const violations = (
      await Promise.all(
        CORE_FILES.map(async (relativePath) => {
          const source = await readFile(resolve(REPO_ROOT, relativePath), 'utf8')
          return runtimeImports(relativePath, source)
            .filter((specifier) => specifier === 'electron' || specifier.startsWith('electron/'))
            .map((specifier) => `${relativePath} -> ${specifier}`)
        })
      )
    ).flat()

    expect(violations).toEqual([])
  })
})
