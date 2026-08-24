import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { HostProfileDomainStore } from './HostProfileDomainStore'
import { projectHostProfileDomainSnapshot } from './HostProfileDomainProjection'

const paths: string[] = []

afterEach(() => {
  while (paths.length > 0) rmSync(paths.pop()!, { recursive: true, force: true })
})

it('projects profile workspaces/threads/providers with honest empty unsupported families', () => {
  const profile = mkdtempSync(join(tmpdir(), 'host-profile-projection-'))
  const workspace = mkdtempSync(join(tmpdir(), 'host-profile-projection-workspace-'))
  paths.push(profile, workspace)
  const store = new HostProfileDomainStore({
    profilePath: profile,
    authority: { assertProfileAuthority: () => {} },
    idFactory: () => 'thread-1'
  })
  const registered = store.registerWorkspace({ path: workspace, displayName: 'Workspace' })
  const thread = store.createThread({
    scope: 'workspace',
    workspaceId: registered.id,
    title: 'Thread'
  })
  store.configureThread({ threadId: thread.appChatId, providerId: 'codex', modelId: 'gpt-5.6' })
  const chatFile = join(profile, 'chats', `${thread.appChatId}.json`)
  const raw = JSON.parse(readFileSync(chatFile, 'utf8')) as Record<string, unknown>
  raw.runs = [
    { runId: 'run-success', status: 'succeeded' },
    { runId: 'run-cancel', status: 'canceled' },
    { runId: 'run-active', status: 'queued' },
    { runId: 'run-unknown' }
  ]
  writeFileSync(chatFile, JSON.stringify(raw))
  chmodSync(chatFile, 0o600)
  const donor = projectHostProfileDomainSnapshot({
    store,
    health: {
      hostStatus: 'ok',
      connectionPhase: 'live',
      supervised: true,
      freshness: 'live'
    },
    providers: [
      {
        providerId: 'codex',
        displayProvider: 'Codex',
        shortCode: 'codex',
        available: true
      }
    ]
  })
  expect(donor).toMatchObject({
    workspaces: [{ id: registered.id, name: 'Workspace' }],
    threads: [{ id: thread.appChatId, providerId: 'codex' }],
    runs: [
      { runId: 'run-success', providerOutcome: 'completed' },
      { runId: 'run-cancel', providerOutcome: 'cancelled' },
      { runId: 'run-active', providerOutcome: 'running' },
      { runId: 'run-unknown', providerOutcome: 'unknown' }
    ],
    providers: [{ providerId: 'codex', available: true }],
    missions: [],
    rounds: [],
    participants: [],
    questions: [],
    approvals: [],
    schedules: [],
    artifacts: []
  })
  expect('position' in donor).toBe(false)
})
