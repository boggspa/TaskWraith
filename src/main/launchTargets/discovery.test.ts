import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LocalServerEntry } from '../localServers/types'
import { discoverLaunchTargets } from './discovery'

async function tempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'taskwraith-launch-targets-'))
}

async function write(filePath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, text, 'utf8')
}

function localServer(workspacePath: string): LocalServerEntry {
  return {
    id: '123',
    pid: 123,
    name: 'vite',
    command: 'npm run dev',
    ports: [5173],
    primaryPort: 5173,
    cwd: workspacePath,
    workspacePath,
    origin: 'detected'
  }
}

describe('discoverLaunchTargets', () => {
  it('surfaces running local servers and package scripts for a workspace', async () => {
    const workspace = await tempWorkspace()
    await write(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/feature/run-button\n')
    await write(
      path.join(workspace, 'package.json'),
      JSON.stringify(
        {
          packageManager: 'pnpm@10.0.0',
          scripts: {
            dev: 'electron-vite dev',
            build: 'electron-vite build',
            test: 'vitest run',
            typecheck: 'npm run typecheck:node && npm run typecheck:web',
            format: 'prettier --write .',
            lint: 'eslint .'
          }
        },
        null,
        2
      )
    )

    const snapshot = await discoverLaunchTargets({
      workspacePath: workspace,
      workspaceId: 'ws-1',
      localServers: [localServer(workspace)],
      now: () => new Date('2026-06-21T12:00:00.000Z')
    })

    expect(snapshot).toMatchObject({
      sampledAt: '2026-06-21T12:00:00.000Z',
      workspacePath: workspace,
      workspaceId: 'ws-1',
      detectionAvailable: true
    })
    expect(snapshot.git).toMatchObject({
      isRepo: true,
      repoRoot: workspace,
      branch: 'feature/run-button'
    })
    expect(snapshot.targets[0]).toMatchObject({
      source: 'local-server',
      kind: 'preview',
      url: 'http://localhost:5173',
      primaryPort: 5173,
      git: {
        isRepo: true,
        branch: 'feature/run-button'
      }
    })
    expect(snapshot.targets.find((target) => target.label === 'pnpm dev')).toMatchObject({
      source: 'package-script',
      kind: 'dev-server',
      platform: 'electron',
      command: {
        raw: 'pnpm dev',
        argv: ['pnpm', 'dev'],
        longRunning: true
      }
    })
    expect(snapshot.targets.find((target) => target.label === 'pnpm build')).toMatchObject({
      kind: 'build',
      command: { argv: ['pnpm', 'build'], longRunning: false }
    })
    expect(snapshot.targets.find((target) => target.label === 'pnpm typecheck')).toMatchObject({
      kind: 'typecheck'
    })
    expect(snapshot.targets.find((target) => target.label === 'pnpm lint')).toMatchObject({
      kind: 'lint'
    })
    expect(snapshot.targets.some((target) => target.label === 'pnpm format')).toBe(false)
  })

  it('parses JSONC VS Code launch and task definitions', async () => {
    const workspace = await tempWorkspace()
    await write(
      path.join(workspace, '.vscode', 'launch.json'),
      `{
        // JSONC comment
        "configurations": [
          {
            "name": "Debug API",
            "type": "pwa-node",
            "request": "launch",
            "program": "\${workspaceFolder}/server/index.js",
          },
          {
            "name": "Attach",
            "type": "pwa-node",
            "request": "attach",
          },
        ],
        "compounds": [
          {
            "name": "Debug All",
            "configurations": ["Debug API", "Attach"],
          },
        ],
      }`
    )
    await write(
      path.join(workspace, '.vscode', 'tasks.json'),
      `{
        "tasks": [
          {
            "label": "Build Web",
            "type": "process",
            "command": "npm",
            "args": ["run", "build"],
            "group": "build",
          }
        ]
      }`
    )

    const snapshot = await discoverLaunchTargets({ workspacePath: workspace })

    expect(snapshot.targets.find((target) => target.label === 'Debug API')).toMatchObject({
      source: 'vscode-launch',
      kind: 'debug',
      platform: 'node',
      command: {
        argv: ['node', path.join(workspace, 'server/index.js')]
      },
      blockers: []
    })
    expect(snapshot.targets.find((target) => target.label === 'Attach')).toMatchObject({
      source: 'vscode-launch',
      blockers: ['Attach configurations require a running process selection.']
    })
    expect(snapshot.targets.find((target) => target.label === 'Debug All')).toMatchObject({
      source: 'vscode-compound',
      kind: 'debug',
      blockers: ['Compound launches require orchestrating multiple child configurations.']
    })
    expect(snapshot.targets.find((target) => target.label === 'Build Web')).toMatchObject({
      source: 'vscode-task',
      kind: 'build',
      command: {
        raw: 'npm run build',
        argv: ['npm', 'run', 'build'],
        shell: false
      }
    })
  })

  it('discovers SwiftPM packages and shared Xcode schemes without executing tools', async () => {
    const workspace = await tempWorkspace()
    await write(
      path.join(workspace, 'swift', 'Tool', 'Package.swift'),
      `// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "Tool",
  products: [
    .executable(name: "taskwraith-tool", targets: ["Tool"]),
  ],
  targets: [
    .executableTarget(name: "Tool")
  ]
)
`
    )
    await write(
      path.join(
        workspace,
        'ios',
        'TaskWraith.xcodeproj',
        'xcshareddata',
        'xcschemes',
        'TaskWraith.xcscheme'
      ),
      '<Scheme />'
    )

    const snapshot = await discoverLaunchTargets({ workspacePath: workspace })

    expect(snapshot.targets.find((target) => target.label === 'swift build (Tool)')).toMatchObject({
      source: 'swiftpm',
      kind: 'build',
      command: { argv: ['swift', 'build'] }
    })
    expect(snapshot.targets.find((target) => target.label === 'swift run taskwraith-tool')).toMatchObject({
      source: 'swiftpm',
      kind: 'run',
      command: { argv: ['swift', 'run', 'taskwraith-tool'] }
    })
    expect(snapshot.targets.find((target) => target.label === 'TaskWraith (Xcode build)')).toMatchObject({
      source: 'xcode',
      kind: 'build',
      platform: 'ios',
      command: {
        argv: [
          'xcodebuild',
          '-project',
          path.join(workspace, 'ios', 'TaskWraith.xcodeproj'),
          '-scheme',
          'TaskWraith',
          'build'
        ]
      }
    })
    const xcodeRun = snapshot.targets.find((target) => target.label === 'TaskWraith (Xcode run)')
    expect(xcodeRun).toMatchObject({
      source: 'xcode',
      kind: 'run',
      platform: 'ios',
      requirements: [
        {
          kind: 'destination',
          label: 'Run destination',
          required: true,
          options: expect.arrayContaining([
            expect.objectContaining({
              id: 'generic-ios-device',
              label: 'Any iOS Device',
              available: true
            }),
            expect.objectContaining({
              id: 'generic-ios-simulator',
              label: 'Any iOS Simulator Device',
              available: false
            })
          ])
        }
      ],
      blockers: ['Run destination selection is required before launching an Xcode scheme.']
    })
    expect(xcodeRun?.command).toBeUndefined()
  })
})
