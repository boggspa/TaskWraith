import { describe, expect, it } from 'vitest'
import {
  releaseCommandBlockReason,
  releasePackageScriptBlockReason,
  releaseScriptBlockReason
} from './ReleaseCommandPolicy'

describe('ReleaseCommandPolicy', () => {
  it('blocks direct release, publish, and signing commands', () => {
    expect(releaseCommandBlockReason('gh release create v1.0.0 dist/app.zip')).toContain(
      'release-class command'
    )
    expect(releaseCommandBlockReason('gh --repo owner/repo pr create --fill')).toContain(
      'release-class command'
    )
    expect(releaseCommandBlockReason('gh api /repos/owner/repo/releases -X POST')).toContain(
      'release-class command'
    )
    expect(releaseCommandBlockReason(['npm', 'publish'])).toContain('release-class command')
    expect(releaseCommandBlockReason('npm --registry https://registry.npmjs.org publish')).toContain(
      'release-class command'
    )
    expect(releaseCommandBlockReason('pnpm -r publish')).toContain('release-class command')
    expect(releaseCommandBlockReason('yarn --cwd packages/app npm publish')).toContain(
      'release-class command'
    )
    expect(releaseCommandBlockReason('npx semantic-release')).toContain('release-class command')
    expect(releaseCommandBlockReason('npx release-it')).toContain('release-class command')
    expect(releaseCommandBlockReason(['xcrun', 'notarytool', 'submit', 'dist/app.zip'])).toContain(
      'release-class command'
    )
    expect(releaseCommandBlockReason('git push --tags')).toContain('release-class command')
    expect(releaseCommandBlockReason('git -C /repo push origin main')).toContain(
      'release-class command'
    )
    expect(releaseCommandBlockReason('/usr/bin/git -c credential.helper= push')).toContain(
      'release-class command'
    )
  })

  it('blocks package-script indirection for release-class scripts', () => {
    expect(
      releaseScriptBlockReason(
        'build:mac:notarized',
        'electron-builder --mac --universal -c.mac.notarize=true'
      )
    ).toContain('release-class command')
    expect(releaseScriptBlockReason('release', 'node scripts/release.cjs')).toContain(
      'release-class command'
    )
    expect(
      releasePackageScriptBlockReason('npm run build:mac', {
        'build:mac': 'electron-builder --mac -c.mac.notarize=true'
      })
    ).toContain('release-class command')
    expect(releaseCommandBlockReason('npm run deploy')).toContain('release-class command')
  })

  it('allows ordinary verification scripts', () => {
    expect(releaseCommandBlockReason(['npm', 'test', '--', '--run'])).toBeNull()
    expect(releaseScriptBlockReason('test', 'vitest --run')).toBeNull()
    expect(releaseScriptBlockReason('prerelease:verify', 'vitest --run')).toBeNull()
    expect(releaseCommandBlockReason('electron-builder --publish never')).toBeNull()
  })

  it('allows release-class commands only with an explicit approval-aware bypass', () => {
    const approval = {
      allowReleaseCommand: true,
      approvalSource: 'approvedMcpTask' as const
    }

    expect(releaseCommandBlockReason('git push --tags', approval)).toBeNull()
    expect(releaseScriptBlockReason('release', 'node scripts/release.cjs', approval)).toBeNull()
    expect(
      releasePackageScriptBlockReason(
        'npm run build:mac:notarized',
        {
          'build:mac:notarized': 'electron-builder --mac -c.mac.notarize=true'
        },
        approval
      )
    ).toBeNull()
    expect(releaseCommandBlockReason('git push --tags', { allowReleaseCommand: true })).toContain(
      'release-class command'
    )
  })
})
