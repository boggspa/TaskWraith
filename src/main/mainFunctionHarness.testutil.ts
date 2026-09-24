import ts from 'typescript'
import type { MainSourceProbe } from './mainSourceProbe.testutil'

/**
 * Runs named top-level functions lifted out of a main-process source file,
 * for behaviour that lives only in `src/main/index.ts`.
 *
 * `MainSourceProbe` can prove where a statement sits, not what it does. A
 * refusal branch can be pinned in place while it keeps the setup guard, leaves
 * the transport open, drops `setupRequired` or shows the wrong sentence, and
 * every structural assertion stays green. This takes the real source text of
 * the named functions, transpiles exactly that text, and evaluates it in a
 * scope where every other free identifier is a stub the test supplies.
 *
 * An identifier the lifted source reaches without a stub THROWS, naming it.
 * That is deliberate, for the same reason `MainSourceProbe.fn` throws: a
 * permissive default would let a test pass over code it never ran. Real
 * globals (`Promise`, `Date`, `process`, ...) resolve normally unless stubbed.
 */
export function liftMainFunctions<T>(
  probe: MainSourceProbe,
  names: readonly string[],
  stubs: Record<string, unknown>
): T {
  const parts = names.map((name) => {
    const declaration = probe.source.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name
    )
    if (!declaration?.body) {
      throw new Error(
        `${probe.source.fileName} declares no top-level function \`${name}\`. It was renamed, ` +
          'moved or deleted — update this test to the claim that replaced it.'
      )
    }
    return probe.text(declaration)
  })
  const code = ts
    .transpileModule(parts.join('\n\n'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }
    })
    .outputText.replace(/^"use strict";\s*/, '')

  const scope = new Proxy(stubs, {
    has: () => true,
    get(target, key) {
      if (key === Symbol.unscopables) return undefined
      if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(target, key)) {
        return target[key]
      }
      if (key in globalThis) return (globalThis as Record<PropertyKey, unknown>)[key]
      throw new ReferenceError(
        `The lifted ${names.join(', ')} reached \`${String(key)}\`, which has no stub. ` +
          'Add one that records what the code does with it.'
      )
    },
    set(target, key, value) {
      target[key as string] = value
      return true
    }
  })
  // A `with` scope is the only way to hand a stub to a free identifier in
  // source that was never written to take one; it needs sloppy mode, which a
  // Function body gets.
  const evaluate = new Function(
    'scope',
    `with (scope) {\n${code}\nreturn { ${names.join(', ')} }\n}`
  ) as (scope: object) => T
  return evaluate(scope)
}
