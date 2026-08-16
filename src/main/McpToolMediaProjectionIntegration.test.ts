import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { TranscriptMediaRef } from './store/types'
import {
  RAW_MEDIA_MAX_REFS,
  sanitizeRawProviderMediaRefs
} from '../shared/transcriptMediaRefSanitize'
import {
  deliverTrustedRunMediaRefs,
  type TrustedRunMediaPayload
} from './services/TrustedRunMediaDelivery'

const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

function appwatchFrames(count: number): TranscriptMediaRef[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `appwatch:run-1:${index + 1}`,
    kind: 'image',
    format: 'raster',
    source: 'tool_result',
    name: `Appwatch frame ${index + 1}`,
    mimeType: 'image/png',
    status: 'available',
    caption: `frame-${index + 1}`,
    groupKind: 'appwatch_frames',
    thumbnail: {
      dataBase64: 'AA==',
      mimeType: 'image/png',
      width: 320,
      height: 180
    }
  }))
}

describe('MCP tool media transcript projection', () => {
  it('carries a 20-frame trusted Appwatch batch to a main-owned transcript intact', () => {
    const frames = appwatchFrames(20)
    let injectedRefs: readonly TranscriptMediaRef[] | undefined
    let foregroundCalled = false

    const result = deliverTrustedRunMediaRefs({
      appChatId: 'chat-1',
      appRunId: 'run-1',
      mediaRefs: frames,
      inject: (appRunId, refs) => {
        expect(appRunId).toBe('run-1')
        injectedRefs = refs
        return true
      },
      sendForeground: () => {
        foregroundCalled = true
      }
    })

    expect(result).toBe('injected')
    expect(injectedRefs).toBe(frames)
    expect(injectedRefs).toHaveLength(20)
    expect(injectedRefs?.map((ref) => ref.caption)).toEqual(
      Array.from({ length: 20 }, (_, index) => `frame-${index + 1}`)
    )
    expect(foregroundCalled).toBe(false)
  })

  it('carries the same batch to the foreground IPC intact while RAW provider refs stay capped', () => {
    const frames = appwatchFrames(20)
    let foregroundPayload: TrustedRunMediaPayload | undefined

    const result = deliverTrustedRunMediaRefs({
      appChatId: 'chat-1',
      appRunId: 'run-1',
      mediaRefs: frames,
      inject: () => false,
      sendForeground: (payload) => {
        foregroundPayload = payload
      }
    })

    expect(result).toBe('foreground')
    expect(foregroundPayload?.mediaRefs).toBe(frames)
    expect(foregroundPayload?.mediaRefs).toHaveLength(20)
    expect(sanitizeRawProviderMediaRefs(frames)).toHaveLength(RAW_MEDIA_MAX_REFS)
  })

  it('wires sniffed tool-result images to the trusted route instead of provider stdout', () => {
    const start = mainSource.indexOf('const resultImageBlocks =')
    const end = mainSource.indexOf('\n      if (publicFinalRichResult) {', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)

    const projection = mainSource.slice(start, end)
    expect(projection).toContain('maxRefs: publicFinalRichResult?.mediaRefHints?.maxRefs')
    expect(projection).toContain('const visibleMediaRefs = mergeTranscriptMediaRefs(')
    expect(projection).toContain('deliverTrustedRunMediaRefs({')
    expect(projection).toContain('mediaRefs: visibleMediaRefs')
    expect(projection).toContain('inject: injectTrustedMediaRefs')
    expect(projection).toContain('sendTrustedRunMediaRefs(context.sender, payload)')
    expect(projection).not.toContain('sendAgentCompatLine')
    expect(projection).not.toContain('sanitizeRawProviderMediaRefs')
  })
})
