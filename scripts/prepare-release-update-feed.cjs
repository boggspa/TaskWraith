#!/usr/bin/env node

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const yaml = require('js-yaml')
const semver = require('semver')

const RELEASE_FEED_BASE_URL = 'https://taskwraith.dev/updates/release/'
const RELEASE_DOWNLOAD_BASE_URL = 'https://github.com/boggspa/TaskWraith/releases/download/'

function releaseInventory(version) {
  if (
    typeof version !== 'string' ||
    semver.valid(version) !== version ||
    semver.prerelease(version) !== null ||
    version.includes('+')
  ) {
    throw new Error('Release feed version must be canonical stable semver without build metadata.')
  }
  return {
    'release-mac.yml': [
      `TaskWraith-${version}-universal-mac.zip`,
      `TaskWraith-${version}-universal-mac.dmg`
    ],
    'release-win-x64.yml': [`TaskWraith-${version}-win-x64-setup.exe`],
    'release-win-arm64.yml': [`TaskWraith-${version}-win-arm64-setup.exe`],
    'release-linux.yml': [`TaskWraith-${version}.AppImage`, `taskwraith_${version}_amd64.deb`]
  }
}

function regularFile(filePath) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Expected a regular file: ${filePath}`)
  }
  return stat
}

function artifactMetadata(filePath) {
  const stat = regularFile(filePath)
  if (stat.size <= 0) throw new Error(`Artifact is empty: ${filePath}`)
  const hash = crypto.createHash('sha512')
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let count
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count))
    }
  } finally {
    fs.closeSync(fd)
  }
  return { sha512: hash.digest('base64'), size: stat.size }
}

function prepareFeed(feedPath, names, version) {
  regularFile(feedPath)
  const feed = yaml.load(fs.readFileSync(feedPath, 'utf8'))
  if (!feed || typeof feed !== 'object' || Array.isArray(feed)) {
    throw new Error(`Invalid update feed: ${feedPath}`)
  }
  if (feed.version !== version) throw new Error(`Feed version mismatch: ${feedPath}`)
  const allowedKeys = new Set(['version', 'files', 'path', 'sha512', 'releaseDate'])
  if (Object.keys(feed).some((key) => !allowedKeys.has(key))) {
    throw new Error(`Unsupported update feed field: ${feedPath}`)
  }
  if (
    typeof feed.releaseDate !== 'string' ||
    !Number.isFinite(Date.parse(feed.releaseDate)) ||
    !Array.isArray(feed.files) ||
    feed.files.length !== names.length
  ) {
    throw new Error(`Incomplete update feed: ${feedPath}`)
  }
  const entries = new Map()
  for (const file of feed.files) {
    if (
      !file ||
      typeof file !== 'object' ||
      Object.keys(file).some((key) => !['url', 'sha512', 'size', 'blockMapSize'].includes(key)) ||
      !names.includes(file.url) ||
      entries.has(file.url)
    ) {
      throw new Error(`Unexpected artifact URL or metadata: ${feedPath}`)
    }
    const metadata = artifactMetadata(path.join(path.dirname(feedPath), file.url))
    if (file.sha512 !== metadata.sha512 || file.size !== metadata.size) {
      throw new Error(`Artifact hash or size mismatch: ${file.url}`)
    }
    if (file.blockMapSize !== undefined) {
      if (
        !file.url.endsWith('.AppImage') ||
        !Number.isInteger(file.blockMapSize) ||
        file.blockMapSize <= 0 ||
        file.blockMapSize + 4 >= metadata.size
      ) {
        throw new Error(`Invalid embedded blockmap size: ${file.url}`)
      }
      const fd = fs.openSync(path.join(path.dirname(feedPath), file.url), 'r')
      try {
        const trailer = Buffer.alloc(4)
        fs.readSync(fd, trailer, 0, 4, metadata.size - 4)
        if (trailer.readUInt32BE() !== file.blockMapSize) {
          throw new Error(`Embedded blockmap size mismatch: ${file.url}`)
        }
      } finally {
        fs.closeSync(fd)
      }
      metadata.blockMapSize = file.blockMapSize
    }
    entries.set(file.url, metadata)
  }
  if (feed.path !== names[0] || feed.sha512 !== entries.get(names[0])?.sha512) {
    throw new Error(`Legacy path or hash mismatch: ${feedPath}`)
  }
  // Preserve the archive/installer blockmaps at their immutable GitHub URLs.
  for (const name of names.filter((name) => /\.(zip|exe)$/.test(name))) {
    const blockmap = path.join(path.dirname(feedPath), `${name}.blockmap`)
    if (regularFile(blockmap).size <= 0) throw new Error(`Blockmap is empty: ${blockmap}`)
  }
  const artifactUrl = (name) => `${RELEASE_DOWNLOAD_BASE_URL}v${version}/${name}`
  return yaml.dump(
    {
      version,
      files: names.map((name) => ({ url: artifactUrl(name), ...entries.get(name) })),
      path: artifactUrl(names[0]),
      sha512: feed.sha512,
      releaseDate: feed.releaseDate
    },
    { lineWidth: -1, noRefs: true }
  )
}

/** Prepare a complete metadata-only directory; never publish or overwrite it. */
function prepareReleaseUpdateFeed({ inputDirs, outputDir, version }) {
  const inventory = releaseInventory(version)
  if (!Array.isArray(inputDirs) || inputDirs.length === 0 || !outputDir) {
    throw new Error('Provide inputDirs and a separate, new outputDir.')
  }
  let output = path.resolve(outputDir)
  let ancestor = output
  const missing = []
  while (!fs.existsSync(ancestor)) {
    missing.unshift(path.basename(ancestor))
    ancestor = path.dirname(ancestor)
  }
  output = path.join(fs.realpathSync(ancestor), ...missing)
  const sources = inputDirs.map((dir) => fs.realpathSync(dir))
  if (
    sources.some((dir) => output === dir || output.startsWith(`${dir}${path.sep}`)) ||
    fs.existsSync(output)
  ) {
    throw new Error('Output directory must be new and separate from all input directories.')
  }
  const feeds = new Map()
  for (const dir of sources) {
    for (const entry of fs.readdirSync(dir)) {
      if (!/^(latest|beta|release).*\.ya?ml$/i.test(entry)) continue
      if (!Object.hasOwn(inventory, entry) || feeds.has(entry)) {
        throw new Error(`Unexpected or duplicate update feed: ${entry}`)
      }
      feeds.set(entry, prepareFeed(path.join(dir, entry), inventory[entry], version))
    }
  }
  if (feeds.size !== Object.keys(inventory).length) {
    throw new Error(
      `Missing release feeds: ${Object.keys(inventory)
        .filter((name) => !feeds.has(name))
        .join(', ')}`
    )
  }
  // Validate everything before creating output. Installers stay in input directories.
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.mkdirSync(output)
  for (const [name, text] of feeds) fs.writeFileSync(path.join(output, name), text, { flag: 'wx' })
  return { outputDir: output, feedNames: [...feeds.keys()].sort(), version }
}

function parseCliArgs(argv) {
  const options = { inputDirs: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--version' || arg === '--output') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
      options[arg === '--output' ? 'outputDir' : 'version'] = value
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`)
    } else options.inputDirs.push(arg)
  }
  return options
}

if (require.main === module) {
  try {
    const result = prepareReleaseUpdateFeed(parseCliArgs(process.argv.slice(2)))
    console.log(
      `[prepare-release-update-feed] ${result.version}: ${result.feedNames.join(', ')} -> ${result.outputDir}`
    )
  } catch (error) {
    console.error(`[prepare-release-update-feed] ${error.message}`)
    process.exitCode = 1
  }
}

module.exports = {
  RELEASE_FEED_BASE_URL,
  RELEASE_DOWNLOAD_BASE_URL,
  releaseInventory,
  prepareReleaseUpdateFeed,
  parseCliArgs
}
