import type { LocalServerEntry } from '../localServers/types'

export type LaunchTargetSource =
  | 'local-server'
  | 'package-script'
  | 'vscode-launch'
  | 'vscode-compound'
  | 'vscode-task'
  | 'swiftpm'
  | 'xcode'

export type LaunchTargetKind =
  | 'preview'
  | 'dev-server'
  | 'run'
  | 'debug'
  | 'build'
  | 'test'
  | 'lint'
  | 'typecheck'
  | 'task'

export type LaunchTargetPlatform =
  | 'web'
  | 'electron'
  | 'node'
  | 'ios'
  | 'macos'
  | 'swiftpm'
  | 'unknown'

export interface LaunchTargetCommand {
  /** Human-readable command shown in approval/UI surfaces. */
  raw: string
  /** Structured argv when discovery can represent the command without shell parsing. */
  argv?: string[]
  cwd: string
  env?: Record<string, string>
  longRunning: boolean
  shell?: boolean
}

export interface LaunchTargetEvidence {
  path: string
  line?: number
  reason?: string
}

export interface LaunchTarget {
  id: string
  label: string
  subtitle?: string
  workspaceId?: string
  workspacePath: string
  source: LaunchTargetSource
  kind: LaunchTargetKind
  platform: LaunchTargetPlatform
  /** 0..1, where 1 is a running server or an exact explicit config. */
  confidence: number
  command?: LaunchTargetCommand
  url?: string
  primaryPort?: number
  localServerPid?: number
  localServer?: LocalServerEntry
  evidence: LaunchTargetEvidence[]
  /**
   * Read-only discovery can surface targets that still need a future picker
   * decision, such as Xcode destination or VS Code attach process selection.
   */
  blockers: string[]
}

export interface LaunchTargetsSnapshot {
  sampledAt: string
  workspacePath: string
  workspaceId?: string
  targets: LaunchTarget[]
  platform: NodeJS.Platform
  detectionAvailable: boolean
}
