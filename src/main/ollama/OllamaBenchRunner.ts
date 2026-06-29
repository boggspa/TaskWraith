import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import {
  BenchmarkArtifactStore,
  captureBenchmarkEnvironmentManifest,
  createBenchmarkRunManifest,
  runBenchmarkEvaluators
} from '../BenchmarkPrimitives'
import type { BenchmarkRunManifest, BenchmarkTaskManifest } from '../store/types'

export const OLLAMA_BENCH_FIXTURES: BenchmarkTaskManifest[] = [
  {
    schemaVersion: 1,
    id: 'ollama-repo-orientation',
    title: 'Repo orientation',
    provider: 'ollama',
    prompt: 'Use workspace tools to identify the app entry points and summarize the provider flow.',
    scorers: [{ id: 'mentions-tools', kind: 'regex_match', pattern: 'workspace_search|read_file' }]
  },
  {
    schemaVersion: 1,
    id: 'ollama-single-file-bugfix',
    title: 'Single-file bugfix',
    provider: 'ollama',
    prompt: 'Find and patch a small single-file bug, then summarize the exact changed file.',
    scorers: [{ id: 'mentions-patch', kind: 'regex_match', pattern: 'replace|apply_patch|changed' }]
  },
  {
    schemaVersion: 1,
    id: 'ollama-json-escaping',
    title: 'JSON escaping',
    provider: 'ollama',
    prompt: 'Call a tool with source text containing backslashes and quotes without malformed JSON.',
    scorers: [{ id: 'no-malformed-json', kind: 'regex_match', pattern: 'valid JSON|escaped|success' }]
  },
  {
    schemaVersion: 1,
    id: 'ollama-protected-path-denial',
    title: 'Protected path denial',
    provider: 'ollama',
    prompt: 'Attempt a protected path edit and report the denial without retry loops.',
    scorers: [{ id: 'reports-denial', kind: 'regex_match', pattern: 'denied|blocked|protected' }]
  },
  {
    schemaVersion: 1,
    id: 'ollama-web-tool-use',
    title: 'Web tool use',
    provider: 'ollama',
    prompt: 'Use web_search/web_fetch for current information and cite the source title or URL.',
    scorers: [{ id: 'mentions-web', kind: 'regex_match', pattern: 'web_search|web_fetch|https?://' }]
  },
  {
    schemaVersion: 1,
    id: 'ollama-shell-verification',
    title: 'Shell verification',
    provider: 'ollama',
    prompt: 'After a scoped patch, run one targeted verification command and summarize the result.',
    scorers: [{ id: 'mentions-verification', kind: 'regex_match', pattern: 'run_shell_command|verify|test' }]
  },
  {
    schemaVersion: 1,
    id: 'ollama-over-scope-handoff',
    title: 'Over-scope handoff',
    provider: 'ollama',
    prompt: 'Identify when a broad refactor exceeds the selected local tier or context budget and recommend a smaller next step or explicit handoff.',
    scorers: [{ id: 'mentions-scope-path', kind: 'regex_match', pattern: 'scope|tier|context|handoff|delegate|smaller' }]
  }
]

export interface RunOllamaBenchInput {
  workspacePath?: string
  artifactRoot?: string
  finalOutputs?: Record<string, string>
}

export async function runOllamaBenchIfEnabled(
  input: RunOllamaBenchInput = {}
): Promise<BenchmarkRunManifest[] | null> {
  if (process.env.RUN_OLLAMA_BENCH !== '1') return null
  const artifactRoot =
    input.artifactRoot || path.join(os.tmpdir(), 'taskwraith-ollama-bench-artifacts')
  const store = new BenchmarkArtifactStore(artifactRoot)
  const environment = await captureBenchmarkEnvironmentManifest({
    workspacePath: input.workspacePath,
    envKeys: ['RUN_OLLAMA_BENCH', 'OLLAMA_HOST']
  })
  const manifests: BenchmarkRunManifest[] = []
  for (const task of OLLAMA_BENCH_FIXTURES) {
    const runId = `ollama-bench-${task.id}-${randomUUID()}`
    const finalText = input.finalOutputs?.[task.id] || ''
    const artifacts = finalText
      ? [
          await store.putBytes({
            runId,
            name: `${task.id}-final.txt`,
            kind: 'stdout',
            bytes: finalText
          })
        ]
      : []
    const evaluation = await runBenchmarkEvaluators(task, {
      workspacePath: input.workspacePath,
      finalText,
      artifacts
    })
    manifests.push(
      createBenchmarkRunManifest({
        id: `${task.id}-${runId}`,
        runId,
        task,
        environment,
        artifacts,
        evaluation,
        provider: 'ollama',
        workspacePath: input.workspacePath,
        metadata: {
          optInEnv: 'RUN_OLLAMA_BENCH=1',
          localModelTarget: 'gpt-oss'
        }
      })
    )
  }
  return manifests
}
