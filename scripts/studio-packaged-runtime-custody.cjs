'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const asar = require('@electron/asar')

const ELECTRON_ROOTS = ['main', 'preload', 'renderer']

function refuse(message) {
  const error = new Error(`Packaged runtime custody: ${message}`)
  error.code = 'ERR_STUDIO_RUNTIME_CUSTODY'
  throw error
}

function inspect(file, kind, allowMissing = false) {
  let stat
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null
    refuse(`missing or unreadable ${kind}: ${file} (${error.code || error.message})`)
  }
  if (stat.isSymbolicLink()) refuse(`symlink is not permitted: ${file}`)
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    refuse(`expected ${kind}: ${file}`)
  }
  return stat
}

function rootPath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    refuse(`${label} must be an absolute directory path`)
  }
  const resolved = path.resolve(value)
  inspect(resolved, 'directory')
  return resolved
}

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function entry(relativePath, bytes) {
  return { path: relativePath, byteLength: bytes.length, sha256: hash(bytes) }
}

function sortManifest(manifest) {
  return manifest.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  )
}

// Match the out/host extraResources filters in electron-builder.yml.
function excludedHostFile(name) {
  return name.endsWith('.map') || name === '.DS_Store'
}

function diskManifest(root, prefix = '', filterHost = false) {
  inspect(root, 'directory')
  const manifest = []
  function visit(directory, relative) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name)
      const stat = fs.lstatSync(file)
      // Excluded names cannot disguise symlinks into another build/resource tree.
      if (stat.isSymbolicLink()) refuse(`symlink is not permitted: ${file}`)
      const member = relative ? `${relative}/${name}` : name
      if (stat.isDirectory()) visit(file, member)
      else {
        if (!stat.isFile()) refuse(`expected regular file: ${file}`)
        if (filterHost && excludedHostFile(name)) continue
        manifest.push(entry(member, fs.readFileSync(file)))
      }
    }
  }
  visit(root, prefix)
  return sortManifest(manifest)
}

function archiveDirectory(node, label) {
  if (node && Object.hasOwn(node, 'link')) refuse(`archive symlink is not permitted: ${label}`)
  if (!node || !node.files || typeof node.files !== 'object' || Array.isArray(node.files)) {
    refuse(`missing or invalid archive directory: ${label}`)
  }
  return node.files
}

function walkArchive(node, relativePath, visitFile) {
  if (!node || typeof node !== 'object') refuse(`invalid archive entry: ${relativePath}`)
  if (Object.hasOwn(node, 'link')) refuse(`archive symlink is not permitted: ${relativePath}`)
  if (Object.hasOwn(node, 'files')) {
    const files = archiveDirectory(node, relativePath)
    for (const name of Object.keys(files).sort()) {
      if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
        refuse(`invalid archive member name under ${relativePath}`)
      }
      walkArchive(files[name], `${relativePath}/${name}`, visitFile)
    }
  } else visitFile(node, relativePath)
}

function unpackedRuntimeManifest(resourcesRoot) {
  const unpackedRoot = path.join(resourcesRoot, 'app.asar.unpacked')
  if (!inspect(unpackedRoot, 'directory', true)) return []
  const outRoot = path.join(unpackedRoot, 'out')
  if (!inspect(outRoot, 'directory', true)) return []

  const hostRoot = path.join(outRoot, 'host')
  if (inspect(hostRoot, 'directory', true)) {
    const host = diskManifest(hostRoot, 'out/host')
    if (host.length) refuse(`Host file must not appear in app.asar.unpacked: ${host[0].path}`)
  }

  const manifest = []
  for (const root of ELECTRON_ROOTS) {
    const directory = path.join(outRoot, root)
    if (inspect(directory, 'directory', true)) {
      manifest.push(...diskManifest(directory, `out/${root}`))
    }
  }
  return sortManifest(manifest)
}

