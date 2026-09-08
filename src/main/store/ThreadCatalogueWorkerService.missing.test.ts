import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThreadCatalogueWorkerService } from './ThreadCatalogueWorkerService'
const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const profilePath = mkdtempSync(join(tmpdir(), 'catalogue-missing-confirmation-'))
  directories.push(profilePath)
  mkdirSync(join(profilePath, 'chats'))
  let resolve!: (value: { type: 'missing' }) => void
  const decoded = new Promise<{ type: 'missing' }>((done) => {
    resolve = done
  })
  const removeChat = vi.fn()
  const onRemoved = vi.fn()
  const worker = Object.create(ThreadCatalogueWorkerService.prototype)
  Object.assign(worker, {
    closed: false,
    changeSequence: 0,
    changes: [],
    options: {
      reader: { profilePath, runtimeInstanceId: 'test-runtime', segmented: false },
      onRemoved
    },
    catalogue: {
      epoch: () => ({ global: 'initial', chat: 'initial' }),
      sourceHeads: () => ({}),
      sourceDurabilityDebts: () => [],
      publicationPending: () => false
    },
    database: { removeChat, abandonGeneration: vi.fn() },
    decoder: { run: () => decoded }
  })
  return {
    profilePath,
    resolve,
    removeChat,
    onRemoved,
    read: () => worker.importChat({ chatId: 'chat-one', mode: 'metadata' }) as Promise<unknown>
  }
}
describe('ThreadCatalogueWorkerService missing-result validation', () => {
  it('does not remove a current row for an old missing decode after the source appears', async () => {
    const f = fixture()
    const reading = f.read()
    writeFileSync(
      join(f.profilePath, 'chats', 'chat-one.json'),
      JSON.stringify({ appChatId: 'chat-one' }),
      { mode: 0o600 }
    )
    f.resolve({ type: 'missing' })
    await expect(reading).rejects.toThrow('History changed during indexing')
    expect(f.removeChat).not.toHaveBeenCalled()
    expect(f.onRemoved).not.toHaveBeenCalled()
  })
  it('still publishes an authoritative absence when the source remains missing', async () => {
    const f = fixture()
    const reading = f.read()
    f.resolve({ type: 'missing' })
    await expect(reading).resolves.toBeNull()
    expect(f.removeChat).toHaveBeenCalledWith('chat-one')
    expect(f.onRemoved).toHaveBeenCalledWith('chat-one')
  })
})
