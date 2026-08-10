import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

interface ReviewModule {
  ATTACK_TEST_FILES: string[]
  EXPECTED_AGENT_IPC: string[]
  PACKAGED_FORBIDDEN_MARKERS: Record<string, string[]>
  PACKAGED_REQUIRED_MARKERS: Record<string, string[]>
  REVIEW_REQUIREMENTS: Array<{
    id: string
    evidence: Array<{ file: string; anchors: string[] }>
  }>
  parseArgs(argv: string[]): {
    evidencePath: string
    packageInput: string
    candidateInput: string
  }
  validateReviewRequirementSources(): {
    requirementCount: number
    testFileCount: number
    manifestSha256: string
  }
  verifyPackagedGroups(
    groups: Record<string, Array<{ path: string; contents: string | Buffer }>>
  ): Record<
    string,
    {
      fileCount: number
      requiredMarkers: string[]
      forbiddenMarkerCount: number
      forbiddenMarkersSha256: string
    }
  >
  verifySourceBoundary(overrides?: Record<string, string>): {
    reviewId: string
    participationEnabled: boolean
    ipcChannels: string[]
  }
}

const require = createRequire(import.meta.url)
const review = require('./channels-p3-review.cjs') as ReviewModule

describe('Channels P3 adversarial review harness', () => {
  it('requires one explicit package and exact candidate commit', () => {
    expect(() => review.parseArgs([])).toThrow('--package')
    expect(() => review.parseArgs(['--package', '.', '--candidate', 'HEAD'])).toThrow('--candidate')
    expect(review.parseArgs(['--package', '.', '--candidate', 'a'.repeat(40)])).toMatchObject({
      candidateInput: 'a'.repeat(40)
    })
    expect(() =>
      review.parseArgs(['--package', '.', '--candidate', 'a'.repeat(40), '--toggle'])
    ).toThrow('unknown argument')
  })

  it('pins every required attack to an executable named test source', () => {
    const manifest = review.validateReviewRequirementSources()
    expect(manifest).toMatchObject({
      requirementCount: 14,
      testFileCount: review.ATTACK_TEST_FILES.length
    })
    expect(manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(new Set(review.REVIEW_REQUIREMENTS.map((item) => item.id)).size).toBe(14)
    expect(new Set(review.ATTACK_TEST_FILES).size).toBe(review.ATTACK_TEST_FILES.length)
  })

  it('fails a stale or toggle-bearing packaged main, preload, or renderer bundle', () => {
    const groups = Object.fromEntries(
      Object.entries(review.PACKAGED_REQUIRED_MARKERS).map(([group, markers]) => [
        group,
        [{ path: `${group}.js`, contents: markers.join('\n') }]
      ])
    )
    const accepted = review.verifyPackagedGroups(groups)
    expect(accepted.main.requiredMarkers).toContain('channel_agent_review_required')
    expect(accepted.preload.forbiddenMarkerCount).toBeGreaterThan(0)
    expect(accepted.preload.forbiddenMarkersSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(accepted)).not.toContain('privateKeyDerB64')

    for (const group of Object.keys(review.PACKAGED_REQUIRED_MARKERS)) {
      const stale = structuredClone(groups)
      stale[group][0].contents = stale[group][0].contents.replace(
        review.PACKAGED_REQUIRED_MARKERS[group][0],
        ''
      )
      expect(() => review.verifyPackagedGroups(stale)).toThrow(`packaged ${group} is stale`)

      const toggle = structuredClone(groups)
      toggle[group][0].contents += '\nchannels:agent:enable'
      expect(() => review.verifyPackagedGroups(toggle)).toThrow(
        `packaged ${group} exposes forbidden markers`
      )
    }
  })

  it('pins the source-only false gate and exact five-channel IPC boundary', () => {
    const boundary = review.verifySourceBoundary()
    expect(boundary).toEqual(
      expect.objectContaining({
        reviewId: 'channels-p3-agent-participation-v1',
        participationEnabled: false,
        ipcChannels: review.EXPECTED_AGENT_IPC
      })
    )

    const gatePath = 'src/shared/collaboration/ChannelAgentReviewGate.ts'
    const gate = readFileSync(gatePath, 'utf8')
    expect(() =>
      review.verifySourceBoundary({
        [gatePath]: `${gate}\nconst bypass = process.env.CHANNEL_AGENT_REVIEW\n`
      })
    ).toThrow('runtime override seam')
  })

  it('enumerates all ten provider routes in the shared untrusted composer proof', () => {
    const source = readFileSync('src/main/collaboration/ChannelAgentRunComposer.test.ts', 'utf8')
    for (const provider of [
      'gemini',
      'codex',
      'claude',
      'kimi',
      'grok',
      'cursor',
      'ollama',
      'antigravity',
      'pi',
      'mistral'
    ]) {
      expect(source).toContain(`'${provider}'`)
    }
    expect(source).toContain(
      'keeps the accepted contribution singly untrusted across every provider route'
    )
  })
})
