#!/usr/bin/env node
'use strict'

// Real-layout regression probe; uses synthetic rows and a private Electron
// profile. Run with: node scripts/perf/transcriptWindowLayoutProbe.cjs
// Add --baseline=<git-ref> to exercise the same fixture against an older hook.
const { execFileSync, spawn } = require('node:child_process')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

async function runParent() {
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], {
    env: { ...process.env, TASKWRAITH_TRANSCRIPT_WINDOW_PROBE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Transcript layout probe timed out\n${stdout}\n${stderr}`))
    }, 45_000)
    child.once('error', reject)
    child.once('exit', (exitCode) => {
      clearTimeout(timeout)
      resolve(exitCode)
    })
  })
  process.stdout.write(stdout)
  if (code !== 0) throw new Error(stderr || `Transcript layout probe exited ${code}`)
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'taskwraith-transcript-window-'))
  app.setPath('userData', path.join(fixtureDir, 'profile'))
  let exitCode = 1
  try {
    const baseline = process.argv.find((arg) => arg.startsWith('--baseline='))?.slice(11)
    const repoRoot = path.resolve(__dirname, '../..')
    const plugins = []
    if (baseline) {
      const revision = execFileSync('git', ['rev-parse', '--verify', `${baseline}^{commit}`], {
        cwd: repoRoot,
        encoding: 'utf8'
      }).trim()
      const source = execFileSync(
        'git',
        ['show', `${revision}:src/renderer/src/components/TranscriptPanel.tsx`],
        { cwd: repoRoot, encoding: 'utf8' }
      )
      plugins.push({
        name: 'baseline-transcript-hook',
        setup(build) {
          build.onLoad({ filter: /[/\\]TranscriptPanel\.tsx$/ }, (args) => ({
            // Older revisions kept the hook private. Expose only that test
            // seam in memory; the checkout is never rewritten for comparison.
            contents: source.replace(
              /^function useTranscriptVirtualization\(/m,
              'export function useTranscriptVirtualization('
            ),
            loader: 'tsx',
            resolveDir: path.dirname(args.path)
          }))
        }
      })
    }
    const result = await require('esbuild').build({
      entryPoints: [path.join(__dirname, 'transcriptWindowLayoutFixture.tsx')],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      jsx: 'automatic',
      plugins,
      // The fixture renders the production hook with simple cards. Vite's
      // unrelated icon catalogue and component styles are not part of it.
      define: {
        'process.env.NODE_ENV': '"production"',
        'import.meta.env.DEV': 'false',
        'import.meta.glob': 'probeAssetGlob'
      },
      banner: { js: 'const probeAssetGlob = () => ({});' },
      loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' }
    })
    const css = readFileSync(
      path.join(__dirname, '../../src/renderer/src/assets/css/02-transcript-messages-fx.css'),
      'utf8'
    )
    writeFileSync(path.join(fixtureDir, 'fixture.js'), result.outputFiles[0].text)
    writeFileSync(path.join(fixtureDir, 'fixture.css'), css)
    writeFileSync(
      path.join(fixtureDir, 'fixture.html'),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"></head>' +
        '<body><div id="root"></div><script>window.reportProbe = result => require("electron").ipcRenderer.send("transcript-window-result", result);' +
        'window.addEventListener("error", event => window.reportProbe({ok:false,error:event.message}))</script>' +
        '<script src="fixture.js"></script></body></html>'
    )
    await app.whenReady()
    const window = new BrowserWindow({
      show: false,
      width: 2500,
      height: 1000,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        backgroundThrottling: false
      }
    })
    const report = await new Promise((resolve, reject) => {
      window.webContents.on('console-message', (event) => {
        if (event.level === 'error') process.stderr.write(`${event.message}\n`)
      })
      ipcMain.once('transcript-window-result', (_event, value) => resolve(value))
      window.webContents.on('render-process-gone', (_event, details) =>
        reject(new Error(JSON.stringify(details)))
      )
      window.loadFile(path.join(fixtureDir, 'fixture.html')).catch(reject)
    })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    window.destroy()
    exitCode = report.ok ? 0 : 1
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
  app.exit(exitCode)
}

const run = process.env.TASKWRAITH_TRANSCRIPT_WINDOW_PROBE === '1' ? runElectron : runParent
run().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  if (process.env.TASKWRAITH_TRANSCRIPT_WINDOW_PROBE === '1') require('electron').app.exit(1)
  else process.exitCode = 1
})
