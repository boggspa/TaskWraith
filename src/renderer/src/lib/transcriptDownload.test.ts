import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadChatMarkdownTranscript } from './transcriptDownload'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('downloadChatMarkdownTranscript', () => {
  it('does not construct a Blob when main streamed the entire task to disk', async () => {
    const download = vi.fn(async () => ({
      ok: true as const,
      streamed: true as const,
      fileName: 'Mission.md',
      messageCount: 30_000,
      charCount: 52_000_000,
      omissions: []
    }))
    const BlobMock = vi.fn()
    vi.stubGlobal('window', { api: { downloadChatMarkdownTranscript: download } })
    vi.stubGlobal('Blob', BlobMock)

    await expect(
      downloadChatMarkdownTranscript('chat-1', { kind: 'entire-task' })
    ).resolves.toEqual({
      ok: true,
      fileName: 'Mission.md',
      messageCount: 30_000,
      charCount: 52_000_000,
      omissions: []
    })
    expect(download).toHaveBeenCalledWith('chat-1', { kind: 'entire-task' })
    expect(BlobMock).not.toHaveBeenCalled()
  })

  it('keeps the existing object-URL download path for a selected round', async () => {
    const download = vi.fn(async () => ({
      ok: true as const,
      markdown: '# Round 4',
      fileName: 'Mission - Round 4.md',
      messageCount: 12,
      charCount: 900,
      omissions: []
    }))
    const blobValue = { kind: 'blob' }
    const BlobMock = vi.fn(function MockBlob() {
      return blobValue
    })
    const link = { href: '', download: '', click: vi.fn() }
    const appendChild = vi.fn()
    const removeChild = vi.fn()
    const createObjectURL = vi.fn(() => 'blob:round-4')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('window', { api: { downloadChatMarkdownTranscript: download } })
    vi.stubGlobal('Blob', BlobMock)
    vi.stubGlobal('document', {
      createElement: vi.fn(() => link),
      body: { appendChild, removeChild }
    })
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })

    await expect(
      downloadChatMarkdownTranscript('chat-1', { kind: 'round', roundId: 'round-4' })
    ).resolves.toMatchObject({ ok: true, fileName: 'Mission - Round 4.md' })
    expect(BlobMock).toHaveBeenCalledWith(['# Round 4'], {
      type: 'text/markdown;charset=utf-8'
    })
    expect(createObjectURL).toHaveBeenCalledWith(blobValue)
    expect(link).toMatchObject({
      href: 'blob:round-4',
      download: 'Mission - Round 4.md'
    })
    expect(link.click).toHaveBeenCalledTimes(1)
    expect(appendChild).toHaveBeenCalledWith(link)
    expect(removeChild).toHaveBeenCalledWith(link)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:round-4')
  })
})
