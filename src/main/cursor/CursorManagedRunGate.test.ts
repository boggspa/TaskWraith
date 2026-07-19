import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cursorManagedRunAdmission, resolveCursorManagedRunAdmission } from './CursorManagedRunGate'

describe('Cursor managed-run release gate', () => {
  it('blocks with the empty embedded roster regardless of explicit auth (fail-closed)', () => {
    for (const _env of [
      {},
      { CURSOR_AUTH_TOKEN: 'secret-token' },
      { CURSOR_API_KEY: 'secret-api-key' }
    ]) {
      // The shipped runtime roster is empty, so admission is fail-closed and is
      // never a function of credentials.
      const admission = cursorManagedRunAdmission()
      expect(admission).toMatchObject({ allowed: false, securityUnavailable: true })
      expect(admission.message).toContain('No Cursor process was started')
      expect(admission.message).not.toContain('secret-token')
      expect(admission.message).not.toContain('secret-api-key')
    }
  })

  it('derives the gate from the qualified roster and never authorizes a spawn at this coarse layer', () => {
    // No qualified build -> security-unavailable (the shipped fail-closed state).
    const empty = resolveCursorManagedRunAdmission(false)
    expect(empty).toMatchObject({ allowed: false, securityUnavailable: true })
    expect(empty.message).toContain('No Cursor process was started')
    // A qualified build present -> no longer "security unavailable", but this
    // coarse synchronous gate STILL does not authorize a spawn: exact-build
    // admission (admitCursorRuntime) is the async authority.
    const armed = resolveCursorManagedRunAdmission(true)
    expect(armed.allowed).toBe(false)
    expect(armed.securityUnavailable).toBe(false)
  })

  it('keeps the production entry point free of every Cursor spawn/resolve path', () => {
    const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
    const start = source.indexOf('async function runCursorProvider(')
    const end = source.indexOf('// 1.0.6-G4/G6', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const productionEntry = source.slice(start, end)

    expect(productionEntry).toContain('cursorManagedRunAdmission()')
    expect(productionEntry).not.toContain('resolveCliProviderBinary')
    expect(productionEntry).not.toContain('runCliProviderProcess')
    expect(productionEntry).not.toContain('buildCursorCliArgs')
    expect(productionEntry).not.toContain('spawn(')
    expect(productionEntry).not.toContain('--force')
    expect(productionEntry).not.toContain('--approve-mcps')
    expect(productionEntry).not.toContain('--resume')
  })

  it('keeps production Kimi calls off the generic CLI launcher and on its admitted path', () => {
    const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
    const start = source.indexOf('function runCliProviderProcess(')
    const end = source.indexOf('\nfunction ', start + 1)
    const launcher = source.slice(start, end)

    expect(launcher).not.toContain('provider: ProviderId')
    expect(source).not.toContain('buildCursorCliArgs(')

    const launchProviders = Array.from(
      source.matchAll(/runCliProviderProcess\([^,]+,\s*'([^']+)'/g),
      (match) => match[1]
    )
    expect(new Set(launchProviders)).toEqual(new Set(['claude']))
    expect(launchProviders).not.toContain('kimi')
    expect(launchProviders).not.toContain('cursor')

    const kimiStart = source.indexOf('async function runKimiAcpProvider(')
    const kimiEnd = source.indexOf('\nasync function ', kimiStart + 1)
    const kimiEntry = source.slice(kimiStart, kimiEnd)
    expect(kimiEntry).toContain('launchKimiProductionAcp({')
    expect(kimiEntry).toContain('assertRuntimeReadyForSpawn: async () => {')

    const runtimeAttestation = kimiEntry.indexOf(
      'const binaryPath = await admittedRuntime.assertReadyForSpawn()'
    )
    const postAttestationAuthority = kimiEntry.indexOf(
      "assertKimiSpawnAuthority(() => providerRunPersistenceAuthorized('kimi', state))",
      runtimeAttestation
    )
    const synchronousLaunch = kimiEntry.indexOf(
      'launch: (production, transportCleanup, admittedBinaryPath) => {'
    )
    const finalLaunchAuthority = kimiEntry.indexOf(
      "assertKimiSpawnAuthority(() => providerRunPersistenceAuthorized('kimi', state))",
      synchronousLaunch
    )
    const acpTurnLaunch = kimiEntry.indexOf('return runKimiAcpTurn({', finalLaunchAuthority)
    const processSpawn = kimiEntry.indexOf('spawnProcess: () => {', acpTurnLaunch)

    expect(runtimeAttestation).toBeGreaterThanOrEqual(0)
    expect(postAttestationAuthority).toBeGreaterThan(runtimeAttestation)
    expect(synchronousLaunch).toBeGreaterThan(postAttestationAuthority)
    expect(finalLaunchAuthority).toBeGreaterThan(synchronousLaunch)
    expect(acpTurnLaunch).toBeGreaterThan(finalLaunchAuthority)
    expect(processSpawn).toBeGreaterThan(acpTurnLaunch)
  })

  it('rejects Cursor in paired-device creation and mutation paths', () => {
    const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
    const createStart = source.indexOf('createThreadFn: async')
    const createEnd = source.indexOf('threadRowExpandFn: async', createStart)
    const createThread = source.slice(createStart, createEnd)
    expect(createThread.match(/assertLiveProviderId/g)?.length).toBeGreaterThanOrEqual(4)
    expect(createThread).not.toContain('assertProviderId(')

    const rosterStart = source.indexOf('ensembleRosterUpdateFn: async')
    const rosterEnd = source.indexOf('ensembleQueueEditFn: async', rosterStart)
    const rosterUpdate = source.slice(rosterStart, rosterEnd)
    expect(rosterUpdate).toContain('assertLiveProviderId(entry.provider)')
    expect(rosterUpdate).not.toContain('assertProviderId(entry.provider)')

    const promptStart = source.indexOf('function prepareIosComposerPromptChat(')
    const promptEnd = source.indexOf('\nfunction ', promptStart + 1)
    const promptPreparation = source.slice(promptStart, promptEnd)
    expect(promptPreparation).toContain('assertLiveProviderId(action.provider)')
  })

  it('keeps historical renderer chats read-only before dispatch', () => {
    const appSource = readFileSync(
      fileURLToPath(new URL('../../renderer/src/App.tsx', import.meta.url)),
      'utf8'
    )
    const start = appSource.indexOf('const handleRun = (')
    const end = appSource.indexOf('\n  const createSideChatFromCurrentChat', start)
    const handleRun = appSource.slice(start, end)
    expect(handleRun).toContain('!isLiveSelectableProvider(baseRequest.provider)')
    expect(handleRun).toContain('managed runs are unavailable. Switch this chat')

    const composerSource = readFileSync(
      fileURLToPath(new URL('../../renderer/src/components/Composer.tsx', import.meta.url)),
      'utf8'
    )
    expect(composerSource).toContain('if (currentProviderRunUnavailableReason) return')
    expect(composerSource).toContain('Boolean(currentProviderRunUnavailableReason)')
    expect(composerSource).toContain('disabledReason={')
  })

  it('does not advertise emulated forks for unavailable historical providers', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../ipc/codexThreadHandlers.ts', import.meta.url)),
      'utf8'
    )
    const start = source.indexOf('function forkCapability(')
    const end = source.indexOf('\nexport function', start)
    const capability = source.slice(start, end)
    expect(capability).toContain('!isLiveSelectableProvider(provider)')
    expect(capability).not.toContain('isRetiredProvider(provider)')
  })

  it('rejects historical Cursor ensemble lanes before Trusted Session authority', () => {
    const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
    const start = source.indexOf('function resolveTrustedSessionScope(')
    const end = source.indexOf('\nfunction ', start + 1)
    const resolver = source.slice(start, end)
    expect(resolver).toContain('assertLiveProviderId(\n      participant ? participant.provider')
    expect(resolver).not.toContain('? participant.provider\n      : assertLiveProviderId')
  })

  it('reports an ensemble Cursor seat unreachable before binary resolution', () => {
    const source = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')
    const start = source.indexOf('async function probeEnsembleParticipant(')
    const end = source.indexOf('async function probeCodexParticipant(', start)
    const probe = source.slice(start, end)
    expect(probe.indexOf("participant.provider === 'cursor'")).toBeGreaterThan(0)
    expect(probe.indexOf('cursorManagedRunAdmission()')).toBeGreaterThan(0)
    expect(probe).not.toContain('resolveCliProviderBinary')
  })
})
