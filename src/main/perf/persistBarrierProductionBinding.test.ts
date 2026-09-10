import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const storeSource = readFileSync(new URL('../store/index.ts', import.meta.url), 'utf8')
const persistSource = readFileSync(
  new URL('../host/HostThreadRecordPersistCommand.ts', import.meta.url),
  'utf8'
)

describe('persist_barrier production binding', () => {
  it('wraps the public awaitChatRecordPersisted entry so joiners are measured', () => {
    expect(storeSource).toContain('observePersistBarrierSpan(')
    expect(storeSource).toContain('mainWorkSpanSink()')
    expect(storeSource).toContain("reason: 'barrier'")
    expect(storeSource).toContain('awaitChatRecordPersistedWork(')
  })

  it('wraps the persist-client receipt poll with the Host command id', () => {
    expect(persistSource).toContain('observePersistBarrierSpan(')
    expect(persistSource).toContain("reason: 'receipt_poll'")
    expect(persistSource).toContain('runId: command.commandId')
    expect(persistSource).toContain('spans: input.spans ?? mainWorkSpanSink()')
  })
})
