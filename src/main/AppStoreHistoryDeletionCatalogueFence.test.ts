import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import { join } from 'path'
import { AppStore, HistoryDeletionIncompleteError, type CatalogueErasureFence } from './store'
import type { ChatRecord } from './store/types'

const userDataPath = vi.hoisted(() => `/tmp/taskwraith-history-deletion-fence-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataPath
  }
}))

const historyIntentPath = join(userDataPath, 'history-deletion-intent.json')
const chatsDir = join(userDataPath, 'chats')
const chatPath = (chatId: string) => join(chatsDir, `${chatId}.json`)

function saveChat(chatId: string): void {
  AppStore.saveChat({
    appChatId: chatId,
    scope: 'workspace',
    chatKind: 'single',
    provider: 'codex',
    title: chatId,
    workspaceId: 'workspace-a',
    workspacePath: '/repo/workspace-a',
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    messages: [],
    runs: []
  } as ChatRecord)
}

const FENCE: CatalogueErasureFence = { chatId: 'chat-a', generation: 'generation-1' }

function install(options: { finish?: () => Promise<void> } = {}) {
  const events: string[] = []
  const begin = vi.fn(async (_preparation: unknown, recorded: readonly CatalogueErasureFence[]) => {
    events.push(
      `begin(sources=${fs.existsSync(chatPath('chat-a')) ? 'present' : 'removed'},intent=${fs.existsSync(historyIntentPath)},recorded=${recorded.length})`
    )
    return [FENCE]
  })
  const finish = vi.fn(async (_preparation: unknown, fences: readonly CatalogueErasureFence[]) => {
    events.push(
      `finish(sources=${fs.existsSync(chatPath('chat-a')) ? 'present' : 'removed'},intent=${fs.existsSync(historyIntentPath)},fences=${fences.map((fence) => fence.generation).join()})`
    )
    await options.finish?.()
  })
  AppStore.installCatalogueErasureFinish(finish)
  AppStore.installCatalogueErasure(
    begin,
    async () => {},
    () => {}
  )
  return { events, begin, finish }
}

/** The commit may throw or return a promise; the tests want a promise either way. */
const commit = (operationId: string): Promise<void> =>
  Promise.resolve().then(() => AppStore.commitPreparedHistoryDeletion(operationId))

function prepare(): string {
  return AppStore.prepareHistoryDeletion({
    kind: 'chat',
    rootChatId: 'chat-a',
    quiescenceTargets: []
  }).operationId
}

describe('history deletion catalogue fence', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(userDataPath, { recursive: true, force: true })
    fs.mkdirSync(chatsDir, { recursive: true })
    AppStore.resetTransientDeletionGuardsForTests()
    saveChat('chat-a')
  })

  afterEach(() => {
    AppStore.setHistoryDeletionFailureInjectionForTests([])
    vi.restoreAllMocks()
  })

  it('raises the fence before any source is removed and lifts it only after verification, before the intent goes', async () => {
    const { events, begin, finish } = install()

    await AppStore.commitPreparedHistoryDeletion(prepare())

    // Begin runs once for the commit and once more in the residual sweep, where
    // the recorded fence makes it a resume of the same erasure.
    expect(events).toEqual([
      'begin(sources=present,intent=true,recorded=0)',
      'begin(sources=removed,intent=true,recorded=1)',
      'finish(sources=removed,intent=true,fences=generation-1)'
    ])
    expect(begin).toHaveBeenCalledTimes(2)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(historyIntentPath)).toBe(false)
  })

  it('keeps the fence when the deletion fails, and a restart resumes the recorded generation', async () => {
    const { events, finish } = install()
    AppStore.setHistoryDeletionFailureInjectionForTests(['run-events'])

    await expect(AppStore.commitPreparedHistoryDeletion(prepare())).rejects.toBeInstanceOf(
      HistoryDeletionIncompleteError
    )

    expect(finish).not.toHaveBeenCalled()
    const retained = JSON.parse(fs.readFileSync(historyIntentPath, 'utf8')) as {
      catalogueErasureFences?: CatalogueErasureFence[]
    }
    expect(retained.catalogueErasureFences).toEqual([FENCE])

    AppStore.setHistoryDeletionFailureInjectionForTests([])
    events.length = 0
    await AppStore.recoverPendingHistoryDeletion()

    expect(events[0]).toBe('begin(sources=removed,intent=true,recorded=1)')
    expect(events.at(-1)).toBe('finish(sources=removed,intent=true,fences=generation-1)')
    expect(finish).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(historyIntentPath)).toBe(false)
  })

  it('a finish that is not acknowledged keeps the intent and names the catalogue step', async () => {
    let refuse = true
    const { finish } = install({
      finish: async () => {
        if (refuse) throw new Error('History catalogue erasure was not acknowledged')
      }
    })

    const error = await commit(prepare()).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(HistoryDeletionIncompleteError)
    expect((error as HistoryDeletionIncompleteError).failures).toEqual([
      { step: 'thread-catalogue', message: 'History catalogue erasure was not acknowledged' }
    ])
    expect(fs.existsSync(historyIntentPath)).toBe(true)

    refuse = false
    await AppStore.recoverPendingHistoryDeletion()

    expect(finish).toHaveBeenCalledTimes(2)
    expect(fs.existsSync(historyIntentPath)).toBe(false)
  })

  it('a begin that fails does not stop source removal, and never reaches finish', async () => {
    const { finish } = install()
    AppStore.installCatalogueErasure(
      async () => {
        throw new Error('fence could not be raised')
      },
      async () => {},
      () => {}
    )

    const error = await commit(prepare()).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(HistoryDeletionIncompleteError)
    expect(finish).not.toHaveBeenCalled()
    expect(fs.existsSync(chatPath('chat-a'))).toBe(false)
    expect(fs.existsSync(historyIntentPath)).toBe(true)
  })

  it('discards a recorded fence that does not parse instead of wedging the intent', async () => {
    install()
    const operationId = prepare()
    const intent = JSON.parse(fs.readFileSync(historyIntentPath, 'utf8'))
    intent.catalogueErasureFences = [
      { chatId: 'not-in-scope', generation: 'g' },
      { chatId: 'chat-a', generation: '' },
      'junk',
      { chatId: 'chat-a', generation: 'good' }
    ]
    fs.writeFileSync(historyIntentPath, JSON.stringify(intent))

    expect(AppStore.getPendingHistoryDeletion()?.operationId).toBe(operationId)
    const { events } = install()
    await AppStore.commitPreparedHistoryDeletion(operationId)

    expect(events[0]).toBe('begin(sources=present,intent=true,recorded=1)')
  })
})