function electronArchiveManifest(archivePath, resourcesRoot) {
  const archiveStat = inspect(archivePath, 'file')
  // @electron/asar caches headers by pathname; a package may be rebuilt in place.
  asar.uncache(archivePath)
  try {
    const header = asar.getRawHeader(archivePath)
    const archiveFiles = archiveDirectory(header.header, '/')
    const out = archiveDirectory(archiveFiles.out, 'out')
    if (Object.hasOwn(out, 'host')) {
      walkArchive(out.host, 'out/host', (_node, member) => {
        refuse(`Host file must not appear in app.asar: ${member}`)
      })
    }
    const manifest = []
    const indexedUnpacked = []
    for (const root of ELECTRON_ROOTS) {
      archiveDirectory(out[root], `out/${root}`)
      walkArchive(out[root], `out/${root}`, (node, member) => {
        if (!Number.isSafeInteger(node.size) || node.size < 0) {
          refuse(`invalid archive file size: ${member}`)
        }
        if (node.unpacked) {
          let current = path.join(resourcesRoot, 'app.asar.unpacked')
          inspect(current, 'directory')
          const parts = member.split('/')
          parts.forEach((part, index) => {
            current = path.join(current, part)
            inspect(current, index === parts.length - 1 ? 'file' : 'directory')
          })
        } else {
          const offset = Number(node.offset)
          if (
            !Number.isSafeInteger(offset) ||
            offset < 0 ||
            8 + header.headerSize + offset + node.size > archiveStat.size
          ) {
            refuse(`invalid or truncated archive file: ${member}`)
          }
        }
        const bytes = asar.extractFile(archivePath, member, false)
        if (bytes.length !== node.size) refuse(`archive file size mismatch: ${member}`)
        const file = entry(member, bytes)
        manifest.push(file)
        if (node.unpacked) indexedUnpacked.push(file)
      })
    }
    // Header traversal cannot see unindexed loose files. Inspect the relevant
    // disk trees too, including when the archive has no unpacked runtime entries.
    compareManifests(
      'Unpacked Electron runtime',
      sortManifest(indexedUnpacked),
      unpackedRuntimeManifest(resourcesRoot)
    )
    return sortManifest(manifest)
  } finally {
    asar.uncache(archivePath)
  }
}

function receipt(manifest) {
  return {
    fileCount: manifest.length,
    byteLength: manifest.reduce((total, file) => total + file.byteLength, 0),
    manifestSha256: hash(JSON.stringify(manifest)),
    manifest
  }
}

function compareManifests(label, source, packaged) {
  const expected = new Map(source.map((file) => [file.path, file]))
  const actual = new Map(packaged.map((file) => [file.path, file]))
  const missing = source.filter((file) => !actual.has(file.path)).map((file) => file.path)
  const extra = packaged.filter((file) => !expected.has(file.path)).map((file) => file.path)
  const changed = source
    .filter((file) => {
      const copy = actual.get(file.path)
      return copy && (copy.sha256 !== file.sha256 || copy.byteLength !== file.byteLength)
    })
    .map((file) => file.path)
  const differences = Object.entries({ missing, extra, changed })
    .filter(([, files]) => files.length)
    .map(([kind, files]) => `${kind} (${files.length}): ${files.slice(0, 8).join(', ')}`)
  if (differences.length) refuse(`${label} mismatch; ${differences.join('; ')}`)
}

/**
 * Synchronously compare the current build's runtime files with a macOS app.
 * Throws on missing, extra, changed or linked runtime files. Successful receipts
 * contain sorted relative paths and SHA-256 hashes, independent of mtimes and
 * unrelated package metadata. This observes local bytes; it does not build or sign.
 * @param {{repoRoot: string, appRoot: string}} options
 */
function assertPackagedRuntimeCustody(options = {}) {
  if (!options || typeof options !== 'object') refuse('repoRoot and appRoot are required')
  const repoRoot = rootPath(options.repoRoot, 'repoRoot')
  const appRoot = rootPath(options.appRoot, 'appRoot')
  inspect(path.join(repoRoot, 'out'), 'directory')
  inspect(path.join(appRoot, 'Contents'), 'directory')
  const resourcesRoot = path.join(appRoot, 'Contents', 'Resources')
  inspect(resourcesRoot, 'directory')

  const electron = ELECTRON_ROOTS.flatMap((root) => {
    const manifest = diskManifest(path.join(repoRoot, 'out', root), `out/${root}`)
    if (!manifest.length) refuse(`empty source runtime directory: out/${root}`)
    return manifest
  })
  const host = diskManifest(path.join(repoRoot, 'out', 'host'), '', true)
  if (!host.length) refuse('empty source runtime directory: out/host')
  const packagedElectron = electronArchiveManifest(
    path.join(resourcesRoot, 'app.asar'),
    resourcesRoot
  )
  // The source filter describes what the builder copies. Every actual Host
  // resource must match that set, including accidentally copied maps/metadata.
  const packagedHost = diskManifest(path.join(resourcesRoot, 'host'))
  compareManifests('Electron runtime', electron, packagedElectron)
  compareManifests('Host runtime', host, packagedHost)

  return {
    schemaVersion: 1,
    ok: true,
    repoRoot,
    appRoot,
    electron: receipt(electron),
    host: receipt(host)
  }
}

module.exports = { assertPackagedRuntimeCustody }
