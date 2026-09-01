import { createPublicKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildAuditBundleSnapshot,
  buildDiagnosticsSnapshot,
  buildProductOperationsStatus,
  buildReleaseAutomationStatus,
  createBridgeHealthRecord,
  createAuditBundleVerificationReceipt,
  createProductCrashRecord,
  filterProductCrashRecords,
  serializeAuditBundleSnapshot,
  signAuditBundleSnapshot,
  serializeDiagnosticsSnapshot,
  verifyAuditBundleSnapshotSignature
} from './ProductOperations'
import type { AppSettings, ProductAuditBundleSnapshot, ProductCrashRecord } from './store/types'
import { createRunEventRecord } from './RunEventStore'
import { generateIdentityKeyPair, signEd25519 } from '../shared/e2ee/keys'

const baseSettings: AppSettings = {
  activeProvider: 'gemini',
  claudeBinaryPath: '',
  kimiBinaryPath: '',
  storeLocalChatHistory: true,
  storeRawEvents: false,
  storePromptResponseInUsage: false,
  ensembleModeEnabled: true,
  geminiCheckpointingEnabled: false,
  chatContextTurns: 6,
  currency: 'USD',
  kimiSanitiserEnabled: false,
  kimiSanitiserCustomKeywords: '',
  appearanceMode: 'soft_glass',
  visualEffectStyle: 'auto',
  themeAppearance: 'system',
  themeCornerStyle: 'rounded',
  themeAccentStyle: 'system',
  toolIconAccent: 'system',
  userBubbleColor: 'system',
  appIconVariant: 'regular',
  promptSurfaceStyle: 'liquid_glass',
  composerStyle: 'default',
  funFxEnabled: true,
  funFxMode: 'cinematic',
  advancedFx: {
    agentAura: true,
    livingWorkspace: true,
    dataViz: true,
    refraction: true,
    intensity: 'cinematic'
  },
  reduceTransparency: false,
  reduceMotion: false,
  compactDensity: false,
  liveActivityViewport: true,
  showInspector: true,
  inspectorWidth: 380,
  sidebarWidth: 260,
  sidebarOpacity: 100,
  mainPaneOpacity: 100,
  agenticServices: {
    shellCommands: 'workspace',
    fileChanges: 'ask',
    mcpTools: 'ask',
    subThreadDelegation: 'ask',
    canvasInteraction: 'ask',
    canvasEval: 'ask',
    networkAccess: 'allow'
  },
  agenticWorkspaceGrants: [],
  autoResumeParentOnSubThreadCompletion: true,
  geminiMcpBridgeEnabled: true,
  codexSandboxFallback: 'ask_rerun',
  updateChannel: 'debug',
  approvalTimeouts: {
    enabled: true,
    perProviderMs: {
      gemini: 120_000,
      codex: 30_000,
      claude: 120_000,
      kimi: 60_000,
      grok: 120_000,
      cursor: 120_000,
      ollama: 120_000,
      antigravity: 120_000,
      pi: 120_000,
      mistral: 120_000,
      muse: 120_000,
      devin: 120_000
    },
    mainAuthorityMs: 60_000
  }
}

