#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { resolvePlatformCommandInvocation } = require('./windows-cmd-invocation.cjs')

const REPO_ROOT = path.resolve(__dirname, '..')
const ALLOWED_EXTERNAL_MODULES = new Set(['node-pty'])

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function packageLayout(repoRoot = REPO_ROOT, packageRoot = path.join(repoRoot, 'packages', 'cli')) {
  const root = path.resolve(repoRoot)
  const cliRoot = path.resolve(packageRoot)
  const expectedRoot = path.join(root, 'packages', 'cli')
  if (cliRoot !== expectedRoot) {
    throw new Error(`Refusing an unexpected CLI package root: ${cliRoot}`)
  }
  return {
    repoRoot: root,
    packageRoot: cliRoot,
    distRoot: path.join(cliRoot, 'dist')
  }
}

function assertPlainDirectory(directory, label) {
  if (!fs.existsSync(directory)) return
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`CLI package ${label} must be a plain directory: ${directory}`)
  }
}

function assertPlainFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`CLI package ${label} is missing: ${file}`)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`CLI package ${label} must be a plain file: ${file}`)
  }
}

function validatePackageManifests(repoRoot, packageRoot) {
  const rootManifest = readJson(path.join(repoRoot, 'package.json'))
  const cliManifest = readJson(path.join(packageRoot, 'package.json'))
  if (rootManifest.private !== true) {
    throw new Error('The Electron root package must stay private before packing the CLI package.')
  }
  if (cliManifest.name !== 'taskwraith') {
    throw new Error(`Unexpected CLI package name: ${String(cliManifest.name)}`)
  }
  if (cliManifest.version !== rootManifest.version) {
    throw new Error(
      `CLI package version ${String(cliManifest.version)} must match root ${String(rootManifest.version)}.`
    )
  }
  const expectedBins = {
    taskwraith: 'bin/taskwraith.cjs',
    tw: 'bin/taskwraith.cjs',
    'taskwraith-host': 'bin/taskwraith-host.cjs'
  }
  if (JSON.stringify(cliManifest.bin) !== JSON.stringify(expectedBins)) {
    throw new Error('CLI package bins must expose taskwraith, tw, and taskwraith-host.')
  }
  assertPlainFile(path.join(packageRoot, expectedBins.taskwraith), 'taskwraith launcher')
  assertPlainFile(path.join(packageRoot, expectedBins['taskwraith-host']), 'Host launcher')
  return { rootManifest, cliManifest }
}

function cleanCliPackage(options = {}) {
  const layout = packageLayout(options.repoRoot, options.packageRoot)
  assertPlainDirectory(layout.packageRoot, 'root')
  validatePackageManifests(layout.repoRoot, layout.packageRoot)
  assertPlainDirectory(layout.distRoot, 'dist output')
  fs.rmSync(layout.distRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  return layout.distRoot
}

function copyJavaScriptTree(source, destination) {
  assertPlainDirectory(source, 'compiled payload source')
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name)
    const destinationPath = path.join(destination, entry.name)
    if (entry.isSymbolicLink()) {
      throw new Error(`CLI package payload refuses symbolic links: ${sourcePath}`)
    }
    if (entry.isDirectory()) {
      copyJavaScriptTree(sourcePath, destinationPath)
      continue
    }
    if (!entry.isFile()) {
      throw new Error(`CLI package payload refuses non-files: ${sourcePath}`)
    }
    if (entry.name === '.DS_Store' || entry.name.endsWith('.map')) continue
    if (!entry.name.endsWith('.js')) {
      throw new Error(`CLI package payload contains an unexpected file: ${sourcePath}`)
    }
    fs.copyFileSync(sourcePath, destinationPath)
  }
}

function collectExternalModules(root) {
  const modules = new Set()
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(file)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue
      const source = fs.readFileSync(file, 'utf8')
      for (const match of source.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
        const specifier = match[2]
        if (!specifier.startsWith('.') && !specifier.startsWith('node:')) modules.add(specifier)
      }
    }
  }
  visit(root)
  return modules
}

