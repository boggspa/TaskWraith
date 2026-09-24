#!/usr/bin/env node

/**
 * prepare-tui-runtime.cjs — fetch official standalone Node binaries for the
 * packaged tw sidecar (Developer Preview).
 *
 * Why not ELECTRON_RUN_AS_NODE against the TaskWraith Electron binary?
 * afterPack hardens FuseV1Options.RunAsNode=false (and related Node CLI
 * env/inspect fuses). That is intentional security posture: the signed App
 * binary must not re-enter as arbitrary Node via env. The TUI therefore ships
 * its own official Node runtime under extraResources → tui-runtime/, and the
 * launchers exec that binary against the outside-asar cli.js payload.
 *
 * Layout written under build/tui-runtime/:
 *   <platform>-<arch>/node       (macOS/Linux)
 *   <platform>-<arch>/node.exe   (Windows)
 *   RUNTIME.json                 (metadata for smoke / docs)
 *
 * Usage:
 *   node scripts/prepare-tui-runtime.cjs
 *   node scripts/prepare-tui-runtime.cjs --targets=darwin-arm64,darwin-x64
 *   TASKWRAITH_TUI_NODE_VERSION=22.23.2 node scripts/prepare-tui-runtime.cjs
 */

const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const { spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const { readPackageJson, resolveRuntimeNodeVersion } = require('./tui-runtime-policy.cjs')

const repoRoot = process.cwd()
const outRoot = path.join(repoRoot, 'build', 'tui-runtime')
const cacheRoot = path.join(outRoot, '.cache')

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  })
}