describe('ProductOperations', () => {
  it('redacts sensitive crash text and diagnostic settings', () => {
    const crash = createProductCrashRecord(
      {
        source: 'main',
        severity: 'error',
        message: `token=${'sk-' + 'exampleSecretValue1234567890'}`,
        stack: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'
      },
      {
        appVersion: '1.2.3',
        platform: 'darwin',
        arch: 'arm64',
        now: '2026-05-07T10:00:00.000Z'
      }
    )

    expect(crash.message).toContain('[redacted]')
    expect(crash.stack).toContain('[redacted]')
    expect(crash.appVersion).toBe('1.2.3')
  })

  it('filters crashes newest first with source and limit', () => {
    const records: ProductCrashRecord[] = [
      createProductCrashRecord(
        {
          source: 'renderer',
          severity: 'warning',
          message: 'old',
          occurredAt: '2026-05-07T09:00:00.000Z'
        },
        { appVersion: '1', platform: 'darwin', arch: 'arm64' }
      ),
      createProductCrashRecord(
        {
          source: 'main',
          severity: 'error',
          message: 'new',
          occurredAt: '2026-05-07T11:00:00.000Z'
        },
        { appVersion: '1', platform: 'darwin', arch: 'arm64' }
      ),
      createProductCrashRecord(
        {
          source: 'main',
          severity: 'warning',
          message: 'middle',
          occurredAt: '2026-05-07T10:00:00.000Z'
        },
        { appVersion: '1', platform: 'darwin', arch: 'arm64' }
      )
    ]

    const filtered = filterProductCrashRecords(records, { source: 'main', limit: 1 })

    expect(filtered).toHaveLength(1)
    expect(filtered[0].message).toBe('new')
  })

  it('includes redacted feedback receipt counts in product operations status', () => {
    const status = buildProductOperationsStatus({
      updateChannel: 'debug',
      appName: 'TaskWraith Debug',
      appVersion: '1.0.0',
      isPackaged: false,
      appPath: '/app',
      userDataPath: '/tmp/taskwraith',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '25.0.0',
      workspaces: [],
      chats: [],
      runQueue: [],
      runRecovery: [],
      approvalLedger: [],
      workspaceChanges: [],
      messageFeedbackReceipts: [
        {
          schemaVersion: 1,
          id: 'feedback-secret',
          source: 'message_metadata',
          action: 'set',
          chatId: 'chat-secret',
          messageId: 'message-secret',
          provider: 'codex',
          model: 'gpt-5.5',
          role: 'Reviewer',
          vote: 'down',
          at: 1,
          recordedAt: 2,
          reason: 'wrong-model-for-role',
          note: 'private feedback note',
          noteSensitive: true
        }
      ],
      externalPublishReceipts: [],
      auditRetentionPurgeReceipts: [],
      userMcpBlockedServers: [],
      scheduledTasks: [],
      recentCrashes: [],
      userDataExists: true,
      geminiBridgeStatus: null,
      packageJson: { scripts: {} },
      builderConfigText: '',
      env: {}
    })
    const serialized = JSON.stringify(status.auditReceipts)

    expect(status.auditReceipts?.counts.messageFeedback).toBe(1)
    expect(status.auditReceipts?.counts.messageFeedbackCastingSignals).toBe(1)
    expect(status.auditReceipts?.hashes.messageFeedback).toMatch(/^[a-f0-9]{64}$/)
    expect(status.auditReceipts?.recent.messageFeedback).toHaveLength(1)
    expect(status.auditReceipts?.recent.messageFeedback[0].receiptHash).toMatch(/^[a-f0-9]{64}$/)
    expect(serialized).not.toContain('feedback-secret')
    expect(serialized).not.toContain('message-secret')
    expect(serialized).not.toContain('gpt-5.5')
    expect(serialized).not.toContain('Reviewer')
    expect(serialized).not.toContain('wrong-model-for-role')
    expect(serialized).not.toContain('private feedback note')
  })

  it('builds redacted audit bundle verification receipt status', () => {
    const verificationReceipt = createAuditBundleVerificationReceipt(
      {
        ok: true,
        path: '/Users/alice/private/TaskWraith-Audit-Bundle-secret.json',
        manifest: {
          generatedAt: '2026-07-03T00:00:00.000Z',
          redactionMode: 'default',
          filters: { workspaceId: 'ws-secret', chatId: 'chat-secret' },
          tamperEvidence: 'local_hashes_signed'
        },
        verification: {
          ok: true,
          signaturePresent: true,
          payloadHashValid: true,
          signatureValid: true,
          sectionHashesValid: true,
          countsValid: true,
          keyId: 'audit-key-1'
        }
      },
      { id: 'verification-secret', verifiedAt: '2026-07-03T00:00:01.000Z' }
    )
    const status = buildProductOperationsStatus({
      updateChannel: 'debug',
      appName: 'TaskWraith Debug',
      appVersion: '1.0.0',
      isPackaged: false,
      appPath: '/app',
      userDataPath: '/tmp/taskwraith',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '25.0.0',
      workspaces: [],
      chats: [],
      runQueue: [],
      runRecovery: [],
      approvalLedger: [],
      workspaceChanges: [],
      messageFeedbackReceipts: [],
      externalPublishReceipts: [],
      auditBundleVerificationReceipts: [verificationReceipt],
      auditRetentionPurgeReceipts: [],
      userMcpBlockedServers: [],
      scheduledTasks: [],
      recentCrashes: [],
      userDataExists: true,
      geminiBridgeStatus: null,
      packageJson: { scripts: {} },
      builderConfigText: '',
      env: {}
    })
    const serialized = JSON.stringify(status.auditReceipts)

    expect(status.auditReceipts?.counts.auditBundleVerifications).toBe(1)
    expect(status.auditReceipts?.hashes.auditBundleVerifications).toMatch(/^[a-f0-9]{64}$/)
    expect(status.auditReceipts?.recent.auditBundleVerifications[0]).toMatchObject({
      ok: true,
      hasBundlePathBasename: true,
      tamperEvidence: 'local_hashes_signed',
      signatureValid: true
    })
    expect(serialized).not.toContain('/Users/alice/private')
    expect(serialized).not.toContain('ws-secret')
    expect(serialized).not.toContain('chat-secret')
    expect(serialized).not.toContain('verification-secret')
  })

  it('summarizes bridge health for enabled but unavailable TaskWraith MCP bridge', () => {
    const health = createBridgeHealthRecord({
      checkedAt: '2026-05-07T10:00:00.000Z',
      enabled: true,
      installed: true,
      available: false,
      serverName: 'TaskWraith',
      message: 'Installed but disabled.'
    })

    expect(health.status).toBe('warning')
    expect(health.provider).toBe('gemini')
  })

  it('detects hardened release automation from scripts and builder config', () => {
    const status = buildReleaseAutomationStatus({
      updateChannel: 'debug',
      now: '2026-05-07T10:00:00.000Z',
      packageJson: {
        scripts: {
          build: 'npm run typecheck && electron-vite build',
          test: 'vitest run',
          ci: 'npm run typecheck && npm run test && npm run smoke:node-pty',
          'smoke:node-pty': 'node scripts/smoke-node-pty.cjs',
          'smoke:package': 'node scripts/smoke-packaged-electron.cjs',
          'build:unpack':
            'npm run build && electron-builder --dir && node scripts/smoke-packaged-electron.cjs dist',
          'build:mac': 'npm run build && electron-builder --mac',
          'build:mac:notarized':
            'npm run build && electron-builder --mac -c.mac.notarize=true',
          'build:debug:mac':
            'npm run build && electron-builder --dir --config electron-builder.debug.yml',
          'build:debug:mac:notarized':
            'npm run build && electron-builder --dir --config electron-builder.debug.yml -c.mac.notarize=true',
          'build:debug:win':
            'npm run build && electron-builder --win --x64 --dir --config electron-builder.debug.yml',
          'build:win:unpack': 'npm run build && electron-builder --win --x64 --arm64 --dir',
          'build:win': 'npm run build && electron-builder --win --x64 --arm64',
          'build:win:signed': 'node scripts/require-windows-signing-env.cjs && npm run build:win',
          'validate:mac-update-feed': 'node scripts/validate-mac-update-feed.cjs dist',
          'validate:win-update-feed': 'node scripts/validate-win-update-feed.cjs dist'
        }
      },
      builderConfigText:
        'appId: com.chrisizatt.taskwraith\nproductName: TaskWraith Debug\ndirectories:\n  output: dist-debug\nasarUnpack:\n  - resources/**\n  - node_modules/node-pty/**\nafterPack: build/validate-native-modules.cjs\nnpmRebuild: true\npublish:\n  provider: github\n  owner: boggspa\n  repo: TaskWraith\n',
      env: {
        APPLE_KEYCHAIN_PROFILE: 'ExampleNotary',
        CSC_NAME: 'Developer ID Application: Example'
      }
    })

    expect(status.status).toBe('ok')
    expect(status.notarization.configured).toBe(true)
    expect(status.notarization.keychainProfile).toBe('ExampleNotary')
    expect(status.notarization.scriptName).toBe('build:mac:notarized')
    expect(status.nativeModules.configured).toBe(true)
    expect(status.updateDistribution.configured).toBe(true)
    expect(status.updateDistribution.provider).toBe('github')
    expect(status.appId).toBe('com.chrisizatt.taskwraith')
    expect(status.scripts.buildWinSigned).toContain('require-windows-signing-env')
    expect(status.scripts.validateWinUpdateFeed).toContain('validate-win-update-feed')
  })

  it('surfaces incompatible mac update artifacts in release automation diagnostics', () => {
    const status = buildReleaseAutomationStatus({
      updateChannel: 'stable',
      now: '2026-05-07T10:00:00.000Z',
      packageJson: {
        scripts: {
          build: 'npm run typecheck && electron-vite build',
          test: 'vitest run',
          ci: 'npm run typecheck && npm run test',
          'build:unpack': 'electron-builder --dir',
          'smoke:node-pty': 'node scripts/smoke-node-pty.cjs',
          'smoke:package': 'node scripts/smoke-packaged-electron.cjs'
        }
      },
      builderConfigText: '',
      updateArchitecture: {
        platform: 'darwin',
        arch: 'x64',
        artifactName: 'TaskWraith-1.0.73-arm64-mac.zip',
        artifactArch: 'arm64',
        compatible: false,
        reason: 'Incompatible update artifact: host=darwin-x64 artifact=arm64'
      }
    })

    expect(status.status).toBe('error')
    expect(status.architectureCompatibility).toMatchObject({
      status: 'error',
      hostPlatform: 'darwin',
      hostArch: 'x64',
      updateArtifactName: 'TaskWraith-1.0.73-arm64-mac.zip',
      updateArtifactArch: 'arm64',
      updateCompatible: false,
      reason: 'Incompatible update artifact: host=darwin-x64 artifact=arm64'
    })
  })

  it('builds a redacted diagnostics snapshot with product counts', () => {
    const status = buildProductOperationsStatus({
      updateChannel: 'debug',
      appName: 'TaskWraith Debug',
      appVersion: '1.0.0',
      isPackaged: false,
      appPath: '/app',
      userDataPath: '/tmp/taskwraith',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '25.0.0',
      workspaces: [],
      chats: [],
      runQueue: [
        {
          id: 'job-1',
          runId: 'run-1',
          provider: 'gemini',
          workspacePath: '/workspace',
          status: 'queued',
          source: 'manual',
          priority: 0,
          attempt: 0,
          createdAt: '2026-05-07T10:00:00.000Z',
          updatedAt: '2026-05-07T10:00:00.000Z',
          request: {
            prompt: 'hi',
            selectedModelType: 'flash',
            customModel: '',
            approvalMode: 'default',
            sessionTrust: false,
            imageAttachments: []
          }
        }
      ],
      runRecovery: [],
      approvalLedger: [
        {
          schemaVersion: 1,
          id: 'diag-approval-secret',
          approvalId: 'diag-approval-secret',
          provider: 'codex',
          service: 'shellCommands',
          method: 'codex-mcp/run_shell_command',
          title: 'Run diagnostics private command',
          body: 'diagnostics approval private body',
          preview: { command: 'echo diagnostics-private-token' },
          params: { prompt: 'diagnostics approval private params' },
          actions: ['accept', 'decline'],
          status: 'approved',
          requestedAt: '2026-05-07T10:00:00.000Z',
          respondedAt: '2026-05-07T10:00:01.000Z',
          decision: 'accept',
          decisionSource: 'user',
          expiration: { mode: 'run_end', description: 'Run end.' },
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          chatId: 'chat-secret',
          runId: 'run-secret'
        }
      ],
      workspaceChanges: [
        {
          schemaVersion: 1,
          id: 'diag-change-secret',
          source: 'provider_run',
          status: 'captured',
          title: 'Diagnostics private change title',
          summary: 'Diagnostics private change summary',
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          chatId: 'chat-secret',
          runId: 'run-secret',
          provider: 'codex',
          createdAt: '2026-05-07T10:00:00.000Z',
          updatedAt: '2026-05-07T10:00:01.000Z',
          files: [
            {
              path: 'src/diagnostics-private-secret.ts',
              status: 'modified',
              origin: 'run_diff',
              additions: 3,
              deletions: 1,
              diffText: 'diagnostics private diff body'
            }
          ],
          artifacts: [],
          stats: { filesChanged: 1, additions: 3, deletions: 1 }
        } as any
      ],
      scheduledTasks: [],
      recentCrashes: [],
      userDataExists: true,
      geminiBridgeStatus: {
        checkedAt: '2026-05-07T10:00:00.000Z',
        enabled: false,
        installed: false,
        available: false,
        serverName: 'TaskWraith'
      },
      packageJson: { scripts: {} },
      builderConfigText: '',
      env: {}
    })
    const snapshot = buildDiagnosticsSnapshot({
      status,
      settings: {
        ...baseSettings,
        codexUsageCredential: {
          encryptedAccessToken: 'secret-token',
          accountId: 'acct'
        }
      },
      workspaces: [],
      runQueue: [
        {
          id: 'queued-secret',
          runId: 'run-queued-secret',
          provider: 'codex',
          chatId: 'queue-chat-secret',
          workspacePath: '/secret/repo',
          status: 'queued',
          source: 'manual',
          priority: 0,
          attempt: 0,
          promptPreview: 'queued private roadmap preview',
          createdAt: '2026-05-07T10:00:00.000Z',
          updatedAt: '2026-05-07T10:00:00.000Z',
          request: {
            prompt: 'queued private roadmap prompt',
            displayPrompt: 'queued private roadmap display',
            selectedModelType: 'cli-default',
            customModel: '',
            approvalMode: 'default',
            sessionTrust: false,
            imageAttachments: [],
            remoteComposer: {
              workspaceId: 'remote-ws-secret',
              threadId: 'remote-thread-secret',
              provider: 'codex',
              text: 'remote composer secret text'
            }
          },
          dispatchReceipt: {
            schemaVersion: 1,
            generatedAt: '2026-05-07T10:00:00.000Z',
            receiptHash: 'd'.repeat(64),
            runId: 'run-queued-secret',
            provider: 'codex',
            source: 'manual',
            scope: 'workspace',
            workspaceId: 'ws-1',
            chatId: 'queue-chat-secret',
            ensembleParticipantId: 'participant-codex',
            ensembleLaneId: 'lane-round-1-participant-codex-1',
            ensembleRole: 'Worker',
            ensembleStageRole: 'worker',
            approvalMode: 'plan',
            workflowMode: 'plan',
            permissionPresetId: 'plan',
            readOnly: true,
            permissionPostureHash: 'a'.repeat(64),
            permissionPostureSignaturePresent: true,
            remoteComposer: {
              workspaceId: 'receipt-remote-ws-secret',
              threadId: 'receipt-remote-thread-secret',
              provider: 'codex',
              approvalMode: 'plan',
              workflowMode: 'plan'
            },
            remoteAllowlist: {
              decision: 'allowed',
              capability: 'startTurn',
              provider: 'codex',
              approvalMode: 'plan',
              policyFingerprint: 'f'.repeat(64),
              evaluatedAt: '2026-05-07T10:00:00.000Z'
            }
          }
        }
      ],
      runRecovery: [
        {
          schemaVersion: 1,
          id: 'recovery-secret',
          runId: 'run-recovery-secret',
          jobId: 'job-recovery-secret',
          provider: 'codex',
          previousStatus: 'active',
          recoveredStatus: 'failed',
          action: 'marked_failed',
          reason: 'Recovered after crash',
          recoveredAt: '2026-05-07T10:00:00.000Z',
          resumeAvailable: false,
          resumeHint: 'private recovery hint',
          jobSnapshot: {
            promptPreview: 'recovery private roadmap preview',
            processCommand: 'node --token sk-1234567890abcdefghijklmnop'
          }
        }
      ],
      scheduledTasks: [
        {
          id: 'task-1',
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          chatId: 'chat-secret',
          provider: 'codex',
          prompt: 'deploy the private roadmap',
          displayPrompt: 'private display prompt',
          selectedModelType: 'cli-default',
          customModel: '',
          approvalMode: 'default',
          workflowMode: 'plan',
          sessionTrust: false,
          imageAttachments: [{ id: 'img-1', path: '/secret/image.png', name: 'image.png' }],
          externalPathGrants: [
            {
              id: 'grant-1',
              provider: 'codex',
              path: '/secret/grant',
              kind: 'directory',
              access: 'read',
              duration: 'workspace',
              createdAt: '2026-05-07T10:00:00.000Z'
            }
          ],
          runtimeProfileId: 'runtime-secret',
          geminiAuthProfileId: 'auth-secret',
          runAt: '2026-05-07T10:00:00.000Z',
          timezone: 'UTC',
          status: 'pending',
          lastError: 'failed while reading /secret/task-error',
          createdAt: '2026-05-07T10:00:00.000Z',
          updatedAt: '2026-05-07T10:00:00.000Z',
          dispatchReceipt: {
            schemaVersion: 1,
            generatedAt: '2026-05-07T10:00:00.000Z',
            receiptHash: 'e'.repeat(64),
            runId: 'task-1',
            provider: 'codex',
            source: 'scheduled',
            scope: 'workspace',
            workspaceId: 'ws-1',
            chatId: 'chat-secret',
            approvalMode: 'plan',
            workflowMode: 'plan',
            permissionPresetId: 'plan',
            readOnly: true,
            permissionPostureHash: 'b'.repeat(64),
            permissionPostureSignaturePresent: true
          }
        }
      ],
      workflows: [
        {
          id: 'workflow-1',
          name: 'Private workflow',
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          enabled: true,
          trigger: { kind: 'manual' },
          template: {
            workspaceId: 'ws-1',
            workspacePath: '/secret/repo',
            chatId: 'chat-secret',
            provider: 'codex',
            prompt: 'audit unreleased roadmap',
            displayPrompt: 'workflow private display prompt',
            selectedModelType: 'cli-default',
            customModel: '',
            approvalMode: 'default',
            sessionTrust: false,
            imageAttachments: [{ id: 'img-2', path: '/secret/workflow-image.png', name: 'w.png' }],
            externalPathGrants: [
              {
                id: 'grant-2',
                provider: 'codex',
                path: '/secret/workflow-grant',
                kind: 'directory',
                access: 'write',
                duration: 'workspace',
                createdAt: '2026-05-07T10:00:00.000Z'
              }
            ],
            runtimeProfileId: 'workflow-runtime-secret',
            geminiAuthProfileId: 'workflow-auth-secret'
          },
          missedRunPolicy: 'coalesce',
          concurrencyPolicy: 'skip',
          limits: { maxRunsPerDay: 24, maxConsecutiveFailures: 3 },
          lastError: 'failed while reading /secret/workflow-error',
          failureStreak: 0,
          history: [
            {
              id: 'execution-1',
              workflowId: 'workflow-1',
              plannedFor: '2026-05-07T10:00:00.000Z',
              status: 'failed',
              error: 'failed while reading /secret/history-error',
              createdAt: '2026-05-07T10:00:00.000Z',
              updatedAt: '2026-05-07T10:00:00.000Z'
            }
          ],
          createdAt: '2026-05-07T10:00:00.000Z',
          updatedAt: '2026-05-07T10:00:00.000Z'
        }
      ],
      approvalLedger: [
        {
          schemaVersion: 1,
          id: 'diag-approval-secret',
          approvalId: 'diag-approval-secret',
          provider: 'codex',
          service: 'shellCommands',
          method: 'codex-mcp/run_shell_command',
          title: 'Run diagnostics private command',
          body: 'diagnostics approval private body',
          preview: { command: 'echo diagnostics-private-token' },
          params: { prompt: 'diagnostics approval private params' },
          actions: ['accept', 'decline'],
          status: 'approved',
          requestedAt: '2026-05-07T10:00:00.000Z',
          respondedAt: '2026-05-07T10:00:01.000Z',
          decision: 'accept',
          decisionSource: 'user',
          expiration: { mode: 'run_end', description: 'Run end.' },
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          chatId: 'chat-secret',
          runId: 'run-secret'
        }
      ],
      workspaceChanges: [
        {
          schemaVersion: 1,
          id: 'diag-change-secret',
          source: 'provider_run',
          status: 'captured',
          title: 'Diagnostics private change title',
          summary: 'Diagnostics private change summary',
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          chatId: 'chat-secret',
          runId: 'run-secret',
          provider: 'codex',
          createdAt: '2026-05-07T10:00:00.000Z',
          updatedAt: '2026-05-07T10:00:01.000Z',
          files: [
            {
              path: 'src/diagnostics-private-secret.ts',
              status: 'modified',
              origin: 'run_diff',
              additions: 3,
              deletions: 1,
              diffText: 'diagnostics private diff body'
            }
          ],
          artifacts: [],
          stats: { filesChanged: 1, additions: 3, deletions: 1 }
        } as any
      ],
      messageFeedbackReceipts: [
        {
          schemaVersion: 1,
          id: 'feedback-1',
          source: 'message_metadata',
          action: 'set',
          chatId: 'chat-secret',
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          messageId: 'msg-1',
          runId: 'run-1',
          provider: 'codex',
          model: 'gpt-5.5',
          role: 'Reviewer',
          vote: 'down',
          at: 1,
          recordedAt: 2,
          reason: 'wrong-model-for-role',
          note: 'private note with sk-1234567890abcdefghijklmnop',
          noteSensitive: true
        }
      ],
      externalPublishReceipts: [
        {
          schemaVersion: 1,
          id: 'publish-1',
          origin: 'agent',
          action: 'githubCreatePr',
          decision: 'allowed',
          reason: 'Agent external publishing passed TaskWraith external-publish policy.',
          requestedAt: '2026-07-03T00:00:00.000Z',
          completedAt: '2026-07-03T00:00:01.000Z',
          outcome: 'completed',
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          repoPath: '/secret/repo',
          title: 'Private roadmap PR',
          prUrl: 'https://github.com/private/repo/pull/1',
          metadata: { token: 'sk-1234567890abcdefghijklmnop', branch: 'feature/audit' }
        }
      ],
      auditRetentionPurgeReceipts: [
        {
          schemaVersion: 1,
          id: 'purge-secret',
          generatedAt: '2026-07-03T00:00:02.000Z',
          dryRun: false,
          enabled: true,
          policy: { enabled: true, maxAgeDays: { runEvents: 30 } },
          counts: {
            approvalLedger: { scanned: 2, retained: 1, deleted: 1 },
            runEvents: { scanned: 3, retained: 2, deleted: 1 },
            workspaceChanges: { scanned: 0, retained: 0, deleted: 0 },
            auditRuns: { scanned: 0, retained: 0, deleted: 0 },
            messageFeedback: { scanned: 0, retained: 0, deleted: 0 },
            externalPublish: { scanned: 0, retained: 0, deleted: 0 },
            productCrashes: { scanned: 0, retained: 0, deleted: 0 }
          }
        }
      ],
      userMcpBlockedServers: [
        {
          serverId: 'mcp-private-docs',
          serverName: 'Private Docs Search',
          transport: 'http',
          allowed: false,
          reason: 'env key PRIVATE_DOCS_TOKEN is not allowlisted'
        }
      ],
      recentCrashes: []
    })
    const serialized = serializeDiagnosticsSnapshot(snapshot)

    expect(status.counts.queuedRuns).toBe(1)
    expect(serialized).not.toContain('secret-token')
    expect(serialized).not.toContain('encryptedAccessToken')
    expect(serialized).not.toContain('deploy the private roadmap')
    expect(serialized).not.toContain('private display prompt')
    expect(serialized).not.toContain('audit unreleased roadmap')
    expect(serialized).not.toContain('workflow private display prompt')
    expect(serialized).not.toContain('/secret/repo')
    expect(serialized).not.toContain('/secret/grant')
    expect(serialized).not.toContain('/secret/workflow-grant')
    expect(serialized).not.toContain('/secret/image.png')
    expect(serialized).not.toContain('/secret/workflow-image.png')
    expect(serialized).not.toContain('/secret/task-error')
    expect(serialized).not.toContain('/secret/workflow-error')
    expect(serialized).not.toContain('/secret/history-error')
    expect(serialized).not.toContain('chat-secret')
    expect(serialized).not.toContain('runtime-secret')
    expect(serialized).not.toContain('workflow-runtime-secret')
    expect(serialized).not.toContain('auth-secret')
    expect(serialized).not.toContain('private note')
    expect(serialized).not.toContain('queued private roadmap prompt')
    expect(serialized).not.toContain('queued private roadmap display')
    expect(serialized).not.toContain('queued private roadmap preview')
    expect(serialized).not.toContain('remote composer secret text')
    expect(serialized).not.toContain('queue-chat-secret')
    expect(serialized).not.toContain('receipt-remote-ws-secret')
    expect(serialized).not.toContain('receipt-remote-thread-secret')
    expect(serialized).not.toContain('recovery private roadmap preview')
    expect(serialized).not.toContain('private recovery hint')
    expect(serialized).not.toContain('diagnostics approval private body')
    expect(serialized).not.toContain('diagnostics approval private params')
    expect(serialized).not.toContain('diagnostics-private-token')
    expect(serialized).not.toContain('Diagnostics private change title')
    expect(serialized).not.toContain('diagnostics private diff body')
    expect(serialized).not.toContain('src/diagnostics-private-secret.ts')
    expect(serialized).not.toContain('feedback-1')
    expect(serialized).not.toContain('msg-1')
    expect(serialized).not.toContain('run-1')
    expect(serialized).not.toContain('gpt-5.5')
    expect(serialized).not.toContain('Reviewer')
    expect(serialized).not.toContain('wrong-model-for-role')
    expect(serialized).not.toContain('Private roadmap PR')
    expect(serialized).not.toContain('https://github.com/private/repo')
    expect(serialized).not.toContain('sk-1234567890')
    expect(serialized).not.toContain('purge-secret')
    expect(serialized).not.toContain('mcp-private-docs')
    expect(serialized).not.toContain('Private Docs Search')
    expect(serialized).not.toContain('PRIVATE_DOCS_TOKEN')
    expect(serialized).toContain('externalPathGrantCount')
    expect(snapshot.auditReceipts.counts.messageFeedback).toBe(1)
    expect(snapshot.auditReceipts.counts.messageFeedbackCastingSignals).toBe(1)
    expect(snapshot.auditReceipts.counts.externalPublish).toBe(1)
    expect(snapshot.auditReceipts.counts.auditRetentionPurges).toBe(1)
    expect(snapshot.auditReceipts.counts.userMcpBlockedServers).toBe(1)
    expect(snapshot.runQueue[0]).toMatchObject({
      hasPromptPreview: true,
      request: {
        hasPrompt: true,
        hasDisplayPrompt: true,
        remoteComposer: { hasText: true }
      },
      dispatchReceipt: {
        receiptHash: 'd'.repeat(64),
        provider: 'codex',
        source: 'manual',
        ensembleLaneId: 'lane-round-1-participant-codex-1',
        ensembleStageRole: 'worker',
        workflowMode: 'plan',
        permissionPresetId: 'plan',
        permissionPostureHash: 'a'.repeat(64),
        permissionPostureSignaturePresent: true,
        remoteComposer: {
          provider: 'codex',
          approvalMode: 'plan',
          workflowMode: 'plan'
        },
        remoteAllowlist: {
          decision: 'allowed',
          capability: 'startTurn',
          provider: 'codex',
          approvalMode: 'plan',
          policyFingerprint: 'f'.repeat(64),
          evaluatedAt: '2026-05-07T10:00:00.000Z'
        }
      }
    })
    expect((snapshot.runQueue[0].dispatchReceipt as any).chatIdHash).toMatch(/^[a-f0-9]{64}$/)
    expect((snapshot.runQueue[0].dispatchReceipt as any).remoteComposer.workspaceIdHash).toMatch(
      /^[a-f0-9]{64}$/
    )
    expect((snapshot.runQueue[0].dispatchReceipt as any).remoteComposer.threadIdHash).toMatch(
      /^[a-f0-9]{64}$/
    )
    expect(snapshot.scheduledTasks[0]).toMatchObject({
      workflowMode: 'plan',
      dispatchReceipt: {
        receiptHash: 'e'.repeat(64),
        provider: 'codex',
        source: 'scheduled',
        approvalMode: 'plan',
        workflowMode: 'plan',
        permissionPresetId: 'plan',
        readOnly: true,
        permissionPostureHash: 'b'.repeat(64),
        permissionPostureSignaturePresent: true
      }
    })
    expect((snapshot.scheduledTasks[0].dispatchReceipt as any).chatIdHash).toMatch(
      /^[a-f0-9]{64}$/
    )
    expect(snapshot.runRecovery[0]).toMatchObject({
      hasResumeHint: true,
      jobSnapshot: { hasPromptPreview: true, hasProcessCommand: true }
    })
    expect(snapshot.approvalLedger[0]).toMatchObject({
      method: 'codex-mcp/run_shell_command',
      hasBody: true,
      hasPreview: true,
      hasParams: true
    })
    expect(snapshot.workspaceChanges[0]).toMatchObject({
      fileCount: 1,
      stats: { filesChanged: 1, additions: 3, deletions: 1 },
      files: [{ additions: 3, deletions: 1 }]
    })
    expect(snapshot.auditReceipts.hashes.messageFeedback).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.auditReceipts.hashes.externalPublish).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.auditReceipts.hashes.userMcpBlockedServers).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.auditReceipts.recent.messageFeedback[0]).toMatchObject({
      vote: 'down',
      hasRunId: true,
      hasModel: true,
      hasRole: true,
      hasReason: true,
      hasSensitiveNote: true
    })
    expect(snapshot.auditReceipts.recent.messageFeedback[0].receiptHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.auditReceipts.recent.messageFeedbackCastingSignals[0]).toMatchObject({
      provider: 'codex',
      hasModel: true,
      hasRole: true,
      samples: 1,
      up: 0,
      down: 1,
      net: -1,
      attributionComplete: 0
    })
    expect(
      (snapshot.auditReceipts.recent.messageFeedbackCastingSignals[0] as any).modelHash
    ).toMatch(/^[a-f0-9]{64}$/)
    expect(
      (snapshot.auditReceipts.recent.messageFeedbackCastingSignals[0] as any).roleHash
    ).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.auditReceipts.recent.externalPublish[0]).toMatchObject({
      id: 'publish-1',
      origin: 'agent',
      action: 'githubCreatePr',
      hasTitle: true,
      hasPrUrl: true
    })
    expect(snapshot.auditReceipts.recent.auditRetentionPurges[0]).toMatchObject({
      dryRun: false,
      enabled: true,
      surfaces: { runEvents: { scanned: 3, retained: 2, deleted: 1 } }
    })
    expect(snapshot.auditReceipts.recent.userMcpBlockedServers[0]).toMatchObject({
      transport: 'http',
      allowed: false,
      reasonCategory: 'env_key_not_allowlisted'
    })
    expect(snapshot.auditReceipts.recent.userMcpBlockedServers[0].serverIdHash).toMatch(
      /^[a-f0-9]{64}$/
    )
  })

  it('builds a redacted audit bundle with hashes, filters, and run-event validation', () => {
    const permissionPosture = {
      schemaVersion: 1,
      approvalMode: 'plan',
      workflowMode: 'plan',
      presetId: 'plan',
      readOnly: true,
      agenticServices: { shellCommands: 'deny' },
      networkAccess: 'deny',
      externalPathGrantCount: 0,
      workspaceGrantServiceIds: [],
      postureHash: 'p'.repeat(64),
      signature: 'do-not-export-signature',
      signaturePresent: true,
      context: { promptHash: 'h'.repeat(64) }
    }
    const firstEvent = createRunEventRecord(
      {
        runId: 'run-secret',
        chatId: 'chat-secret',
        workspaceId: 'ws-1',
        workspacePath: '/secret/repo',
        provider: 'codex',
        kind: 'lifecycle',
        phase: 'control',
        source: 'main',
        summary: 'private lifecycle summary',
        payload: { status: 'started', prompt: 'private run prompt', permissionPosture }
      },
      1,
      { now: '2026-07-03T00:00:00.000Z' }
    )
    const secondEvent = createRunEventRecord(
      {
        runId: 'run-secret',
        chatId: 'chat-secret',
        workspaceId: 'ws-1',
        workspacePath: '/secret/repo',
        provider: 'codex',
        kind: 'final_message',
        phase: 'normalized',
        source: 'main',
        summary: 'private final summary',
        payload: { content: 'private final answer with sk-1234567890abcdefghijklmnop' }
      },
      2,
      { now: '2026-07-03T00:00:01.000Z', previousHash: firstEvent.hash }
    )
    const bundle = buildAuditBundleSnapshot({
      filter: { workspaceId: 'ws-1' },
      approvalLedger: [
        {
          schemaVersion: 1,
          id: 'approval-secret',
          approvalId: 'approval-secret',
          provider: 'codex',
          service: 'shellCommands',
          method: 'codex-mcp/run_shell_command',
          title: 'Run private command',
          body: 'approval private body',
          preview: { command: 'echo sk-1234567890abcdefghijklmnop' },
          params: { prompt: 'approval private params' },
          actions: ['accept', 'decline'],
          status: 'approved',
          requestedAt: '2026-07-03T00:00:00.000Z',
          respondedAt: '2026-07-03T00:00:01.000Z',
          decision: 'accept',
          decisionSource: 'user',
          grantedScope: 'run',
          expiration: { mode: 'run_end', description: 'Run end.' },
          runId: 'run-secret',
          chatId: 'chat-secret',
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          metadata: { permissionPosture }
        },
        {
          schemaVersion: 1,
          id: 'approval-sibling',
          approvalId: 'approval-sibling',
          provider: 'codex',
          method: 'codex-mcp/read_file',
          title: 'Sibling',
          actions: [],
          status: 'denied',
          requestedAt: '2026-07-03T00:00:00.000Z',
          expiration: { mode: 'on_decision', description: 'Denied.' },
          workspaceId: 'ws-2'
        }
      ],
      runEvents: [firstEvent, secondEvent],
      workspaceChanges: [
        {
          schemaVersion: 1,
          id: 'change-secret',
          source: 'provider_run',
          status: 'captured',
          title: 'Private change title',
          summary: 'Private change summary',
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          chatId: 'chat-secret',
          runId: 'run-secret',
          provider: 'codex',
          createdAt: '2026-07-03T00:00:00.000Z',
          updatedAt: '2026-07-03T00:00:01.000Z',
          files: [
            {
              path: 'src/private-secret.ts',
              status: 'modified',
              origin: 'run_diff',
              additions: 1,
              deletions: 0,
              diffText: 'private diff body'
            }
          ],
          artifacts: [],
          stats: { filesChanged: 1, additions: 1, deletions: 0 }
        } as any
      ],
      auditRuns: [
        {
          schemaVersion: 1,
          id: 'audit-secret',
          mode: 'deep',
          chatId: 'chat-secret',
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          status: 'completed',
          phases: [],
          dimensions: ['private dimension'],
          participants: [],
          findings: [],
          verdicts: [],
          gates: [],
          budget: { maxAgents: 1, spentAgents: 1, spentTokens: 0, truncated: false },
          report: 'private audit report',
          createdAt: '2026-07-03T00:00:00.000Z',
          updatedAt: '2026-07-03T00:00:01.000Z'
        } as any
      ],
      evidencePacks: [
        {
          schemaVersion: 1,
          id: 'pack-secret',
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          chatId: 'chat-secret',
          runId: 'run-secret',
          provider: 'codex',
          title: 'Private evidence title',
          mapEntries: [],
          capabilityCells: [],
          completionClaims: [],
          diffTouchedFiles: ['src/private-secret.ts'],
          createdAt: '2026-07-03T00:00:00.000Z',
          updatedAt: '2026-07-03T00:00:01.000Z'
        } as any
      ],
      capabilityLedger: {
        workspaceId: 'ws-1',
        generatedAt: '2026-07-03T00:00:00.000Z',
        cells: [
          {
            capabilityKey: 'private-capability',
            title: 'Private capability title',
            status: 'verified',
            evidenceRefs: [{ path: 'src/private-secret.ts', note: 'private evidence note' }],
            latestEvidencePackId: 'pack-secret',
            latestRunId: 'run-secret',
            updatedAt: '2026-07-03T00:00:00.000Z'
          }
        ],
        mapEntries: [],
        totalCompletionClaims: 0,
        unsupportedCompletionClaims: 0,
        unsupportedCompletionClaimRate: 0,
        stallSignals: []
      } as any,
      messageFeedbackReceipts: [
        {
          schemaVersion: 1,
          id: 'feedback-secret',
          source: 'message_metadata',
          action: 'set',
          chatId: 'chat-secret',
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          messageId: 'message-secret',
          runId: 'run-secret',
          provider: 'codex',
          model: 'private-model',
          role: 'Reviewer',
          vote: 'down',
          at: 1,
          recordedAt: 2,
          reason: 'wrong-model-for-role',
          note: 'private feedback note',
          noteSensitive: true
        }
      ],
      externalPublishReceipts: [
        {
          schemaVersion: 1,
          id: 'publish-secret',
          origin: 'agent',
          action: 'githubCreatePr',
          decision: 'allowed',
          reason: 'Allowed.',
          requestedAt: '2026-07-03T00:00:00.000Z',
          completedAt: '2026-07-03T00:00:01.000Z',
          outcome: 'completed',
          workspaceId: 'ws-1',
          workspacePath: '/secret/repo',
          repoPath: '/secret/repo',
          title: 'Private PR title',
          prUrl: 'https://github.com/private/repo/pull/1',
          metadata: { token: 'sk-1234567890abcdefghijklmnop' }
        }
      ],
      auditRetentionPurgeReceipts: [
        {
          schemaVersion: 1,
          id: 'purge-secret',
          generatedAt: '2026-07-03T00:00:02.000Z',
          dryRun: false,
          enabled: true,
          policy: { enabled: true, maxAgeDays: { runEvents: 30 } },
          counts: {
            approvalLedger: { scanned: 2, retained: 1, deleted: 1 },
            runEvents: { scanned: 3, retained: 2, deleted: 1 },
            workspaceChanges: { scanned: 0, retained: 0, deleted: 0 },
            auditRuns: { scanned: 0, retained: 0, deleted: 0 },
            messageFeedback: { scanned: 0, retained: 0, deleted: 0 },
            externalPublish: { scanned: 0, retained: 0, deleted: 0 },
            productCrashes: { scanned: 0, retained: 0, deleted: 0 }
          }
        }
      ],
      userMcpBlockedServers: [
        {
          serverId: 'mcp-private-docs',
          serverName: 'Private Docs Search',
          transport: 'http',
          allowed: false,
          reason: 'header X-Private-Docs is not allowlisted'
        }
      ],
      now: '2026-07-03T00:00:02.000Z'
    })
    const serialized = serializeAuditBundleSnapshot(bundle)

    expect(bundle.manifest.counts).toMatchObject({
      approvalLedger: 1,
      runEventReplays: 1,
      runEvents: 2,
      workspaceChanges: 1,
      auditRuns: 1,
      evidencePacks: 1,
      capabilityLedgerEntries: 1,
      messageFeedback: 1,
      messageFeedbackCastingSignals: 1,
      externalPublish: 1,
      auditRetentionPurges: 1,
      userMcpBlockedServers: 1
    })
    expect(bundle.manifest.validation.runEventHashChains).toEqual({
      checked: 1,
      valid: 1,
      invalid: 0
    })
    expect(bundle.manifest.validation.permissionPostureProofs).toMatchObject({
      approvalLedger: 1,
      runEvents: 1,
      auditRuns: 0
    })
    expect(serialized).not.toContain('approval private body')
    expect(serialized).not.toContain('approval private params')
    expect(serialized).not.toContain('private run prompt')
    expect(serialized).not.toContain('private final answer')
    expect(serialized).not.toContain('private diff body')
    expect(serialized).not.toContain('private audit report')
    expect(serialized).not.toContain('private evidence note')
    expect(serialized).not.toContain('private feedback note')
    expect(serialized).not.toContain('private-model')
    expect(serialized).not.toContain('Reviewer')
    expect(serialized).not.toContain('wrong-model-for-role')
    expect(serialized).not.toContain('https://github.com/private/repo')
    expect(serialized).not.toContain('Private PR title')
    expect(serialized).not.toContain('/secret/repo')
    expect(serialized).not.toContain('src/private-secret.ts')
    expect(serialized).not.toContain('purge-secret')
    expect(serialized).not.toContain('mcp-private-docs')
    expect(serialized).not.toContain('Private Docs Search')
    expect(serialized).not.toContain('X-Private-Docs')
    expect(serialized).not.toContain('do-not-export-signature')
    expect(serialized).not.toContain('approval-sibling')
    expect(bundle.manifest.hashes.runEventReplays).toMatch(/^[a-f0-9]{64}$/)
    expect(bundle.manifest.hashes.messageFeedbackCastingSignals).toMatch(/^[a-f0-9]{64}$/)
    expect(bundle.manifest.hashes.userMcpBlockedServers).toMatch(/^[a-f0-9]{64}$/)
    expect(bundle.sections.messageFeedbackCastingSignals[0]).toMatchObject({
      provider: 'codex',
      hasModel: true,
      hasRole: true,
      samples: 1,
      down: 1,
      net: -1
    })
    expect(bundle.sections.userMcpBlockedServers[0]).toMatchObject({
      transport: 'http',
      allowed: false,
      reasonCategory: 'header_not_allowlisted'
    })
  })

  it('includes redacted audit bundle verification receipts in audit bundles', () => {
    const receipt = createAuditBundleVerificationReceipt(
      {
        ok: false,
        path: '/private/bundles/failed-secret-bundle.json',
        error: 'Signature check failed for /private/bundles/failed-secret-bundle.json'
      },
      { id: 'verification-secret', verifiedAt: '2026-07-03T00:00:03.000Z' }
    )
    const bundle = buildAuditBundleSnapshot({
      approvalLedger: [],
      runEvents: [],
      workspaceChanges: [],
      auditRuns: [],
      evidencePacks: [],
      messageFeedbackReceipts: [],
      externalPublishReceipts: [],
      auditBundleVerificationReceipts: [receipt],
      now: '2026-07-03T00:00:04.000Z'
    })
    const serialized = serializeAuditBundleSnapshot(bundle)

    expect(bundle.manifest.counts.auditBundleVerifications).toBe(1)
    expect(bundle.manifest.hashes.auditBundleVerifications).toMatch(/^[a-f0-9]{64}$/)
    expect(bundle.sections.auditBundleVerifications[0]).toMatchObject({
      ok: false,
      hasError: true
    })
    expect(serialized).not.toContain('/private/bundles')
    expect(serialized).not.toContain('verification-secret')
  })

  it('signs audit bundles and rejects tampered manifests or sections', () => {
    const keyPair = generateIdentityKeyPair()
    const publicKeyDerBase64 = (
      createPublicKey(keyPair.privateKey).export({ type: 'spki', format: 'der' }) as Buffer
    ).toString('base64')
    const unsigned = buildAuditBundleSnapshot({
      approvalLedger: [],
      runEvents: [],
      workspaceChanges: [],
      auditRuns: [],
      evidencePacks: [],
      messageFeedbackReceipts: [],
      externalPublishReceipts: [],
      now: '2026-07-03T00:00:02.000Z'
    })
    const signed = signAuditBundleSnapshot(unsigned, {
      keyId: 'test-audit-key',
      publicKeyDerBase64,
      signedAt: '2026-07-03T00:00:03.000Z',
      signPayload: (payload) => signEd25519(keyPair.privateKey, payload)
    })

    expect(signed.manifest.validation.tamperEvidence).toBe('local_hashes_signed')
    expect(signed.manifest.signature).toMatchObject({
      schemaVersion: 1,
      algorithm: 'ed25519',
      keyId: 'test-audit-key',
      publicKeyDerBase64,
      signedAt: '2026-07-03T00:00:03.000Z'
    })
    expect(verifyAuditBundleSnapshotSignature(signed)).toMatchObject({
      ok: true,
      signaturePresent: true,
      payloadHashValid: true,
      signatureValid: true,
      sectionHashesValid: true,
      countsValid: true
    })

    const tamperedSections: ProductAuditBundleSnapshot = {
      ...signed,
      sections: {
        ...signed.sections,
        approvalLedger: [{ tampered: true }]
      }
    }
    expect(verifyAuditBundleSnapshotSignature(tamperedSections)).toMatchObject({
      ok: false,
      payloadHashValid: false,
      signatureValid: false,
      sectionHashesValid: false,
      countsValid: false
    })

    const tamperedSignature: ProductAuditBundleSnapshot = {
      ...signed,
      manifest: {
        ...signed.manifest,
        signature: {
          ...signed.manifest.signature!,
          payloadHash: '0'.repeat(64)
        }
      }
    }
    expect(verifyAuditBundleSnapshotSignature(tamperedSignature)).toMatchObject({
      ok: false,
      payloadHashValid: false,
      signatureValid: true
    })
  })
})
