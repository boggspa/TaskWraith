import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function between(start: string, end: string): string {
  const startAt = source.indexOf(start)
  const endAt = source.indexOf(end, startAt + start.length)
  expect(startAt, `missing start anchor: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endAt, `missing end anchor: ${end}`).toBeGreaterThan(startAt)
  return source.slice(startAt, endAt)
}

describe('Channels production main integration', () => {
  it('starts shared storage early and activates agents only after main run ports are live', () => {
    const composition = between(
      'let channelProductionBootstrap:',
      'type BroadHistoryStrictAttempt = {'
    )
    expect(composition).toContain('startPeopleToChannelMigrationBootstrap({')
    expect(composition).toContain(
      'runner: new PeopleToChannelMigrationFinalizationProductionRunner({'
    )
    expect(composition).toContain("hostDisplayName: app.getName().trim() || 'TaskWraith'")
    expect(composition).toContain('listChats: () => AppStore.getChats()')
    expect(composition).toContain('retainedWorkspaceBootstrapShareIds: () => []')
    expect(composition).toContain('createChannelProductionBootstrap({')
    expect(composition).toContain("'human-collaboration-identity.json'")
    expect(composition).toContain('safeStorage,')
    expect(composition).toContain('migratedAdmissionAuthority,')
    expect(composition).toContain('migrationHandoff,')
    expect(composition).toContain('createChannelProductionRelayPort({')
    expect(composition).toContain('getEmbeddedRelayPort: () => embeddedRelayHandle?.port')
    expect(composition).toContain(
      'getAdvertisedRelayUrls: () => iosRemoteRuntime?.describeHost().relayUrls ?? []'
    )
    expect(composition).toContain('channelProductionBootstrap = channelMigrationStartup.bootstrap')
    expect(composition).toContain(
      'channelMigrationLegacyWriteGate = channelMigrationStartup.legacyWriteGate'
    )
    expect(composition).toContain('workspacePopoutOwnerForSender(senderId)')
    expect(composition).toContain('agentManagement: {')
    expect(composition).toContain('getSettings: () => AppStore.getSettings()')
    expect(composition).toContain('selectableProviderIds(settings).includes(provider)')
    expect(composition).toContain('getWorkspaces: () => AppStore.getWorkspaces()')
    expect(composition).toContain('canonicalizePath: canonicalPath')
    expect(composition).toContain(
      'getOwnerWindow: (event) => BrowserWindow.fromWebContents(event.sender)'
    )
    expect(composition).toContain('agentExecution: {')
    expect(composition).toContain('composer.composeMainOwnedChannelAgentRun(input, authority)')
    expect(composition).toContain('subscribeRunEvents: (sink) => runEventBus.subscribe(sink)')
    expect(composition).toContain(
      'subscribeRunSessions: (listener) => runManager.onChange(listener)'
    )
    expect(composition).toContain(
      'claimRunAudience: (runId, sinkIds) => runEventBus.claimRunAudience(runId, sinkIds)'
    )
    expect(composition).toContain('reconcileChannelAgentProductionRun(')
    expect(composition).not.toContain('confirm:')
    expect(composition).toContain('win.webContents.send(CHANNEL_IPC_CHANGED_EVENT, event)')
    expect(composition).toContain('historyClearAdmissionGate.isAuthorityBlocked({')

    const migration = source.indexOf('startPeopleToChannelMigrationBootstrap({')
    const constructed = source.indexOf('createChannelProductionBootstrap({')
    const start = migration
    const recovery = source.indexOf('await recoverPendingHistoryDeletionBeforeRunQueue()')
    const peopleRuntime = source.indexOf('const getHumanCollaborationRuntime = () => {')
    const composer = source.indexOf('composerServiceRef = composerService')
    const dispatch = source.indexOf('channelAgentDispatchRef = async (payload, hooks) => {')
    const activation = source.indexOf('channelProductionBootstrap?.startAgentExecution()')
    expect(migration).toBeGreaterThanOrEqual(0)
    expect(constructed).toBeGreaterThanOrEqual(0)
    expect(constructed).toBeGreaterThan(migration)
    expect(recovery).toBeGreaterThan(start)
    expect(peopleRuntime).toBeGreaterThan(start)
    expect(composer).toBeGreaterThan(recovery)
    expect(dispatch).toBeGreaterThan(composer)
    expect(activation).toBeGreaterThan(dispatch)
    const dispatchComposition = source.slice(dispatch, activation)
    expect(dispatchComposition).toContain('baseDispatchRunWithProviderPause(')
    expect(dispatchComposition).toContain('hooks.observer')
    expect(dispatchComposition).toContain('hooks.finalAuthorization')
    expect(source).toContain('Channels migration authority is unavailable before People startup.')
    expect(source).toContain('{ legacyWriteGate: channelMigrationLegacyWriteGate }')
  })

  it('isolates exact Channel runs from parent sessions, raw history, and ordinary failover', () => {
    const dispatch = between(
      'channelAgentDispatchRef = async (payload, hooks) => {',
      'channelProductionBootstrap?.startAgentExecution()'
    )
    const registered = dispatch.indexOf('channelAgentRunIsolationRegistry.register(payload)')
    const provider = dispatch.indexOf('baseDispatchRunWithProviderPause(')
    const settled = dispatch.indexOf('isolationLease.settle()')
    expect(registered).toBeGreaterThanOrEqual(0)
    expect(provider).toBeGreaterThan(registered)
    expect(settled).toBeGreaterThan(provider)
    expect(dispatch).toContain('hooks.finalAuthorization')
    expect(dispatch).toContain('quotaWallSignalByRun.delete(isolationLease.binding.runId)')
    expect(dispatch).toContain('failoverSnapshotByRun.delete(isolationLease.binding.runId)')

    const isolation = between(
      'function isMainOwnedContextIsolatedPayload',
      'function getActiveTaskWraithThreadCount'
    )
    expect(isolation).toContain('isExecutionGraphIsolatedPayload(payload)')
    expect(isolation).toContain('channelAgentRunIsolationRegistry.isPayloadIsolated(payload)')

    const profileStore = between(
      'function taskWraithMcpProfileStoreStateForPayload',
      'interface ProviderSeatStoreTarget'
    )
    expect(profileStore).toContain('isMainOwnedContextIsolatedPayload(payload)')
    expect(profileStore).toContain('storeSessionId: null')
    expect(profileStore).toContain('storeWritable: false')

    const sessionPersistence = between(
      'function shouldPersistProviderSessionForRun',
      'function releaseProviderSessionPersistenceDecision'
    )
    expect(sessionPersistence).toContain('!channelAgentRunIsolationRegistry.isRunIsolated(runId)')
    expect(sessionPersistence).toContain('redactChannelAgentUsageContent(entry)')

    const durableHistory = between(
      'function appendDurableRunEvent(input: RunEventInput): void {',
      'const runItemEventCompatMapper'
    )
    expect(durableHistory).toContain(
      'if (channelAgentRunIsolationRegistry.isRunIsolated(input.runId)) return'
    )

    const failover = between(
      'function maybeTriggerProviderAutoFailover',
      '/** Wire the failover orchestrator to live main-process dependencies. */'
    )
    expect(failover).toContain(
      'if (channelAgentRunIsolationRegistry.isRunIsolated(appRunId)) return'
    )

    expect(source).toContain(
      'function kimiAcpSeatHomeDir(payload: AgentRunPayload): string {\n  if (isMainOwnedContextIsolatedPayload(payload)) {'
    )
    expect(
      source.match(/const mainOwnedContextIsolated = isMainOwnedContextIsolatedPayload/g)
    ).toHaveLength(2)

    const geminiApi = between(
      'function geminiApiProviderDeps()',
      'async function runGeminiProvider'
    )
    expect(geminiApi).toContain('getChat: (chatId: string, route: AgentRunRoute) =>')
    expect(
      geminiApi.match(/channelAgentRunIsolationRegistry\.isRunIsolated\(route\.appRunId\)/g)
    ).toHaveLength(3)
    expect(geminiApi).toContain('recordUsage: recordProviderRunUsage')
  })

  it('gives broad and scoped deletion their own durable Channels target before commit', () => {
    const broad = between('type BroadHistoryDeletionHolds = {', 'const clearBroadChatHistory = ')
    expect(broad).toContain('channelsPurge: BroadHistoryStrictAttempt')
    expect(broad).toContain("id: historyDeletionTargetId('channels', scopeIdentity)")
    expect(broad).toContain("kind: 'channels'")
    expect(broad).toContain('purgeChannelsForHistoryPreparation(preparation)')
    expect(broad).toContain('purgeChannelsForHistoryPreparation(_preparation)')
    expect(broad).toContain('await holds.channelsPurge.promise')

    const purge = broad.indexOf('await holds.channelsPurge.promise')
    const commit = broad.indexOf('AppStore.commitPreparedHistoryDeletion(operationId)')
    expect(purge).toBeGreaterThanOrEqual(0)
    expect(commit).toBeGreaterThan(purge)

    const scoped = between(
      'const scopedHistoryDeletionCoordinator = new ScopedHistoryDeletionCoordinator({',
      'const deleteChatWithLifecycle = async'
    )
    expect(scoped).toContain('beginChannelsClear: (kind, chatIds) => {')
    expect(scoped).toContain('service.purgeForHistoryDeletionScope({ kind, chatIds })')
    expect(source).toContain("{ id: 'channels:chat-batch', kind: 'channels' }")
  })

  it('refreshes rooms with relay readiness and stops on process shutdown', () => {
    const reopen = between(
      'const reopenCollaborationRooms = (): void => {',
      'const getHumanCollaborationRuntime = () => {'
    )
    expect(reopen.indexOf('channelProductionBootstrap?.refreshRelayRooms()')).toBeLessThan(
      reopen.indexOf('if (roomIds.size === 0) return')
    )

    const shutdown = between(
      "app.on('will-quit', () => {",
      '// A crash after durable history prepare'
    )
    expect(shutdown).toContain('channelProductionBootstrap?.stop().catch((error) => {')
  })

  it('projects remote isShared from the active-channel set, not the retired share store', () => {
    // The People→Channel migration DELETES legacy share records at
    // finalization, so a task card whose isShared reads only
    // getShareForChat goes permanently dark on iOS the moment migration
    // commits — the phone's channel-membership section silently empties.
    const card = between(
      'const buildRemoteTaskCardForChat = (',
      'const leanRemoteDiffSummary = ('
    )
    expect(card).toContain('resolveActiveChannelChatIds()')
    expect(card).toContain('isShared: activeChannelChatIds.has(canonicalChat.appChatId) ||')
    expect(card).toContain(
      "sharedMode: activeChannelChatIds.has(canonicalChat.appChatId) ? 'channel'"
    )
    // Legacy lookup stays as the pre-migration / P5 workspace-bootstrap
    // fallback — union, never replacement.
    expect(card).toContain('humanCollaborationStore.getShareForChat(canonicalChat.appChatId)')

    // The resolver is wired AFTER the bootstrap try/catch (TDZ: the
    // projection closure is declared ~1500 lines above the `let` binding)
    // and must fail closed to the empty set unless the channel authority is
    // actually running; only ACTIVE channels count as shared.
    const wiring = between(
      'resolveActiveChannelChatIds = () => {',
      'const purgeChannelsForHistoryPreparation = ('
    )
    expect(wiring).toContain("if (!service || service.status().state !== 'running')")
    expect(wiring).toContain("channel.status === 'active'")
  })
})
