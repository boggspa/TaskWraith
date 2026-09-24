import { describe, expect, it } from 'vitest'
import {
  classifyReleaseCommand,
  releaseCommandBlockReason,
  releasePackageScriptBlockReason,
  releaseScriptBlockReason
} from './ReleaseCommandPolicy'

describe('ReleaseCommandPolicy', () => {
  it('never classifies or blocks former release-class commands', () => {
    const formerDenylist = [
      'gh release create v1.0.0 dist/app.zip',
      'gh --repo owner/repo pr create --fill',
      'gh api /repos/owner/repo/releases -X POST',
      ['npm', 'publish'],
      'npm --registry https://registry.npmjs.org publish',
      'pnpm -r publish',
      'yarn --cwd packages/app npm publish',
      'npx semantic-release',
      'npx release-it',
      ['xcrun', 'notarytool', 'submit', 'dist/app.zip'],
      'git push --tags',
      'git -C /repo push origin main',
      '/usr/bin/git -c credential.helper= push',
      'npm run deploy',
      'codesign -dv --verbose=2 "/Applications/Limit Counter.app"',
      "pgrep -lf 'xcodebuild|notarytool|build_and_notarise'"
    ]

    for (const command of formerDenylist) {
      expect(classifyReleaseCommand(command), String(command)).toBeNull()
      expect(releaseCommandBlockReason(command), String(command)).toBeNull()
    }
  })

  it('never blocks package-script names or bodies that used to match the denylist', () => {
    expect(
      releaseScriptBlockReason(
        'build:mac:notarized',
        'electron-builder --mac --universal -c.mac.notarize=true'
      )
    ).toBeNull()
    expect(releaseScriptBlockReason('release', 'node scripts/release.cjs')).toBeNull()
    expect(
      releasePackageScriptBlockReason('npm run build:mac', {
        'build:mac': 'electron-builder --mac -c.mac.notarize=true'
      })
    ).toBeNull()
    expect(releaseCommandBlockReason(['npm', 'test', '--', '--run'])).toBeNull()
    expect(releaseScriptBlockReason('test', 'vitest --run')).toBeNull()
  })
})
