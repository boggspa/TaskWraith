/**
 * Tool detail under barrier durability, through the real store and the
 * barrier's own port: what the save that ends a run keeps inline, the class
 * its batch is synced at, the refs a later save takes, and what no barrier
 * pays.
 */
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ThreadBarrierDurability } from './ThreadBarrierDurability'
import { readToolActivityDetailSync } from './ToolActivityDetailLedger'
import {
  chatRecord,
  disposeHostOwnedStores,
  importHostOwnedStore
} from './hostOwnedErasure.testutil'
import type { ToolActivity } from './types'

/** The layer the store built, as it built it. */
const built = vi.hoisted(() => ({ layers: [] as ThreadBarrierDurability[] }))

vi.mock('./ThreadBarrierDurability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ThreadBarrierDurability')>()
  return {
    ...actual,
    createThreadBarrierDurability: (
      ...args: Parameters<typeof actual.createThreadBarrierDurability>
    ) => {
      const layer = actual.createThreadBarrierDurability(...args)
      built.layers.push(layer)
      return layer
    }
  }
})

afterEach(async () => {
  await disposeHostOwnedStores()
  vi.unstubAllEnvs()
  built.layers.length = 0
})

const CHAT = 'chat-tool-detail'
const RUN = 'run-tool-detail'
const AT = '2026-10-05T00:00:00.000Z'

function activity(id: string): ToolActivity {
  return {
    id,
    toolName: 'run_shell_command',
    displayName: 'Ran command',
    category: 'shell',
    status: 'success',
    endedAt: AT,
    parameters: { command: `npm test -- ${id}` },
    resultSummary: `${id} passed`,
    rawResultEvent: { output: `output of ${id}` }
  }
}

/** A thread whose run made two tool calls, saved up to and including the save that ends it. */
async function runEnded() {
  vi.stubEnv('TASKWRAITH_THREAD_BARRIER_DURABILITY', '1')
  const { AppStore, profilePath } = await importHostOwnedStore([])
  const layer = built.layers[0]
  AppStore.saveChat(chatRecord(CHAT, 0))
  const created = AppStore.getChat(CHAT)!
  AppStore.saveChat({
    ...created,
    runs: [{ runId: RUN, startedAt: AT, status: 'running', provider: 'codex' }],
    messages: [
      ...created.messages,
      {
        id: 'tools',
        role: 'assistant',
        content: 'Ran them.',
        timestamp: AT,
        runId: RUN,
        toolActivities: [activity('tool-1'), activity('tool-2')]
      }
    ]
  })
  const running = AppStore.getChat(CHAT)!
  AppStore.saveChat({
    ...running,
    runs: running.runs.map((run) => ({ ...run, status: 'completed', endedAt: AT }))
  })
  const rows = (): ToolActivity[] =>
    AppStore.getChat(CHAT)!.messages.find((message) => message.id === 'tools')!.toolActivities!
  const staging = () => layer.snapshot().staging!
  return { AppStore, profilePath, layer, rows, staging }
}

describe('tool detail under barrier durability, through the real store', () => {
  it("keeps a run's detail inline at its end, syncs its batch in the background, and strips the rows at the next save", async () => {
    const { AppStore, profilePath, rows, staging } = await runEnded()

    expect(rows()).toEqual([activity('tool-1'), activity('tool-2')])
    expect(staging()).toMatchObject({ batches: { committed: 1 }, rows: { staged: 2 } })

    await vi.waitFor(() => expect(staging().batches.durable).toBe(1))
    // Every sync the batch asked for was at background class.
    const { port } = AppStore.getThreadBarrierDurabilityPerf()
    expect(port!.startedBackground).toBe(staging().syncs.files + staging().syncs.directories)
    expect(port!.startedBackground).toBeGreaterThan(0)

    AppStore.saveChat({ ...AppStore.getChat(CHAT)!, title: 'The next save' })

    expect(staging().rows.swapped).toBe(2)
    const runArtifactsDir = join(profilePath, 'run-artifacts')
    for (const [index, row] of rows().entries()) {
      expect(row.rawResultEvent).toBeUndefined()
      expect(readToolActivityDetailSync(runArtifactsDir, row.detailRef!)).toEqual(
        activity(`tool-${index + 1}`)
      )
    }
  })

  it("pays none of it at the run's final barrier or at a user's, and the counts show it", async () => {
    const { AppStore, layer, staging } = await runEnded()
    await layer.tickets.awaitChat(CHAT)
    await vi.waitFor(() => expect(staging().batches.durable).toBe(1))
    AppStore.saveChat({
      ...AppStore.getChat(CHAT)!,
      messages: [
        ...AppStore.getChat(CHAT)!.messages,
        { id: 'user-2', role: 'user', content: 'Thanks', timestamp: AT }
      ]
    })
    await layer.tickets.awaitChat(CHAT, ['user_message'])

    const debt = layer.debt.snapshot()
    expect(layer.tickets.snapshot().moments).toMatchObject({
      user_message: { noted: 2 },
      run_final: { noted: 1 }
    })
    expect(debt.owners.detail).toMatchObject({ noted: 0, synced: 0 })
    // The barriers paid the journal and the run's events; the detail, its
    // folders and its checkpoint were the staging's, each at background class.
    expect(debt.owners.journal.synced).toBeGreaterThan(0)
    expect(AppStore.getThreadBarrierDurabilityPerf().port!.startedBackground).toBe(
      staging().syncs.files + staging().syncs.directories
    )
  })
})
