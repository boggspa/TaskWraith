import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import os from 'node:os'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const yaml: { load: (text: string) => unknown } = require('js-yaml')

type Step = {
  if?: string
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
  it('checks private handoff access without giving CI broader repository permissions', () => {
    const preflight = jobs['handoff-input-preflight']
    expect(preflight.if).toBe(
      "github.event_name == 'workflow_dispatch' && inputs.unsigned_distribution == 'handoff'"
    )
    expect(preflight.permissions).toEqual({ contents: 'read' })
    expect(actionSteps(preflight).some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(
      false
    )
    expect(runText(preflight)).not.toContain('npm ')
    const script = runText(preflight)
      .trim()
      .replace(/^node <<'NODE'\n/, '')
      .replace(/\nNODE\s*$/, '')
    const source = 'a'.repeat(40)
    const bytes = Buffer.from(JSON.stringify({ prepared: true, sourceCommit: source }))
    const digest = crypto.createHash('sha256').update(bytes).digest('hex')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-handoff-preflight-test-'))
    const downloads: string[][] = []
    const execute = (expectedDigest: string, expectedSource: string) =>
      vm.runInNewContext(script, {
        require: (name: string) => {
          if (name === 'node:os') return { tmpdir: () => root }
          if (name === 'node:child_process') {
            return {
              execFileSync: (command: string, args: string[]) => {
                expect(command).toBe('gh')
                expect(args.slice(0, 7)).toEqual([
                  'release',
                  'download',
                  'v0.1.0-handoff-rc.1',
                  '--repo',
                  'boggspa/TaskWraith',
                  '--pattern',
                  'identity-handoff.json'
                ])
                downloads.push(args)
                fs.writeFileSync(path.join(args[8], 'identity-handoff.json'), bytes)
              }
            }
          }
          return require(name)
        },
        process: {
          env: {
            TASKWRAITH_HANDOFF_DOWNLOAD_TAG: 'v0.1.0-handoff-rc.1',
            TASKWRAITH_HANDOFF_PAYLOAD_SHA256: expectedDigest,
            TASKWRAITH_HANDOFF_SOURCE_COMMIT: expectedSource
          }
        },
        console: { log: () => {} }
      })
    try {
      expect(() => execute(digest, source)).not.toThrow()
      expect(() => execute('b'.repeat(64), source)).toThrow('SHA-256 mismatch')
      expect(() => execute(digest, 'c'.repeat(40))).toThrow('source mismatch')
      expect(downloads).toHaveLength(3)
      expect(fs.readdirSync(root)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('defers Studio from both release identities while retaining its separate development lane', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
    const { loadBuilderIdentity } = require('./release-distribution.cjs')
    expect(pkg.taskwraithRelease.studioCompanion).toBe(false)
    for (const name of [
      'build:unpack',
      'build:mac',
      'build:mac:notarized',
      'build:debut:mac',
      'build:debut:mac:notarized'
    ]) {
      expect(pkg.scripts[name]).not.toContain('studio-companion')
    }
    for (const file of [
      'electron-builder.yml',
      'electron-builder.release.yml',
      'electron-builder.debut.yml'
    ]) {
      const config = loadBuilderIdentity(process.cwd(), file).config
      expect(config.extraMetadata.taskwraithStudioCompanionIncluded).toBe(false)
      expect(config.mac.extraResources).toEqual([])
    }
    expect(pkg.scripts['test:studio']).toBe('node scripts/run-studio-tests.cjs')
    expect(pkg.scripts['build:debug:mac']).toContain('studio-companion')
  })

  it('builds debut and pinned handoff identities in read-only unsigned lanes', () => {
    for (const platform of ['windows', 'linux']) {
      const steps = jobs[`unsigned-${platform}-build`].steps || []
      const prepare = steps.find(
        (step) => step.run === 'node scripts/prepare-ci-identity-handoff.cjs'
      )
      expect(prepare?.if).toBe("inputs.unsigned_distribution == 'handoff'")
      expect(prepare?.env?.TASKWRAITH_HANDOFF_PAYLOAD_SHA256).toBe(
        '${{ inputs.handoff_payload_sha256 }}'
      )
      expect(
        steps.some(
          (step) =>
            step.if === "inputs.unsigned_distribution == 'debut'" &&
            step.run?.includes('build:debut:')
        )
      ).toBe(true)
      const handoff = steps.find((step) => step.run?.includes('run-identity-handoff-build.cjs'))
      expect(handoff?.if).toBe("inputs.unsigned_distribution == 'handoff'")
      expect(handoff?.run).toContain('--payload')
      expect(handoff?.run).toContain('--artifact-dir')
      expect(JSON.stringify(jobs[`unsigned-${platform}-build`])).toContain("'dist-debut' || 'dist'")
      expect(jobs[`unsigned-${platform}-build`].permissions?.contents).toBe('read')
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'))
    expect(pkg.scripts['build:debut:win']).not.toContain('require-windows-signing-env')
    expect(pkg.scripts['build:debut:win']).toContain('smoke-win-installer.ps1')
    expect(pkg.scripts['build:debut:win']).toContain('-AllowUnsigned')
    expect(pkg.scripts['build:win:handoff-smoke']).toContain('-AllowUnsigned')
    expect(pkg.scripts['build:win:signed:handoff-smoke']).not.toContain('-AllowUnsigned')
    expect(pkg.scripts['build:handoff:win']).toContain('build:win:handoff-smoke')
    expect(pkg.scripts['postbuild:debut:mac:notarized']).toBe('npm run smoke:debut:mac-artifacts')
    expect(pkg.scripts['postbuild:debut:linux']).toBe('npm run smoke:debut:linux-artifacts')
    const nativeArm = jobs['unsigned-windows-arm64-smoke']
    expect(nativeArm['runs-on']).toBe('windows-11-arm')
    expect(nativeArm.needs).toEqual(['unsigned-windows-build'])
    expect(JSON.stringify(nativeArm)).toContain(
      '${{ needs.unsigned-windows-build.outputs.source-sha }}'
    )
    expect(JSON.stringify(nativeArm)).toContain(
      '${{ needs.unsigned-windows-build.outputs.artifact-name }}'
    )
    expect(runText(nativeArm)).toContain('win-arm64-setup.exe')
    expect(runText(nativeArm)).toContain('-AllowUnsigned')
    for (const name of ['unsigned-windows-build', 'unsigned-windows-arm64-smoke']) {
      const replacement = jobs[name].steps?.find((step) =>
        step.run?.includes('-PreviousInstallerPath')
      )
      expect(replacement?.if).toBe("inputs.unsigned_distribution == 'handoff'")
      expect(replacement?.run).toContain('-ExpectedInstallerSha256')
      expect(replacement?.run).toContain('TaskWraith-0.1.0-win-')
      expect(replacement?.run).toContain('TaskWraith-1.9.9-win-')
    }
  })

  it('keeps artifact builders read-only and reserves mutation for the disabled publisher', () => {
    const builders = [
      'notarized-macos-release',
      'signed-windows-release',
      'windows-arm64-release-candidate',
      'unsigned-windows-build',
      'unsigned-windows-arm64-smoke',
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

  it.each([
    { version: '1.9.9', distribution: 'beta', channel: 'latest' },
    { version: '0.1.1', distribution: 'release', channel: 'release' },
    { version: '0.1.1-beta.1', distribution: 'release', channel: 'beta' }
  ])(
    'packages and verifies signed Windows $version using its $distribution identity',
    ({ version, distribution, channel }) => {
      const steps = jobs['signed-windows-release'].steps || []
      const signing = steps.find((step) => step.name === 'Sign and package Windows artifacts')
      const verification = steps.find((step) => step.name === 'Verify signed Windows artifacts')
      const builderCommand = signing?.run?.match(
        /^\s*node (scripts\/run-electron-builder\.cjs) (.+)$/m
      )
      const feedExpression = verification?.run?.match(/^\s*\$feedPrefix = node -p "([^"]+)"$/m)?.[1]
      expect(builderCommand, 'signed packaging must resolve the declared distribution').toBeTruthy()
      expect(
        feedExpression,
        'feed verification must resolve the declared distribution'
      ).toBeTruthy()

      const sourceRoot = process.cwd()
      const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-signed-windows-distribution-'))
      const distDir = path.join(repoRoot, 'dist')
      try {
        fs.mkdirSync(distDir)
        fs.mkdirSync(path.join(repoRoot, 'scripts'))
        fs.writeFileSync(
          path.join(repoRoot, 'package.json'),
          JSON.stringify({ version, taskwraithRelease: { distribution } })
        )
        for (const file of [
          'scripts/release-distribution.cjs',
          'electron-builder.yml',
          'electron-builder.release.yml'
        ]) {
          fs.copyFileSync(path.join(sourceRoot, file), path.join(repoRoot, file))
        }
        for (const arch of ['x64', 'arm64']) {
          const installer = path.join(distDir, `TaskWraith-${version}-win-${arch}-setup.exe`)
          fs.writeFileSync(installer, `fixture installer ${arch}`)
          fs.writeFileSync(`${installer}.blockmap`, `fixture blockmap ${arch}`)
        }
        const options = {
          cwd: repoRoot,
          encoding: 'utf8' as const,
          stdio: 'pipe' as const,
          env: { ...process.env, NODE_PATH: path.join(sourceRoot, 'node_modules') }
        }
        execFileSync(
          process.execPath,
          [path.join(sourceRoot, 'scripts/write-win-update-feeds.cjs'), 'dist'],
          options
        )
        // Execute the exact channel expression from the workflow against the
        // real release configs, then compare it with the producer's files.
        const feedPrefix = execFileSync(process.execPath, ['-p', feedExpression!], options).trim()
        expect(feedPrefix).toBe(channel)
        expect(
          fs
            .readdirSync(distDir)
            .filter((file) => file.endsWith('.yml'))
            .sort()
        ).toEqual(['x64', 'arm64'].map((arch) => `${feedPrefix}-win-${arch}.yml`).sort())
        const { resolveBuilderArgs } = require(path.join(sourceRoot, builderCommand![1]))
        expect(resolveBuilderArgs(builderCommand![2].trim().split(/\s+/), repoRoot)).toEqual([
          '--win',
          '--x64',
          '--arm64',
          '--publish',
          'never',
          '--config',
          distribution === 'beta' ? 'electron-builder.yml' : 'electron-builder.release.yml'
        ])
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true })
      }
    }
  )

  it('labels manual unsigned artifacts with the selected source SHA', () => {
    const windows = jobs['unsigned-windows-build']
    const windowsText = JSON.stringify(windows)
    const windowsSteps = windows.steps || []
    const packageIndex = windowsSteps.findIndex((step) =>
      step.run?.includes(
        'node scripts/run-electron-builder.cjs --win --x64 --arm64 --publish never'
      )
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
