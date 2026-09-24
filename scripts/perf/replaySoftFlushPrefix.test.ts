import { createRequire } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildReplaySchedule } = require('./fixtureGenerator.cjs')
const { createCdpPageApiAdapter, runDeterministicReplay } = require('./replayDriver.cjs')
const { planLaneReplay } = require('./concurrentReplayLanes.cjs')

function fixture(messageCount: number) {
  const chat = {
    appChatId: 'soft-prefix-chat',
    scope: 'global',
    persistenceRevision: 1,
    updatedAt: 1,
    runs: [],
    messages: Array.from({ length: messageCount }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `content-${index}`
    }))
  }
  const input = { chats: [chat], workload: 'soft-prefix-regression', seed: 42 }
  return { ...input, replaySchedule: buildReplaySchedule(input) }
}

describe.each(['prefix', 'fallback'])('D1 fixture boundary through evaluated %s saves', (path) => {
  it.each([26, 51, 76])(
    'retains the just-appended row at every flush in a %i-row schedule',
    async (count) => {
      const input = fixture(count)
      let canonical = structuredClone(input.chats[0])
      const context = createContext({
        window: {
          api: {
            getChat: () => canonical,
            saveChatWithOutcome: (record: typeof canonical) => {
              const accepted = record.persistenceRevision === canonical.persistenceRevision
              if (accepted)
                canonical = {
                  ...structuredClone(record),
                  persistenceRevision: canonical.persistenceRevision + 1
                }
              return { accepted, chat: canonical }
            }
          }
        }
      })
      const adapter = createCdpPageApiAdapter({
        evaluate: (expression: string) => runInContext(expression, context)
      })
      const api =
        path === 'prefix' ? adapter : { getChat: adapter.getChat, saveChat: adapter.saveChat }
      let precedingRows: typeof canonical.messages = []
      const observedFlushCounts: number[] = []
      const result = await runDeterministicReplay({
        api,
        fixture: input,
        onProgress: ({ kind }: { kind: string }) => {
          if (kind === 'durability_soft_flush') {
            expect(canonical.messages).toEqual(precedingRows)
            observedFlushCounts.push(canonical.messages.length)
          }
          precedingRows = structuredClone(canonical.messages)
        }
      })
      expect(observedFlushCounts).toEqual([26, 51, 76].filter((boundary) => boundary <= count))
      expect(canonical.messages).toEqual(input.chats[0].messages)
      expect(
        result.unsupported.filter(
          (entry: { field?: string }) => entry.field === 'integratedOrchestratorTick'
        )
      ).toHaveLength(observedFlushCounts.length)
    }
  )
})

it('keeps the post-append flush at the first included seeded-tail row', () => {
  const input = fixture(26)
  const plan = planLaneReplay(
    {
      role: 'heavy',
      chatId: input.chats[0].appChatId,
      chats: input.chats,
      schedule: input.replaySchedule
    },
    { seededTailMinSeededRecordBytes: 1, seededTailMessageCount: 1 }
  )
  expect(plan.basis).toBe('seeded_tail')
  expect(plan.rewindMessageCount).toBe(25)
  expect(
    plan.schedule.filter((event: { kind: string }) => event.kind === 'durability_soft_flush')
  ).toEqual([expect.objectContaining({ messageIndex: 26 })])
})
