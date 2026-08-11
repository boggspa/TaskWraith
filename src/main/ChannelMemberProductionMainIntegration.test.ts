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

describe('Channel member production main integration', () => {
  it('starts one extracted main-only member authority before history recovery', () => {
    const composition = between(
      'let channelMemberProductionBootstrap:',
      'const purgeChannelsForHistoryPreparation = '
    )

    expect(composition).toContain('createChannelMemberProductionBootstrap({')
    expect(composition).toContain("userDataPath: app.getPath('userData')")
    expect(composition).toContain('safeStorage,')
    expect(composition).toContain('ipc: ipcMain')
    expect(composition).toContain('assertMainRendererSender,')
    expect(composition).toContain('channelMemberProductionBootstrap.start()')
    expect(composition).toContain(
      'mainWindow.webContents.send(CHANNEL_MEMBER_IPC_CHANGED_EVENT, event)'
    )

    const hostStart = source.indexOf('startPeopleToChannelMigrationBootstrap({')
    const memberStart = source.indexOf('channelMemberProductionBootstrap.start()')
    const recovery = source.indexOf('await recoverPendingHistoryDeletionBeforeRunQueue()')
    expect(hostStart).toBeGreaterThanOrEqual(0)
    expect(memberStart).toBeGreaterThan(hostStart)
    expect(recovery).toBeGreaterThan(memberStart)
  })

  it('keeps foreign memberships outside hosted-chat history deletion', () => {
    const deletion = between(
      'const purgeChannelsForHistoryPreparation = ',
      'const scopedHistoryDeletionCoordinator = new ScopedHistoryDeletionCoordinator({'
    )

    expect(deletion).toContain('channelProductionBootstrap?.service')
    expect(deletion).not.toContain('channelMemberProductionBootstrap?.service')
    expect(source).not.toContain('channelMemberProductionBootstrap?.service.forget')
  })

  it('stops the member authority during process shutdown', () => {
    const shutdown = between(
      "app.on('will-quit', () => {",
      '// A crash after durable history prepare'
    )

    expect(shutdown).toContain('channelMemberProductionBootstrap?.stop().catch((error) => {')
    expect(shutdown).toContain("'[channels] member production shutdown failed'")
  })
})
