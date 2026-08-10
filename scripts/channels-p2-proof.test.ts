import { createRequire } from 'module'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildSync } from 'esbuild'
import { describe, expect, it } from 'vitest'

interface ProofModule {
  PACKAGED_SURFACE_MARKERS: Record<string, string[]>
  ProofWorker: new (
    label: string,
    child: EventEmitter
  ) => { waitReady(timeoutMs?: number): Promise<unknown> }
  parseArgs(argv: string[]): { evidencePath: string; packageInput: string; runs: number }
  verifySurfaceGroups(
    groups: Record<string, Array<{ path: string; contents: string | Buffer }>>
  ): Record<string, { fileCount: number; markers: string[] }>
}

const require = createRequire(import.meta.url)
const proof = require('./channels-p2-proof.cjs') as ProofModule

describe('Channels P2 acceptance proof harness', () => {
  it('requires an explicit package artifact and bounded repeat count', () => {
    expect(() => proof.parseArgs([])).toThrow('--package')
    expect(() => proof.parseArgs(['--package', '.', '--runs', '0'])).toThrow('--runs')
    expect(proof.parseArgs(['--package', '.', '--runs', '3'])).toMatchObject({ runs: 3 })
  })

  it('fails closed when a proof worker exits before its ready receipt', async () => {
    const child = new EventEmitter()
    const ready = new proof.ProofWorker('Failed worker', child).waitReady()

    child.emit('exit', 7, null)

    await expect(ready).rejects.toThrow('Failed worker exited code=7 signal=null')
  })

  it('fails closed when any shipping main/preload/renderer marker is stale', () => {
    const groups = Object.fromEntries(
      Object.entries(proof.PACKAGED_SURFACE_MARKERS).map(([group, markers]) => [
        group,
        [{ path: `${group}.js`, contents: markers.join('\n') }]
      ])
    )
    const accepted = proof.verifySurfaceGroups(groups)
    expect(accepted.main.fileCount).toBe(1)
    expect(accepted.renderer.markers).toContain('Confirm joins')
    expect(accepted.renderer.markers).toContain('Human posts stay manual.')
    expect(accepted.renderer.markers).toContain(
      'automatic mention dispatch remains disabled pending security review.'
    )

    const stale = structuredClone(groups)
    stale.renderer[0].contents = stale.renderer[0].contents.replace('Confirm joins', '')
    expect(() => proof.verifySurfaceGroups(stale)).toThrow('packaged renderer surface is stale')
  })

  it('bundles a worker rooted in production bootstraps, strict handlers, and renderer controllers', () => {
    const source = readFileSync(join(process.cwd(), 'scripts/channels-p2-proof-worker.ts'), 'utf8')
    expect(source).toContain('createChannelProductionBootstrap')
    expect(source).toContain('createChannelMemberProductionBootstrap')
    expect(source).toContain('ChannelHostPanelController')
    expect(source).toContain('ChannelMemberPanelController')
    expect(source).toContain('agentExecution: proofAgentExecution()')
    expect(source).toContain('agentRouteCalls')
    expect(readFileSync(join(process.cwd(), 'scripts/channels-p2-proof.cjs'), 'utf8')).toContain(
      "NODE_PATH: join(ROOT, 'node_modules')"
    )
    expect(source).not.toContain("from '../src/main/collaboration/ChannelRuntime'")
    expect(source).not.toContain("from '../src/main/collaboration/ChannelMemberClient'")

    const directory = mkdtempSync(join(tmpdir(), 'taskwraith-channels-p2-proof-test-'))
    const outfile = join(directory, 'worker.cjs')
    try {
      buildSync({
        entryPoints: [join(process.cwd(), 'scripts/channels-p2-proof-worker.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        external: ['electron'],
        outfile,
        sourcemap: false,
        logLevel: 'silent'
      })
      expect(statSync(outfile).size).toBeGreaterThan(100_000)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
