/**
 * Host Arc Wave 3.6d — HostProductionAuthorityEvaluator.
 *
 * Production Host authority evaluator. Decides whether a Host command may
 * execute (allowed), is forbidden (denied), or requires an interactive
 * deferred challenge (deferred + typed challengeKind).
 *
 * BOUNDARIES (R5 C1-C7):
 * - Electron-free by import (zero node:electron, AppStore, Bridge, store,
 *   resolver, pipeline value imports).
 * - Translates existing authority; never invents policy.
 * - No existing authority ⇒ deferred with typed challengeKind (over-ask).
 * - Read commands are allowed on already-authenticated v2 socket.
 * - Untypeable / unknown commands fail closed (denied).
 * - clientClass is load-bearing: remote never more permissive than local.
 * - Gaps are reported honestly; no fabricated rules.
 *
 * NEVER inline in index.ts — an evaluator written as a root closure is
 * untestable domain logic in a composition root, forbidden by the goal.
 */

import {
  TASKWRAITH_DESKTOP_HOST_ACTOR,
  type HostClientClass,
  type HostCommand,
  type HostCommandName
} from '../shared/hostProtocol'

import type {
  AppStoreHostAuthorityEvaluation,
  AppStoreHostAuthorityEvaluator
} from './AppStoreHostAuthority'
import type { HostAuthorityCallContext } from './HostAuthority'
import type { HostDeferredChallengeKind } from './HostDeferredCommandBridge'

/* ------------------------------------------------------------------ */
/*  Ports (injected by composition root; never import engines)        */
/* ------------------------------------------------------------------ */

/**
 * Narrow port over the existing PermissionService.
 *
 * The real PermissionService governs agentic tool-call permissions
 * (AgenticServicePolicy per service/provider). Host commands are
 * domain/UI actions, not agent tool calls — there is no direct mapping.
 * The port is injected so a future slice can wire it if a mapping emerges.
 */
export interface HostProductionAuthorityEvaluatorPermissionPort {
  /**
   * Resolve the effective permission for a service.
   * Returns 'ask' when no explicit policy is set.
   */
  getServicePolicy?: (service: string, settings?: unknown) => 'allow' | 'deny' | 'ask'
}

/**
 * Narrow port over NativeApprovalPolicy.resolveNativeApprovalPreflightDecision.
 *
 * Governs native OS-level approvals (media editing, canvas eval).
 * Host commands are not native OS actions — there is no direct mapping.
 * The port is injected so a future slice can wire it if a mapping emerges.
 */
export interface HostProductionAuthorityEvaluatorNativeApprovalPort {
  resolvePreflight?: (args: {
    commandName: string
    clientClass: HostClientClass
  }) => { decision: 'allowed' | 'denied' | 'ask' } | null
}

/** All injectable ports for the production evaluator. */
export interface HostProductionAuthorityEvaluatorPorts {
  readonly permission?: HostProductionAuthorityEvaluatorPermissionPort
  readonly nativeApproval?: HostProductionAuthorityEvaluatorNativeApprovalPort
}

/* ------------------------------------------------------------------ */
/*  Command classification (R5 C4 — enumerated, not pattern-matched)  */
/* ------------------------------------------------------------------ */

/**
 * Read-only projection commands. The v2 socket is already authenticated
 * (0600, token-gated, timingSafeEqual). Asking per-snapshot makes the
 * Host unusable (R5 C4).
 */
const READ_COMMANDS: ReadonlySet<HostCommandName> = new Set([
  'snapshot.get',
  'deltas.since',
  'receipt.lookup',
  'ping'
])

/**
 * User-response commands. These answer a pending deferred challenge the
 * Host already asked. Making the answer itself require another ask would
 * be an infinite loop. The resolution path validates correlation
 * (challengeId + actor match in Scope-4 E-first pre-route).
 */
const RESPONSE_COMMANDS: ReadonlySet<HostCommandName> = new Set([
  'approval.decide',
  'question.answer'
])

/**
 * Whole-record persistence/deletion are app-internal bridges, not user/agent actions.
 * It is allowed only for the exact authenticated Desktop Host transport actor;
 * every other otherwise-local client fails closed without an approval escape.
 */
