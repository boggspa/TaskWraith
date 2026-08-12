/**
 * Host Arc Wave 3.6d — HostProductionAuthorityEvaluator tests.
 *
 * BOUNDARIES (R5 mandatory test pins):
 * - (1) Exhaustive table: every HostCommandName → justified decision + kind
 * - (2) Same command: clientClass 'ios' never more permissive than 'desktop'
 * - (3) Unknown command name ⇒ denied, RED-proved
 * - (4) Import isolation (Electron-free; zero AppStore/Bridge/store/
 *       resolver/pipeline value imports)
 * - (5) clientClass ordering: remote never more permissive than local (C5)
 *
 * R5 C1: allow-all shape () => ({decision:'allowed'}) is FORBIDDEN
 *        in production — the test below PROVES denial on unknowns.
 */

/* eslint-disable @typescript-eslint/no-require-imports -- source-isolation probes intentionally load Node modules dynamically. */

import { describe, expect, it } from 'vitest'

import type {
  HostActorIdentity,
  HostClientClass,
  HostCommand,
  HostCommandName
} from '../../shared/hostProtocol'

import {
  createHostProductionAuthorityEvaluator,
  HOST_PRODUCTION_AUTHORITY_EVALUATOR_CATALOGUE,
  HOST_PRODUCTION_AUTHORITY_EVALUATOR_DEFERRED,
  HOST_PRODUCTION_AUTHORITY_EVALUATOR_READS,
  HOST_PRODUCTION_AUTHORITY_EVALUATOR_RESPONSES,
  type HostProductionAuthorityEvaluatorPorts
} from './HostProductionAuthorityEvaluator'

import type { AppStoreHostAuthorityEvaluation } from './AppStoreHostAuthority'

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function makeActor(overrides: Partial<HostActorIdentity> = {}): HostActorIdentity {
  return {
    actorId: 'user-1',
    clientId: 'desktop-main',
    clientClass: 'desktop',
    ...overrides
  }
}

function makeCommand(name: string, overrides: Partial<HostCommand> = {}): HostCommand {
  return {
    type: 'host.command',
    protocolVersion: '2.0.0' as const,
    commandId: `cmd-${name}-1`,
    idempotencyKey: `idem-${name}-1`,
    actor: makeActor(),
    name: name as HostCommandName,
    target: { threadId: 'thread-1' },
    arguments: {},
    ...overrides
  } as HostCommand
}

function evaluate(
  commandName: string,
  actorOverrides: Partial<HostActorIdentity> = {},
  ports?: HostProductionAuthorityEvaluatorPorts
): AppStoreHostAuthorityEvaluation {
  const evaluator = createHostProductionAuthorityEvaluator(ports)
  const cmd = makeCommand(commandName, { actor: makeActor(actorOverrides) })
  const result = evaluator(cmd, {
    actor: cmd.actor,
    client: {
      clientId: cmd.actor.clientId,
      clientClass: cmd.actor.clientClass,
      clientVersion: '1.0.0'
    }
  })
  // The production evaluator is always sync; the union return type
  // is for the interface contract, not this implementation.
  return result as AppStoreHostAuthorityEvaluation
}

/** Permission rank: allowed > deferred > denied. Higher rank = more permissive. */
function permissivenessRank(decision: string): number {
  if (decision === 'allowed') return 3
  if (decision === 'deferred') return 2
  return 1 // denied
}

/* ------------------------------------------------------------------ */
/*  Import isolation (test pin 4)                                     */
/* ------------------------------------------------------------------ */

