import { describe, expect, it } from 'vitest'
import type { ToolActivity } from './store/types'
import {
  extractRemoteToolFilePath,
  extractRemoteToolUrls,
  projectRemoteToolDetail
} from './RemoteToolTargetProjection'

function activity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    id: 'tool-1',
    toolName: 'read_file',
    displayName: 'Read file',
    category: 'read',
    status: 'success',
    ...overrides
  }
}

describe('RemoteToolTargetProjection', () => {
  describe('extractRemoteToolFilePath', () => {
    it('prefers desktop-compatible parameter keys over activity.filePath', () => {
      expect(
        extractRemoteToolFilePath(
          activity({
            parameters: { file_path: 'src/main/Thing.ts' },
            filePath: 'fallback.ts'
          })
        )
      ).toBe('src/main/Thing.ts')
    })

    it('falls back to filePath and a single diff file', () => {
      expect(extractRemoteToolFilePath(activity({ filePath: 'README.md' }))).toBe('README.md')
      expect(
        extractRemoteToolFilePath(
          activity({
            diffSummary: {
              files: [{ path: 'src/a.ts', additions: 2, deletions: 0 }],
              additions: 2,
              deletions: 0,
              source: 'result_diff',
              confidence: 'estimated'
            }
          })
        )
      ).toBe('src/a.ts')
    })

    it('rejects empty, oversized, and URL-shaped path values', () => {
      expect(
        extractRemoteToolFilePath(
          activity({ parameters: { path: 'https://example.com/result' }, filePath: '   ' })
        )
      ).toBeUndefined()
      expect(
        extractRemoteToolFilePath(activity({ parameters: { path: 'x'.repeat(2_049) } }))
      ).toBeUndefined()
    })
  })

  describe('extractRemoteToolUrls', () => {
    it('mines nested parameters, summary, and output in stable order', () => {
      const urls = extractRemoteToolUrls(
        activity({
          parameters: {
            request: { endpoint: 'https://api.example.com/v1/items' },
            docs: ['See https://docs.example.com/start.']
          },
          resultSummary: 'Result at https://result.example.com/a',
          outputPreview: 'Mirror: https://mirror.example.com/b'
        })
      )
      expect(urls).toEqual([
        'https://api.example.com/v1/items',
        'https://docs.example.com/start',
        'https://result.example.com/a',
        'https://mirror.example.com/b'
      ])
    })

    it('deduplicates, caps, and strips credentials and fragments', () => {
      const urls = extractRemoteToolUrls(
        activity({
          parameters: {
            first: 'https://user:secret@example.com/a#private',
            duplicate: 'https://example.com/a',
            second: 'https://two.example.com',
            third: 'https://three.example.com'
          }
        }),
        2
      )
      expect(urls).toEqual(['https://example.com/a', 'https://two.example.com/'])
      expect(JSON.stringify(urls)).not.toContain('secret')
      expect(JSON.stringify(urls)).not.toContain('private')
    })

    it('returns no targets when the requested cap is zero', () => {
      expect(extractRemoteToolUrls(activity({ resultSummary: 'https://example.com' }), 0)).toEqual(
        []
      )
    })
  })

  describe('projectRemoteToolDetail', () => {
    it('keeps a bounded result summary for explicit per-tool inspection', () => {
      expect(projectRemoteToolDetail(activity({ resultSummary: 'All good' }))).toEqual({
        detail: 'All good'
      })
      const projected = projectRemoteToolDetail(activity({ resultSummary: 'x'.repeat(50) }), 12)
      expect(projected).toEqual({ detail: 'xxxxxxxxx...', truncated: true })
    })

    it('does not project raw output as detail', () => {
      expect(
        projectRemoteToolDetail(activity({ outputPreview: 'raw secret-bearing output' }))
      ).toEqual({})
    })
  })
})
