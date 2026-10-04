import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { MainSourceProbe } from './mainSourceProbe.testutil'

/**
 * Wiring only. The ordered pump's behaviour — arrival order behind a deferred
 * remainder, flush, the backlog bound — is tested against real inputs in
 * providers/CooperativeStreamPump.test.ts. index.ts cannot be imported, so
 * these assert that each provider launch in it actually routes its stdout
 * through one pump and flushes that pump before its terminal path.
 */
const probe = new MainSourceProbe('index.ts', new URL('./index.ts', import.meta.url))

/** The callback passed to `<receiver>.on('<event>', callback)` inside `scope`. */
function listener(scope: ts.Node, receiver: string, event: string): ts.ArrowFunction {
  const matches = probe
    .callsTo(scope, 'on')
    .filter(
      (call) =>
        ts.isPropertyAccessExpression(call.expression) &&
        probe.text(call.expression.expression) === receiver &&
        probe.argText(call, 0) === `'${event}'`
    )
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ${receiver}.on('${event}', …) listener, found ${matches.length}`
    )
  }
  const callback = matches[0].arguments[1]
  if (!callback || !ts.isArrowFunction(callback)) {
    throw new Error(`${receiver}.on('${event}', …) does not take an inline arrow function`)
  }
  return callback
}

function firstStatementText(callback: ts.ArrowFunction): string {
  if (!ts.isBlock(callback.body) || callback.body.statements.length === 0) {
    throw new Error('listener has no block body to read a first statement from')
  }
  return probe.text(callback.body.statements[0])
}

/** The one pump constructed inside `scope`, and the name it is bound to. */
function onlyPump(scope: ts.Node): { call: ts.CallExpression; name: string } {
  const calls = probe.callsTo(scope, 'createOrderedStreamPump')
  expect(calls).toHaveLength(1)
  const declaration = calls[0].parent
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) {
    throw new Error('createOrderedStreamPump(…) is not bound to a named const')
  }
  return { call: calls[0], name: declaration.name.text }
}

describe('provider stdout reaches its handler through one ordered pump', () => {
  it('generic CLI providers: the stdout listener only queues, and close flushes first', () => {
    const runner = probe.fn('runCliProviderProcess')
    const pump = onlyPump(runner)
    expect(probe.propText(pump.call, 0, 'label')).toBe('provider')
    expect(probe.propText(pump.call, 0, 'source')).toBe('child.stdout')

    // The line handler lives in the pump's visit, never in the stream listener:
    // a listener that handled lines itself would run ahead of a deferred turn.
    const onData = listener(runner, 'child.stdout', 'data')
    expect(probe.callsTo(onData, 'pushAll').map((call) => probe.text(call))).toEqual([
      `${pump.name}.pushAll(lines)`
    ])
    expect(probe.callsTo(onData, 'handleCliProviderJsonEvent')).toHaveLength(0)
    expect(probe.callsTo(onData, 'emitPlainAssistantContent')).toHaveLength(0)

    // `close` reads state the stdout lines set (terminalResultFailed, the
    // assistant text) and then awaits; the flush has to precede all of it.
    expect(firstStatementText(listener(runner, 'child', 'close'))).toBe(`${pump.name}.flush()`)
  })

  // This one forwards whole chunks: a per-run sanitizer holds the partial line
  // and the terminal path flushes it, so the pump has to be emptied into the
  // sanitizer before that flush or the run's last output is lost behind it.
  it('Codex exec fallback: the stdout listener only queues, and close flushes first', () => {
    const runner = probe.fn('runCodexExecFallback')
    const pump = onlyPump(runner)
    expect(probe.propText(pump.call, 0, 'label')).toBe("'codex-exec'")
    expect(probe.propText(pump.call, 0, 'source')).toBe('child.stdout')
    expect(probe.propText(pump.call, 0, 'visit')).toBe(
      '(text) => emitCodexExecStdout(codexExecStdoutSanitizer.push(text))'
    )

    // `push` is also the sanitizer's verb: a listener that still fed the
    // sanitizer itself would show up here as a second call.
    const onData = listener(runner, 'child.stdout', 'data')
    expect(probe.callsTo(onData, 'push').map((call) => probe.text(call))).toEqual([
      `${pump.name}.push(data.toString())`
    ])
    expect(probe.callsTo(onData, 'emitCodexExecStdout')).toHaveLength(0)

    expect(firstStatementText(listener(runner, 'child', 'close'))).toBe(`${pump.name}.flush()`)
  })
})
