/**
 * Dependency contracts for Muse opaque-exec orchestration.
 *
 * Wave-2 siblings (W2A–C) own the real CliArgs / IsolatedHome / ExecJson /
 * Usage / CronAssert / skill-pin modules. Until those land, the adapter takes
 * these interfaces via DI so this folder typechecks in isolation without
 * inventing colliding filenames.
 */

import type {
  MuseIsolatedHomeLease,
  MuseLaunchPlan,
  MuseMetaReasoningEffort,
  MuseRunRequest,
  MuseTokenUsage,
  NormalizedMuseRunEvent
} from './MuseTypes'

export interface MuseCliArgsInput {
  readonly workspacePath: string
  readonly prompt: string
  readonly model: string | null
  readonly effort: MuseMetaReasoningEffort
  readonly writeCapable: boolean
  readonly sessionId: string
  readonly apiKeyStdin: boolean
}

/** W2A: pure argv builder (`muse exec --json …`). */
export interface MuseCliArgsModule {
  buildExecArgv(input: MuseCliArgsInput): readonly string[]
  normalizeEffort(raw: string | null | undefined): MuseMetaReasoningEffort
}

export interface MuseIsolatedHomeCreateInput {
  readonly temporaryRoot: string
  readonly runId: string
}

/** W2A/B: Pi-shaped XDG/HOME lease. */
export interface MuseIsolatedHomeModule {
  create(input: MuseIsolatedHomeCreateInput): MuseIsolatedHomeLease
}

export interface MuseSkillPinResult {
  readonly ok: boolean
  readonly pinHash: string
  readonly enabledSkillIds: readonly string[]
  readonly warning?: string
}

/** W2B: disable dangerous bundled skills against the per-run home; pin list. */
export interface MuseSkillPinModule {
  applyAndAssert(home: MuseIsolatedHomeLease): Promise<MuseSkillPinResult>
}

export interface MuseExecJsonParser {
  push(chunk: string): NormalizedMuseRunEvent[]
  flush(): NormalizedMuseRunEvent[]
}

/** W2C: NDJSON stdout reducer. */
export interface MuseExecJsonModule {
  createParser(): MuseExecJsonParser
  assertToolSurface(
    event: NormalizedMuseRunEvent,
    expectedVersion: string
  ): { ok: true } | { ok: false; reason: string }
}

export interface MuseUsageProjection {
  readonly usage: MuseTokenUsage | null
  readonly recordsSeen: number
}

/** W2C: session-index + session.jsonl metering projection. */
export interface MuseUsageModule {
  /**
   * Resolve `session_log_path` via session-index (never reconstruct date paths)
   * and project usage. May no-op until siblings land.
   */
  projectFromSession(input: {
    readonly dataHome: string
    readonly sessionId: string
  }): Promise<MuseUsageProjection>
}

export interface MuseCronAssertResult {
  readonly ok: boolean
  readonly jobCount: number
  readonly warning?: string
}

/** W2B: teardown assert that `cron_jobs` is empty (fail closed / warn). */
export interface MuseCronAssertModule {
  assertEmptyAtTeardown(input: {
    readonly dataHome: string
    readonly sessionId: string
  }): Promise<MuseCronAssertResult>
}

export interface MuseProcessCaptureResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
  readonly error?: string
  readonly timedOut?: boolean
}

