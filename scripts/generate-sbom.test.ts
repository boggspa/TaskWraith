import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const {
  defaultNpmSbomRunner,
  generateSbom
}: {
  defaultNpmSbomRunner: (
    repoRoot: string,
    options: {
      platform: string
      env: Record<string, string>
      spawn: (
        command: string,
        args: string[],
        options: Record<string, unknown>
      ) => { status: number; stdout: string; stderr: string }
    }
  ) => { status: number; stdout: string; stderr: string }
  generateSbom: (options: {
    repoRoot: string
    outputPath: string
    runNpmSbom: () => { status: number; stdout: string; stderr: string }
  }) => string
} = require('./generate-sbom.cjs')

describe('release SBOM generation', () => {
  it('writes npm dependencies plus the verified standalone Node runtime', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-sbom-'))
    const runtimeDir = path.join(root, 'build', 'tui-runtime')
    fs.mkdirSync(runtimeDir, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({
        taskwraithRelease: { tuiNodeRuntime: { version: '22.23.2' } }
      })
    )
    const source = 'https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.gz'
    fs.writeFileSync(
      path.join(runtimeDir, 'RUNTIME.json'),
      JSON.stringify({
        nodeVersion: '22.23.2',
        targets: [
          {
            platform: 'linux',
            arch: 'x64',
            sha256: 'a'.repeat(64),
            archiveSha256: 'b'.repeat(64),
            licenseSha256: 'c'.repeat(64),
            source,
            licenseSource: `${source}#LICENSE`
          }
        ]
      })
    )

    try {
      const output = generateSbom({
        repoRoot: root,
        outputPath: 'dist/sbom-linux.cdx.json',
        runNpmSbom: () => ({
          status: 0,
          stdout: JSON.stringify({
            bomFormat: 'CycloneDX',
            metadata: { component: { 'bom-ref': 'taskwraith@1.9.2' } },
            components: [{ type: 'library', name: 'dependency' }],
            dependencies: [
              { ref: 'taskwraith@1.9.2', dependsOn: ['dependency@1.0.0'] },
              { ref: 'dependency@1.0.0', dependsOn: [] }
            ]
          }),
          stderr: ''
        })
      })
      const sbom = JSON.parse(fs.readFileSync(output, 'utf8'))
      expect(sbom.components.map((component: { name: string }) => component.name)).toEqual([
        'dependency',
        'Node.js standalone TUI runtime'
      ])
      const runtimeRef = sbom.components[1]['bom-ref']
      expect(sbom.dependencies).toEqual(
        expect.arrayContaining([
          {
            ref: 'taskwraith@1.9.2',
            dependsOn: ['dependency@1.0.0', runtimeRef]
          },
          { ref: runtimeRef, dependsOn: [] }
        ])
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('invokes npm.cmd through fixed ComSpec on Windows', () => {
    let invocation:
      | { command: string; args: string[]; options: Record<string, unknown> }
      | undefined
    defaultNpmSbomRunner('C:\\repo', {
      platform: 'win32',
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      spawn: (command, args, options) => {
        invocation = { command, args, options }
        return { status: 0, stdout: '{}', stderr: '' }
      }
    })

    expect(invocation).toMatchObject({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'call "npm.cmd" "sbom" "--sbom-format=cyclonedx" "--omit=dev"'],
      options: { windowsVerbatimArguments: true }
    })
  })
})
