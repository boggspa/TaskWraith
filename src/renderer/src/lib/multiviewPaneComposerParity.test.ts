import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'

function paneComposerContextKeys(source: string): string[][] {
  const sourceFile = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const contexts: string[][] = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'paneComposerCtx' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      const keys = node.initializer.properties.flatMap((property) => {
        if (ts.isSpreadAssignment(property)) return []
        if (!property.name) return []
        if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
          return [property.name.text]
        }
        return []
      })
      contexts.push([...new Set(keys)].sort())
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return contexts
}

describe('Multiview pane Composer context parity', () => {
  it('keeps the live fallback and memoized builder on the same explicit prop surface', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    const contexts = paneComposerContextKeys(source)

    expect(contexts).toHaveLength(2)
    expect(contexts[0]).toEqual(contexts[1])
  })

  it('derives linked-child state from each pane chat instead of forcing it on', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')

    expect(source).not.toContain('isCurrentChatLinkedChild: true')
    expect(source.match(/isCurrentChatLinkedChild: Boolean\(viewerChat\.parentChatId\)/g)).toHaveLength(
      2
    )
  })
})
