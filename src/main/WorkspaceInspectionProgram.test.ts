import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HostCommandResult } from './runStateTypes'
import {
  executeWorkspaceInspectionProgram,
  workspaceInspectionProgramPlan,
  type WorkspaceInspectionProgramCommandInvocation
} from './WorkspaceInspectionProgram'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  )
})

async function fixture(): Promise<{
  workspace: string
  workspaceRealPath: string
  external: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'taskwraith-inspection-program-'))
  cleanup.push(root)
  const workspace = join(root, 'workspace')
  const external = join(root, 'external')
  await mkdir(workspace)
  await mkdir(external)
  await writeFile(join(workspace, 'README.md'), '# fixture\n')
  await writeFile(join(external, 'secret.txt'), 'secret\n')
  return { workspace, workspaceRealPath: await realpath(workspace), external }
}

const capturedCommand =
  'git branch --show-current && git rev-parse HEAD && git status --porcelain && ls -la .WORK-IN-PROGRESS* 2>/dev/null; echo "---markers-end---"'

function successfulResult(stdout = ''): HostCommandResult {
  return { stdout, stderr: '', exitCode: 0, timedOut: false, durationMs: 1 }
}

describe('WorkspaceInspectionProgram', () => {
  it('compiles the captured Pi marker inspection into typed direct stages', async () => {
    const { workspace, workspaceRealPath } = await fixture()
    const plan = workspaceInspectionProgramPlan(capturedCommand, {
      workspacePath: workspace,
      cwd: workspace
    })

    expect(plan).toMatchObject({
      reason: 'inspection_shell',
      recipe: 'workspace_git_snapshot_v1',
      workspaceRealPath,
      steps: [
        { kind: 'command', condition: 'always' },
        { kind: 'command', condition: 'previous_succeeded' },
        { kind: 'command', condition: 'previous_succeeded' },
        {
          kind: 'marker_list',
          condition: 'previous_succeeded',
          discardStderr: true,
          prefix: '.WORK-IN-PROGRESS'
        },
        { kind: 'literal', condition: 'always', stdout: '---markers-end---\n' }
      ]
    })
    const commandSteps = plan?.steps.filter((step) => step.kind === 'command') || []
    expect(commandSteps.map((step) => step.plan.argv)).toEqual([
      ['branch', '--show-current'],
      ['rev-parse', 'HEAD'],
      ['status', '--porcelain']
    ])
    for (const step of commandSteps) {
      expect(step.plan.executableRealPath).toMatch(/\/git$/)
      expect(step.plan.environment).toMatchObject({ GIT_OPTIONAL_LOCKS: '0' })
      expect(step.plan.unsetEnvironment).toContain('GIT_EXTERNAL_DIFF')
    }
  })

  it('rejects other sequences, shell composition, and mixed effects', async () => {
    const { workspace, external } = await fixture()

    for (const command of [
      'git status --short && cat README.md; echo done',
      'git status --short || echo failed',
      'git status --short | head -n 1',
      'git status --short & echo done',
      'git status --short\necho done',
      'git status --short && rm -rf .',
      'cat README.md > /dev/null; echo done',
      'cat README.md 2>/tmp/errors; echo done',
      'git status --short && echo $(whoami)',
      'git status --short && echo $HOME',
      `git status --short && cat ${external}/secret.txt`,
      'git status --short && ls -la ../* 2>/dev/null',
      'git status --short && ls -la .WORK-IN-PROGRESS* 2>&1; echo done',
      'git status --short && ls -la .WORK-IN-PROGRESS* 2>>/dev/null; echo done'
    ]) {
      expect(
        workspaceInspectionProgramPlan(command, { workspacePath: workspace, cwd: workspace }),
        command
      ).toBeNull()
    }
  })

  it('executes direct stages, enumerates markers without a shell, and appends the terminator', async () => {
    const { workspace } = await fixture()
    await writeFile(join(workspace, '.WORK-IN-PROGRESS-zeta.md'), 'zeta\n')
    await writeFile(join(workspace, '.WORK-IN-PROGRESS-alpha.md'), 'alpha\n')
    const plan = workspaceInspectionProgramPlan(capturedCommand, {
      workspacePath: workspace,
      cwd: workspace
    })
    if (!plan) throw new Error('Expected the captured inspection program to compile.')
    const invocations: WorkspaceInspectionProgramCommandInvocation[] = []
    const outputs = ['master\n', 'deadbeef\n', ' M file.ts\n']
    const assertAuthorityStillLive = vi.fn()
    const result = await executeWorkspaceInspectionProgram(
      plan,
      async (invocation) => {
        invocations.push(invocation)
        return successfulResult(outputs[invocations.length - 1])
      },
      assertAuthorityStillLive
    )

    expect(invocations.map((invocation) => invocation.argv)).toEqual([
      ['branch', '--show-current'],
      ['rev-parse', 'HEAD'],
      ['status', '--porcelain']
    ])
    expect(result).toMatchObject({ exitCode: 0, timedOut: false })
    expect(result.error).toBeUndefined()
    expect(assertAuthorityStillLive).toHaveBeenCalledTimes(5)
    expect(result.stdout).toBe(
      'master\ndeadbeef\n M file.ts\n".WORK-IN-PROGRESS-alpha.md"\n".WORK-IN-PROGRESS-zeta.md"\n---markers-end---\n'
    )
  })

  it('treats no marker matches as a successful empty listing', async () => {
    const { workspace } = await fixture()
    const plan = workspaceInspectionProgramPlan(capturedCommand, {
      workspacePath: workspace,
      cwd: workspace
    })
    if (!plan) throw new Error('Expected the captured inspection program to compile.')
    const result = await executeWorkspaceInspectionProgram(
      plan,
      async () => successfulResult(),
      () => undefined
    )
    expect(result).toMatchObject({ exitCode: 0 })
    expect(result.error).toBeUndefined()
    expect(result.stdout).toBe('---markers-end---\n')
  })

  it('stops an && chain, still emits the unconditional terminator, and preserves failure', async () => {
    const { workspace } = await fixture()
    const plan = workspaceInspectionProgramPlan(capturedCommand, {
      workspacePath: workspace,
      cwd: workspace
    })
    if (!plan) throw new Error('Expected the captured inspection program to compile.')
    const runner = vi.fn(
      async (): Promise<HostCommandResult> => ({
        stdout: '',
        stderr: 'not a repository\n',
        exitCode: 128,
        error: 'git failed',
        timedOut: false,
        durationMs: 1
      })
    )
    const result = await executeWorkspaceInspectionProgram(plan, runner, () => undefined)

    expect(runner).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ exitCode: 128, error: 'git failed' })
    expect(result.stderr).toBe('not a repository\n')
    expect(result.stdout).toBe('---markers-end---\n')
  })

  it('rechecks the marker-list workspace before reading it', async () => {
    const { workspace, external } = await fixture()
    const workspaceLink = join(workspace, 'link')
    await symlink(external, workspaceLink)
    expect(
      workspaceInspectionProgramPlan(capturedCommand, {
        workspacePath: workspace,
        cwd: workspaceLink
      })
    ).toBeNull()
  })

  it('escapes marker names so they cannot forge the output sentinel', async () => {
    const { workspace } = await fixture()
    await writeFile(join(workspace, '.WORK-IN-PROGRESS-bad\n---markers-end---\u001b[31m'), 'x')
    const plan = workspaceInspectionProgramPlan(capturedCommand, {
      workspacePath: workspace,
      cwd: workspace
    })
    if (!plan) throw new Error('Expected the captured inspection program to compile.')
    const result = await executeWorkspaceInspectionProgram(
      plan,
      async () => successfulResult(),
      () => undefined
    )
    expect(result.stdout).toContain(
      '".WORK-IN-PROGRESS-bad\\n---markers-end---\\u001b[31m"\n---markers-end---\n'
    )
    expect(result.stdout).not.toContain('\u001b[31m')
  })

  it('rejects forged plans and consumes a valid plan exactly once', async () => {
    const { workspace } = await fixture()
    const plan = workspaceInspectionProgramPlan(capturedCommand, {
      workspacePath: workspace,
      cwd: workspace
    })
    if (!plan) throw new Error('Expected the captured inspection program to compile.')
    const runner = vi.fn(async () => successfulResult())
    const forged = { ...plan }
    const forgedResult = await executeWorkspaceInspectionProgram(forged, runner, () => undefined)
    expect(forgedResult.error).toMatch(/not issued/i)
    expect(runner).not.toHaveBeenCalled()

    const first = await executeWorkspaceInspectionProgram(plan, runner, () => undefined)
    expect(first.error).toBeUndefined()
    const replay = await executeWorkspaceInspectionProgram(plan, runner, () => undefined)
    expect(replay.error).toMatch(/not issued/i)
  })
})
