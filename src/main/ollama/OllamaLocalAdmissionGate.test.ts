import { describe, expect, it } from 'vitest'
import { OllamaLocalAdmissionGate } from './OllamaLocalAdmissionGate'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('OllamaLocalAdmissionGate', () => {
  it('admits everything immediately when capacity is unknown', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: undefined })
    const tickets = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((model) => gate.acquire(model)))
    expect(tickets).toHaveLength(5)
    expect(gate.waiting).toBe(0)
    expect(gate.inFlight).toBe(5)
  })

  it('holds a request past the capacity of distinct models until one releases', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: 2 })
    const first = await gate.acquire('qwen')
    await gate.acquire('granite')

    let thirdAdmitted = false
    const third = gate.acquire('llama').then((ticket) => {
      thirdAdmitted = true
      return ticket
    })

    await settle()
    expect(thirdAdmitted).toBe(false)
    expect(gate.waiting).toBe(1)
    expect(gate.inFlight).toBe(2)

    first.release()
    await third
    expect(thirdAdmitted).toBe(true)
    expect(gate.waiting).toBe(0)
    expect(gate.inFlight).toBe(2)
  })

  it('counts DISTINCT models, so a second lane on a resident model is free', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: 2 })
    await gate.acquire('qwen')
    await gate.acquire('granite')

    let sharedAdmitted = false
    void gate.acquire('qwen').then(() => {
      sharedAdmitted = true
    })
    await settle()

    expect(sharedAdmitted).toBe(true)
    expect(gate.inFlight).toBe(2)
  })

  it('keeps a shared model resident until the last holder releases', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: 1 })
    const a = await gate.acquire('qwen')
    const b = await gate.acquire('qwen')

    let nextAdmitted = false
    void gate.acquire('granite').then(() => {
      nextAdmitted = true
    })

    a.release()
    await settle()
    expect(nextAdmitted).toBe(false)
    expect(gate.inFlight).toBe(1)

    b.release()
    await settle()
    expect(nextAdmitted).toBe(true)
  })

  it('admits waiters in FIFO order', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: 1 })
    const held = await gate.acquire('first')
    const order: string[] = []
    void gate.acquire('second').then((t) => {
      order.push('second')
      t.release()
    })
    void gate.acquire('third').then((t) => {
      order.push('third')
      t.release()
    })

    held.release()
    await settle()
    await settle()
    expect(order).toEqual(['second', 'third'])
  })

  it('ignores a double release rather than over-crediting capacity', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: 1 })
    const ticket = await gate.acquire('qwen')
    ticket.release()
    ticket.release()
    expect(gate.inFlight).toBe(0)

    await gate.acquire('granite')
    expect(gate.inFlight).toBe(1)
  })

  it('drains waiters when capacity is raised, and never evicts in-flight when lowered', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: 1 })
    await gate.acquire('qwen')
    let admitted = false
    void gate.acquire('granite').then(() => {
      admitted = true
    })
    await settle()
    expect(admitted).toBe(false)

    gate.setCapacity(2)
    await settle()
    expect(admitted).toBe(true)
    expect(gate.inFlight).toBe(2)

    gate.setCapacity(1)
    expect(gate.inFlight).toBe(2)
  })

  it('becomes unbounded when capacity is cleared', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: 1 })
    await gate.acquire('qwen')
    let admitted = false
    void gate.acquire('granite').then(() => {
      admitted = true
    })
    await settle()
    expect(admitted).toBe(false)

    gate.setCapacity(undefined)
    await settle()
    expect(admitted).toBe(true)
  })

  it('drops an aborted waiter without leaking the slot it was queued for', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: 1 })
    const held = await gate.acquire('qwen')
    const controller = new AbortController()
    const rejected = gate.acquire('granite', controller.signal).catch((error: Error) => error.name)

    await settle()
    expect(gate.waiting).toBe(1)
    controller.abort()
    await expect(rejected).resolves.toBe('AbortError')
    expect(gate.waiting).toBe(0)

    held.release()
    const next = await gate.acquire('llama')
    expect(next).toBeDefined()
    expect(gate.inFlight).toBe(1)
  })

  it('rejects immediately when handed an already-aborted signal', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: 4 })
    const controller = new AbortController()
    controller.abort()
    await expect(gate.acquire('qwen', controller.signal)).rejects.toThrow()
    expect(gate.inFlight).toBe(0)
  })
})

describe('OllamaLocalAdmissionGate.reconcile', () => {
  it('reclaims a slot whose holder died without releasing', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: 2 })
    await gate.acquire('qwen')
    await gate.acquire('granite')
    let admitted = false
    void gate.acquire('llama').then(() => {
      admitted = true
    })
    await settle()
    expect(admitted).toBe(false)

    // 'granite' crashed: its run is gone but release() never ran.
    gate.reconcile(['qwen'])
    await settle()

    expect(admitted).toBe(true)
    expect(gate.inFlight).toBe(2)
  })

  it('does not disturb slots that are still genuinely live', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: 2 })
    const qwen = await gate.acquire('qwen')
    await gate.acquire('granite')
    gate.reconcile(['qwen', 'granite'])
    expect(gate.inFlight).toBe(2)

    // The surviving ticket still releases correctly after a reconcile.
    qwen.release()
    expect(gate.inFlight).toBe(1)
  })

  it('makes a stale ticket release a no-op instead of freeing a live slot', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: 2 })
    const stale = await gate.acquire('qwen')
    gate.reconcile([])
    expect(gate.inFlight).toBe(0)

    // A later lane legitimately takes qwen's slot.
    await gate.acquire('qwen')
    expect(gate.inFlight).toBe(1)

    // The dead run's late release must not evict the new holder.
    stale.release()
    expect(gate.inFlight).toBe(1)
  })

  it('drops every slot when authoritative state says nothing is running', async () => {
    const gate = new OllamaLocalAdmissionGate({ capacity: 1 })
    await gate.acquire('qwen')
    let admitted = false
    void gate.acquire('granite').then(() => {
      admitted = true
    })
    await settle()
    expect(admitted).toBe(false)

    gate.reconcile([])
    await settle()
    expect(admitted).toBe(true)
  })
})