export interface MuseSpawnHandle {
  readonly pid: number | null
  kill(signal?: NodeJS.Signals): void
  onStdout(listener: (chunk: string) => void): void
  onStderr(listener: (chunk: string) => void): void
  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

/** Host I/O seams — wired by composition root later; fakes in unit tests. */
export interface MuseProcessModule {
  spawn(input: {
    readonly binaryPath: string
    readonly argv: readonly string[]
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly stdin?: string | null
  }): MuseSpawnHandle
}

export interface MuseOrchestrationModules {
  readonly cliArgs: MuseCliArgsModule
  readonly isolatedHome: MuseIsolatedHomeModule
  readonly skillPin: MuseSkillPinModule
  readonly execJson: MuseExecJsonModule
  readonly usage: MuseUsageModule
  readonly cronAssert: MuseCronAssertModule
  readonly process: MuseProcessModule
}

/**
 * Minimal in-folder stubs so the adapter can unit-test orchestration before
 * W2A–C land real modules. Not production containment.
 */
export function createMuseOrchestrationStubs(
  overrides: Partial<MuseOrchestrationModules> = {}
): MuseOrchestrationModules {
  const defaultHome: MuseIsolatedHomeModule = {
    create(input) {
      const path = `${input.temporaryRoot}/muse-home-${input.runId}`
      const env = {
        HOME: `${path}/home`,
        TMPDIR: `${path}/tmp`,
        XDG_CONFIG_HOME: `${path}/xdg-config`,
        XDG_DATA_HOME: `${path}/xdg-data`,
        XDG_CACHE_HOME: `${path}/xdg-cache`,
        XDG_STATE_HOME: `${path}/xdg-state`,
        MUSE_NO_AUTO_UPDATE: '1' as const
      }
      return {
        path,
        authority: {
          schemaVersion: 1,
          strategy: 'node-mkdtemp-random-suffix-v1',
          canonicalRealPathVerified: true,
          leafType: 'real-directory',
          fileIdentity: { device: '0', inode: '0' },
          fileIdentityVerification: 'device-inode-best-effort',
          ownerVerification: 'unsupported-platform',
          modeVerification: 'unsupported-platform',
          cleanupPolicy: 'identity-match-recursive-force'
        },
        env,
        verify() {
          return this.authority
        },
        cleanup() {
          return { ok: true, alreadyAbsent: false }
        }
      }
    }
  }

  const stubs: MuseOrchestrationModules = {
    cliArgs: {
      normalizeEffort(raw) {
        const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
        if (
          value === 'minimal' ||
          value === 'low' ||
          value === 'medium' ||
          value === 'high' ||
          value === 'xhigh' ||
          value === 'ultra'
        ) {
          return value
        }
        // TaskWraith `none` and unknown → meta-safe minimal (never emit none).
        return 'minimal'
      },
      buildExecArgv(input) {
        const argv: string[] = [
          'exec',
          '--json',
          '--provider',
          'meta',
          '--workspace',
          input.workspacePath,
          '--no-foreign-personal-context',
          '--disable-web-tools',
          '--sandbox-network',
          'proxy-only',
          '--session-id',
          input.sessionId,
          '--reasoning-effort',
          input.effort
        ]
        if (input.model) argv.push('--model', input.model)
        if (!input.writeCapable) {
          argv.push('--disable-write', '--disable-shell')
        }
        if (input.apiKeyStdin) argv.push('--api-key-stdin')
        argv.push(input.prompt)
        return argv
      }
    },
    isolatedHome: defaultHome,
    skillPin: {
      async applyAndAssert() {
        return {
          ok: true,
          pinHash: 'stub-skill-pin',
          enabledSkillIds: []
        }
      }
    },
    execJson: {
      createParser() {
        let buffer = ''
        const parseLine = (line: string): NormalizedMuseRunEvent | null => {
          const trimmed = line.trim()
          if (!trimmed) return null
          try {
            const raw = JSON.parse(trimmed) as Record<string, unknown>
            const payloadType =
              typeof raw.payload_type === 'string'
                ? raw.payload_type
                : typeof raw.type === 'string'
                  ? raw.type
                  : 'unknown'
            if (
              payloadType.includes('assistant') ||
              payloadType.includes('output') ||
              payloadType === 'content'
            ) {
              const text =
                typeof raw.text === 'string'
                  ? raw.text
                  : typeof (raw as { delta?: string }).delta === 'string'
                    ? (raw as { delta: string }).delta
                    : ''
              return { type: 'content', text, raw }
            }
            if (payloadType.includes('terminal') || payloadType === 'result') {
              return {
                type: 'result',
                status: 'success',
                text: typeof raw.text === 'string' ? raw.text : undefined,
                raw
              }
            }
            if (
              payloadType.includes('session') ||
              payloadType.includes('route_facts') ||
              payloadType === 'init'
            ) {
              const meta = (raw.metadata ?? raw) as Record<string, unknown>
              const toolSurfaceVersion =
                typeof meta.tool_surface_version === 'string'
                  ? meta.tool_surface_version
                  : typeof (meta as { toolSurfaceVersion?: string }).toolSurfaceVersion === 'string'
                    ? (meta as { toolSurfaceVersion: string }).toolSurfaceVersion
                    : undefined
              const build =
                meta.build && typeof meta.build === 'object'
                  ? (meta.build as { sha?: string })
                  : null
              return {
                type: 'init',
                sessionId: typeof raw.session_id === 'string' ? raw.session_id : undefined,
                toolSurfaceVersion,
                buildSha: typeof build?.sha === 'string' ? build.sha : undefined,
                raw
              }
            }
            return { type: 'provider_warning', text: `unmapped muse event: ${payloadType}`, raw }
          } catch {
            return { type: 'provider_warning', text: 'invalid muse NDJSON line', raw: trimmed }
          }
        }
        return {
          push(chunk: string) {
            buffer += chunk
            const events: NormalizedMuseRunEvent[] = []
            let idx: number
            while ((idx = buffer.indexOf('\n')) !== -1) {
              const line = buffer.slice(0, idx)
              buffer = buffer.slice(idx + 1)
              const event = parseLine(line)
              if (event) events.push(event)
            }
            return events
          },
          flush() {
            if (!buffer.trim()) {
              buffer = ''
              return []
            }
            const event = parseLine(buffer)
            buffer = ''
            return event ? [event] : []
          }
        }
      },
      assertToolSurface(event, expectedVersion) {
        if (typeof event.toolSurfaceVersion !== 'string') {
          return { ok: true }
        }
        if (event.toolSurfaceVersion !== expectedVersion) {
          return {
            ok: false,
            reason: `tool_surface_version mismatch: got ${event.toolSurfaceVersion}, expected ${expectedVersion}`
          }
        }
        return { ok: true }
      }
    },
    usage: {
      async projectFromSession() {
        return { usage: null, recordsSeen: 0 }
      }
    },
    cronAssert: {
      async assertEmptyAtTeardown() {
        return { ok: true, jobCount: 0 }
      }
    },
    process: {
      spawn() {
        throw new Error('Muse process stub: inject MuseProcessModule for real/fake spawn')
      }
    }
  }

  return {
    ...stubs,
    ...overrides,
    cliArgs: overrides.cliArgs ?? stubs.cliArgs,
    isolatedHome: overrides.isolatedHome ?? stubs.isolatedHome,
    skillPin: overrides.skillPin ?? stubs.skillPin,
    execJson: overrides.execJson ?? stubs.execJson,
    usage: overrides.usage ?? stubs.usage,
    cronAssert: overrides.cronAssert ?? stubs.cronAssert,
    process: overrides.process ?? stubs.process
  }
}

/** Build a launch plan from request + modules (no spawn). */
export function buildMuseLaunchPlan(
  request: MuseRunRequest,
  modules: Pick<MuseOrchestrationModules, 'cliArgs' | 'isolatedHome'>,
  options: {
    readonly skillPinHash: string | null
    readonly nativeToolPolicySha256?: string | null
    /** Reuse a home that already received skill pin / bootstrap. */
    readonly isolatedHome?: MuseIsolatedHomeLease
  }
): MuseLaunchPlan {
  const sessionId =
    typeof request.sessionId === 'string' && request.sessionId.trim()
      ? request.sessionId.trim()
      : request.runId
  const effort = modules.cliArgs.normalizeEffort(request.reasoningEffort)
  const apiKeyStdin = Boolean(request.apiKey && request.apiKey.length > 0)
  const home =
    options.isolatedHome ??
    modules.isolatedHome.create({
      temporaryRoot: request.temporaryRoot,
      runId: request.runId
    })
  const wireModel =
    typeof request.model === 'string' && request.model.trim() ? request.model.trim() : null
  const argv = modules.cliArgs.buildExecArgv({
    workspacePath: request.workspacePath,
    prompt: request.prompt,
    model: wireModel,
    effort,
    writeCapable: request.writeCapable,
    sessionId,
    apiKeyStdin
  })
  const env: Record<string, string> = {
    ...home.env,
    MUSE_NO_AUTO_UPDATE: '1'
  }
  if (home.env.MUSE_AUTH_PATH) env.MUSE_AUTH_PATH = home.env.MUSE_AUTH_PATH

  return {
    argv,
    env,
    cwd: request.workspacePath,
    sessionId,
    isolatedHome: home,
    wireModel,
    effort,
    writeCapable: request.writeCapable,
    toolSurfaceVersionExpected: '2',
    buildShaExpected: request.buildShaExpected ?? null,
    skillPinHash: options.skillPinHash,
    nativeToolPolicySha256: options.nativeToolPolicySha256 ?? null,
    apiKeyStdin
  }
}
