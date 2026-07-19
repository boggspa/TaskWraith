/*
 * AuditGatesRunner — the deterministic "gates" phase of an audit run.
 *
 * Gates are NOT an agent: they run the project's OWN configured commands
 * (typecheck, tests, supply-chain check, validate-release, npm outdated) and
 * record a structured pass/fail per check. No model tokens are spent here. This
 * is the live implementation of AuditOrchestratorDeps.runGates.
 *
 * The command runner + id generator + (optional) log-artifact writer are
 * injected so the result mapping is exhaustively unit-tested without spawning
 * real processes. index.ts supplies runCommand = runHostCommand when it builds
 * the orchestrator.
 */

import type { AuditGateCheck } from './AuditOrchestrator'
import type { AuditGateResult } from '../store/types'
import type { HostCommandResult } from '../runStateTypes'
import type { HostCommandProjectionHandle } from '../run/HostCommandOperationRegistry'

export interface AuditGateCommandAuthority {
  auditRunId: string
  appChatId: string
  workspaceId?: string
  workspacePath: string
}

export interface AuditGatesRunnerDeps {
  /** Run one command in `cwd`; resolves with the captured host-command result. */
  runCommand: (command: string, cwd: string) => Promise<HostCommandResult>
  createHostCommandProjection?: (
    authority: AuditGateCommandAuthority
  ) => HostCommandProjectionHandle | null
  uuid: () => string
  /** Persist a check's combined stdout/stderr and return its artifact id (so the
   * gate result can reference the full log). Optional — when absent only the
   * trimmed summary is kept. */
  recordLog?: (input: { check: string; command: string; output: string }) => string | undefined
}

export interface AuditGatesRunner {
  runGates: (
    checks: AuditGateCheck[],
    workspacePath: string,
    authority?: AuditGateCommandAuthority,
    projectGate?: (gate: AuditGateResult) => void
  ) => Promise<AuditGateResult[]>
}

const MAX_SUMMARY_TAIL = 280

/** A passing gate gets a terse 'passed'; a failing one surfaces the tail of its
 * output (where the error lives) so the report is actionable without opening the
 * full artifact. */
function summarize(result: HostCommandResult): string {
  if (result.timedOut) return 'timed out'
  if (result.error) return result.error
  if (result.exitCode === 0) return 'passed'
  const base = `exit ${result.exitCode ?? '?'}`
  const tail = (result.stderr || result.stdout || '').trim()
  if (!tail) return base
  const slice = tail.length > MAX_SUMMARY_TAIL ? `…${tail.slice(-MAX_SUMMARY_TAIL)}` : tail
  return `${base}: ${slice}`
}

function statusFor(result: HostCommandResult): AuditGateResult['status'] {
  if (result.timedOut || result.error) return 'fail'
  return result.exitCode === 0 ? 'pass' : 'fail'
}

export function createAuditGatesRunner(deps: AuditGatesRunnerDeps): AuditGatesRunner {
  return {
    async runGates(checks, workspacePath, authority, projectGate) {
      const results: AuditGateResult[] = []
      // Sequential, not concurrent: gates are heavy project scripts
      // (typecheck/test) that share CPU and on-disk caches (node_modules/.cache,
      // tsbuildinfo). Running them serially avoids contention + interleaved logs
      // and keeps the pass/fail ledger deterministic. The orchestrator already
      // runs the whole gates phase in parallel WITH the reviewers.
      for (const { check, command } of checks) {
        const hostCommandProjection = authority
          ? deps.createHostCommandProjection?.(authority)
          : null
        try {
          let result: HostCommandResult
          try {
            const runCommand = () => deps.runCommand(command, workspacePath)
            result = hostCommandProjection
              ? await hostCommandProjection.run(runCommand)
              : await runCommand()
          } catch (err) {
            // A spawn failure (e.g. the command binary is missing) is a failed
            // gate, not a thrown audit — record it and move on.
            const message = err instanceof Error ? err.message : String(err)
            result = {
              stdout: '',
              stderr: message,
              exitCode: null,
              error: message,
              timedOut: false,
              durationMs: 0
            }
          }
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
          const logArtifactId = deps.recordLog?.({ check, command, output })
          const gate: AuditGateResult = {
            id: deps.uuid(),
            check,
            command,
            status: statusFor(result),
            ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
            ...(logArtifactId ? { logArtifactId } : {}),
            summary: summarize(result),
            durationMs: result.durationMs
          }
          projectGate?.(gate)
          results.push(gate)
        } finally {
          hostCommandProjection?.complete()
        }
      }
      return results
    }
  }
}
