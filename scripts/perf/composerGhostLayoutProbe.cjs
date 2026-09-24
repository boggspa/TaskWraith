#!/usr/bin/env node
'use strict'

const { spawn } = require('node:child_process')
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const STYLES = [
  'default',
  'codex',
  'claude',
  'gemini',
  'grok',
  'kimi',
  'cursor',
  'chatgpt',
  'modular',
  'terminal',
  'stub',
  'satellite',
  'obsidian',
  'alabaster'
]

async function runParent() {
  const electronBinary = require('electron')
  const child = spawn(electronBinary, [__filename], {
    env: { ...process.env, TASKWRAITH_COMPOSER_GHOST_PROBE_CHILD: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stderr.on('data', (chunk) => (stderr += chunk))
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Composer ghost layout probe timed out.'))
    }, 30_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
  if (exitCode !== 0) throw new Error(stderr || `Electron exited ${exitCode}`)
  const line = stdout
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('COMPOSER_GHOST_LAYOUT_RESULT='))
  if (!line) throw new Error(`Electron returned no layout result.\n${stdout}\n${stderr}`)
  const result = JSON.parse(line.slice('COMPOSER_GHOST_LAYOUT_RESULT='.length))
  const failures = result.rows.filter((row) => !row.ok)
  if (failures.length > 0) {
    throw new Error(`Composer ghost layout failures:\n${JSON.stringify(failures, null, 2)}`)
  }
  process.stdout.write(
    `Composer ghost layout passed in real Electron Chromium for ${result.rows.length} shells.\n`
  )
}

async function runElectronChild() {
  const { app, BrowserWindow, ipcMain } = require('electron')
  const repoRoot = path.resolve(__dirname, '..', '..')
  const cssPaths = [
    'src/renderer/src/assets/css/00-fonts-base.css',
    'src/renderer/src/assets/css/03-composer-welcome-activity.css',
    'src/renderer/src/assets/css/07-composer-shells.css',
    'src/renderer/src/assets/css/10-provider-shell-overrides.css'
  ]
  const css = cssPaths
    .map((relative) => readFileSync(path.join(repoRoot, relative), 'utf8'))
    .join('\n')
    .replace(/<\/style/gi, '<\\/style')
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'taskwraith-composer-ghost-'))
  const fixturePath = path.join(fixtureDir, 'fixture.html')
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
:root { --font-size-md: 14px; --composer-font-family: system-ui; --text-primary: #eee;
--text-secondary: #aaa; --text-tertiary: #888; --composer-bg-solid: #222; }
body { margin: 0; padding: 20px; background: #111; color: #eee; }
.probe-host { width: 360px; margin: 8px; }
${css}
</style></head><body><script>
const { ipcRenderer } = require('electron')
const styles = ${JSON.stringify(STYLES)}
const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
window.addEventListener('DOMContentLoaded', async () => {
  const rows = []
  for (const style of styles) {
    const host = document.createElement('div')
    host.className = 'probe-host'
    host.dataset.composerStyle = style
    host.dataset.theme = style === 'alabaster' ? 'alabaster' : 'obsidian'
    host.innerHTML = '<div class="composer-area"><div class="composer-surface"><div class="composer-textarea-wrap"><textarea class="composer-textarea" rows="1" placeholder="Message"></textarea></div></div></div>'
    document.body.appendChild(host)
    const textarea = host.querySelector('textarea')
    await waitFrame()
    const baseHeight = textarea.getBoundingClientRect().height
    textarea.classList.add('has-ghost-suggestion')
    textarea.placeholder = 'Inspect the focused validation failure.\\n\\nThen run the targeted regression suite.'
    await waitFrame()
    const ghostHeight = textarea.getBoundingClientRect().height
    const computed = getComputedStyle(textarea)
    const maxHeight = Number.parseFloat(computed.maxHeight)
    textarea.placeholder = Array.from({ length: 12 }, (_, index) => 'Line ' + (index + 1)).join('\\n')
    await waitFrame()
    const cappedHeight = textarea.getBoundingClientRect().height
    const ok = textarea.value === '' && ghostHeight > baseHeight + 4 &&
      (!Number.isFinite(maxHeight) || cappedHeight <= maxHeight + 1)
    rows.push({ style, ok, baseHeight, ghostHeight, cappedHeight, maxHeight, fieldSizing: computed.fieldSizing })
    host.remove()
  }
  ipcRenderer.send('composer-ghost-layout-result', { rows })
})
</script></body></html>`
  writeFileSync(fixturePath, html, 'utf8')

  app.commandLine.appendSwitch('disable-gpu')
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    width: 520,
    height: 760,
    webPreferences: { contextIsolation: false, nodeIntegration: true }
  })
  ipcMain.once('composer-ghost-layout-result', (_event, result) => {
    process.stdout.write(`COMPOSER_GHOST_LAYOUT_RESULT=${JSON.stringify(result)}\n`)
    window.destroy()
    rmSync(fixtureDir, { recursive: true, force: true })
    app.exit(0)
  })
  await window.loadFile(fixturePath)
}

if (process.versions.electron && process.env.TASKWRAITH_COMPOSER_GHOST_PROBE_CHILD === '1') {
  runElectronChild().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exit(1)
  })
} else {
  runParent().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`)
    process.exit(1)
  })
}