function npmInvocation(args) {
  const npmExecPath = String(process.env.npm_execpath || '').trim()
  if (npmExecPath) {
    return { command: process.execPath, arguments: [npmExecPath, ...args], spawnOptions: {} }
  }
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return resolvePlatformCommandInvocation(npmCommand, args)
}

function runNpm(args, cwd, stdio = 'inherit') {
  const invocation = npmInvocation(args)
  const result = spawnSync(invocation.command, invocation.arguments, {
    cwd,
    env: process.env,
    stdio,
    ...invocation.spawnOptions
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `npm ${args.join(' ')} failed${result.status === null ? '' : ` with exit ${result.status}`}`,
      { cause: result.error }
    )
  }
  return result
}

function prepareCliPackage(options = {}) {
  const layout = packageLayout(options.repoRoot, options.packageRoot)
  assertPlainDirectory(layout.packageRoot, 'root')
  const { rootManifest } = validatePackageManifests(layout.repoRoot, layout.packageRoot)
  cleanCliPackage(layout)

  if (options.build !== false) {
    runNpm(['run', 'tui:build', '--silent'], layout.repoRoot)
    runNpm(['run', 'host:build', '--silent'], layout.repoRoot)
  }

  const tuiSource = path.join(layout.repoRoot, 'out', 'tui')
  const hostSource = path.join(layout.repoRoot, 'out', 'host')
  copyJavaScriptTree(tuiSource, path.join(layout.distRoot, 'tui'))
  copyJavaScriptTree(hostSource, path.join(layout.distRoot, 'host'))
  fs.copyFileSync(path.join(layout.repoRoot, 'LICENSE'), path.join(layout.distRoot, 'LICENSE'))
  fs.writeFileSync(
    path.join(layout.distRoot, 'PACKAGE.json'),
    `${JSON.stringify(
      {
        name: 'taskwraith',
        version: rootManifest.version,
        runtime: 'system-node',
        payloads: ['tui', 'host']
      },
      null,
      2
    )}\n`
  )

  const externalModules = collectExternalModules(layout.distRoot)
  const unexpected = [...externalModules].filter((name) => !ALLOWED_EXTERNAL_MODULES.has(name))
  if (unexpected.length > 0) {
    cleanCliPackage(layout)
    throw new Error(`CLI package payload has undeclared external modules: ${unexpected.join(', ')}`)
  }
  fs.chmodSync(path.join(layout.distRoot, 'tui', 'tui', 'cli.js'), 0o755)
  fs.chmodSync(path.join(layout.distRoot, 'host', 'host-runtime', 'cli.js'), 0o755)
  console.log(`prepared npm CLI payload: ${path.relative(layout.repoRoot, layout.distRoot)}`)
  return layout.distRoot
}

function packCliPackage(options = {}) {
  const layout = packageLayout(options.repoRoot, options.packageRoot)
  const { cliManifest } = validatePackageManifests(layout.repoRoot, layout.packageRoot)
  const destination = path.resolve(
    options.destination || path.join(layout.repoRoot, 'artifacts', 'npm-cli')
  )
  fs.mkdirSync(destination, { recursive: true })
  runNpm(['pack', layout.packageRoot, '--pack-destination', destination], layout.repoRoot)
  const tarball = path.join(destination, `${cliManifest.name}-${cliManifest.version}.tgz`)
  assertPlainFile(tarball, 'packed tarball')
  console.log(`packed npm CLI: ${tarball}`)
  return tarball
}

if (require.main === module) {
  if (process.argv.includes('--clean')) cleanCliPackage()
  else if (process.argv.includes('--pack')) packCliPackage()
  else prepareCliPackage()
}

module.exports = {
  cleanCliPackage,
  collectExternalModules,
  packCliPackage,
  packageLayout,
  prepareCliPackage
}
