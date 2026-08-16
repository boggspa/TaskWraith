import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatRecord } from './store/types'
import { buildChatMarkdownTranscript } from './TranscriptMarkdownExport'
import { writeChatMarkdownTranscriptToFile } from './TranscriptMarkdownFileExport'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('writeChatMarkdownTranscriptToFile', () => {
  it('writes the same safe Markdown directly to a file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'taskwraith-transcript-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'mission.md')
    const chat: ChatRecord = {
      appChatId: 'chat-1',
      title: 'Mission',
      chatKind: 'ensemble',
      provider: 'codex',
      createdAt: 1,
      updatedAt: 1,
      archived: false,
      messages: [
        {
          id: 'message-1',
          role: 'user',
          content: 'Run the mission.',
          timestamp: '2026-08-16T10:00:00.000Z'
        }
      ],
      runs: []
    }
    const options = {
      copiedAt: '2026-08-16T10:02:00.000Z',
      scopeLabel: 'Entire task'
    }

    const result = await writeChatMarkdownTranscriptToFile(chat, options, filePath)
    const written = await readFile(filePath, 'utf8')
    const built = buildChatMarkdownTranscript(chat, options)

    expect(written).toBe(built.markdown)
    expect(result).toEqual({
      messageCount: built.messageCount,
      charCount: built.charCount,
      omissions: built.omissions
    })
  })
})