describe('HostProductionAuthorityEvaluator import isolation', () => {
  it('imports zero electron symbols', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'HostProductionAuthorityEvaluator.ts'),
      'utf-8'
    )
    // No electron import — not even type-only
    expect(src).not.toMatch(/from\s+['"]electron['"]/)
    expect(src).not.toMatch(/require\s*\(\s*['"]electron['"]/)
  })

  it('imports zero AppStore / Bridge / store / resolver / pipeline value imports', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'HostProductionAuthorityEvaluator.ts'),
      'utf-8'
    )
    // Only hostProtocol types + AppStoreHostAuthority types + HostDeferredChallengeKind
    // No value-level imports from these modules
    const forbiddenValueImports = [
      'AppStore',
      'BridgeActionExecutor',
      'ChatStore',
      'HostCommandReceiptStore',
      'HostDeferredCommandEnvelopeResolver',
      'HostDeferredAllowPipeline',
      'HostDeferredCommandBridge',
      'HostRuntimeBootstrap',
      'HostMainComposition',
      'HostLocalServer',
      'HostSupervisor',
      'HostSnapshotProjector',
      'HostProductionSuppliers',
      'HostProjectionClient'
    ]
    for (const symbol of forbiddenValueImports) {
      // The module should not USE these symbols as bare value imports
      expect(src).not.toMatch(new RegExp(`^\\s*import\\s+(?![^"]*type)[^"']*${symbol}`))
    }
  })

  it('only imports from hostProtocol types, AppStoreHostAuthority types, HostDeferredChallengeKind', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(__dirname, 'HostProductionAuthorityEvaluator.ts'),
      'utf-8'
    )
    // Extract all import paths
    const importPaths = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
    for (const p of importPaths) {
      // Allowed: shared/hostProtocol (types), local host module types
      expect(p === '../../shared/hostProtocol' || p.startsWith('./')).toBe(true)
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Test pin 1: exhaustive command table                              */
/* ------------------------------------------------------------------ */

describe('HostProductionAuthorityEvaluator exhaustive command table', () => {
  it('catalogue contains exactly 12 HostCommandNames', () => {
    expect(HOST_PRODUCTION_AUTHORITY_EVALUATOR_CATALOGUE).toHaveLength(12)
  })

  it('every classified command is covered by exactly one set', () => {
    const reads = new Set(HOST_PRODUCTION_AUTHORITY_EVALUATOR_READS)
    const responses = new Set(HOST_PRODUCTION_AUTHORITY_EVALUATOR_RESPONSES)
    const deferred = new Set(HOST_PRODUCTION_AUTHORITY_EVALUATOR_DEFERRED)

    for (const name of HOST_PRODUCTION_AUTHORITY_EVALUATOR_CATALOGUE) {
      const inReads = reads.has(name)
      const inResponses = responses.has(name)
      const inDeferred = deferred.has(name)

      // Exactly one set
      const count = [inReads, inResponses, inDeferred].filter(Boolean).length
      expect(count).toBe(1)
    }
  })

  /* ---- reads ---- */

  it.each([...HOST_PRODUCTION_AUTHORITY_EVALUATOR_READS])(
    '%s → allowed (v2-socket-authenticated)',
    (name) => {
      const result = evaluate(name)
      expect(result.decision).toBe('allowed')
      expect(result.reason).toContain('v2-socket')
    }
  )

  /* ---- responses ---- */

  it.each([...HOST_PRODUCTION_AUTHORITY_EVALUATOR_RESPONSES])(
    '%s → allowed (response-to-existing-deferred-ask)',
    (name) => {
      const result = evaluate(name)
      expect(result.decision).toBe('allowed')
      expect(result.reason).toContain('ask')
    }
  )

  /* ---- mutations → deferred ---- */

  it.each([...HOST_PRODUCTION_AUTHORITY_EVALUATOR_DEFERRED])(
    '%s → deferred + challengeKind approval (no existing authority)',
    (name) => {
      const result = evaluate(name)
      expect(result.decision).toBe('deferred')
      expect(result.challengeKind).toBe('approval')
      expect(result.reason).toContain('no-existing-authority')
      expect(result.policy).toBe('host-arc-r5-c3-ask')
    }
  )
})

/* ------------------------------------------------------------------ */
/*  Test pin 2 + C5: clientClass ordering                             */
/* ------------------------------------------------------------------ */

describe('HostProductionAuthorityEvaluator clientClass ordering (C5)', () => {
  const allClientClasses: HostClientClass[] = ['desktop', 'tui', 'ios', 'test']

  it.each([...HOST_PRODUCTION_AUTHORITY_EVALUATOR_CATALOGUE])(
    '%s: ios never more permissive than desktop',
    (name) => {
      const desktopResult = evaluate(name, { clientClass: 'desktop' })
      const iosResult = evaluate(name, { clientClass: 'ios' })

      expect(permissivenessRank(iosResult.decision)).toBeLessThanOrEqual(
        permissivenessRank(desktopResult.decision)
      )
    }
  )

  it.each([...HOST_PRODUCTION_AUTHORITY_EVALUATOR_CATALOGUE])(
    '%s: tui never more permissive than desktop',
    (name) => {
      const desktopResult = evaluate(name, { clientClass: 'desktop' })
      const tuiResult = evaluate(name, { clientClass: 'tui' })

      expect(permissivenessRank(tuiResult.decision)).toBeLessThanOrEqual(
        permissivenessRank(desktopResult.decision)
      )
    }
  )

  it.each([...HOST_PRODUCTION_AUTHORITY_EVALUATOR_CATALOGUE])(
    '%s: test never more permissive than desktop',
    (name) => {
      const desktopResult = evaluate(name, { clientClass: 'desktop' })
      const testResult = evaluate(name, { clientClass: 'test' })

      expect(permissivenessRank(testResult.decision)).toBeLessThanOrEqual(
        permissivenessRank(desktopResult.decision)
      )
    }
  )

  it('all client classes get the same decision for each command (current policy is uniform)', () => {
    // Today's evaluator is class-agnostic by command type. This test
    // documents that fact — if a future slice adds class-dependent policy
    // it must update the ordering tests above AND this one.
    for (const name of HOST_PRODUCTION_AUTHORITY_EVALUATOR_CATALOGUE) {
      const results = allClientClasses.map((cc) => evaluate(name, { clientClass: cc }))
      const decisions = new Set(results.map((r) => r.decision))
      expect(decisions.size).toBe(1)
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Test pin 3: unknown command → denied (RED-proof)                   */
/* ------------------------------------------------------------------ */

describe('HostProductionAuthorityEvaluator unknown commands (C6 fail-closed)', () => {
  it('unknown command "health.get" → denied (not in catalogue — health is a port)', () => {
    const result = evaluate('health.get' as string)
    expect(result.decision).toBe('denied')
    expect(result.reason).toContain('unknown-host-command')
    expect(result.policy).toBe('host-arc-r5-c6-fail-closed')
    // RED-PROOF: NOT allowed, NOT deferred
    expect(result.decision).not.toBe('allowed')
    expect(result.decision).not.toBe('deferred')
  })

  it('unknown command "provider.launch" → denied', () => {
    const result = evaluate('provider.launch' as string)
    expect(result.decision).toBe('denied')
    expect(result.challengeKind).toBeUndefined()
  })

  it('unknown command "workspace.delete" → denied', () => {
    const result = evaluate('workspace.delete' as string)
    expect(result.decision).toBe('denied')
  })

  it('empty string command → denied', () => {
    const result = evaluate('' as string)
    expect(result.decision).toBe('denied')
  })

  it('arbitrary garbage command → denied', () => {
    const result = evaluate('!!!not-a-command!!!' as string)
    expect(result.decision).toBe('denied')
    expect(result.policy).toBe('host-arc-r5-c6-fail-closed')
  })

  it('unknown command: ios never gets allowed when desktop gets denied', () => {
    const desktopResult = evaluate('health.get' as string, { clientClass: 'desktop' })
    const iosResult = evaluate('health.get' as string, { clientClass: 'ios' })

    expect(desktopResult.decision).toBe('denied')
    expect(permissivenessRank(iosResult.decision)).toBeLessThanOrEqual(
      permissivenessRank(desktopResult.decision)
    )
  })
})

/* ------------------------------------------------------------------ */
/*  R5 C1: allow-all is FORBIDDEN in production                       */
/* ------------------------------------------------------------------ */

describe('HostProductionAuthorityEvaluator R5 C1 — allow-all forbidden', () => {
  it('does NOT allow all commands — mutations are deferred', () => {
    // The fixture () => ({decision:'allowed'}) in composition tests is a
    // TEST FIXTURE only. The production evaluator must NOT be allow-all.
    const deferredDecisions = HOST_PRODUCTION_AUTHORITY_EVALUATOR_DEFERRED.map(
      (name) => evaluate(name).decision
    )
    // Every deferred command is NOT allowed
    expect(deferredDecisions.every((d) => d !== 'allowed')).toBe(true)
    // Every deferred command IS deferred
    expect(deferredDecisions.every((d) => d === 'deferred')).toBe(true)
  })

  it('does NOT allow unknown commands', () => {
    const result = evaluate('composer.delete' as string)
    expect(result.decision).not.toBe('allowed')
  })

  it('the composition-test fixture shape () => ({decision:"allowed"}) is NOT the default', () => {
    // Prove: the evaluator produced by the factory with ZERO ports is NOT
    // equivalent to the fixture () => ({decision:'allowed'}).
    const evaluator = createHostProductionAuthorityEvaluator()
    const cmd = makeCommand('composer.send')
    const result = evaluator(cmd, {
      actor: cmd.actor,
      client: { clientId: 'desktop-main', clientClass: 'desktop', clientVersion: '1.0.0' }
    }) as AppStoreHostAuthorityEvaluation
    expect(result.decision).not.toBe('allowed')
  })
})

/* ------------------------------------------------------------------ */
/*  R5 C6: deferred commands carry typed challengeKind                 */
/* ------------------------------------------------------------------ */

describe('HostProductionAuthorityEvaluator deferred challengeKind typing (C6)', () => {
  it('every deferred decision carries challengeKind ∈ {approval, question}', () => {
    for (const name of HOST_PRODUCTION_AUTHORITY_EVALUATOR_CATALOGUE) {
      const result = evaluate(name)
      if (result.decision === 'deferred') {
        expect(['approval', 'question']).toContain(result.challengeKind)
      }
    }
  })

  it('allowed decisions do NOT carry challengeKind', () => {
    for (const name of [
      ...HOST_PRODUCTION_AUTHORITY_EVALUATOR_READS,
      ...HOST_PRODUCTION_AUTHORITY_EVALUATOR_RESPONSES
    ]) {
      const result = evaluate(name)
      expect(result.decision).toBe('allowed')
      expect(result.challengeKind).toBeUndefined()
    }
  })

  it('denied decisions do NOT carry challengeKind', () => {
    const result = evaluate('health.get' as string)
    expect(result.decision).toBe('denied')
    expect(result.challengeKind).toBeUndefined()
  })
})

/* ------------------------------------------------------------------ */
/*  R5 C7: gap reporting — evaluator documents why mutations defer    */
/* ------------------------------------------------------------------ */

describe('HostProductionAuthorityEvaluator gap reporting (C7)', () => {
  it('every deferred command has an honest reason string', () => {
    for (const name of HOST_PRODUCTION_AUTHORITY_EVALUATOR_DEFERRED) {
      const result = evaluate(name)
      expect(result.decision).toBe('deferred')
      expect(typeof result.reason).toBe('string')
      expect(result.reason!.length).toBeGreaterThan(0)
      expect(result.reason).toContain(name)
    }
  })

  it('every policy tag points at a specific R5 clause', () => {
    const seen = new Set<string>()
    for (const name of HOST_PRODUCTION_AUTHORITY_EVALUATOR_CATALOGUE) {
      const result = evaluate(name)
      expect(typeof result.policy).toBe('string')
      expect(result.policy).toMatch(/^host-arc-r5-c\d/)
      seen.add(result.policy!)
    }
    // At least three distinct policy clauses are referenced
    expect(seen.size).toBeGreaterThanOrEqual(3)
  })
})

/* ------------------------------------------------------------------ */
/*  Ports: injected but not called for today's classification          */
/* ------------------------------------------------------------------ */

describe('HostProductionAuthorityEvaluator ports injection', () => {
  it('accepts optional ports without calling them (no authority governs Host commands today)', () => {
    const called: string[] = []
    const ports: HostProductionAuthorityEvaluatorPorts = {
      permission: {
        getServicePolicy: (_service, _settings) => {
          called.push('permission')
          return 'ask'
        }
      },
      nativeApproval: {
        resolvePreflight: (_args) => {
          called.push('nativeApproval')
          return null
        }
      }
    }

    const evaluator = createHostProductionAuthorityEvaluator(ports)
    // Evaluate a mutation command
    const cmd = makeCommand('composer.send')
    evaluator(cmd, {
      actor: cmd.actor,
      client: { clientId: 'desktop-main', clientClass: 'desktop', clientVersion: '1.0.0' }
    })

    // Ports are injected but the evaluator does not call them today —
    // there is no existing authority that governs Host commands.
    // This test documents the honest gap per R5 C7.
    // If a future slice wires these ports, update this test.
    expect(called).toHaveLength(0)
  })

  it('works with undefined ports (fully portable)', () => {
    const evaluator = createHostProductionAuthorityEvaluator()
    const cmd = makeCommand('snapshot.get')
    const result = evaluator(cmd, {
      actor: cmd.actor,
      client: { clientId: 'desktop-main', clientClass: 'desktop', clientVersion: '1.0.0' }
    }) as AppStoreHostAuthorityEvaluation
    expect(result.decision).toBe('allowed')
  })
})

/* ------------------------------------------------------------------ */
/*  Deterministic + stateless                                         */
/* ------------------------------------------------------------------ */

describe('HostProductionAuthorityEvaluator determinism', () => {
  it('same command always returns the same evaluation', () => {
    const evaluator = createHostProductionAuthorityEvaluator()
    const cmd = makeCommand('composer.send')

    const results = Array.from({ length: 10 }, () =>
      evaluator(cmd, {
        actor: cmd.actor,
        client: { clientId: 'desktop-main', clientClass: 'desktop', clientVersion: '1.0.0' }
      })
    )

    const first = JSON.stringify(results[0])
    for (const r of results) {
      expect(JSON.stringify(r)).toBe(first)
    }
  })

  it('sync factory always returns sync evaluator (no Promise)', () => {
    const evaluator = createHostProductionAuthorityEvaluator()
    const cmd = makeCommand('snapshot.get')
    const result = evaluator(cmd, {
      actor: cmd.actor,
      client: { clientId: 'desktop-main', clientClass: 'desktop', clientVersion: '1.0.0' }
    }) as AppStoreHostAuthorityEvaluation
    expect(result).not.toBeInstanceOf(Promise)
    expect(typeof result.decision).toBe('string')
  })
})
