import { describe, expect, it, vi } from 'vitest'
import {
  createMainRunEventProducerQuiescence,
  type MainRunEventProducer
} from './MainRunEventProducerQuiescence'

function held() {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function harness(producers: MainRunEventProducer[]) {
  const order: string[] = []
  const ports = {
    fenceAdmissions: vi.fn(() => {
      order.push('admissions')
    }),
    fenceQueueDispatch: vi.fn(() => {
      order.push('queue')
    }),
    fenceNativeActions: vi.fn(() => {
      order.push('native')
    }),
    snapshot: vi.fn(() => {
      order.push('snapshot')
      return producers
    })
  }
  return { order, ports, coordinator: createMainRunEventProducerQuiescence(ports) }
}

describe('MainRunEventProducerQuiescence', () => {
  it('fences synchronously, joins transport and audit, and leaves independent Host work untouched', async () => {
    const transport = held()
    const audit = held()
    const hostJoin = vi.fn(async () => true)
    const h = harness([
      { id: 'solo', ownership: 'main', join: () => transport.promise },
      { id: 'audit', ownership: 'main', join: () => audit.promise },
      { id: 'host', ownership: 'independent-host', join: hostJoin }
    ])
    const result = h.coordinator.quiesce()
    expect(h.order.slice(0, 4)).toEqual(['admissions', 'queue', 'native', 'snapshot'])
    expect(h.coordinator.quiesce()).toBe(result)
    let complete = false
    void result.then(() => {
      complete = true
    })
    transport.resolve(true)
    await Promise.resolve()
    expect(complete).toBe(false)
    audit.resolve(true)
    await result
    expect(hostJoin).not.toHaveBeenCalled()
  })

  it('joins a late audit registered by a captured transport terminal callback', async () => {
    const audit = held()
    const entries: MainRunEventProducer[] = []
    const auditJoin = vi.fn(() => audit.promise)
    entries.push({
      id: 'transport',
      ownership: 'main',
      join: async () => {
        entries.push({ id: 'late-audit', ownership: 'main', join: auditJoin })
        return true
      }
    })
    const h = harness(entries)
    const result = h.coordinator.quiesce()
    await vi.waitFor(() => expect(auditJoin).toHaveBeenCalledOnce())
    audit.resolve(true)
    await result
  })

  it('rejects unknown ownership while still joining captured main operations', async () => {
    const join = vi.fn(async () => true)
    const h = harness([
      { id: 'unknown', ownership: 'unknown', join: vi.fn() },
      { id: 'main', ownership: 'main', join }
    ])
    await expect(h.coordinator.quiesce()).rejects.toThrow('did not quiesce')
    expect(join).toHaveBeenCalledOnce()
  })

  it('rejects a late unknown producer and retries after ownership is resolved', async () => {
    const entries: MainRunEventProducer[] = []
    const unknown: MainRunEventProducer = {
      id: 'late-unknown',
      ownership: 'unknown',
      join: vi.fn(async () => true)
    }
    entries.push({
      id: 'parent',
      ownership: 'main',
      join: async () => {
        if (!entries.includes(unknown)) entries.push(unknown)
        return true
      }
    })
    const h = harness(entries)
    await expect(h.coordinator.quiesce()).rejects.toThrow('did not quiesce')
    expect(unknown.join).not.toHaveBeenCalled()
    entries.splice(0, entries.length, { ...unknown, ownership: 'independent-host' })
    await h.coordinator.quiesce()
    expect(unknown.join).not.toHaveBeenCalled()
  })

  it('retries failed joins with fresh snapshots while keeping the quit fences', async () => {
    const join = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const h = harness([{ id: 'solo', ownership: 'main', join }])
    await expect(h.coordinator.quiesce()).rejects.toThrow('did not quiesce')
    await h.coordinator.quiesce()
    expect(join).toHaveBeenCalledTimes(2)
    expect(h.ports.fenceAdmissions).toHaveBeenCalledOnce()
    expect(h.ports.fenceQueueDispatch).toHaveBeenCalledOnce()
    expect(h.ports.fenceNativeActions).toHaveBeenCalledOnce()
  })

  it('attempts all fences, snapshots only after success, and retries only failed fences', async () => {
    const h = harness([])
    h.ports.fenceAdmissions.mockImplementationOnce(() => {
      throw new Error('fence failed')
    })
    await expect(h.coordinator.quiesce()).rejects.toThrow('quit fence failed')
    expect(h.ports.snapshot).not.toHaveBeenCalled()
    await h.coordinator.quiesce()
    expect(h.ports.fenceAdmissions).toHaveBeenCalledTimes(2)
    expect(h.ports.fenceQueueDispatch).toHaveBeenCalledOnce()
    expect(h.ports.fenceNativeActions).toHaveBeenCalledOnce()
  })
})
