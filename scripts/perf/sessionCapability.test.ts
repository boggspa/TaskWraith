import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  attachRendererCdpSession,
  attachMainInspectorSession
} = require('./cdpWebSocketSession.cjs')

/**
 * A DOUBLE MAY BE LESS CAPABLE THAN PRODUCTION, NEVER MORE.
 *
 * `sampleHostSpans` guarded on `session.post`; every test supplied
 * `{ post: async () => ... }`; the real `attachRendererCdpSession` returned
 * `{ send, onEvent, close }`. The double was more capable than the thing it
 * stood in for, so the guard was pinned against a shape nothing builds, the
 * collector refused every production renderer at its own guard, and
 * `metrics.crossThread` could not fold on any run — with a green suite
 * throughout.
 *
 * Enforced from the PRODUCTION side, which needs no registry of doubles: if
 * every real wrapper satisfies every verb any collector guards on, a double
 * cannot exceed production by having one of them. The doubles themselves are
 * still hand-written; centralising them is a separate, optional cleanup.
 *
 * The lesson underneath, for which this repo holds both examples side by side:
 * double the LOWEST layer you can and build everything above it for real. A
 * fake WebSocket (below) lets the real wrapper and the real collector both run;
 * a fake wrapper skips the only code that could disagree.
 */
/**
 * PER WRAPPER, and every entry is here because a guard in this tree demands it
 * — not because the two wrappers ought to look alike. They do not: the renderer
 * speaks a page CDP socket and the main inspector a Node one, and requiring
 * `send`/`onEvent` on the inspector would be inventing capability to satisfy a
 * test, which is the same sin as a double inventing it to satisfy a guard.
 *
 *   renderer_cdp    send/onEvent  cdpRendererCollector, frameCadenceTriage
 *                   post          hostSpans (the mismatch this test exists for)
 *                   close         runT2Baseline teardown
 *   main_inspector  post          mainPersistenceStatsCollector,
 *                                 nodeInspectorMainCollector, isolatedHome,
 *                                 frameCadenceTriage
 *                   close         runT2Baseline teardown
 */
const SESSION_CONTRACT = Object.freeze({
  renderer_cdp: Object.freeze(['send', 'onEvent', 'post', 'close']),
  main_inspector: Object.freeze(['post', 'close'])
})

/** Union, for the source scan: a guard naming anything else is unaccounted for. */
const SESSION_VERBS = Object.freeze([
  ...new Set([...SESSION_CONTRACT.renderer_cdp, ...SESSION_CONTRACT.main_inspector])
])

class RepliesToAnything {
  handlers: Record<string, (arg?: unknown) => void> = {}
  constructor() {
    queueMicrotask(() => this.handlers.open && this.handlers.open())
  }
  on(event: string, handler: (arg?: unknown) => void) {
    this.handlers[event] = handler
  }
  send(data: string) {
    const msg = JSON.parse(data)
    queueMicrotask(() => this.handlers.message(JSON.stringify({ id: msg.id, result: {} })))
  }
  close() {
    /* the fake socket owns no resources */
  }
}

function perfSources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...perfSources(full))
    else if (entry.name.endsWith('.cjs') && !entry.name.endsWith('.test.cjs')) out.push(full)
  }
  return out
}

describe('CDP session capability contract', () => {
  it('every real session wrapper exposes every verb in the contract', async () => {
    const renderer = await attachRendererCdpSession({
      port: 9,
      WebSocket: RepliesToAnything,
      adapters: {
        httpGetJson: async (url: string) =>
          String(url).includes('/json/version')
            ? { Browser: 'Fake/1' }
            : [
                {
                  type: 'page',
                  id: 'p1',
                  webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/p1'
                }
              ]
      }
    })
    const mainInspector = await attachMainInspectorSession({
      webSocketDebuggerUrl: 'ws://127.0.0.1:9/abc',
      WebSocket: RepliesToAnything
    })

    for (const [kind, wrapper] of [
      ['renderer_cdp', renderer],
      ['main_inspector', mainInspector]
    ] as const) {
      const missing = SESSION_CONTRACT[kind].filter(
        (verb) => typeof (wrapper as Record<string, unknown>)[verb] !== 'function'
      )
      // Reported as an object so a failure names the wrapper AND the verb.
      expect({ kind, missing }).toEqual({ kind, missing: [] })
    }
    renderer.close()
    mainInspector.close()
  })

  it('no collector guards on a session verb outside the contract', () => {
    // Globbed, not listed: a NEW collector is covered the day it is written,
    // which is the difference between a convention and a one-off correction.
    const guard = /typeof\s+([A-Za-z_$][\w$]*)\.([\w$]+)\s*!==\s*'function'/g
    const offenders: Array<{ file: string; identifier: string; verb: string }> = []
    for (const file of perfSources(__dirname)) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(guard)) {
        const [, identifier, verb] = match
        if (!/session|inspector/i.test(identifier)) continue
        if (SESSION_VERBS.includes(verb)) continue
        offenders.push({ file: path.relative(__dirname, file), identifier, verb })
      }
    }
    expect(offenders).toEqual([])
  })
})
