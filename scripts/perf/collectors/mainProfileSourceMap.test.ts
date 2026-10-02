import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { build } from 'esbuild'
const require = createRequire(import.meta.url)
const { resolveMainProfileSources } = require('./mainProfileSourceMap.cjs')
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

async function fixture() {
  const bytes = Buffer.from('export function commit() { return 42 }\nconsole.log(commit())\n')
  const output = await build({
    stdin: {
      contents: bytes.toString(),
      sourcefile: 'src/main/store/ToolActivityDetailLedger.ts',
      resolveDir: process.cwd()
    },
    outfile: 'out/main/index.js',
    bundle: true,
    platform: 'node',
    format: 'cjs',
    sourcemap: 'external',
    write: false
  })
  const bundle = output.outputFiles!.find((file) => file.path.endsWith('.js'))!
  const map = output.outputFiles!.find((file) => file.path.endsWith('.map'))!
  const raw = JSON.parse(map.text)
  const { TraceMap, generatedPositionFor } = require('@jridgewell/trace-mapping')
  const generated = generatedPositionFor(new TraceMap(raw), {
    source: raw.sources[0],
    line: 1,
    column: 0
  })
  const input = {
    profile: {
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: 'commit',
            url: 'file:///frozen/out/main/index.js',
            lineNumber: generated.line - 1,
            columnNumber: generated.column
          }
        }
      ],
      samples: [1],
      timeDeltas: [1000],
      startTime: 0,
      endTime: 1000
    },
    sources: [
      {
        path: 'src/main/store/ToolActivityDetailLedger.ts',
        bytes,
        sha256: sha(bytes),
        tracked: true
      }
    ],
    build: {
      commitSha: 'a'.repeat(40),
      sourceManifestSha256: sha(
        Buffer.from(JSON.stringify([['src/main/store/ToolActivityDetailLedger.ts', sha(bytes)]]))
      )
    },
    artifacts: [
      {
        profileUrl: 'file:///frozen/out/main/index.js',
        emittedFile: 'index.js',
        bundleBytes: Buffer.from(bundle.contents),
        mapBytes: Buffer.from(map.contents),
        bundleSha256: sha(Buffer.from(bundle.contents)),
        mapSha256: sha(Buffer.from(map.contents)),
        buildCommitSha: 'a'.repeat(40),
        sourcePaths: { [raw.sources[0]]: 'src/main/store/ToolActivityDetailLedger.ts' }
      }
    ]
  }
  const captureManifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      commitSha: input.build.commitSha,
      sourceManifestSha256: input.build.sourceManifestSha256,
      artifacts: input.artifacts.map(({ bundleBytes, mapBytes, buildCommitSha, ...tuple }) => tuple)
    })
  )
  return { ...input, captureManifest, trustedCaptureManifestSha256: sha(captureManifest) }
}

it.each(['column', 'line', 'tuple', 'path', 'alias', 'drive', 'uri'])(
  'refuses %s substitution or bounds',
  async (kind) => {
    const input = await fixture()
    if (kind === 'column') input.profile.nodes[0].callFrame.columnNumber = 100000
    if (kind === 'line') input.profile.nodes[0].callFrame.lineNumber = 100000
    if (kind === 'tuple') input.artifacts[0].profileUrl = 'file:///different/index.js'
    if (['path', 'alias', 'drive', 'uri'].includes(kind)) {
      input.sources[0].path = (
        {
          path: 'src\\main.ts',
          alias: './src/main.ts',
          drive: 'C:/src/main.ts',
          uri: 'file:src/main.ts'
        } as Record<string, string>
      )[kind]
    }
    expect(() => resolveMainProfileSources(input)).toThrow('refused')
  }
)

it('resolves actual emitted fixture positions and retains original evidence/digests', async () => {
  const input = await fixture(),
    result = resolveMainProfileSources(input)
  expect(result.profile.nodes[0].callFrame.url).toBe(
    'frozen-source:///src/main/store/ToolActivityDetailLedger.ts'
  )
  expect(result.sourceProvenance.evidence[0].originalFrame).toEqual(
    input.profile.nodes[0].callFrame
  )
  expect(result.sourceProvenance.evidence[0].sourceSha256).toBe(input.sources[0].sha256)
  expect(result.profile.samples).toEqual(input.profile.samples)
})

it('refuses out-of-bounds original mappings even with a matching frozen artifact manifest', async () => {
  const input = await fixture()
  const { SourceMapGenerator } = require('source-map')
  const original = JSON.parse(input.artifacts[0].mapBytes.toString())
  const generator = new SourceMapGenerator({ file: 'index.js' })
  generator.addMapping({
    generated: {
      line: input.profile.nodes[0].callFrame.lineNumber + 1,
      column: input.profile.nodes[0].callFrame.columnNumber
    },
    original: { line: 1000, column: 1000 },
    source: original.sources[0]
  })
  generator.setSourceContent(original.sources[0], input.sources[0].bytes.toString())
  input.artifacts[0].mapBytes = Buffer.from(generator.toString())
  input.artifacts[0].mapSha256 = sha(input.artifacts[0].mapBytes)
  const manifest = JSON.parse(input.captureManifest.toString())
  manifest.artifacts[0].mapSha256 = input.artifacts[0].mapSha256
  input.captureManifest = Buffer.from(JSON.stringify(manifest))
  input.trustedCaptureManifestSha256 = sha(input.captureManifest)
  expect(() => resolveMainProfileSources(input)).toThrow('original position bounds')
})

it.each([
  'bundle',
  'map',
  'source',
  'manifest',
  'build',
  'missing',
  'unmapped',
  'content',
  'bound'
])('refuses %s provenance failure', async (kind) => {
  const input = await fixture()
  if (kind === 'bundle') input.artifacts[0].bundleSha256 = '0'.repeat(64)
  if (kind === 'map') input.artifacts[0].mapSha256 = '0'.repeat(64)
  if (kind === 'source') input.sources[0].bytes = Buffer.from('replacement')
  if (kind === 'manifest') input.build.sourceManifestSha256 = '0'.repeat(64)
  if (kind === 'build') input.artifacts[0].buildCommitSha = 'b'.repeat(40)
  if (kind === 'missing') input.artifacts = []
  if (kind === 'unmapped') input.profile.nodes[0].callFrame.lineNumber = 100000
  if (kind === 'content') {
    const raw = JSON.parse(input.artifacts[0].mapBytes.toString())
    raw.sourcesContent[0] = 'wrong'
    input.artifacts[0].mapBytes = Buffer.from(JSON.stringify(raw))
    input.artifacts[0].mapSha256 = sha(input.artifacts[0].mapBytes)
  }
  expect(() =>
    resolveMainProfileSources({
      ...input,
      ...(kind === 'bound' ? { limits: { maxBytes: 1 } } : {})
    })
  ).toThrow('refused')
})
