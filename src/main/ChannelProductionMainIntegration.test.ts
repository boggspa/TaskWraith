import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

// This sentence is part of the executable pin. An authorized future People
// retirement must edit the reason, not quietly delete an unexplained count.
const DEGRADED_PEOPLE_RETENTION_REASON =
  'P6-03 retention pin: the user explicitly kept the People store, runtime, IPC and enabled-share reconnect path because they are the only collaboration history/reconnect capability when Channels migration degrades; removing any seam silently breaks that recovery mode.'

function between(start: string, end: string, message?: string): string {
  const startAt = source.indexOf(start)
  const endAt = source.indexOf(end, startAt + start.length)
  expect(startAt, message ?? `missing start anchor: ${start}`).toBeGreaterThanOrEqual(0)
  expect(endAt, message ?? `missing end anchor: ${end}`).toBeGreaterThan(startAt)
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
    // P5-C RETIRED the retention port. This previously pinned the literal
    // `retainedWorkspaceBootstrapShareIds: () => []` — an explicit empty
    // declaration. Workspace bootstrap is Channel-native and no automatic
    // People share is ever created, so production declares no producer AT ALL;
    // the assertion is inverted so the port cannot return, not even as an
    // "empty" one that would re-open the seam P5-A sealed.
    expect(composition).not.toContain('retainedWorkspaceBootstrapShareIds')
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

  it('pins the user-kept degraded People recovery path so it cannot be retired silently', () => {
    const reason = DEGRADED_PEOPLE_RETENTION_REASON
    const degradedAt = source.indexOf('const degraded = degradePeopleToChannelMigrationStartup(')
    const catchEndAt = source.indexOf(
      '// Wire the remote task-card channel lookup now that the bootstrap',
      degradedAt
    )
    const storeAt = source.indexOf('const humanCollaborationStore = new HumanCollaborationStore(')
    const reconnectAt = source.indexOf('const reopenCollaborationRooms = (): void => {')
    const runtimeAt = source.indexOf('const getHumanCollaborationRuntime = () => {')
    const ipcAt = source.indexOf(
      'disposeHumanCollaborationIpcHandlers = registerHumanCollaborationHandlers({'
    )

    expect(degradedAt, reason).toBeGreaterThanOrEqual(0)
    expect(catchEndAt, reason).toBeGreaterThan(degradedAt)
    expect(storeAt, reason).toBeGreaterThan(catchEndAt)
    expect(reconnectAt, reason).toBeGreaterThan(storeAt)
    expect(runtimeAt, reason).toBeGreaterThan(reconnectAt)
    expect(ipcAt, reason).toBeGreaterThan(runtimeAt)

    // Parse only this composition slice: all four seams must remain direct
    // statements in the same flow as the completed catch. A future
    // `if (channelProductionBootstrap)` wrapper would change the AST parent and
    // fail even though every source string still existed.
    const compositionStartAt = source.indexOf('let channelProductionBootstrap:')
    const compositionEndAt = source.indexOf('registerUsageRatesHandlers({', ipcAt)
    expect(compositionStartAt, reason).toBeGreaterThanOrEqual(0)
    expect(compositionEndAt, reason).toBeGreaterThan(ipcAt)
    const syntax = ts.createSourceFile(
      'channels-p6-retention-pin.ts',
      `async function retentionPin() {\n${source.slice(compositionStartAt, compositionEndAt)}\n}`,
      ts.ScriptTarget.Latest,
      true
    )
    const findNode = <Node extends ts.Node>(predicate: (node: ts.Node) => node is Node): Node => {
      let found: Node | undefined
      const visit = (node: ts.Node): void => {
        if (found) return
        if (predicate(node)) found = node
        else ts.forEachChild(node, visit)
      }
      visit(syntax)
      expect(found, reason).toBeDefined()
      return found!
    }
    const degradedTry = findNode(
      (node): node is ts.TryStatement =>
        ts.isTryStatement(node) &&
        Boolean(node.catchClause?.block.getText(syntax).includes('degradePeopleToChannel'))
    )
    const directVariable = (name: string): ts.VariableStatement =>
      findNode(
        (node): node is ts.VariableStatement =>
          ts.isVariableStatement(node) &&
          node.declarationList.declarations.some(
            (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name
          )
      )
    const ipcRegistration = findNode(
      (node): node is ts.ExpressionStatement =>
        ts.isExpressionStatement(node) &&
        ts.isBinaryExpression(node.expression) &&
        ts.isIdentifier(node.expression.left) &&
        node.expression.left.text === 'disposeHumanCollaborationIpcHandlers' &&
        node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    )
    for (const statement of [
      directVariable('humanCollaborationStore'),
      directVariable('reopenCollaborationRooms'),
      directVariable('getHumanCollaborationRuntime'),
      ipcRegistration
    ]) {
      expect(statement.parent === degradedTry.parent, reason).toBe(true)
      expect(statement.pos, reason).toBeGreaterThan(degradedTry.end)
    }

    const degradedCatch = source.slice(degradedAt, catchEndAt)
    expect(degradedCatch, reason).toContain(
      'channelMigrationLegacyWriteGate = degraded.legacyWriteGate'
    )
    expect(degradedCatch, reason).not.toMatch(/\b(?:return|throw)\b/)

    const storeConstruction = between(
      'const humanCollaborationStore = new HumanCollaborationStore(',
      '/**\n     * Tri-state presence for external collaborators',
      reason
    )
    expect(storeConstruction, reason).toContain("'human-collaboration.json'")
    expect(storeConstruction, reason).toContain(
      '{ legacyWriteGate: channelMigrationLegacyWriteGate }'
    )

    const reconnect = between(
      'const reopenCollaborationRooms = (): void => {',
      'const getHumanCollaborationRuntime = () => {',
      reason
    )
    expect(reconnect, reason).toContain(
      'for (const share of humanCollaborationStore.listShares()) {'
    )
    expect(reconnect, reason).toContain('if (!share.enabled) continue')
    expect(reconnect, reason).toContain("participant.status === 'active'")
    expect(reconnect, reason).toContain("typeof invite.consumedAt === 'number'")
    expect(reconnect, reason).toContain('getHumanCollaborationRuntime()')
    expect(reconnect, reason).toContain(
      'humanCollaborationHostTransport?.openRoom(hostRelay, roomId)'
    )

    const runtime = between(
      'const getHumanCollaborationRuntime = () => {',
      '// Boot the iOS remote bridge now that the human-collaboration cluster above is',
      reason
    )
    expect(runtime, reason).toContain('humanCollaborationRuntime = new HumanCollaborationRuntime({')
    expect(runtime, reason).toContain('store: humanCollaborationStore')
    expect(runtime, reason).toContain(
      'humanCollaborationHostTransport.attachRuntime(humanCollaborationRuntime)'
    )

    const ipc = between(
      'disposeHumanCollaborationIpcHandlers = registerHumanCollaborationHandlers({',
      'registerUsageRatesHandlers({',
      reason
    )
    expect(ipc, reason).toContain('humanCollaborationStore,')
    expect(ipc, reason).toContain('getHumanCollaborationRuntime,')
    expect(ipc, reason).toContain(
      'getCurrentHumanCollaborationRuntime: () => humanCollaborationRuntime'
    )
    expect(source, reason).toContain(
      'if (humanCollaborationHostTransport) reopenCollaborationRooms()'
    )
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

  it('resolves external collaborator seats through the shared Channel-only resolver', () => {
    const resolver = between(
      'const resolveChannelExternalSeats = (',
      'const humanCollaborationAuditLog = new HumanCollaborationAuditLog('
    )
    // One tested resolver now owns store/runtime construction, the X4 seal and
    // the strict null-versus-empty result. Main wires only the live service.
    expect(resolver).toContain('resolveChannelExternalSeatsForChat({')
    expect(resolver).toContain('chatId,')
    expect(resolver).toContain('service: channelProductionBootstrap?.service')
    expect(resolver).not.toContain('new ChannelExternalSeatAuthority({')
    // The retired People read is gone from this resolver entirely.
    expect(resolver).not.toContain('humanCollaborationStore.getShareForChat')

    // And gone from the whole composition root: this was the last legacy
    // share read in index.ts, across all three consumers.
    expect(source).not.toContain('humanCollaborationStore.getShareForChat')
  })

  it('feeds ensemble external-seat delivery from the Channel authority', () => {
    const delivery = between('resolveExternalSeats: (chatId) => {', 'externalContributionQueue,')
    expect(delivery).toContain('resolveChannelExternalSeats(chatId)')
    expect(delivery).not.toContain('getShareForChat')

    // The orchestrator dep cannot express "unknown": an empty roster and an
    // unreadable one look identical to it. An unreadable authority therefore
    // DEFERS (the contribution stays queued and the next pass retries) and
    // says so, because silent inertness is the failure this seam shipped once.
    expect(delivery).toContain('if (seats === null)')
    expect(delivery).toContain('console.warn(')

    // A Channel-native seat carries no legacy share id, and identity stays on
    // collaboratorId — never a synthesised or inferred share.
    expect(delivery).toContain("shareId: ''")
    expect(delivery).toContain('collaboratorId: seat.seatId')
  })

  it('projects remote isShared from the active-channel set, not the retired share store', () => {
    // The People→Channel migration DELETES legacy share records at
    // finalization, so a task card whose isShared reads getShareForChat goes
    // permanently dark on iOS the moment migration commits — the phone's
    // channel-membership section silently empties.
    const card = between('const buildRemoteTaskCardForChat = (', 'const leanRemoteDiffSummary = (')
    expect(card).toContain('resolveActiveChannelChatIds()')
    expect(card).toContain('isShared: activeChannelChatIds.has(canonicalChat.appChatId),')
    expect(card).toContain(
      "sharedMode: activeChannelChatIds.has(canonicalChat.appChatId) ? 'channel' : undefined"
    )
    // P5-X2-b retired the People arm: sharing is Channel-native, and P5-A
    // sealed the contract that no automatic People share is ever created. The
    // retired store must not come back as a fallback — a union here would
    // resurrect a source that finalization deletes.
    expect(card).not.toContain('humanCollaborationStore.getShareForChat')
    expect(card).not.toContain('collaborationShare')

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

  it('keeps a Channel-shared chat out of reach of the abandoned-chat reaper', () => {
    // `getSharedChatIds` is the AbandonedChatReaper's protection list, and the
    // reaper DELETES. The People→Channel migration DELETES ordinary legacy
    // share records at finalization, so after cutover a Channel-shared chat
    // contributes nothing here unless the Channel authority is also a source:
    // an empty, unjoined, still-untitled Channel chat then looks exactly like
    // an abandoned draft to every other guard. Union, never replacement — the
    // legacy and queue sources stay for the pre-migration boot window.
    const sharedChatIds = between('getSharedChatIds: () => {', 'getOpenChatPopoutIds: () => {')
    expect(sharedChatIds).toContain('humanCollaborationStore.listShares()')
    expect(sharedChatIds).toContain('externalContributionQueue.chatIdsWithQueued()')
    expect(sharedChatIds).toContain('resolveActiveChannelChatIds()')

    // `resolveActiveChannelChatIds` returns the SAME empty set for "no active
    // channels" and "the channel authority is unreadable" (degraded launch,
    // service not running). Unioning it alone would therefore be silently
    // inert exactly when channels are down — and for a delete guard, inert
    // means the chat is unprotected. The unreadable case must fail closed.
    expect(sharedChatIds).toContain('if (!channelAuthorityIsReadable()) {')
    expect(sharedChatIds).toContain('for (const chat of AppStore.getChats()) chatIds.add(')
    expect(source).toContain('let channelAuthorityIsReadable: () => boolean = () => false')
  })
})
