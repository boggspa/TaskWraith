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
  it('starts the extracted bootstrap with the shared encrypted identity before recovery', () => {
    const composition = between(
      'let channelProductionBootstrap:',
      'type BroadHistoryStrictAttempt = {'
    )
    expect(composition).toContain('createChannelProductionBootstrap({')
    expect(composition).toContain("'human-collaboration-identity.json'")
    expect(composition).toContain('safeStorage,')
    expect(composition).toContain('createChannelProductionRelayPort({')
    expect(composition).toContain('getEmbeddedRelayPort: () => embeddedRelayHandle?.port')
    expect(composition).toContain(
      'getAdvertisedRelayUrls: () => iosRemoteRuntime?.describeHost().relayUrls ?? []'
    )
    expect(composition).toContain('channelProductionBootstrap.start()')
    expect(composition).toContain('workspacePopoutOwnerForSender(senderId)')
    expect(composition).toContain('agentManagement: {')
    expect(composition).toContain('getSettings: () => AppStore.getSettings()')
    expect(composition).toContain('selectableProviderIds(settings).includes(provider)')
    expect(composition).toContain('getWorkspaces: () => AppStore.getWorkspaces()')
    expect(composition).toContain('canonicalizePath: canonicalPath')
    expect(composition).toContain(
      'getOwnerWindow: (event) => BrowserWindow.fromWebContents(event.sender)'
    )
    expect(composition).not.toContain('confirm:')
    expect(composition).toContain('win.webContents.send(CHANNEL_IPC_CHANGED_EVENT, event)')
    expect(composition).toContain('historyClearAdmissionGate.isAuthorityBlocked({')

    const start = source.indexOf('channelProductionBootstrap.start()')
    const recovery = source.indexOf('await recoverPendingHistoryDeletionBeforeRunQueue()')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(recovery).toBeGreaterThan(start)
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
})
