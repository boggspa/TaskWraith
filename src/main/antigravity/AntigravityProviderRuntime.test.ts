import { describe, expect, it, vi } from 'vitest'
import {
  getAntigravityProviderStatus,
  prepareAntigravityProviderLaunch
} from './AntigravityProviderRuntime'
import { formatAgyProjectBoundSessionId } from './AntigravityConversationReceipt'
import { withAntigravityLongTurnProgress } from './AntigravityLongTurnProgress'

const OPTED_IN = {
  antigravityEnabled: true,
  antigravityOptInAcceptedAt: 1_700_000_000_000
} as const

describe('prepareAntigravityProviderLaunch', () => {
  it('fails closed before resolving a binary when informed opt-in is absent', async () => {
    const resolveBinary = vi.fn()

    await expect(
      prepareAntigravityProviderLaunch(
        { settings: {}, prompt: 'Inspect the repository.', approvalMode: 'default' },
        { resolveBinary }
      )
    ).rejects.toThrow(/disabled until the user enables/i)

    expect(resolveBinary).not.toHaveBeenCalled()
  })

  it('prepares a sanitized sandboxed plan-mode argv for a read-only run', async () => {
    const launch = await prepareAntigravityProviderLaunch(
      {
        settings: OPTED_IN,
        prompt: 'Review the failing test.',
        model: 'cli-default',
        reasoningEffort: 'high',
        approvalMode: 'plan',
        inheritedEnv: { PATH: '/usr/bin', GOOGLE_API_KEY: 'must-not-pass', KEEP: 'yes' }
      },
      {
        resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy', source: 'common' })
      }
    )

    expect(launch.mode).toBe('plan')
    expect(launch.args).toEqual([
      '--sandbox',
      '--mode',
      'plan',
      '--print-timeout',
      '30m',
      '--new-project',
      '--effort',
      'high',
      '-p',
      withAntigravityLongTurnProgress('Review the failing test.')
    ])
    expect(launch.env).toEqual({ PATH: '/usr/bin', KEEP: 'yes' })
    expect(launch.args).not.toContain('--dangerously-skip-permissions')
    expect(launch.args).toContain('--new-project')
    expect(launch.resumedConversationId).toBeNull()
  })

  it('threads only the exact admitted workspace-lock owner into the agy launch', async () => {
    const launch = await prepareAntigravityProviderLaunch(
      {
        settings: OPTED_IN,
        prompt: 'Apply the approved change.',
        approvalMode: 'default',
        workspaceLockOwnerId: 'exact-antigravity-seat-owner',
        inheritedEnv: {
          PATH: '/usr/bin',
          TASKWRAITH_LOCK_OWNER_ID: 'ambient-owner'
        }
      },
      {
        resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy', source: 'common' })
      }
    )

    expect(launch.env.TASKWRAITH_LOCK_OWNER_ID).toBe('exact-antigravity-seat-owner')
  })

  // agy has no per-tool approval bridge, so a denied shell/file service can only
  // be honoured at launch. Before this, "Shell commands: deny" was silently
  // inert for AntiGravity: the setting read as enforced while the run still
  // received --mode accept-edits.
  describe('agentic-service write clamp', () => {
    const resolveBinary = async () => ({
      binaryPath: '/usr/local/bin/agy',
      source: 'path' as const
    })

    it.each([
      ['shell commands denied', { shellCommands: 'deny', fileChanges: 'allow' }],
      ['file changes denied', { shellCommands: 'allow', fileChanges: 'deny' }]
    ] as const)('launches read-only when %s', async (_label, agenticServices) => {
      const launch = await prepareAntigravityProviderLaunch(
        {
          settings: OPTED_IN,
          prompt: 'Apply the fix.',
          approvalMode: 'default',
          isolatedMutationWorkspace: true,
          agenticServices
        },
        { resolveBinary }
      )

      expect(launch.mode).toBe('plan')
      expect(launch.args).toContain('plan')
      expect(launch.args).not.toContain('accept-edits')
    })

    it('still allows a write-capable turn when neither service is denied', async () => {
      const launch = await prepareAntigravityProviderLaunch(
        {
          settings: OPTED_IN,
          prompt: 'Apply the fix.',
          approvalMode: 'default',
          isolatedMutationWorkspace: true,
          agenticServices: { shellCommands: 'ask', fileChanges: 'allow' }
        },
        { resolveBinary }
      )

      expect(launch.mode).toBe('accept-edits')
    })

    it('retains isolated-worktree writes when no service policy is supplied', async () => {
      const launch = await prepareAntigravityProviderLaunch(
        {
          settings: OPTED_IN,
          prompt: 'Apply the fix.',
          approvalMode: 'default',
          isolatedMutationWorkspace: true
        },
        { resolveBinary }
      )

      expect(launch.mode).toBe('accept-edits')
    })

    /* Shared checkouts were plan-only because "agy has no per-tool approval
     * bridge". The PreToolUse hook bridge IS that seam (verified loading in
     * agy's own log), so a live bridge is now an accepted alternative to
     * worktree isolation — every mutation still passes the approval gate. */
    it('allows a write-capable turn in a shared checkout when the per-tool bridge is live', async () => {
      const launch = await prepareAntigravityProviderLaunch(
        {
          settings: OPTED_IN,
          prompt: 'Apply the fix.',
          approvalMode: 'default',
          isolatedMutationWorkspace: false,
          perToolApprovalBridge: true,
          agenticServices: { shellCommands: 'ask', fileChanges: 'allow' }
        },
        { resolveBinary }
      )

      expect(launch.mode).toBe('accept-edits')
    })

    /* The two Full tiers (workspace_write "Full WS Access", full_access "Full
     * Access") carry `approvalMode: 'auto_edit'`, not 'default' — a mode-string
     * check that only recognised 'default' would leave exactly the tiers the
     * user expects writes from stuck in plan. */
    it('allows a write-capable turn for the auto_edit tiers over the bridge', async () => {
      for (const approvalMode of ['auto_edit', 'default']) {
        const launch = await prepareAntigravityProviderLaunch(
          {
            settings: OPTED_IN,
            prompt: 'Apply the fix.',
            approvalMode,
            isolatedMutationWorkspace: false,
            perToolApprovalBridge: true,
            agenticServices: { shellCommands: 'allow', fileChanges: 'allow' }
          },
          { resolveBinary }
        )
        expect(launch.mode, approvalMode).toBe('accept-edits')
      }
    })

    it('opens the exact attended Ask posture only when its per-tool bridge is live', async () => {
      const launch = await prepareAntigravityProviderLaunch(
        {
          settings: OPTED_IN,
          prompt: 'Apply the fix after asking.',
          approvalMode: 'plan',
          workflowMode: 'normal',
          perToolApprovalBridge: true,
          effectivePermissions: { presetId: 'read_only', readOnly: true },
          agenticServices: { shellCommands: 'ask', fileChanges: 'ask' }
        },
        { resolveBinary }
      )

      expect(launch.mode).toBe('accept-edits')
      expect(launch.args).toContain('accept-edits')
      expect(launch.args).not.toContain('--dangerously-skip-permissions')
    })

    it('keeps Plan and incomplete Ask claims plan-only over the bridge', async () => {
      const postures = [
        { workflowMode: 'plan', effectivePermissions: { presetId: 'plan', readOnly: true } },
        {
          workflowMode: 'normal',
          effectivePermissions: { presetId: 'plan', readOnly: true }
        },
        {
          workflowMode: 'normal',
          effectivePermissions: { presetId: 'read_only', readOnly: false }
        }
      ] as const
      for (const posture of postures) {
        const launch = await prepareAntigravityProviderLaunch(
          {
            settings: OPTED_IN,
            prompt: 'Apply the fix.',
            approvalMode: 'plan',
            perToolApprovalBridge: true,
            ...posture,
            agenticServices: { shellCommands: 'allow', fileChanges: 'allow' }
          },
          { resolveBinary }
        )
        expect(launch.mode).toBe('plan')
      }
    })

    it('keeps the exact Ask posture plan-only if its bridge or write service is unavailable', async () => {
      for (const input of [
        {
          perToolApprovalBridge: false,
          agenticServices: { shellCommands: 'ask' as const, fileChanges: 'ask' as const }
        },
        {
          perToolApprovalBridge: true,
          agenticServices: { shellCommands: 'ask' as const, fileChanges: 'deny' as const }
        }
      ]) {
        const launch = await prepareAntigravityProviderLaunch(
          {
            settings: OPTED_IN,
            prompt: 'Apply the fix after asking.',
            approvalMode: 'plan',
            workflowMode: 'normal',
            effectivePermissions: { presetId: 'read_only', readOnly: true },
            ...input
          },
          { resolveBinary }
        )
        expect(launch.mode).toBe('plan')
      }
    })

    it('stays plan-only in a shared checkout when no bridge is available', async () => {
      const launch = await prepareAntigravityProviderLaunch(
        {
          settings: OPTED_IN,
          prompt: 'Apply the fix.',
          approvalMode: 'default',
          isolatedMutationWorkspace: false,
          perToolApprovalBridge: false,
          agenticServices: { shellCommands: 'ask', fileChanges: 'allow' }
        },
        { resolveBinary }
      )

      expect(launch.mode).toBe('plan')
    })

    it('keeps a denied file-change policy plan-only even with a live bridge', async () => {
      const launch = await prepareAntigravityProviderLaunch(
        {
          settings: OPTED_IN,
          prompt: 'Apply the fix.',
          approvalMode: 'default',
          perToolApprovalBridge: true,
          agenticServices: { shellCommands: 'deny', fileChanges: 'deny' }
        },
        { resolveBinary }
      )

      expect(launch.mode).toBe('plan')
    })

    it('keeps a read-only posture plan-only even with a live bridge', async () => {
      const launch = await prepareAntigravityProviderLaunch(
        {
          settings: OPTED_IN,
          prompt: 'Apply the fix.',
          approvalMode: 'default',
          perToolApprovalBridge: true,
          effectivePermissions: { readOnly: true }
        },
        { resolveBinary }
      )

      expect(launch.mode).toBe('plan')
    })
  })

  describe('conversation resumption', () => {
    const resolveBinary = async () => ({
      binaryPath: '/usr/local/bin/agy',
      source: 'path' as const
    })
    const CONVERSATION = '0e81528b-aa70-4678-b9ce-d3005b829583'
    const PROJECT_SESSION = formatAgyProjectBoundSessionId(CONVERSATION)!

    it('resumes a prior conversation the CLI itself reported', async () => {
      const launch = await prepareAntigravityProviderLaunch(
        {
          settings: OPTED_IN,
          prompt: 'Carry on.',
          approvalMode: 'plan',
          conversationId: PROJECT_SESSION
        },
        { resolveBinary }
      )

      expect(launch.resumedConversationId).toBe(CONVERSATION)
      expect(launch.args).toEqual([
        '--sandbox',
        '--mode',
        'plan',
        '--print-timeout',
        '30m',
        '--conversation',
        CONVERSATION,
        '-p',
        withAntigravityLongTurnProgress('Carry on.')
      ])
    })

    it('starts fresh in an explicit project when no prior id exists', async () => {
      for (const conversationId of [null, undefined, '']) {
        const launch = await prepareAntigravityProviderLaunch(
          { settings: OPTED_IN, prompt: 'Start.', approvalMode: 'plan', conversationId },
          { resolveBinary }
        )
        expect(launch.resumedConversationId).toBeNull()
        expect(launch.args).not.toContain('--conversation')
        expect(launch.args).toContain('--new-project')
      }
    })

    // agy silently allocates a new conversation for an id it does not recognise,
    // so a foreign session id must be dropped rather than forwarded — otherwise
    // the user loses context with no error.
    it('drops a non-uuid id rather than forwarding another provider session', async () => {
      const launch = await prepareAntigravityProviderLaunch(
        {
          settings: OPTED_IN,
          prompt: 'Carry on.',
          approvalMode: 'plan',
          conversationId: 'claude-session-abc123'
        },
        { resolveBinary }
      )

      expect(launch.resumedConversationId).toBeNull()
      expect(launch.args).not.toContain('--conversation')
      expect(launch.args).toContain('--new-project')
      expect(launch.args.join(' ')).not.toContain('claude-session-abc123')
    })

    it('rotates a bare legacy agy UUID into a project-bound fresh session', async () => {
      const launch = await prepareAntigravityProviderLaunch(
        {
          settings: OPTED_IN,
          prompt: 'Carry on safely.',
          approvalMode: 'plan',
          conversationId: CONVERSATION
        },
        { resolveBinary }
      )

      expect(launch.resumedConversationId).toBeNull()
      expect(launch.args).toContain('--new-project')
      expect(launch.args).not.toContain('--conversation')
      expect(launch.args).not.toContain(CONVERSATION)
    })

    it('carries resumption into write-capable mode too', async () => {
      const launch = await prepareAntigravityProviderLaunch(
        {
          settings: OPTED_IN,
          prompt: 'Apply the fix.',
          approvalMode: 'default',
          isolatedMutationWorkspace: true,
          conversationId: PROJECT_SESSION
        },
        { resolveBinary }
      )

      expect(launch.mode).toBe('accept-edits')
      expect(launch.args).toContain('--conversation')
      expect(launch.args).toContain(CONVERSATION)
      expect(launch.args).not.toContain('--dangerously-skip-permissions')
    })
  })

  it('uses the ordinary sandboxed accept-edits mode only for a write-capable posture', async () => {
    const launch = await prepareAntigravityProviderLaunch(
      {
        settings: OPTED_IN,
        prompt: 'Apply the approved change.',
        model: 'Gemini 3.6 Flash (High)',
        approvalMode: 'default',
        isolatedMutationWorkspace: true
      },
      {
        resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy', source: 'path' })
      }
    )

    expect(launch.mode).toBe('accept-edits')
    expect(launch.args).toContain('--sandbox')
    expect(launch.args).toContain('accept-edits')
    expect(launch.args).toContain('Gemini 3.6 Flash (High)')
    expect(launch.args).not.toContain('--dangerously-skip-permissions')
  })

  it('auto-approves native confirmations only for a signed non-read-only Full Access posture', async () => {
    const deps = {
      resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy', source: 'path' as const })
    }
    const fullAccess = await prepareAntigravityProviderLaunch(
      {
        settings: OPTED_IN,
        prompt: 'Run the migration.',
        approvalMode: 'default',
        effectivePermissions: { presetId: 'full_access', readOnly: false },
        isolatedMutationWorkspace: true
      },
      deps
    )
    // Full Access already pregrants every native capability, so agy's own
    // confirmation layer is skipped — while the sandbox and TaskWraith's
    // hook-bridge holds (remote egress, rm -r) remain in force.
    expect(fullAccess.args).toContain('--dangerously-skip-permissions')
    expect(fullAccess.args).toContain('--sandbox')
    expect(fullAccess.mode).toBe('accept-edits')

    const readOnlyFullAccess = await prepareAntigravityProviderLaunch(
      {
        settings: OPTED_IN,
        prompt: 'Inspect only.',
        approvalMode: 'default',
        effectivePermissions: { presetId: 'full_access', readOnly: true }
      },
      deps
    )
    expect(readOnlyFullAccess.args).not.toContain('--dangerously-skip-permissions')

    const deniedServices = await prepareAntigravityProviderLaunch(
      {
        settings: OPTED_IN,
        prompt: 'Run the migration.',
        approvalMode: 'default',
        effectivePermissions: { presetId: 'full_access', readOnly: false },
        agenticServices: { shellCommands: 'deny', fileChanges: 'allow' },
        isolatedMutationWorkspace: true
      },
      deps
    )
    expect(deniedServices.args).not.toContain('--dangerously-skip-permissions')

    const workspaceWrite = await prepareAntigravityProviderLaunch(
      {
        settings: OPTED_IN,
        prompt: 'Run the migration.',
        approvalMode: 'default',
        effectivePermissions: { presetId: 'workspace_write', readOnly: false },
        isolatedMutationWorkspace: true
      },
      deps
    )
    expect(workspaceWrite.args).not.toContain('--dangerously-skip-permissions')
  })

  it('keeps a write-approved shared checkout in plan mode without an exact bridge', async () => {
    const launch = await prepareAntigravityProviderLaunch(
      {
        settings: OPTED_IN,
        prompt: 'Inspect and propose the change.',
        approvalMode: 'default'
      },
      {
        resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy', source: 'path' })
      }
    )

    expect(launch.mode).toBe('plan')
    expect(launch.args).not.toContain('accept-edits')
  })

  it('keeps an explicitly read-only effective posture in plan mode', async () => {
    const launch = await prepareAntigravityProviderLaunch(
      {
        settings: OPTED_IN,
        prompt: 'Do not edit.',
        approvalMode: 'default',
        effectivePermissions: { readOnly: true }
      },
      {
        resolveBinary: async () => ({ binaryPath: '/usr/local/bin/agy', source: 'path' })
      }
    )

    expect(launch.mode).toBe('plan')
  })

  it('reports a missing official CLI without constructing an argv', async () => {
    await expect(
      prepareAntigravityProviderLaunch(
        { settings: OPTED_IN, prompt: 'hello', approvalMode: 'default' },
        {
          resolveBinary: async () => ({
            binaryPath: null,
            source: 'missing',
            error: 'official agy is missing'
          })
        }
      )
    ).rejects.toThrow('official agy is missing')
  })

  it('does not probe a binary or account state while the opt-in is disabled', async () => {
    const resolveBinary = vi.fn()
    const status = await getAntigravityProviderStatus({ settings: {} }, { resolveBinary })

    expect(status).toMatchObject({ available: false, authState: 'consent-required' })
    expect(resolveBinary).not.toHaveBeenCalled()
  })

  it('admits the key lane without opt-in and without any agy binary', async () => {
    // The SDK lane needs neither consent to the separate ban-risk CLI lane nor
    // the CLI itself. Reporting unavailable here was what blocked key-lane
    // runs at preflight after the picker had happily offered the models.
    const resolveBinary = vi.fn()
    const status = await getAntigravityProviderStatus(
      { settings: {} },
      { resolveBinary, isGeminiApiKeyConfigured: () => true }
    )

    expect(status).toMatchObject({
      available: true,
      setupRequired: false,
      authState: 'api-key',
      binaryPath: null,
      binarySource: 'gemini-api'
    })
    expect(status.error).toBeUndefined()
    expect(resolveBinary).not.toHaveBeenCalled()
  })

  it('keeps the provider available on the key lane when the consented agy binary is missing', async () => {
    const status = await getAntigravityProviderStatus(
      { settings: OPTED_IN },
      {
        resolveBinary: async () => ({
          binaryPath: null,
          source: 'missing',
          error: 'official agy is missing'
        }),
        isGeminiApiKeyConfigured: () => true
      }
    )

    expect(status).toMatchObject({ available: true, authState: 'api-key', binaryPath: null })
    expect(status.error).toBeUndefined()
  })

  it('fails closed when the key signal itself throws', async () => {
    const status = await getAntigravityProviderStatus(
      { settings: {} },
      {
        resolveBinary: vi.fn(),
        isGeminiApiKeyConfigured: () => {
          throw new Error('signal exploded')
        }
      }
    )

    expect(status).toMatchObject({ available: false, authState: 'consent-required' })
  })
})
