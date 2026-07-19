import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
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
    const handler = sourceSection(
      mainSource,
      "'run-ensemble-round'",
      "'steer-queued-ensemble-prompt'"
    )
    const attachmentExpansion = handler.indexOf('authorizeThenExpandAttachmentRecords(')
    const canonicalChatRead = handler.indexOf('const ensembleChat = AppStore.getChat(chatId)')
    const authoritativeResolution = handler.indexOf(
      'const dmTargetResolution = resolveEnsembleDmTargetForDispatch({'
    )
    const roundStart = handler.indexOf('ensembleOrchestratorRef?.startRound({')

    expect(attachmentExpansion).toBeGreaterThanOrEqual(0)
    expect(canonicalChatRead).toBeGreaterThan(attachmentExpansion)
    expect(authoritativeResolution).toBeGreaterThan(canonicalChatRead)
    expect(roundStart).toBeGreaterThan(authoritativeResolution)
    expect(handler).toContain('participants: ensembleChat.ensemble.participants')
    expect(handler).toContain('advisoryParticipantId: payload?.dmTargetParticipantId')
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
    expect(scheduled).toContain(
      'advisoryParticipantId: scheduledSnapshot?.dmTargetParticipantId'
    )
    expect(scheduled).toContain('Scheduled ensemble dispatch: ${scheduledDmTargetError}')
    expect(scheduled).not.toContain(
      'dmTargetParticipantId: scheduledSnapshot.dmTargetParticipantId'
    )
  })

  it('keeps the exact participant id when the composer picker inserts a mention', () => {
    const picker = sourceSection(
      composerSource,
      "if (mention.kind === 'participant' && mention.participantId)",
      'return formatComposerPathMention'
    )
    expect(picker).toContain(
      'return formatEnsembleDmMention(mention.name, mention.participantId)'
    )
    expect(picker).not.toContain('return `@${mention.name} `')
  })
})
