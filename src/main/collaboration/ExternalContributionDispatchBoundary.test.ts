import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * P2c security review, F6: an external contribution must never START a round.
 *
 * WHY THIS IS A SOURCE ASSERTION AND NOT A BEHAVIOURAL TEST. The invariant is
 * currently true by ABSENCE — `ChatService.appendCollaboratorComment` appends
 * and returns, and there is simply no dispatcher wired into it to call. A
 * behavioural test of that shape is vacuous: it passes because nothing happens,
 * and it would keep passing right up until someone adds the thing it is meant
 * to forbid, which is the only moment it matters. The repo already uses
 * source-region assertions for exactly this class of architectural invariant
 * (see `ComposerPermissionsGrantAdmission.test.ts`).
 *
 * WHAT THE INVARIANT PROTECTS. If a contribution can start a round rather than
 * only ride one the host started, then an admitted-but-compromised collaborator
 * can initiate autonomous tool activity and burn the host's paid provider quota
 * while the host is asleep. Under today's Demote-only grant the question is
 * academic; under Promote it is the difference between "a person left a note"
 * and "a person on another machine can run agents on your Mac unattended".
 *
 * This test is a TRIPWIRE, not a proof. It fails loudly when the Promote slice
 * wires dispatch into the append path, which is precisely when a human needs to
 * stop and decide deliberately rather than discover it later.
 */

const chatServiceSource = readFileSync(join(__dirname, '../services/ChatService.ts'), 'utf8')

function sourceRegion(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf(endMarker, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('F6 — an external contribution cannot start a round', () => {
  const appendRegion = (): string =>
    sourceRegion(
      chatServiceSource,
      '  appendCollaboratorComment(args: {',
      '\n  promoteCollaboratorComment('
    )

  it('the collaborator append path contains no run-dispatch call', () => {
    const region = appendRegion()

    // Every symbol by which main starts provider work. If the Promote slice
    // needs one of these here, that is a decision to take in the open — read
    // the F6 rationale above before deleting a line from this list.
    //
    // CASE-INSENSITIVE, deliberately. These are matched as concepts, not as
    // exact identifiers: the same idea appears as a type (`RunCoordinator`), a
    // member (`runCoordinator`), and a method fragment, and a guard that only
    // recognised one casing would wave the other two through. The steering
    // entry caught this for real — see the note on the next test.
    for (const concept of [
      'runAgent',
      'dispatch(',
      'startRound',
      'beginRound',
      'enqueueFollowUpPrompt',
      'runCoordinator',
      'ensembleOrchestrator',
      'midRunSteering'
    ]) {
      expect(region).not.toMatch(new RegExp(concept.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
    }
  })

  it('the collaborator append path does not reach the mid-run steering builder', () => {
    // Separately pinned because this is the sharpest version of the failure.
    // The builder now REQUIRES an `author` and stamps `sourceTrust` +
    // `role: 'system'` for the external variant (`7968c1618`), so text routed
    // through it is no longer laundered into the host's voice — but this guard
    // is about DISPATCH, not provenance: the steering lane is the only one that
    // does not wait for a run boundary, so reaching it from the append path is
    // still how a contribution would start work of its own.
    //
    // Matched as a case-insensitive CONCEPT rather than the exact symbol. The
    // other session initially kept the then-slightly-wrong name
    // `buildMidRunSteering*User*Message` specifically so this assertion would
    // not be silently defeated — which is exactly the kind of favour a guard
    // should not need. The rename to `buildMidRunSteeringMessage` would have
    // passed the old exact-string check AND the old case-sensitive
    // `'midRunSteering'` entry above it, because that spelling has a capital M.
    // Once this matched the concept the name was free to be corrected, and it
    // has been — the builder is `buildMidRunSteeringMessage` as of the rename.
    expect(appendRegion()).not.toMatch(/buildmidrunsteering\w*message/i)
  })

  it('ChatService takes no run-dispatching dependency at all', () => {
    // The append path cannot start a round if the service it lives in has no
    // way to start one. Pinned at the deps interface so the guard survives the
    // append method being renamed, split, or moved.
    const deps = sourceRegion(chatServiceSource, 'export interface ChatServiceDeps', '\n}')
    for (const forbidden of ['RunCoordinator', 'EnsembleOrchestrator', 'RunManager']) {
      expect(deps).not.toContain(forbidden)
    }
  })
})