async function main() {
  const targets = resolveTargets()
  const version = normalizeVersion(resolveRuntimeNodeVersion(readPackageJson(repoRoot)))
  fs.mkdirSync(cacheRoot, { recursive: true })
  fs.mkdirSync(outRoot, { recursive: true })

  const checksumManifest = await fetchOfficialChecksums(version)
  const prepared = []
  for (const target of targets) {
    const entry = await prepareTarget(target, version, checksumManifest)
    prepared.push(entry)
  }

  // Drop stale arch dirs that are not in this prepare set (keeps package lean).
  for (const entry of fs.readdirSync(outRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === '.cache') continue
    if (!prepared.some((item) => item.dirName === entry.name)) {
      fs.rmSync(path.join(outRoot, entry.name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    }
  }

  const runtimeMeta = {
    nodeVersion: version,
    preparedAt: new Date().toISOString(),
    note:
      'Official Node.js binary runtime for the packaged tw sidecar. ' +
      'TaskWraith keeps Electron FuseV1 RunAsNode disabled; launchers must use this binary.',
    targets: prepared
  }
  fs.writeFileSync(path.join(outRoot, 'RUNTIME.json'), `${JSON.stringify(runtimeMeta, null, 2)}\n`)

  console.log(
    `Prepared TUI Node runtime v${version} for: ${prepared.map((p) => p.dirName).join(', ')}`
  )
  console.log(`Output: ${path.relative(repoRoot, outRoot)}`)
}

function resolveTargets() {
  const fromArg = process.argv.find((arg) => arg.startsWith('--targets='))
  const raw =
    (fromArg && fromArg.slice('--targets='.length)) ||
    process.env.TASKWRAITH_TUI_RUNTIME_TARGETS ||
    ''
  if (raw.trim()) {
    return raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map(parseTargetToken)
  }

  // Host-only default (fast local/dir packages). Universal mac builds should
  // pass --targets=darwin-arm64,darwin-x64 via prepare:tui-runtime:mac.
  return [hostTarget()]
}

function hostTarget() {
  const platform = process.platform
  const arch = normalizeArch(process.arch)
  return { platform, arch, dirName: `${platform}-${arch}` }
}

function parseTargetToken(token) {
  const match = /^(darwin|linux|win32)-(x64|arm64)$/.exec(token)
  if (!match) {
    throw new Error(
      `Invalid TUI runtime target "${token}". Expected platform-arch like darwin-arm64.`
    )
  }
  return { platform: match[1], arch: match[2], dirName: token }
}

function normalizeArch(arch) {
  if (arch === 'x86_64' || arch === 'amd64') return 'x64'
  if (arch === 'aarch64') return 'arm64'
  return arch
}

function normalizeVersion(version) {
  return String(version).replace(/^v/, '')
}

async function prepareTarget(target, version, checksumManifest) {
  const distName = officialDistName(target, version)
  const url = `https://nodejs.org/dist/v${version}/${distName}`
  const cachePath = path.join(cacheRoot, distName)
  const expectedArchiveSha256 = checksumManifest.checksums.get(distName)
  if (!expectedArchiveSha256) {
    throw new Error(
      `Official ${path.basename(checksumManifest.source)} has no checksum for ${distName}`
    )
  }
  await ensureVerifiedArchive({
    archiveUrl: url,
    cachePath,
    distName,
    expectedSha256: expectedArchiveSha256
  })

  const targetDir = path.join(outRoot, target.dirName)
  fs.rmSync(targetDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  fs.mkdirSync(targetDir, { recursive: true })

  const binaryName = target.platform === 'win32' ? 'node.exe' : 'node'
  const destBinary = path.join(targetDir, binaryName)
  const destLicense = path.join(targetDir, 'LICENSE')
  extractNodePayload(cachePath, target, version, destBinary, destLicense)

  if (target.platform !== 'win32') {
    fs.chmodSync(destBinary, 0o755)
  }

  const stat = fs.statSync(destBinary)
  if (!stat.isFile() || stat.size < 1_000_000) {
    throw new Error(`Extracted Node binary looks too small: ${destBinary} (${stat.size} bytes)`)
  }
  const licenseStat = fs.statSync(destLicense)
  if (!licenseStat.isFile() || licenseStat.size < 1_000) {
    throw new Error(
      `Extracted Node distribution license looks too small: ${destLicense} (${licenseStat.size} bytes)`
    )
  }

  // Smoke that the binary can at least print a version when host arch matches.
  if (canExecOnHost(target)) {
    const probe = spawnSync(destBinary, ['-e', 'process.stdout.write(process.version)'], {
      encoding: 'utf8',
      timeout: 10_000
    })
    if (probe.status !== 0) {
      throw new Error(
        `Prepared Node binary failed version probe: ${destBinary}\n${probe.stderr || probe.stdout || probe.error}`
      )
    }
    const got = String(probe.stdout || '').trim()
    if (got !== `v${version}`) {
      throw new Error(
        `Prepared Node version mismatch at ${destBinary}: got ${got}, want v${version}`
      )
    }
  }

  const sha256 = hashFile(destBinary)
  const licenseSha256 = hashFile(destLicense)
  fs.writeFileSync(
    path.join(targetDir, 'NODE.json'),
    `${JSON.stringify(
      {
        nodeVersion: version,
        platform: target.platform,
        arch: target.arch,
        binary: binaryName,
        sha256,
        source: url,
        archive: distName,
        archiveSha256: expectedArchiveSha256,
        checksumSource: checksumManifest.source,
        license: 'LICENSE',
        licenseSha256,
        licenseSource: `${url}#LICENSE`
      },
      null,
      2
    )}\n`
  )

  console.log(
    `  ${target.dirName}: ${path.relative(repoRoot, destBinary)} (${formatBytes(stat.size)})`
  )
  return {
    dirName: target.dirName,
    platform: target.platform,
    arch: target.arch,
    binary: binaryName,
    bytes: stat.size,
    sha256,
    source: url,
    archive: distName,
    archiveSha256: expectedArchiveSha256,
    checksumSource: checksumManifest.source,
    license: 'LICENSE',
    licenseBytes: licenseStat.size,
    licenseSha256,
    licenseSource: `${url}#LICENSE`
  }
}

function officialDistName(target, version) {
  // Official Node release archive naming:
  //   node-vVERSION-darwin-arm64.tar.gz
  //   node-vVERSION-linux-x64.tar.xz  (we prefer .tar.gz when available)
  //   node-vVERSION-win-x64.zip
  if (target.platform === 'win32') {
    const winArch = target.arch === 'x64' ? 'x64' : 'arm64'
    return `node-v${version}-win-${winArch}.zip`
  }
  const plat = target.platform === 'darwin' ? 'darwin' : 'linux'
  // nodejs.org ships .tar.gz for darwin/linux for current LTS lines.
  return `node-v${version}-${plat}-${target.arch}.tar.gz`
}

