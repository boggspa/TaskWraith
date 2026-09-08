const { build } = require('esbuild')

build({
  entryPoints: {
    ThreadCatalogueWorkerEntry: 'src/main/workers/threadCatalogueWorker.ts',
    ThreadCatalogueDecoderEntry: 'src/main/workers/threadCatalogueDecoder.ts'
  },
  outdir: process.argv.includes('--outdir')
    ? process.argv[process.argv.indexOf('--outdir') + 1]
    : 'out/host/host-node',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  treeShaking: true,
  logLevel: 'warning'
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
