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
  if?: string | boolean
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
  it('keeps artifact builders read-only and reserves mutation for the disabled publisher', () => {
    const builders = [
      'notarized-macos-release',
      'signed-windows-release',
      'windows-arm64-release-candidate',
      'unsigned-windows-build',
      'unsigned-linux-build'
    ]
    for (const name of builders) {
      expect(jobs[name].permissions?.contents).toBe('read')
      expect(runText(jobs[name])).not.toContain('gh release')
    }

    expect(jobs['linux-release-candidate']).toBeUndefined()
    expect(jobs['publish-coordinated-release'].permissions?.contents).toBe('write')
    expect(jobs['publish-coordinated-release'].if).toBe('${{ false }}')
    expect(
      Object.entries(jobs)
        .filter(([, job]) => job.permissions?.contents === 'write')
        .map(([name]) => name)
    ).toEqual(['publish-coordinated-release'])
  })

  it('keeps the coordinated publisher inoperative without a tag-triggered Linux candidate', () => {
    expect(jobs['publish-coordinated-release'].needs).toEqual([
      'notarized-macos-release',
      'signed-windows-release',
      'windows-arm64-release-candidate'
    ])
    expect(jobs['notarized-macos-release'].needs).toEqual(['test', 'ios'])
    expect(jobs['signed-windows-release'].needs).toEqual(['test', 'ios'])
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

  it('labels manual unsigned artifacts with the selected source SHA', () => {
    const windows = jobs['unsigned-windows-build']
    const windowsText = JSON.stringify(windows)
    const windowsSteps = windows.steps || []
    const packageIndex = windowsSteps.findIndex((step) =>
      step.run?.includes('npx electron-builder --win --x64 --arm64 --publish never')
    )
    const overlayIndex = windowsSteps.findIndex(
      (step) => step.name === 'Overlay current Windows smoke harness after packaging'
    )
    const checksIndex = windowsSteps.findIndex((step) =>
      step.run?.includes('npm run build:win:checks')
    )

    expect(windowsText).toContain('${{ inputs.unsigned_build_ref || github.sha }}')
    expect(windowsText).toContain(
      'unsigned-windows-testing-${{ steps.unsigned-source.outputs.sha }}-${{ github.run_id }}-${{ github.run_attempt }}'
    )
    expect(windowsText).toContain('.ci-release-harness')
    expect(packageIndex).toBeGreaterThanOrEqual(0)
    expect(packageIndex).toBeLessThan(overlayIndex)
    expect(overlayIndex).toBeLessThan(checksIndex)
    expect(runText(windows)).not.toContain('gh release')

    const linux = jobs['unsigned-linux-build']
    const linuxText = JSON.stringify(linux)
    expect(linuxText).toContain('${{ inputs.unsigned_build_ref || github.sha }}')
    expect(linuxText).toContain(
      'unsigned-linux-testing-${{ steps.unsigned-source.outputs.sha }}-${{ github.run_id }}-${{ github.run_attempt }}'
    )
    expect(runText(linux)).toContain('xvfb-run -a npm run build:linux:nopublish')
    expect(runText(linux)).not.toContain('gh release')
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
    expect(runText(jobs['unsigned-linux-build'])).toContain(
      'xvfb-run -a npm run build:linux:nopublish'
    )
    expect(runText(jobs['signed-windows-release'])).toContain(
      'node scripts/guard-no-bundled-secrets.cjs --require-packaged'
    )
    expect(runText(jobs['signed-windows-release'])).toContain('npm run security:sbom')
    expect(runText(jobs['unsigned-linux-build'])).toContain('npm run security:deps')
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
