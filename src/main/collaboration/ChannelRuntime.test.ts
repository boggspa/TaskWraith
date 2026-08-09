import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { generateIdentityKeyPair } from '../../shared/e2ee/keys'
import { ChannelMessageLog } from './ChannelMessageLog'
import { ChannelRuntime, type ChannelRuntimeTransport } from './ChannelRuntime'
import { ChannelStore } from './ChannelStore'

const temporaryDirectories: string[] = []

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'taskwraith-channel-runtime-fault-'))
  temporaryDirectories.push(path)
  return path
}

class RecordingTransport implements ChannelRuntimeTransport {
  readonly sent: Array<{ roomId: string; payload: string }> = []
  readonly closed: string[] = []

  send(roomId: string, payload: string): boolean {
    this.sent.push({ roomId, payload })
    return true
  }

  close(roomId: string): void {
    this.closed.push(roomId)
  }
}

describe('ChannelRuntime durability boundary', () => {
  it('recovers a crash after fsync but before fan-out and deduplicates the retry', async () => {
    const root = directory()
    const storePath = join(root, 'channels.json')
    const logPath = join(root, 'logs')
    const identity = generateIdentityKeyPair()
    const store = new ChannelStore(storePath)
    const log = new ChannelMessageLog(logPath, store)
    let faultArmed = true
    const runtime = new ChannelRuntime({
      identityKeyPair: identity,
      store,
      log,
      afterDurableCommit: () => {
        if (!faultArmed) return
        faultArmed = false
        throw new Error('injected crash after durable commit')
      }
    })
    const transport = new RecordingTransport()
    runtime.attachTransport(transport)
    const created = runtime.createChannel({
      chatId: 'chat',
      title: 'Channel',
      ownerDisplayName: 'Host'
    })
    const input = {
      clientMessageId: 'crash-window',
      content: 'survives restart'
    }

    await expect(runtime.appendHost(created.channel.channelId, input)).rejects.toThrow(
      'injected crash after durable commit'
    )
    expect(log.highWaterSequence(created.channel.channelId)).toBe(1)
    expect(log.getMessage(created.channel.channelId, 1)).toMatchObject({
      sequence: 1,
      content: 'survives restart'
    })
    expect(transport.sent).toEqual([])
    runtime.dispose()

    const restartedStore = new ChannelStore(storePath)
    const restartedLog = new ChannelMessageLog(logPath, restartedStore)
    const restarted = new ChannelRuntime({
      identityKeyPair: identity,
      store: restartedStore,
      log: restartedLog
    })
    const restartedTransport = new RecordingTransport()
    restarted.attachTransport(restartedTransport)
    const retry = await restarted.appendHost(created.channel.channelId, input)
    expect(retry).toMatchObject({ deduplicated: true, record: { sequence: 1 } })
    expect(restartedLog.highWaterSequence(created.channel.channelId)).toBe(1)
    expect(restartedTransport.sent).toEqual([])

    const next = await restarted.appendHost(created.channel.channelId, {
      clientMessageId: 'after-restart',
      content: 'next'
    })
    expect(next).toMatchObject({ deduplicated: false, record: { sequence: 2 } })
    expect(restartedLog.highWaterSequence(created.channel.channelId)).toBe(2)
    restarted.dispose()
  })

  it('rejects an agent-shaped host append before it consumes a sequence', async () => {
    const root = directory()
    const store = new ChannelStore(join(root, 'channels.json'))
    const log = new ChannelMessageLog(join(root, 'logs'), store)
    const runtime = new ChannelRuntime({
      identityKeyPair: generateIdentityKeyPair(),
      store,
      log
    })
    const created = runtime.createChannel({
      chatId: 'chat',
      title: 'Channel',
      ownerDisplayName: 'Host'
    })

    await expect(
      runtime.appendHost(created.channel.channelId, {
        clientMessageId: 'agent',
        content: 'dispatch',
        kind: 'agent.text'
      } as never)
    ).rejects.toMatchObject({ code: 'human_only' })
    expect(log.highWaterSequence(created.channel.channelId)).toBe(0)
    runtime.dispose()
  })
})