async function fetchOfficialChecksums(version, fetchText = downloadText) {
  const source = `https://nodejs.org/dist/v${version}/SHASUMS256.txt`
  const text = await fetchText(source)
  return {
    source,
    checksums: parseShasums256(text)
  }
}

function parseShasums256(text) {
  const checksums = new Map()
  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue
    const match = /^([a-fA-F0-9]{64})\s{2,}(\S+)$/.exec(rawLine)
    if (!match) {
      throw new Error(`Malformed SHASUMS256.txt line ${index + 1}`)
    }
    const sha256 = match[1].toLowerCase()
    const fileName = match[2]
    if (checksums.has(fileName)) {
      throw new Error(`Duplicate SHASUMS256.txt entry for ${fileName}`)
    }
    checksums.set(fileName, sha256)
  }
  if (checksums.size === 0) {
    throw new Error('SHASUMS256.txt contained no checksum entries')
  }
  return checksums
}

async function ensureVerifiedArchive({
  archiveUrl,
  cachePath,
  distName,
  expectedSha256,
  download = downloadToFile
}) {
  const hadCache = fs.existsSync(cachePath)
  if (!hadCache || fs.statSync(cachePath).size <= 1_000_000) {
    fs.rmSync(cachePath, { force: true })
    console.log(`  downloading: ${archiveUrl}`)
    await download(archiveUrl, cachePath)
  } else {
    console.log(`  cache hit: ${path.basename(cachePath)}`)
  }

  try {
    return assertArchiveChecksum(cachePath, expectedSha256, distName)
  } catch (error) {
    fs.rmSync(cachePath, { force: true })
    if (!hadCache) throw error
    console.log(`  cached checksum mismatch; downloading again: ${distName}`)
    await download(archiveUrl, cachePath)
    try {
      return assertArchiveChecksum(cachePath, expectedSha256, distName)
    } catch (freshError) {
      fs.rmSync(cachePath, { force: true })
      throw freshError
    }
  }
}

function assertArchiveChecksum(filePath, expectedSha256, label = path.basename(filePath)) {
  if (!/^[a-f0-9]{64}$/i.test(String(expectedSha256))) {
    throw new Error(`Invalid expected SHA-256 for ${label}`)
  }
  const actualSha256 = hashFile(filePath)
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(
      `Official SHA-256 mismatch for ${label}: expected ${expectedSha256.toLowerCase()}, got ${actualSha256}`
    )
  }
  return actualSha256
}

function extractNodePayload(archivePath, target, version, destBinary, destLicense) {
  const tmpDir = path.join(cacheRoot, `extract-${target.dirName}-${process.pid}`)
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  fs.mkdirSync(tmpDir, { recursive: true })

  try {
    const distributionName =
      target.platform === 'win32'
        ? `node-v${version}-win-${target.arch === 'x64' ? 'x64' : 'arm64'}`
        : `node-v${version}-${target.platform === 'darwin' ? 'darwin' : 'linux'}-${target.arch}`
    if (target.platform === 'win32') {
      extractZip(archivePath, tmpDir)
      const candidate = path.join(tmpDir, distributionName, 'node.exe')
      if (!fs.existsSync(candidate)) {
        // Some zip layouts place node.exe at the root of the archive folder.
        const alt = findFile(tmpDir, 'node.exe')
        if (!alt) throw new Error(`node.exe not found after extracting ${archivePath}`)
        fs.copyFileSync(alt, destBinary)
      } else {
        fs.copyFileSync(candidate, destBinary)
      }
      copyNodeDistributionLicense(tmpDir, distributionName, destLicense)
      return
    }

    extractTarGz(archivePath, tmpDir)
    const candidate = path.join(tmpDir, distributionName, 'bin', 'node')
    if (!fs.existsSync(candidate)) {
      const alt = findFile(tmpDir, 'node')
      if (!alt) throw new Error(`node binary not found after extracting ${archivePath}`)
      fs.copyFileSync(alt, destBinary)
    } else {
      fs.copyFileSync(candidate, destBinary)
    }
    copyNodeDistributionLicense(tmpDir, distributionName, destLicense)
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
}

function copyNodeDistributionLicense(extractRoot, distributionName, destLicense) {
  const sourceLicense = path.join(extractRoot, distributionName, 'LICENSE')
  if (!fs.existsSync(sourceLicense) || !fs.statSync(sourceLicense).isFile()) {
    throw new Error(`Verified Node distribution is missing ${distributionName}/LICENSE`)
  }
  const text = fs.readFileSync(sourceLicense, 'utf8')
  if (
    Buffer.byteLength(text, 'utf8') < 1_000 ||
    !/Node\.js is licensed for use as follows:/i.test(text) ||
    !/Permission is hereby granted, free of charge/i.test(text)
  ) {
    throw new Error(`Verified Node distribution has an invalid ${distributionName}/LICENSE`)
  }
  fs.copyFileSync(sourceLicense, destLicense)
}

function extractTarGz(archivePath, destDir) {
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], {
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    throw new Error(`tar extract failed for ${archivePath}: ${result.stderr || result.stdout}`)
  }
}

