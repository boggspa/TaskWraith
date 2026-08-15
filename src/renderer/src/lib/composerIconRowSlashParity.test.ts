import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { COMPOSER_SURFACE_IDS } from './composerSurfaceRequest'

/**
 * The composer's icon row (`.composer-telemetry-cluster`) and the slash picker
 * are two doors onto the same set of actions. A control that grows there and
 * never gets a command leaves keyboard users without it, which is how /canvas,
 * /terminal, /plan, /schedule, /blackboard, /multiview and /ensemble all came
 * to be missing at once.
 *
 * `buildScopedComposerSlashExtraCommands` lives inside the App component and
 * closes over its state, so it cannot be imported. This reads the declarations
 * out of the source instead — the same approach
 * `multiviewPaneComposerParity.test.ts` takes for the pane context.
 */

interface ExtraCommandInventory {
  /** Commands offered in every chat. */
  unconditional: string[]
  /** Commands inside an `isEnsembleChat ? [...] : []` spread. */
  ensembleOnly: string[]
}

function readExtraCommandInventory(): ExtraCommandInventory {
  const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
  const sourceFile = ts.createSourceFile(
    'App.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )

  let builderBody: ts.ArrayLiteralExpression | null = null
  const findBuilder = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'buildScopedComposerSlashExtraCommands' &&
      node.initializer &&
      ts.isArrowFunction(node.initializer) &&
      ts.isArrayLiteralExpression(node.initializer.body)
    ) {
      builderBody = node.initializer.body
    }
    ts.forEachChild(node, findBuilder)
  }
  findBuilder(sourceFile)
  if (!builderBody) throw new Error('buildScopedComposerSlashExtraCommands not found in App.tsx')

  const commandOf = (node: ts.Node): string | null => {
    if (!ts.isObjectLiteralExpression(node)) return null
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      if (!ts.isIdentifier(property.name) || property.name.text !== 'command') continue
      const value = property.initializer
      if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text
    }
    return null
  }

  const unconditional: string[] = []
  const ensembleOnly: string[] = []
  for (const element of (builderBody as ts.ArrayLiteralExpression).elements) {
    if (!ts.isSpreadElement(element)) {
      const command = commandOf(element)
      if (command) unconditional.push(command)
      continue
    }
    // `...(isEnsembleChat ? [ … ] : [])`
    const spread = element.expression
    const conditional = ts.isParenthesizedExpression(spread) ? spread.expression : spread
    if (!ts.isConditionalExpression(conditional)) continue
    const guard = conditional.condition.getText()
    if (!guard.includes('isEnsembleChat')) continue
    if (!ts.isArrayLiteralExpression(conditional.whenTrue)) continue
    for (const entry of conditional.whenTrue.elements) {
      const command = commandOf(entry)
      if (command) ensembleOnly.push(command)
    }
  }
  return { unconditional, ensembleOnly }
}

describe('composer icon row ↔ slash command parity', () => {
  const inventory = readExtraCommandInventory()
  const all = [...inventory.unconditional, ...inventory.ensembleOnly]

  it('offers a command for every icon-row control that has a behaviour', () => {
    // Ordered as the row renders, left to right. The above-rows minimize toggle
    // is deliberately absent: it is view chrome with no state a command could
    // meaningfully report or change.
    for (const command of [
      '/ensemble', // ComposerEnsembleToggleButton
      '/screen', // Screen Watch
      '/terminal', // workspace terminal
      '/goal', // goal popover
      '/schedule', // ComposerScheduleButton
      '/plan', // ComposerPlanPopoverButton
      '/blackboard', // ComposerBlackboardButton (ensemble-only)
      '/copy-transcript', // CopyTranscriptButton
      '/multiview', // MultiviewLayoutPicker
      '/canvas' // CanvasComposerButton
    ]) {
      expect(all).toContain(command)
    }
  })

  it('gates the ensemble-only surfaces so a solo chat is not offered dead commands', () => {
    // The blackboard exists only on an ensemble chat, and /discuss's prefix is
    // only stripped by EnsembleOrchestrator at startRound — in a solo chat it
    // would be sent to the provider as literal text.
    expect(inventory.ensembleOnly).toContain('/blackboard')
    expect(inventory.ensembleOnly).toContain('/discuss')
    expect(inventory.unconditional).not.toContain('/blackboard')
    expect(inventory.unconditional).not.toContain('/discuss')
  })

  it('no longer offers /meta', () => {
    // Retired as a picker entry: steering a panel onto TaskWraith itself is a
    // harness-development gesture, and /discuss already covers the mode. The
    // orchestrator still accepts a hand-typed /meta.
    expect(all).not.toContain('/meta')
  })

  it('keeps /plan and /import-plan distinct', () => {
    // /plan shows the live todo lanes; /import-plan reviews a pasted plan.
    // Collapsing them would silently change what the icon's command does.
    expect(all).toContain('/plan')
    expect(all).toContain('/import-plan')
  })

  it('names every command token exactly once', () => {
    expect(all).toHaveLength(new Set(all).size)
  })

  it('routes each popover-backed surface through a declared surface id', () => {
    const source = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    for (const surface of COMPOSER_SURFACE_IDS) {
      expect(source).toContain(`handleComposerSurfaceCommand(ctx, '${surface}')`)
    }
  })
})
