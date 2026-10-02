import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HOST_THREAD_RECORD_TRANSFER_SERVICE_NAME,
  configureHostThreadRecordTransferChannel,
  createWorkerThreadTransferChannel,
  hostThreadRecordTransferChannelFactory,
  type UtilityProcessChildLike,
  type UtilityProcessLike
} from '../../host-runtime/HostThreadRecordTransferWorker'
import { createDesktopHostThreadRecordPersistClient } from './HostThreadRecordPersistCommand'
import {
  HOST_THREAD_RECORD_TRANSFER_WORKER_THREAD_ENV,
  electronUtilityProcess,
  installHostThreadRecordTransferTransport,
  stageHostThreadRecordTransfer
} from './HostThreadRecordTransferTransport'

// The Desktop factory builds a projection broker; construction alone must not
// need a live Host, and this test never submits a command through it.
vi.mock('./HostProjectionBroker', () => ({
  createHostProjectionBroker: () => ({
    submitCommand: async () => {
      throw new Error('no Host in this test')
    },
    lookupReceipt: async () => {
      throw new Error('no Host in this test')
    }
  })
}))

function scriptedUtility(): {
  utility: UtilityProcessLike
  forks: Array<{ modulePath: string; options?: { serviceName?: string } }>
} {
  const forks: Array<{ modulePath: string; options?: { serviceName?: string } }> = []
  const exits: Array<(code: number) => void> = []
  const child: UtilityProcessChildLike = {
    postMessage: () => undefined,
    on: () => child,
    once: (event, listener) => {
      if (event === 'exit') exits.push(listener as (code: number) => void)
      return child
    },
    kill: () => {
      queueMicrotask(() => {
        for (const listener of exits.splice(0)) listener(0)
      })
      return true
    }
  }
  return {
    forks,
    utility: {
      fork(modulePath, _args, options) {
        forks.push({ modulePath, options })
        return child
      }
    }
  }
}

afterEach(() => {
  configureHostThreadRecordTransferChannel(createWorkerThreadTransferChannel)
})

describe('thread-record transfer transport (Desktop)', () => {
  it('rejects mismatched reference descriptors without publishing a fallback record', async () => {
    const publish = vi.fn()
    const counters = {
      referenceArtifacts: 0,
      recordArtifacts: 0,
      referenceDeclines: 0,
      referenceFailures: 0
    }
    await expect(
      stageHostThreadRecordTransfer({
        profilePath: '/tmp/profile',
        transferId: 'wanted',
        persist: {
          chatId: 'chat',
          expectedRevision: 0,
          record: {} as import('../store/types').ChatRecord
        },
        reference: {
          stage: () => ({ transferId: 'other', sha256: 'a'.repeat(64), byteLength: 3 })
        },
        transfer: { publish, remove: () => true },
        counters
      })
    ).rejects.toThrow('Invalid reference')
    expect(publish).not.toHaveBeenCalled()
    expect(counters.referenceFailures).toBe(1)
  })
  it('resolves the Electron utility process only under Electron main', () => {
    const utility: UtilityProcessLike = {
      fork: () => {
        throw new Error('unused')
      }
    }
    let loads = 0
    const load = (): { utilityProcess?: UtilityProcessLike } => {
      loads += 1
      return { utilityProcess: utility }
    }
    expect(electronUtilityProcess({ versions: {}, type: 'browser' }, load)).toBeUndefined()
    expect(
      electronUtilityProcess({ versions: { electron: '41.10.5' }, type: 'utility' }, load)
    ).toBeUndefined()
    expect(loads).toBe(0)
    expect(
      electronUtilityProcess({ versions: { electron: '41.10.5' }, type: 'browser' }, load)
    ).toBe(utility)
    expect(
      electronUtilityProcess({ versions: { electron: '41.10.5' }, type: 'browser' }, () => {
        throw new Error('electron is not importable here')
      })
    ).toBeUndefined()
    expect(
      electronUtilityProcess({ versions: { electron: '41.10.5' }, type: 'browser' }, () => ({}))
    ).toBeUndefined()
    // This test process is plain Node.
    expect(electronUtilityProcess()).toBeUndefined()
  })

  it('installs a utility-process factory for the shared worker and stays idempotent', async () => {
    const { utility, forks } = scriptedUtility()
    expect(installHostThreadRecordTransferTransport({ utility, env: {} })).toBe('utility-process')
    const factory = hostThreadRecordTransferChannelFactory()
    expect(factory).not.toBe(createWorkerThreadTransferChannel)
    const channel = factory('/out/main/HostThreadRecordTransferWorkerEntry.js')
    expect(channel.kind).toBe('utility-process')
    expect(forks).toEqual([
      {
        modulePath: '/out/main/HostThreadRecordTransferWorkerEntry.js',
        options: { serviceName: HOST_THREAD_RECORD_TRANSFER_SERVICE_NAME }
      }
    ])
    await channel.terminate()
    expect(installHostThreadRecordTransferTransport({ utility, env: {} })).toBe('utility-process')
    expect(hostThreadRecordTransferChannelFactory()).toBe(factory)
  })

  it('keeps the worker thread without Electron or when the escape hatch is set', () => {
    expect(installHostThreadRecordTransferTransport({ env: {} })).toBe('worker-thread')
    const { utility, forks } = scriptedUtility()
    expect(
      installHostThreadRecordTransferTransport({
        utility,
        env: { [HOST_THREAD_RECORD_TRANSFER_WORKER_THREAD_ENV]: '1' }
      })
    ).toBe('worker-thread')
    const channel = hostThreadRecordTransferChannelFactory()(
      '/out/main/HostThreadRecordTransferWorkerEntry.js'
    )
    // Not constructed: a worker-thread channel would spawn a real Worker here.
    expect(channel.kind).toBe('worker-thread')
    expect(forks).toEqual([])
  })

  it('is installed by the Desktop persist-client factory before its first persist', () => {
    expect(hostThreadRecordTransferChannelFactory()).toBe(createWorkerThreadTransferChannel)
    createDesktopHostThreadRecordPersistClient({
      userDataPath: mkdtempSync(join(tmpdir(), 'tw-transfer-transport-')),
      appVersion: '1.9.8'
    })
    // Plain Node resolves no utility process, but the installed factory is in place.
    expect(hostThreadRecordTransferChannelFactory()).not.toBe(createWorkerThreadTransferChannel)
  })
})