function extractZip(archivePath, destDir) {
  // Prefer bsdtar/tar which handle zip on macOS; fall back to PowerShell on Windows.
  if (process.platform === 'win32') {
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
      ],
      { encoding: 'utf8' }
    )
    if (ps.status !== 0) {
      throw new Error(`Expand-Archive failed for ${archivePath}: ${ps.stderr || ps.stdout}`)
    }
    return
  }
  const result = spawnSync('tar', ['-xf', archivePath, '-C', destDir], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`tar zip extract failed for ${archivePath}: ${result.stderr || result.stdout}`)
  }
}

function canExecOnHost(target) {
  if (target.platform !== process.platform) return false
  return normalizeArch(process.arch) === target.arch
}

function findFile(root, baseName) {
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name === baseName) return full
    }
  }
  return null
}

function downloadToFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let parsedUrl
    try {
      parsedUrl = requireHttpsUrl(url)
    } catch (error) {
      reject(error)
      return
    }
    const tmp = `${destPath}.partial`
    fs.mkdirSync(path.dirname(destPath), { recursive: true })
    const file = fs.createWriteStream(tmp)
    const req = https.get(
      parsedUrl,
      { headers: { 'User-Agent': 'TaskWraith-tui-runtime-prepare' } },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          file.close()
          fs.rmSync(tmp, { force: true })
          let redirectUrl
          try {
            redirectUrl = requireHttpsUrl(res.headers.location, parsedUrl)
          } catch (error) {
            reject(error)
            return
          }
          res.resume()
          downloadToFile(redirectUrl, destPath, redirectsLeft - 1).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          file.close()
          fs.rmSync(tmp, { force: true })
          reject(new Error(`Download failed ${res.statusCode} for ${parsedUrl}`))
          res.resume()
          return
        }
        res.pipe(file)
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(tmp, destPath)
            resolve()
          })
        })
      }
    )
    req.on('error', (error) => {
      file.close()
      fs.rmSync(tmp, { force: true })
      reject(error)
    })
  })
}

function downloadText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    let parsedUrl
    try {
      parsedUrl = requireHttpsUrl(url)
    } catch (error) {
      reject(error)
      return
    }
    const req = https.get(
      parsedUrl,
      { headers: { 'User-Agent': 'TaskWraith-tui-runtime-prepare' } },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirectsLeft > 0
        ) {
          let redirectUrl
          try {
            redirectUrl = requireHttpsUrl(res.headers.location, parsedUrl)
          } catch (error) {
            reject(error)
            return
          }
          res.resume()
          downloadText(redirectUrl, redirectsLeft - 1).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed ${res.statusCode} for ${parsedUrl}`))
          res.resume()
          return
        }
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        res.on('error', reject)
      }
    )
    req.on('error', reject)
  })
}

function requireHttpsUrl(value, base) {
  const url = new URL(value, base)
  if (url.protocol !== 'https:') {
    throw new Error(`Refusing non-HTTPS runtime download URL: ${url}`)
  }
  return url.toString()
}

function hashFile(filePath) {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function formatBytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

module.exports = {
  assertArchiveChecksum,
  copyNodeDistributionLicense,
  ensureVerifiedArchive,
  fetchOfficialChecksums,
  officialDistName,
  parseShasums256,
  requireHttpsUrl
}
