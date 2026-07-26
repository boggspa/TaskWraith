import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { PROVIDER_ADAPTER_REGISTRATION_IDS } from './ProviderAdapters'
import type { ProviderId } from './store/types'

/**
 * The production adapter registry is built at module scope in src/main/index.ts
 * and asserts its own completeness there. That assertion is real, but it fires
 * during main-process import: an identity added to the baseline without an
 * adapter does not fail a run, it makes the app un-launchable behind Electron's
 * "A JavaScript error occurred in the main process" dialog, before any window,
 * logger or error boundary exists to say why.
 *
 * index.ts cannot be imported by a test (it calls into Electron at load), so
 * this guard parses it instead and walks the registry argument the way the
 * runtime would: object literals contribute their `defaultProviderDescriptor`
 * identity, spread identifiers resolve to their array declarations and recurse.
 *
 * Reachability from the call is the whole point. The text-scan version of this
 * claim only checked that `defaultProviderDescriptor('x')` appeared somewhere
 * in a source region, so an adapter array that was declared and never spread
 * into the call read as registered — which is exactly the shape that reaches a
 * developer as a startup crash rather than a red test.
 */

const REGISTRY_FACTORY = 'createProviderAdapterRegistry'
const DESCRIPTOR_FACTORY = 'defaultProviderDescriptor'

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
}

function describeNode(source: ts.SourceFile, node: ts.Node): string {
  const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
  return `${source.fileName}:${line + 1}`
}

/** The single module-scope `createProviderAdapterRegistry([...], {...})` call. */
function findRegistryCall(source: ts.SourceFile): ts.CallExpression {
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === REGISTRY_FACTORY
    ) {
      calls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  if (calls.length !== 1) {
    throw new Error(
      `expected exactly one ${REGISTRY_FACTORY}(...) call in ${source.fileName}, found ${calls.length}`
    )
  }
  return calls[0]
}

/** `const <name>: ProviderAdapter<...>[] = [...]` at module scope. */
function resolveAdapterArray(source: ts.SourceFile, name: string): ts.ArrayLiteralExpression {
  let found: ts.ArrayLiteralExpression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      found = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  if (!found) {
    throw new Error(`spread \`...${name}\` has no array declaration in ${source.fileName}`)
  }
  return found
}

/** `...defaultProviderDescriptor('<id>')` — the identity every adapter opens with. */
function adapterProviderId(source: ts.SourceFile, adapter: ts.ObjectLiteralExpression): string {
  for (const property of adapter.properties) {
    if (!ts.isSpreadAssignment(property)) continue
    const call = property.expression
    if (
      !ts.isCallExpression(call) ||
      !ts.isIdentifier(call.expression) ||
      call.expression.text !== DESCRIPTOR_FACTORY
    ) {
      continue
    }
    const [arg] = call.arguments
    if (arg && ts.isStringLiteralLike(arg)) return arg.text
  }

  // Never fall through to "skip": an adapter this walk cannot read is one it
  // would silently report as absent — or, worse, one whose absence it would
  // stop noticing. Fail here and teach the guard the new shape instead.
  throw new Error(
    `adapter at ${describeNode(source, adapter)} does not open with ` +
      `...${DESCRIPTOR_FACTORY}('<provider>'); this guard reads registration through that ` +
      'spread — extend it if the shape changed'
  )
}

/** Provider ids reachable from the registry call, in registration order. */
function collectRegisteredProviderIds(
  source: ts.SourceFile,
  elements: ts.NodeArray<ts.Expression>
): string[] {
  const registered: string[] = []
  for (const element of elements) {
    if (ts.isObjectLiteralExpression(element)) {
      registered.push(adapterProviderId(source, element))
      continue
    }
    if (ts.isSpreadElement(element) && ts.isIdentifier(element.expression)) {
      const array = resolveAdapterArray(source, element.expression.text)
      registered.push(...collectRegisteredProviderIds(source, array.elements))
      continue
    }
    throw new Error(
      `unreadable registry entry at ${describeNode(source, element)}: this guard resolves object ` +
        'literals and spreads of module-scope adapter arrays — extend it if the shape changed'
    )
  }
  return registered
}

function registeredProviderIds(source: ts.SourceFile): string[] {
  const [adapters] = findRegistryCall(source).arguments
  if (!adapters || !ts.isArrayLiteralExpression(adapters)) {
    throw new Error(`${REGISTRY_FACTORY} was not called with an array literal of adapters`)
  }
  return collectRegisteredProviderIds(source, adapters.elements)
}

