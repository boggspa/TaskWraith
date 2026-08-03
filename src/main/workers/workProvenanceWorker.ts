import type { WorkProvenanceProjection } from '../../shared/workProvenance'

// These TaskWraith-owned CJS modules are statically bundled into this worker.
// The selected repository contributes only a canonical cwd and local evidence;
// no script or package from that repository is imported or executed.
import workGuardCore from '../../../scripts/work-guard.cjs'
import workProvenanceCore from '../../../scripts/work-provenance.cjs'

const QUERY_LIMIT = 200

interface WorkGuardCore {
  evaluate: (root: string, now: number) => { markers: unknown[] }
}

interface WorkProvenanceCore {
  queryWorkProvenance: (
    root: string,
    options: { markers: unknown[]; now: number; limit: number }
  ) => WorkProvenanceProjection
}

function installReadOnlyGitEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/i.test(key) || key === 'GIT_EXTERNAL_DIFF') {
      delete process.env[key]
    }
  }
  const entries: Array<[string, string]> = [
    ['core.fsmonitor', 'false'],
    ['core.hooksPath', process.platform === 'win32' ? 'NUL' : '/dev/null'],
    ['core.attributesFile', process.platform === 'win32' ? 'NUL' : '/dev/null'],
    ['include.path', '/dev/null'],
    ['diff.external', ''],
    ['credential.helper', ''],
    ['credential.interactive', 'never'],
    ['protocol.ext.allow', 'never']
  ]
  process.env.GIT_CONFIG_COUNT = String(entries.length)
  entries.forEach(([key, value], index) => {
    process.env[`GIT_CONFIG_KEY_${index}`] = key
    process.env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  process.env.GIT_OPTIONAL_LOCKS = '0'
  process.env.GIT_TERMINAL_PROMPT = '0'
  process.env.GIT_ATTR_NOSYSTEM = '1'
}

export function queryBundledWorkProvenance(root: string): WorkProvenanceProjection {
  installReadOnlyGitEnvironment()
  const now = Date.now()
  const guard = workGuardCore as WorkGuardCore
  const provenance = workProvenanceCore as WorkProvenanceCore
  const evaluation = guard.evaluate(root, now)
  return provenance.queryWorkProvenance(root, {
    markers: evaluation.markers,
    now,
    limit: QUERY_LIMIT
  })
}

const parentPort = process.parentPort

parentPort?.on('message', (event) => {
  const message = event?.data as { type?: string; root?: string } | undefined
  if (!message || message.type !== 'query' || typeof message.root !== 'string') return
  try {
    parentPort.postMessage({
      type: 'complete',
      projection: queryBundledWorkProvenance(message.root)
    })
  } catch (error) {
    parentPort.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    })
  }
})
