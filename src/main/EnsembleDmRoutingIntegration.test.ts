import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const roundSource = readFileSync(new URL('./ipc/ensembleRoundHandlers.ts', import.meta.url), 'utf8')
const composerSource = readFileSync(
  new URL('../renderer/src/components/Composer.tsx', import.meta.url),
  'utf8'
)

function sourceSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('Ensemble DM routing ingress integration', () => {
  it('re-resolves desktop IPC routing from the canonical roster after attachment expansion', () => {
    // The run-ensemble-round callback body moved to ensembleRoundHandlers.ts;
    // the ipcMain.handle registration stays in index.ts by design (pinned by
    // StartupWindowGate + projectReferenceContextDispatch).
    expect(mainSource).toContain("ipcMain.handle(\n      'run-ensemble-round'")
    const handler = sourceSection(
      roundSource,
      'export async function handleRunEnsembleRound(',
      'return ensembleStartResult'
    )
    const attachmentExpansion = handler.indexOf('authorizeThenExpandAttachmentRecords(')
    const canonicalChatRead = handler.indexOf('const ensembleChat = deps.getChat(chatId)')
    const authoritativeResolution = handler.indexOf(
      'const dmTargetResolution = resolveEnsembleDmTargetForDispatch({'
    )
    const roundStart = handler.indexOf('deps.getEnsembleOrchestrator()?.startRound({')

    expect(attachmentExpansion).toBeGreaterThanOrEqual(0)
    expect(canonicalChatRead).toBeGreaterThan(attachmentExpansion)
    expect(authoritativeResolution).toBeGreaterThan(canonicalChatRead)
    expect(roundStart).toBeGreaterThan(authoritativeResolution)
    // 51010be84 hoisted the roster into a guarded local (a catalogue
    // projection can drop the field once the chrome budget is spent): the
    // canonical-roster routing claim now spans two pins plus the fail-closed.
    expect(handler).toContain('const roster = ensembleChat.ensemble.participants')
    expect(handler).toContain('participants: roster')
    expect(handler).toContain('Ensemble roster is unavailable')
    expect(handler).toContain('advisoryParticipantId: payload?.dmTargetParticipantId')
    expect(handler).toContain('exactPickerParticipantId: payload?.exactPickerParticipantId')
    expect(handler).toContain('if (dmTargetError) throw new Error(dmTargetError)')
    expect(handler).toContain('...(dmTargetParticipantId ? { dmTargetParticipantId } : {})')
    expect(handler).not.toContain('dmTargetParticipantId: payload.dmTargetParticipantId')
  })

  it('uses the same authoritative resolver and rejection path for remote steer', () => {
    const remoteSteer = sourceSection(mainSource, 'ensembleSteerFn: async', 'createThreadFn: async')
    expect(remoteSteer).toContain('resolveEnsembleDmTargetForDispatch({')
    expect(remoteSteer).toContain('participants: chat.ensemble.participants')
    expect(remoteSteer).toContain('ensembleDmTargetResolutionError(')
    expect(remoteSteer).toContain('if (dmTargetError) return { ok: false, error: dmTargetError }')
  })

  it('resolves scheduled/headless routing against the schedule-time roster', () => {
    const scheduled = sourceSection(
      mainSource,
      'async function dispatchDueEnsembleScheduledTaskHeadless(',
      '// ENSEMBLE occurrences delegate to dispatchDueEnsembleScheduledTaskHeadless'
    )
    expect(scheduled).toContain(
      'const scheduledRoutingRoster = scheduledSnapshot?.participants ?? chat.ensemble.participants'
    )
    expect(scheduled).toContain('resolveEnsembleDmTargetForDispatch({')
    expect(scheduled).toContain('advisoryParticipantId: scheduledSnapshot?.dmTargetParticipantId')
    expect(scheduled).toContain(
      'exactPickerParticipantId: scheduledSnapshot?.exactPickerParticipantId'
    )
    expect(scheduled).toContain('Scheduled ensemble dispatch: ${scheduledDmTargetError}')
    expect(scheduled).not.toContain(
      'dmTargetParticipantId: scheduledSnapshot.dmTargetParticipantId'
    )
  })

  it('keeps picker routing metadata while inserting plain editable mention text', () => {
    const picker = sourceSection(
      composerSource,
      "if (mention.kind === 'participant' && mention.participantId)",
      'return formatComposerPathMention'
    )
    expect(picker).toContain('formatComposerParticipantMention(mention.name)')
    expect(picker).toContain('participantId: mention.participantId')
    expect(picker).not.toContain('formatEnsembleDmMention(mention.name, mention.participantId)')
  })
})