function completenessAssertionArmed(source: ts.SourceFile): boolean {
  const options = findRegistryCall(source).arguments[1]
  if (!options || !ts.isObjectLiteralExpression(options)) return false
  return options.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      property.name.getText(source) === 'requireCompleteProviderSet' &&
      property.initializer.kind === ts.SyntaxKind.TrueKeyword
  )
}

const productionSource = parse(
  'src/main/index.ts',
  readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
)

describe('production provider adapter registration site', () => {
  it('registers exactly one reachable adapter per registration-baseline identity', () => {
    const registered = registeredProviderIds(productionSource)

    // Set equality, not containment, and in both directions: an unaccounted
    // adapter throws at the same module-scope assertion a missing one does.
    expect([...registered].sort()).toEqual([...PROVIDER_ADAPTER_REGISTRATION_IDS].sort())
    expect(new Set(registered).size, `duplicate adapter registration: ${registered}`).toBe(
      registered.length
    )
  })

  it('keeps the runtime completeness assertion armed at the production call site', () => {
    // Source-reading only. The runtime assertion is what protects a shipped
    // build, so disarming it must fail here rather than quietly widen what a
    // release is allowed to boot with.
    expect(
      completenessAssertionArmed(productionSource),
      'requireCompleteProviderSet: true is missing from the production registry'
    ).toBe(true)
  })

  it('exposes the baseline as concrete provider identities', () => {
    // If the baseline ever widened to string[], set equality above would still
    // pass while meaning considerably less.
    const baseline: readonly ProviderId[] = PROVIDER_ADAPTER_REGISTRATION_IDS
    expect(baseline.length).toBeGreaterThan(0)
    expect(new Set(baseline).size).toBe(baseline.length)
  })
})

/**
 * A guard nobody has watched fail is a guard nobody should trust. These drive
 * the same walk over synthetic sources carrying each mistake it exists to
 * catch, so the passing result above is evidence rather than an assumption.
 */
describe('registration-site guard fails on the mistakes it exists to catch', () => {
  const declarations = `
    const grokAdapters = [{ ...defaultProviderDescriptor('grok'), run: async () => {} }]
    const mistralAdapters = [{ ...defaultProviderDescriptor('mistral'), run: async () => {} }]
  `

  it('does not credit an adapter array that is declared but never spread', () => {
    const source = parse(
      'declared-not-spread.ts',
      `${declarations}
       const providerAdapters = ${REGISTRY_FACTORY}([
         { ...defaultProviderDescriptor('claude'), run: async () => {} },
         ...grokAdapters
       ], { requireCompleteProviderSet: true })`
    )

    // The exact regression: `mistralAdapters` exists, and the old text scan
    // found defaultProviderDescriptor('mistral') in the file, but nothing
    // reaches it from the registry call.
    expect(registeredProviderIds(source)).toEqual(['claude', 'grok'])
  })

  it('follows spreads into their arrays rather than counting the spread itself', () => {
    const source = parse(
      'spread-resolved.ts',
      `${declarations}
       const providerAdapters = ${REGISTRY_FACTORY}([
         { ...defaultProviderDescriptor('claude'), run: async () => {} },
         ...grokAdapters,
         ...mistralAdapters
       ], { requireCompleteProviderSet: true })`
    )

    expect(registeredProviderIds(source)).toEqual(['claude', 'grok', 'mistral'])
  })

  it('reports a disarmed completeness assertion', () => {
    const armed = (options: string): boolean =>
      completenessAssertionArmed(
        parse('options.ts', `const r = ${REGISTRY_FACTORY}([], ${options})`)
      )

    expect(armed('{ requireCompleteProviderSet: true }')).toBe(true)
    expect(armed('{ requireCompleteProviderSet: false }')).toBe(false)
    expect(armed('{}')).toBe(false)
  })

  it('refuses an entry shape it cannot statically resolve', () => {
    const source = parse(
      'unreadable-entry.ts',
      `const providerAdapters = ${REGISTRY_FACTORY}([...buildAdapters()], {})`
    )

    expect(() => registeredProviderIds(source)).toThrow(/unreadable registry entry/)
  })

  it('refuses an adapter that does not declare its identity through the descriptor spread', () => {
    const source = parse(
      'untagged-adapter.ts',
      `const providerAdapters = ${REGISTRY_FACTORY}([{ provider: 'claude' }], {})`
    )

    expect(() => registeredProviderIds(source)).toThrow(/does not open with/)
  })
})
