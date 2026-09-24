import { describe, expect, it } from 'vitest'
import {
  BETA_DESKTOP_APP_ID,
  readAppDistributionIdentity,
  RELEASE_DESKTOP_APP_ID
} from './AppDistributionIdentity'

function readMetadata(value: unknown): () => string {
  return () => JSON.stringify(value)
}

describe('readAppDistributionIdentity', () => {
  it('recognizes the frozen final-beta identity and latest feed', () => {
    expect(
      readAppDistributionIdentity(
        '/app.asar',
        readMetadata({
          taskwraithDistributionIdentity: 'beta',
          taskwraithAppId: BETA_DESKTOP_APP_ID,
          taskwraithUpdateFeedChannel: 'latest'
        })
      )
    ).toEqual({
      series: 'beta',
      appId: BETA_DESKTOP_APP_ID,
      stableUpdateChannel: 'latest',
      valid: true
    })
  })

  it('recognizes the public Release identity and isolated release feed', () => {
    expect(
      readAppDistributionIdentity(
        '/app.asar',
        readMetadata({
          taskwraithDistributionIdentity: 'release',
          taskwraithAppId: RELEASE_DESKTOP_APP_ID,
          taskwraithUpdateFeedChannel: 'release'
        })
      )
    ).toEqual({
      series: 'release',
      appId: RELEASE_DESKTOP_APP_ID,
      stableUpdateChannel: 'release',
      valid: true
    })
  })

  it('treats a repository/dev package with no identity metadata as development', () => {
    expect(readAppDistributionIdentity('/repo', readMetadata({ name: 'taskwraith' }))).toEqual({
      series: 'development',
      stableUpdateChannel: 'latest',
      valid: true
    })
  })

  it('fails closed when identity, app id, and feed are mixed', () => {
    expect(
      readAppDistributionIdentity(
        '/app.asar',
        readMetadata({
          taskwraithDistributionIdentity: 'release',
          taskwraithAppId: BETA_DESKTOP_APP_ID,
          taskwraithUpdateFeedChannel: 'latest'
        })
      )
    ).toMatchObject({ series: 'invalid', valid: false })
  })

  it('fails closed on unreadable package metadata', () => {
    expect(
      readAppDistributionIdentity('/app.asar', () => {
        throw new Error('missing package')
      })
    ).toMatchObject({
      series: 'invalid',
      valid: false,
      reason: expect.stringContaining('missing package')
    })
  })
})
