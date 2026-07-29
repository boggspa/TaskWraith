#!/usr/bin/env node

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function findPackagedRoot(root) {
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (fs.existsSync(path.join(current, 'resources', 'app.asar'))) {
      return current
    }
    for (const entry of safeReadDir(current)) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name))
    }
  }
  return null
}

function resolveLinuxArtifacts(distDir, version, architecture = process.arch) {
  const appImage = path.join(distDir, `TaskWraith-${version}.AppImage`)
  if (!fs.existsSync(appImage)) {
    throw new Error(`Missing Linux AppImage: ${appImage}`)
  }
  const debArchitecture = architecture === 'arm64' ? 'arm64' : 'amd64'
  const deb = path.join(distDir, `taskwraith_${version}_${debArchitecture}.deb`)
  if (!fs.existsSync(deb)) {
    throw new Error(`Missing exact Linux deb: ${deb}`)
  }
  return { appImage, deb }
}

function runChecked(command, args, options, label) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 120_000,
    ...options
  })
  if (result.error) {
    throw new Error(`${label} failed to spawn: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(
      `${label} exited ${result.status}${detail ? `:\n${detail.slice(0, 4000)}` : ''}`
    )
  }
  return result
}

function validateDebMetadata(metadataText, version, architecture) {
  const fields = new Map(
    String(metadataText)
      .split(/\r?\n/)
      .map((line) => line.match(/^([^:]+):\s*(.+)$/))
      .filter(Boolean)
      .map((match) => [match[1], match[2]])
  )
  const errors = []
  if (fields.get('Package') !== 'taskwraith') {
    errors.push(`deb Package must be taskwraith; got ${fields.get('Package') || '<missing>'}`)
  }
  const expectedDebVersion = version.replace(/-/g, '~')
  if (fields.get('Version') !== expectedDebVersion) {
    errors.push(
      `deb Version must be ${expectedDebVersion}; got ${fields.get('Version') || '<missing>'}`
    )
  }
  if (fields.get('Architecture') !== architecture) {
    errors.push(
      `deb Architecture must be ${architecture}; got ${fields.get('Architecture') || '<missing>'}`
    )
  }
  return errors
}

function smokeExtractedPackage(extractedRoot, repoRoot, label) {
  const packageRoot = findPackagedRoot(extractedRoot)
  if (!packageRoot) {
    throw new Error(`${label} contains no packaged resources/app.asar payload`)
  }
  runChecked(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'smoke-packaged-electron.cjs'), packageRoot],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        TASKWRAITH_FORCE_LAUNCH_SMOKE: '1',
        TASKWRAITH_TUI_REQUIRE_PACKAGE: '1',
        TASKWRAITH_TUI_REQUIRE_PACKAGED_HOST: '1'
      }
    },
    `${label} extracted package smoke`
  )
}

function runCli(argv = process.argv.slice(2), repoRoot = process.cwd()) {
  if (process.platform !== 'linux') {
    throw new Error('Linux artifact smoke must run on Linux')
  }
  const distDir = path.resolve(repoRoot, argv[0] || 'dist')
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const { appImage, deb } = resolveLinuxArtifacts(distDir, packageJson.version)
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-linux-artifacts-'))

  try {
    fs.accessSync(appImage, fs.constants.X_OK)
    const appImageRoot = path.join(tempRoot, 'appimage')
    fs.mkdirSync(appImageRoot)
    runChecked(appImage, ['--appimage-extract'], { cwd: appImageRoot }, 'AppImage extraction')
    smokeExtractedPackage(
      path.join(appImageRoot, 'squashfs-root'),
      repoRoot,
      path.basename(appImage)
    )

    const debArchitecture = process.arch === 'arm64' ? 'arm64' : 'amd64'
    const metadata = runChecked(
      'dpkg-deb',
      ['--field', deb, 'Package', 'Version', 'Architecture'],
      { cwd: tempRoot },
      'deb metadata validation'
    )
    const metadataErrors = validateDebMetadata(
      metadata.stdout,
      packageJson.version,
      debArchitecture
    )
    if (metadataErrors.length > 0) {
      throw new Error(metadataErrors.join('\n'))
    }
    const debRoot = path.join(tempRoot, 'deb')
    fs.mkdirSync(debRoot)
    runChecked('dpkg-deb', ['--extract', deb, debRoot], { cwd: tempRoot }, 'deb extraction')
    smokeExtractedPackage(debRoot, repoRoot, path.basename(deb))
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }

  console.log(
    `[smoke-linux-artifacts] AppImage and deb payloads extracted and passed packaged Electron/TUI smoke`
  )
  return 0
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

if (require.main === module) {
  try {
    process.exitCode = runCli()
  } catch (error) {
    console.error(
      `[smoke-linux-artifacts] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}

module.exports = {
  findPackagedRoot,
  resolveLinuxArtifacts,
  runCli,
  validateDebMetadata
}