const DESKTOP_INTERNAL_COMMANDS: ReadonlySet<HostCommandName> = new Set([
  'thread.record.persist',
  'thread.record.delete'
])

/**
 * Domain mutation commands with no pre-existing governing authority in
 * the codebase (R5 C3 + C7). PermissionService governs agentic tool-call
 * permissions; NativeApprovalPolicy governs native OS preflight. Neither
 * governs these Host domain actions. Per R5 C3: over-ask, never under-protect.
 *
 * These commands default to deferred with challengeKind 'approval'.
 * question.answer is not in this set — it is a response command (above).
 */
const MUTATION_COMMANDS_NO_AUTHORITY: ReadonlySet<HostCommandName> = new Set([
  'composer.send',
  'run.cancel',
  'ensemble.seat.toggle',
  'channel.member.revoke',
  'channel.close',
  'thread.select'
])

/**
 * Setup has a distinct executor and no Bridge/deferred authority path. It is
 * available only to the exact authenticated local actor established by the
 * transport binding; remote/iOS callers fail closed.
 */
const SETUP_COMMANDS: ReadonlySet<HostCommandName> = new Set([
  'workspace.register',
  'thread.create',
  'thread.configure',
  'thread.archive',
  'provider.auth.begin',
  'provider.auth.cancel'
])

/** Every HostCommandName must appear in exactly one of the sets above. */
const ALL_CLASSIFIED: ReadonlySet<HostCommandName> = new Set([
  ...READ_COMMANDS,
  ...RESPONSE_COMMANDS,
  ...DESKTOP_INTERNAL_COMMANDS,
  ...MUTATION_COMMANDS_NO_AUTHORITY,
  ...SETUP_COMMANDS
])

function isExactDesktopInternalActor(
  command: HostCommand,
  context: HostAuthorityCallContext
): boolean {
  const expected = TASKWRAITH_DESKTOP_HOST_ACTOR
  return (
    context.client.clientClass === expected.clientClass &&
    context.client.clientId === expected.clientId &&
    context.actor.clientClass === expected.clientClass &&
    context.actor.clientId === expected.clientId &&
    context.actor.actorId === expected.actorId &&
    command.actor.clientClass === expected.clientClass &&
    command.actor.clientId === expected.clientId &&
    command.actor.actorId === expected.actorId
  )
}

/* ------------------------------------------------------------------ */
/*  Factory                                                           */
/* ------------------------------------------------------------------ */

/**
 * Create the production Host authority evaluator.
 *
 * Injected ports carry existing authority surfaces (PermissionService,
 * NativeApprovalPolicy). Today those authorities do not govern any Host
 * command directly — the evaluator reports this gap honestly per R5 C7
 * and defaults mutations to deferred. The ports remain injectable so a
 * future slice can wire them without editing this module.
 *
 * @returns A stateless AppStoreHostAuthorityEvaluator suitable for every
 *          composition path (sync-safe; no side effects).
 */
