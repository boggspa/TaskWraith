import { mkdtemp, mkdir, writeFile, rm, utimes, open } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), `taskwraith-external-activity-electron-${process.pid}`)
  }
}))

import { loadExternalProviderUsageRecords } from './ExternalProviderActivity'
import { resetExternalActivityFileCacheForTests } from './ExternalActivityFileCache'

beforeEach(() => {
  resetExternalActivityFileCacheForTests()
})

describe('loadExternalProviderUsageRecords', () => {
  it('normalizes external provider logs into UsageRecord rows', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-activity-'))
    try {
      await mkdir(join(homeDir, '.codex', 'sessions', '2026', '05', '31'), { recursive: true })
      await mkdir(join(homeDir, '.claude', 'projects', 'sample'), { recursive: true })
      await mkdir(join(homeDir, '.gemini', 'tmp', 'sample', 'chats'), { recursive: true })
      await mkdir(join(homeDir, '.kimi', 'sessions', 'sample', 'turn'), { recursive: true })

      await writeFile(
        join(homeDir, '.codex', 'sessions', '2026', '05', '31', 'rollout.jsonl'),
        [
          JSON.stringify({
            timestamp: '2026-05-31T08:59:00.000Z',
            type: 'turn_context',
            payload: {
              type: 'turn_context',
              model: 'gpt-5.5'
            }
          }),
          JSON.stringify({
            timestamp: '2026-05-31T09:00:00.000Z',
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: {
                  input_tokens: 10,
                  cached_input_tokens: 5,
                  output_tokens: 7,
                  reasoning_output_tokens: 3,
                  total_tokens: 25
                }
              }
            }
          })
        ].join('\n')
      )

      await writeFile(
        join(homeDir, '.claude', 'projects', 'sample', 'thread.jsonl'),
        [
          JSON.stringify({
            timestamp: '2026-05-31T10:00:00.000Z',
            requestId: 'req-1',
            message: {
              id: 'msg-1',
              model: 'claude-sonnet',
              usage: {
                input_tokens: 11,
                cache_read_input_tokens: 3,
                output_tokens: 5
              }
            }
          })
        ].join('\n')
      )

      await writeFile(
        join(homeDir, '.gemini', 'tmp', 'sample', 'chats', 'session-2026-05-31.jsonl'),
        [
          JSON.stringify({
            id: 'gemini-1',
            timestamp: '2026-05-31T11:00:00.000Z',
            type: 'gemini',
            model: 'gemini-3.1-pro-preview',
            tokens: { input: 20, output: 4, total: 24 }
          })
        ].join('\n')
      )

      await writeFile(
        join(homeDir, '.kimi', 'sessions', 'sample', 'turn', 'wire.jsonl'),
        [
          JSON.stringify({
            timestamp: Date.parse('2026-05-31T12:00:00.000Z') / 1000,
            message: {
              type: 'StatusUpdate',
              payload: {
                token_usage: {
                  input_other: 13,
                  input_cache_read: 2,
                  input_cache_creation: 1,
                  output: 9
                }
              }
            }
          })
        ].join('\n')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z')
      })
      const byProvider = new Map(records.map((record) => [record.provider, record]))

      expect(byProvider.get('codex')?.totalTokens).toBe(25)
      expect(byProvider.get('codex')?.model).toBe('gpt-5.5')
      expect(byProvider.get('claude')?.totalTokens).toBe(19)
      expect(byProvider.get('claude')?.inputTokens).toBe(11)
      expect(byProvider.get('claude')?.cacheReadInputTokens).toBe(3)
      expect(byProvider.get('gemini')?.totalTokens).toBe(24)
      expect(byProvider.get('kimi')?.totalTokens).toBe(25)
      expect(records.every((record) => record.workspaceId === 'external')).toBe(true)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('keeps Codex history beyond the old narrow session cap', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-codex-history-'))
    try {
      const sessionDir = join(homeDir, '.codex', 'sessions', '2026', '05', '31')
      await mkdir(sessionDir, { recursive: true })

      for (let index = 0; index < 270; index += 1) {
        await writeFile(
          join(sessionDir, `rollout-${String(index).padStart(3, '0')}.jsonl`),
          JSON.stringify({
            timestamp: `2026-05-31T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  total_tokens: index === 269 ? 269 : 2
                }
              }
            }
          })
        )
      }

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T23:00:00.000Z')
      })

      expect(records.filter((record) => record.provider === 'codex')).toHaveLength(270)
      expect(
        records.some((record) => record.provider === 'codex' && record.totalTokens === 269)
      ).toBe(true)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it(
    'keeps older high-token Claude sessions when many newer session files exist',
    async () => {
      const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-claude-history-'))
      try {
        const projectDir = join(homeDir, '.claude', 'projects', 'sample')
        await mkdir(projectDir, { recursive: true })

        const olderHeavyPath = join(projectDir, 'older-heavy.jsonl')
        await writeFile(
          olderHeavyPath,
          JSON.stringify({
            timestamp: '2026-05-01T10:00:00.000Z',
            requestId: 'req-heavy',
            message: {
              id: 'msg-heavy',
              model: 'claude-opus',
              usage: {
                input_tokens: 9_000,
                cache_read_input_tokens: 500,
                cache_creation_input_tokens: 250,
                output_tokens: 250
              }
            }
          })
        )
        await utimes(
          olderHeavyPath,
          new Date('2026-05-01T10:00:00.000Z'),
          new Date('2026-05-01T10:00:00.000Z')
        )

        for (let index = 0; index < 270; index += 1) {
          const filePath = join(projectDir, `newer-${String(index).padStart(4, '0')}.jsonl`)
          await writeFile(
            filePath,
            JSON.stringify({
              timestamp: `2026-06-01T${String(index % 24).padStart(2, '0')}:00:00.000Z`,
              requestId: `req-${index}`,
              message: {
                id: `msg-${index}`,
                model: 'claude-sonnet',
                usage: { input_tokens: 1, output_tokens: 1 }
              }
            })
          )
          await utimes(
            filePath,
            new Date('2026-06-01T00:00:00.000Z'),
            new Date(Date.parse('2026-06-01T00:00:00.000Z') + index * 1000)
          )
        }

        const records = await loadExternalProviderUsageRecords({
          homeDir,
          now: new Date('2026-06-30T13:00:00.000Z')
        })
        const claudeRecords = records.filter((record) => record.provider === 'claude')

        expect(claudeRecords).toHaveLength(271)
        expect(claudeRecords.some((record) => record.totalTokens === 10_000)).toBe(true)
      } finally {
        await rm(homeDir, { recursive: true, force: true })
      }
    },
    15_000
  )

  it('keeps early Claude usage from session files larger than the old tail window', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-claude-large-file-'))
    try {
      const projectDir = join(homeDir, '.claude', 'projects', 'sample')
      await mkdir(projectDir, { recursive: true })

      const largePath = join(projectDir, 'large-session.jsonl')
      const handle = await open(largePath, 'w')
      try {
        await handle.write(
          `${JSON.stringify({
            timestamp: '2026-05-01T10:00:00.000Z',
            requestId: 'req-large',
            message: {
              id: 'msg-large',
              model: 'claude-opus',
              usage: { input_tokens: 7_000, output_tokens: 3_000 }
            }
          })}\n`,
          0,
          'utf8'
        )
        for (let megabyte = 1; megabyte <= 129; megabyte += 1) {
          await handle.write('\n', megabyte * 1024 * 1024, 'utf8')
        }
      } finally {
        await handle.close()
      }
      await utimes(
        largePath,
        new Date('2026-05-01T10:00:00.000Z'),
        new Date('2026-05-01T10:00:00.000Z')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-06-30T13:00:00.000Z')
      })

      expect(records.filter((record) => record.provider === 'claude')).toHaveLength(1)
      expect(records.find((record) => record.provider === 'claude')?.totalTokens).toBe(10_000)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('reads Codex archived sessions and session-index activity markers', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-codex-archive-'))
    try {
      await mkdir(join(homeDir, '.codex', 'archived_sessions'), { recursive: true })

      await writeFile(
        join(homeDir, '.codex', 'archived_sessions', 'archived.jsonl'),
        JSON.stringify({
          timestamp: '2026-05-30T09:00:00.000Z',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: {
                input_tokens: 10,
                output_tokens: 5,
                total_tokens: 15
              }
            }
          }
        })
      )
      await writeFile(
        join(homeDir, '.codex', 'session_index.jsonl'),
        JSON.stringify({
          id: 'thread-1',
          thread_name: 'hidden from output',
          updated_at: '2026-05-29T13:00:00.000Z'
        })
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z')
      })
      const codexRecords = records.filter((record) => record.provider === 'codex')

      expect(codexRecords.some((record) => record.totalTokens === 15)).toBe(true)
      expect(codexRecords.some((record) => record.totalTokens === 0)).toBe(true)
      expect(codexRecords.find((record) => record.totalTokens === 15)?.model).toBe('codex')
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('splits Codex external usage by turn_context model within each session file', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-codex-models-'))
    try {
      await mkdir(join(homeDir, '.codex', 'sessions', '2026', '06', '13'), { recursive: true })
      await writeFile(
        join(homeDir, '.codex', 'sessions', '2026', '06', '13', 'rollout.jsonl'),
        [
          JSON.stringify({
            timestamp: '2026-06-13T10:00:00.000Z',
            type: 'turn_context',
            payload: { type: 'turn_context', model: 'gpt-5.5' }
          }),
          JSON.stringify({
            timestamp: '2026-06-13T10:01:00.000Z',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 }
              }
            }
          }),
          JSON.stringify({
            timestamp: '2026-06-13T11:00:00.000Z',
            type: 'turn_context',
            payload: {
              type: 'turn_context',
              collaboration_mode: { settings: { model: 'gpt-5.4' } }
            }
          }),
          JSON.stringify({
            timestamp: '2026-06-13T11:01:00.000Z',
            type: 'event_msg',
            payload: {
              type: 'token_count',
              info: {
                last_token_usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 }
              }
            }
          })
        ].join('\n')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-06-13T13:00:00.000Z')
      })
      const codexRecords = records.filter((record) => record.provider === 'codex')

      expect(codexRecords.map((record) => [record.model, record.totalTokens]).sort()).toEqual([
        ['gpt-5.4', 600],
        ['gpt-5.5', 1200]
      ])
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('reads Gemini legacy JSON and nested session JSONL activity', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-gemini-sessions-'))
    try {
      const chatsDir = join(homeDir, '.gemini', 'tmp', 'sample', 'chats')
      const nestedDir = join(chatsDir, 'subagent-session')
      await mkdir(nestedDir, { recursive: true })

      await writeFile(
        join(chatsDir, 'session-2026-05-31.json'),
        JSON.stringify({
          sessionId: 'legacy',
          messages: [
            {
              id: 'legacy-1',
              timestamp: '2026-05-31T09:00:00.000Z',
              type: 'gemini',
              model: 'gemini-3.1-pro-preview',
              tokens: { input: 100, output: 20, total: 150 }
            }
          ]
        })
      )
      await writeFile(
        join(nestedDir, 'worker.jsonl'),
        [
          JSON.stringify({
            sessionId: 'worker',
            startTime: '2026-05-31T10:00:00.000Z',
            kind: 'subagent'
          }),
          JSON.stringify({
            id: 'nested-1',
            timestamp: '2026-05-31T10:05:00.000Z',
            type: 'gemini',
            model: 'gemini-3.1-flash-lite-preview',
            tokens: { input: 40, output: 10, total: 50 }
          })
        ].join('\n')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z')
      })
      const geminiRecords = records.filter((record) => record.provider === 'gemini')

      expect(geminiRecords.map((record) => record.totalTokens).sort((a, b) => a - b)).toEqual([
        50, 120
      ])
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('loads Cursor IDE agent-transcript usage with estimated tokens', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-cursor-'))
    try {
      const transcriptDir = join(
        homeDir,
        '.cursor',
        'projects',
        'Users-me-Documents-sample',
        'agent-transcripts',
        'composer-abc'
      )
      await mkdir(transcriptDir, { recursive: true })
      await writeFile(
        join(transcriptDir, 'composer-abc.jsonl'),
        [
          JSON.stringify({
            role: 'user',
            message: { content: [{ type: 'text', text: 'a'.repeat(400) }] }
          }),
          JSON.stringify({
            role: 'assistant',
            message: { content: [{ type: 'text', text: 'b'.repeat(200) }] }
          })
        ].join('\n')
      )

      const records = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-06-13T13:00:00.000Z'),
        cursorCachePath: join(homeDir, 'cursor-external-activity-cache.json')
      })
      const cursor = records.find((record) => record.provider === 'cursor')
      expect(cursor?.totalTokens).toBe(150)
      expect(cursor?.model).toBe('composer-2.5-fast')
      expect(cursor?.workspaceId).toBe('external')
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})

describe('external activity per-file incremental cache', () => {
  const CODEX_MTIME = new Date('2026-05-31T09:30:00.000Z')
  const CLAUDE_MTIME = new Date('2026-05-31T10:30:00.000Z')

  async function writeFixtures(homeDir: string): Promise<{
    codexPath: string
    claudePath: string
    codexContent: string
    claudeContent: string
  }> {
    const codexDir = join(homeDir, '.codex', 'sessions', '2026', '05', '31')
    const claudeDir = join(homeDir, '.claude', 'projects', 'sample')
    await mkdir(codexDir, { recursive: true })
    await mkdir(claudeDir, { recursive: true })
    const codexPath = join(codexDir, 'rollout.jsonl')
    const claudePath = join(claudeDir, 'thread.jsonl')
    const codexContent = JSON.stringify({
      timestamp: '2026-05-31T09:00:00.000Z',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 10, output_tokens: 7, total_tokens: 17 } }
      }
    })
    const claudeContent = JSON.stringify({
      timestamp: '2026-05-31T10:00:00.000Z',
      requestId: 'req-1',
      message: {
        id: 'msg-1',
        model: 'claude-sonnet',
        usage: { input_tokens: 11, output_tokens: 5 }
      }
    })
    await writeFile(codexPath, codexContent)
    await writeFile(claudePath, claudeContent)
    await utimes(codexPath, CODEX_MTIME, CODEX_MTIME)
    await utimes(claudePath, CLAUDE_MTIME, CLAUDE_MTIME)
    return { codexPath, claudePath, codexContent, claudeContent }
  }

  /** Overwrite with same-length garbage and restore mtime, so a RE-PARSE
   * would yield nothing while mtime+size still match the cache entry. */
  async function corruptKeepingStat(path: string, content: string, mtime: Date): Promise<void> {
    await writeFile(path, 'x'.repeat(content.length))
    await utimes(path, mtime, mtime)
  }

  it('serves unchanged files from the cache across scans and sinceMs drift', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-filecache-'))
    try {
      const cachePath = join(homeDir, 'external-file-cache.jsonl')
      const fx = await writeFixtures(homeDir)

      const first = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      expect(first.find((record) => record.provider === 'codex')?.totalTokens).toBe(17)
      expect(first.find((record) => record.provider === 'claude')?.totalTokens).toBe(16)

      await corruptKeepingStat(fx.codexPath, fx.codexContent, CODEX_MTIME)
      await corruptKeepingStat(fx.claudePath, fx.claudeContent, CLAUDE_MTIME)

      // One hour later — the rolling 90-day window has drifted forward, the
      // exact scenario that used to defeat sinceMs-keyed caching.
      const second = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T14:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      expect(second.find((record) => record.provider === 'codex')?.totalTokens).toBe(17)
      expect(second.find((record) => record.provider === 'claude')?.totalTokens).toBe(16)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('persists the per-file cache across process restarts', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-filecache-boot-'))
    try {
      const cachePath = join(homeDir, 'external-file-cache.jsonl')
      const fx = await writeFixtures(homeDir)

      await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      await corruptKeepingStat(fx.codexPath, fx.codexContent, CODEX_MTIME)
      await corruptKeepingStat(fx.claudePath, fx.claudeContent, CLAUDE_MTIME)

      // Simulate a fresh app launch: in-memory state gone, disk cache remains.
      resetExternalActivityFileCacheForTests()

      const afterRestart = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T15:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      expect(afterRestart.find((record) => record.provider === 'codex')?.totalTokens).toBe(17)
      expect(afterRestart.find((record) => record.provider === 'claude')?.totalTokens).toBe(16)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('re-parses files whose mtime or size changed', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-filecache-change-'))
    try {
      const cachePath = join(homeDir, 'external-file-cache.jsonl')
      const fx = await writeFixtures(homeDir)

      const first = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      expect(first.filter((record) => record.provider === 'codex')).toHaveLength(1)

      const appended = [
        fx.codexContent,
        JSON.stringify({
          timestamp: '2026-05-31T11:00:00.000Z',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } }
          }
        })
      ].join('\n')
      await writeFile(fx.codexPath, appended)
      const bumped = new Date('2026-05-31T11:30:00.000Z')
      await utimes(fx.codexPath, bumped, bumped)

      const second = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:30:00.000Z'),
        externalFileCachePath: cachePath
      })
      const codexRecords = second.filter((record) => record.provider === 'codex')
      expect(codexRecords).toHaveLength(2)
      expect(codexRecords.some((record) => record.totalTokens === 25)).toBe(true)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })

  it('dedupes duplicate Claude events across files through the cache', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'taskwraith-external-filecache-dedupe-'))
    try {
      const cachePath = join(homeDir, 'external-file-cache.jsonl')
      const claudeDir = join(homeDir, '.claude', 'projects', 'sample')
      await mkdir(claudeDir, { recursive: true })
      const duplicate = JSON.stringify({
        timestamp: '2026-05-31T10:00:00.000Z',
        requestId: 'req-dup',
        message: {
          id: 'msg-dup',
          model: 'claude-sonnet',
          usage: { input_tokens: 11, output_tokens: 5 }
        }
      })
      const mtime = new Date('2026-05-31T10:30:00.000Z')
      for (const name of ['thread-a.jsonl', 'thread-b.jsonl']) {
        await writeFile(join(claudeDir, name), duplicate)
        await utimes(join(claudeDir, name), mtime, mtime)
      }

      const first = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T13:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      expect(first.filter((record) => record.provider === 'claude')).toHaveLength(1)

      // Second scan served from cache must apply the same cross-file dedupe.
      const second = await loadExternalProviderUsageRecords({
        homeDir,
        now: new Date('2026-05-31T14:00:00.000Z'),
        externalFileCachePath: cachePath
      })
      expect(second.filter((record) => record.provider === 'claude')).toHaveLength(1)
    } finally {
      await rm(homeDir, { recursive: true, force: true })
    }
  })
})
