import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const yaml: { load: (text: string) => unknown } = require('js-yaml')

type Step = {
  env?: Record<string, string>
  id?: string
  name?: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
}

type Job = {
  needs?: string[] | string
  outputs?: Record<string, string>
  permissions?: Record<string, string>
  'runs-on'?: string
  steps?: Step[]
}

const workflowPath = path.join(process.cwd(), '.github', 'workflows', 'ci.yml')
const workflowText = fs.readFileSync(workflowPath, 'utf8')
const workflow = yaml.load(workflowText) as { jobs: Record<string, Job> }
const jobs = workflow.jobs

function runText(job: Job) {
  return (job.steps || []).map((step) => step.run || '').join('\n')
}

function actionSteps(job: Job) {
  return (job.steps || []).filter((step) => step.uses)
}

describe('release workflow contract', () => {
  it('keeps candidate jobs read-only and reserves release mutation for the final publisher', () => {
    const candidates = [
      'notarized-macos-release',
      'signed-windows-release',
      'windows-arm64-release-candidate',
      'linux-release-candidate'
    ]
    for (const name of candidates) {
      expect(jobs[name].permissions?.contents).toBe('read')
      expect(runText(jobs[name])).not.toContain('gh release')
    }

    expect(jobs['publish-coordinated-release'].permissions?.contents).toBe('write')
    expect(
      Object.entries(jobs)
        .filter(([, job]) => job.permissions?.contents === 'write')
        .map(([name]) => name)
    ).toEqual(['publish-coordinated-release'])
  })

  it('publishes only after macOS, Windows x64, native ARM64, and Linux gates succeed', () => {
    expect(jobs['publish-coordinated-release'].needs).toEqual([
      'notarized-macos-release',
      'signed-windows-release',
      'windows-arm64-release-candidate',
      'linux-release-candidate'
    ])
    expect(jobs['windows-arm64-release-candidate']).toMatchObject({
      'runs-on': 'windows-11-arm',
      needs: ['signed-windows-release']
    })

    const armText = JSON.stringify(jobs['windows-arm64-release-candidate'])
    expect(armText).toContain('actions/download-artifact@')
    expect(armText).toContain('${{ needs.signed-windows-release.outputs.artifact-name }}')
    expect(armText).toContain('candidate/win-arm64-unpacked')
    expect(armText).toContain('smoke-win-installer.ps1')
  })

  it('hands off attempt-scoped candidates and validates exact public release assets', () => {
    const publisher = JSON.stringify(jobs['publish-coordinated-release'])
    const producers = [
      'notarized-macos-release',
      'signed-windows-release',
      'linux-release-candidate'
    ]
    for (const producer of producers) {
      expect(jobs[producer].outputs?.['artifact-name']).toBe(
        '${{ steps.release-artifact-name.outputs.name }}'
      )
      expect(JSON.stringify(jobs[producer])).toContain('GITHUB_RUN_ATTEMPT')
      const outputStepIndex = (jobs[producer].steps || []).findIndex(
        (step) => step.id === 'release-artifact-name'
      )
      const uploadStepIndex = (jobs[producer].steps || []).findIndex((step) =>
        step.uses?.startsWith('actions/upload-artifact@')
      )
      expect(outputStepIndex).toBeGreaterThanOrEqual(0)
      expect(outputStepIndex).toBeLessThan(uploadStepIndex)
    }
    expect(publisher).toContain('${{ needs.notarized-macos-release.outputs.artifact-name }}')
    expect(publisher).toContain('${{ needs.signed-windows-release.outputs.artifact-name }}')
    expect(publisher).toContain('${{ needs.linux-release-candidate.outputs.artifact-name }}')

    const publishRun = runText(jobs['publish-coordinated-release'])
    expect(publishRun).toContain('channel="latest"')
    expect(publishRun).toContain('channel="beta"')
    expect(publishRun).toContain('release_title="TaskWraith v${version}"')
    expect(publishRun).toContain('prepare-release-notes.cjs "$version" "$notes_path"')
    expect(publishRun).toContain('--notes-file "$notes_path"')
    expect(publishRun).toContain('cmp --silent "$notes_path" "$body_file"')
    expect(publishRun).not.toContain('--notes "Verified TaskWraith')
    expect(publishRun).toContain('TaskWraith-"$version"-universal-mac.dmg')
    expect(publishRun).toContain('TaskWraith-"$version"-universal-mac.zip.blockmap')
    expect(publishRun).not.toContain('release-assets/mac/*.blockmap')
    expect(publishRun).toContain('TaskWraith-"$version"-win-arm64-setup.exe')
    expect(publishRun).toContain('TaskWraith-"$version".AppImage')
    expect(publishRun).toContain('taskwraith_"$version"_amd64.deb')
    expect(publishRun).toContain('"$channel"-linux.yml')
    expect(publishRun).toContain('validate-linux-update-feed.cjs release-assets/linux')
    expect(publishRun).toContain('sbom-windows.cdx.json')
    expect(publishRun).toContain('sbom-linux.cdx.json')
    expect(publishRun).toContain('checksums_path="release-assets/SHA256SUMS-${version}.txt"')
    expect(publishRun).toContain('write-release-checksums.cjs "$checksums_path" "${assets[@]}"')
    expect(
      publishRun.indexOf('write-release-checksums.cjs "$checksums_path" "${assets[@]}"')
    ).toBeLessThan(publishRun.indexOf('assets+=("$checksums_path")'))
    expect(publishRun.indexOf('assets+=("$checksums_path")')).toBeLessThan(
      publishRun.indexOf('declare -A asset_paths=()')
    )
    expect(publishRun).toContain('gh release upload')
    expect(publishRun).toContain('cmp --silent')
    expect(publishRun).not.toContain('--clobber')
    expect(publishRun).toContain('gh release edit "$release_tag" --draft=false')
    expect(publishRun).toContain('if [ "$is_draft" = "false" ]; then')
    expect(publishRun).toContain(
      'Existing public release exactly matches the verified candidate; no mutation needed.'
    )
    expect(publishRun).toContain('"${fresh_public_assets[*]}" != "${expected_assets[*]}"')
    expect(publishRun).toContain('mapfile -t fresh_public_assets')
    expect(publishRun).not.toContain(
      'Existing release must be a matching draft; refusing public mutation.'
    )
  })

  it('finalizes both local macOS build paths before validating update metadata', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    )
    const unsigned = packageJson.scripts['build:mac'] as string
    const notarized = packageJson.scripts['build:mac:notarized'] as string
    expect(unsigned.indexOf('npm run finalize:mac-release-artifacts:unsigned')).toBeGreaterThan(
      unsigned.indexOf('run-electron-builder.cjs')
    )
    expect(unsigned.indexOf('npm run finalize:mac-release-artifacts:unsigned')).toBeLessThan(
      unsigned.indexOf('npm run validate:mac-update-feed')
    )
    expect(notarized.indexOf('npm run finalize:mac-release-artifacts')).toBeGreaterThan(
      notarized.indexOf('run-electron-builder.cjs')
    )
    expect(notarized.indexOf('npm run finalize:mac-release-artifacts')).toBeLessThan(
      notarized.indexOf('npm run smoke:mac-artifacts')
    )
  })

  it('gates actual platform containers and packaged payloads', () => {
    const macSteps = jobs['notarized-macos-release'].steps || []
    const finalizeIndex = macSteps.findIndex(
      (step) => step.name === 'Finalize exact macOS release artifacts'
    )
    const smokeIndex = macSteps.findIndex(
      (step) => step.name === 'Run post-package macOS checks without signing credentials'
    )
    expect(finalizeIndex).toBeGreaterThanOrEqual(0)
    expect(finalizeIndex).toBeLessThan(smokeIndex)
    expect(macSteps[finalizeIndex].run).toBe('npm run finalize:mac-release-artifacts')
    expect(macSteps[finalizeIndex].env).toMatchObject({
      APPLE_ID: '${{ secrets.APPLE_ID }}',
      APPLE_APP_SPECIFIC_PASSWORD: '${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}',
      APPLE_TEAM_ID: '${{ secrets.APPLE_TEAM_ID }}'
    })
    expect(JSON.stringify(macSteps[finalizeIndex])).not.toContain('APPLE_KEYCHAIN_PROFILE')
    expect(runText(jobs['notarized-macos-release'])).toContain('npm run smoke:mac-artifacts')
    expect(JSON.stringify(jobs['notarized-macos-release'])).toContain(
      'dist/*-universal-mac.zip.blockmap'
    )
    expect(JSON.stringify(jobs['notarized-macos-release'])).not.toContain('*.dmg.blockmap')
    expect(runText(jobs['linux-release-candidate'])).toContain(
      'xvfb-run -a npm run build:linux:nopublish'
    )
    expect(runText(jobs['signed-windows-release'])).toContain(
      'node scripts/guard-no-bundled-secrets.cjs --require-packaged'
    )
    expect(runText(jobs['signed-windows-release'])).toContain('npm run security:sbom')
    expect(runText(jobs['linux-release-candidate'])).toContain('npm run security:sbom')
  })

  it('pins every action and Node runtime used by the workflow', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    )
    const expectedNode = packageJson.taskwraithRelease.tuiNodeRuntime.version
    for (const job of Object.values(jobs)) {
      for (const step of actionSteps(job)) {
        expect(step.uses).toMatch(/@[a-f0-9]{40}$/)
        if (step.uses?.startsWith('actions/setup-node@')) {
          expect(step.with?.['node-version']).toBe(expectedNode)
        }
      }
    }
  })
})