export function createHostProductionAuthorityEvaluator(
  ports?: HostProductionAuthorityEvaluatorPorts
): AppStoreHostAuthorityEvaluator {
  // Capture ports once at construction time (closure over injected authority
  // surfaces — never imports the real engines).
  // Today no Host command maps to tool-call permissions or native preflight;
  // the ports are injected so a future slice can wire them without editing
  // this module. Voided here to satisfy noUnusedLocals while keeping the
  // documented injection seam.
  void ports

  return (
    command: HostCommand,
    context: HostAuthorityCallContext
  ): AppStoreHostAuthorityEvaluation => {
    const name = command.name as string

    // Actor identity is load-bearing per R5 C5; desktop-internal commands below bind it exactly.

    // ── classified commands ──────────────────────────────────────

    if (READ_COMMANDS.has(name as HostCommandName)) {
      return {
        decision: 'allowed',
        reason: 'v2-socket-authenticated',
        policy: 'host-arc-r5-c4-read'
      }
    }

    if (RESPONSE_COMMANDS.has(name as HostCommandName)) {
      return {
        decision: 'allowed',
        reason: 'response-to-existing-deferred-ask',
        policy: 'host-arc-r5-c2-response'
      }
    }

    if (DESKTOP_INTERNAL_COMMANDS.has(name as HostCommandName)) {
      if (!isExactDesktopInternalActor(command, context)) {
        return {
          decision: 'denied',
          reason: 'thread-record-persist-requires-desktop-host-actor',
          policy: 'host-arc-r5-c5-thread-record-desktop-only'
        }
      }
      return {
        decision: 'allowed',
        reason: 'exact-desktop-host-actor',
        policy: 'host-arc-r5-c5-thread-record-desktop-only'
      }
    }

    if (SETUP_COMMANDS.has(name as HostCommandName)) {
      const locallyBound =
        (context.client.clientClass === 'desktop' ||
          context.client.clientClass === 'tui' ||
          context.client.clientClass === 'test') &&
        context.actor.clientId === context.client.clientId &&
        context.actor.clientClass === context.client.clientClass &&
        command.actor.actorId === context.actor.actorId &&
        command.actor.clientId === context.actor.clientId &&
        command.actor.clientClass === context.actor.clientClass
      if (!locallyBound) {
        return {
          decision: 'denied',
          reason: 'setup-requires-exact-local-actor',
          policy: 'host-arc-r5-c5-setup-local-only'
        }
      }
      return {
        decision: 'allowed',
        reason: 'exact-local-setup-actor',
        policy: 'host-arc-r5-c5-setup-local-only'
      }
    }

    if (MUTATION_COMMANDS_NO_AUTHORITY.has(name as HostCommandName)) {
      // R5 C3: no existing authority ⇒ ask, never allow.
      // R5 C7: report the gap honestly.
      //
      // challengeKind is typed 'approval' per PIN S4-Q moratorium:
      // 3.6 emits only approval-kind deferrals until question answer-payload
      // semantics land as a named follow-up slice.
      const kind: HostDeferredChallengeKind = 'approval'
      return {
        decision: 'deferred',
        reason: `no-existing-authority-governs:${name}`,
        policy: 'host-arc-r5-c3-ask',
        challengeKind: kind
      }
    }

    // ── unknown / untypeable command ──────────────────────────────

    // R5 C6: untypeable / unknown fails closed.
    // Never derive kind from command-name matching, client assertion,
    // transcript prose, or a default fallback.
    return {
      decision: 'denied',
      reason: `unknown-host-command:${name}`,
      policy: 'host-arc-r5-c6-fail-closed'
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Exhaustive catalogue (exported for test-table verification)       */
/* ------------------------------------------------------------------ */

/** Every HostCommandName this evaluator knows about. */
export const HOST_PRODUCTION_AUTHORITY_EVALUATOR_CATALOGUE: readonly HostCommandName[] = [
  ...ALL_CLASSIFIED
].sort() as HostCommandName[]

/** Read commands that are unconditionally allowed. */
export const HOST_PRODUCTION_AUTHORITY_EVALUATOR_READS: readonly HostCommandName[] = [
  ...READ_COMMANDS
].sort() as HostCommandName[]

/** Response commands that are allowed (answering an existing ask). */
export const HOST_PRODUCTION_AUTHORITY_EVALUATOR_RESPONSES: readonly HostCommandName[] = [
  ...RESPONSE_COMMANDS
].sort() as HostCommandName[]

/** App-internal commands allowed only for the exact authenticated Desktop Host actor. */
export const HOST_PRODUCTION_AUTHORITY_EVALUATOR_DESKTOP_INTERNAL: readonly HostCommandName[] = [
  ...DESKTOP_INTERNAL_COMMANDS
].sort() as HostCommandName[]

/** Mutation commands that default to deferred (no existing authority). */
export const HOST_PRODUCTION_AUTHORITY_EVALUATOR_DEFERRED: readonly HostCommandName[] = [
  ...MUTATION_COMMANDS_NO_AUTHORITY
].sort() as HostCommandName[]

/** Setup is local-only and never deferred to the Bridge approval path. */
export const HOST_PRODUCTION_AUTHORITY_EVALUATOR_SETUP: readonly HostCommandName[] = [
  ...SETUP_COMMANDS
].sort() as HostCommandName[]
