import { readFileSync } from 'node:fs'
import ts from 'typescript'

/**
 * Structural probe over a main-process source file, for tests that cannot
 * import their subject.
 *
 * `src/main/index.ts` reaches into Electron at load, so nothing under test can
 * import it. The established workaround is a text scan: slice the source
 * between two literals and assert `toContain` on the slice. That has failed
 * twice in one afternoon — `authorizeBeforeAdapterRun: (payload, reservation)
 * => {` became a named reference, and an inline `runManager.finish(...)` moved
 * into a shared helper — and neither failure described a real regression.
 *
 * The loud direction is the tolerable one. The dangerous direction is a scan
 * that keeps passing after its subject moves: `sourceBetween` markers that
 * still resolve over a region that no longer contains the thing being claimed,
 * so the test reports green while asserting nothing. Anchoring on declared
 * names and call structure removes that failure mode — a renamed or deleted
 * subject throws here rather than quietly passing.
 *
 * This probe proves WIRING only, which is all a non-importable module can
 * offer. Where the behaviour itself lives in an importable module, test it
 * there against real inputs and let this assert only that production reaches
 * it. The durable fix for any given claim is to extract its subject out of
 * index.ts so it can be called directly.
 */
export class MainSourceProbe {
  readonly source: ts.SourceFile

  constructor(fileName: string, url: URL) {
    this.source = ts.createSourceFile(
      fileName,
      readFileSync(url, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
  }

  /** Probe over source text, for exercising the probe itself. */
  static fromText(fileName: string, text: string): MainSourceProbe {
    const probe = Object.create(MainSourceProbe.prototype) as {
      -readonly [K in keyof MainSourceProbe]: MainSourceProbe[K]
    }
    probe.source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
    return probe as MainSourceProbe
  }

  text(node: ts.Node): string {
    return node.getText(this.source)
  }

  /**
   * Body of a top-level `function name(...)` or `const name = (...) => ...`.
   * Throws when the name is absent — a probe that cannot find its subject must
   * never report the absence as a satisfied claim.
   */
  fn(name: string): ts.Node {
    let found: ts.Node | undefined
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) {
        found = node.body
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        found = node.initializer.body
      }
      ts.forEachChild(node, visit)
    }
    visit(this.source)

    if (!found) {
      throw new Error(
        `${this.source.fileName} declares no function \`${name}\`. It was renamed, moved or ` +
          'deleted — update this test to the claim that replaced it rather than deleting the assertion.'
      )
    }
    return found
  }

  /** Calls to `name(...)` or `x.name(...)` anywhere inside `scope`. */
  callsTo(scope: ts.Node, name: string): ts.CallExpression[] {
    const calls: ts.CallExpression[] = []
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const matches =
          (ts.isIdentifier(callee) && callee.text === name) ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === name)
        if (matches) calls.push(node)
      }
      ts.forEachChild(node, visit)
    }
    visit(scope)
    return calls
  }

  /** Source text of a positional argument, whitespace-normalized. */
  argText(call: ts.CallExpression, index: number): string {
    const arg = call.arguments[index]
    if (!arg) throw new Error(`call has no argument at index ${index}: ${this.text(call)}`)
    return this.text(arg).replace(/\s+/g, ' ')
  }

  /**
   * Initializer text of `prop` in an object-literal argument. Order-independent
   * and formatting-independent, unlike matching `prop: value` as a substring.
   */
  propText(call: ts.CallExpression, argIndex: number, prop: string): string | null {
    const arg = call.arguments[argIndex]
    if (!arg || !ts.isObjectLiteralExpression(arg)) return null
    for (const property of arg.properties) {
      if (ts.isPropertyAssignment(property) && property.name.getText(this.source) === prop) {
        return this.text(property.initializer).replace(/\s+/g, ' ')
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === prop) {
        return prop
      }
    }
    return null
  }

  /** Right-hand sides of every `target = ...` assignment inside `scope`. */
  assignmentsTo(scope: ts.Node, target: string): string[] {
    const values: string[] = []
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        this.text(node.left).replace(/\s+/g, '') === target
      ) {
        values.push(this.text(node.right).replace(/\s+/g, ' '))
      }
      ts.forEachChild(node, visit)
    }
    visit(scope)
    return values
  }

  /** Whether `scope` compares `a !== b` (either operand order). */
  comparesStrictly(scope: ts.Node, a: string, b: string): boolean {
    let found = false
    const normalize = (node: ts.Node): string => this.text(node).replace(/\s+/g, '')
    const visit = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      ) {
        const left = normalize(node.left)
        const right = normalize(node.right)
        if ((left === a && right === b) || (left === b && right === a)) found = true
      }
      ts.forEachChild(node, visit)
    }
    visit(scope)
    return found
  }
}
