const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { generateThirdPartyNotices } = require('./third-party-notices.cjs')
const {
  distributionMetadataFromPackager,
  installIdentityHandoffPayload
} = require('./identity-handoff-payload.cjs')

async function validateNativeModules(context) {
  const resourcesDir = resolveResourcesDir(context)
  const distributionMetadata = distributionMetadataFromPackager(context)
  const handoffPayload = installIdentityHandoffPayload({
    resourcesDir,
    payloadPath: process.env.TASKWRAITH_IDENTITY_HANDOFF_PAYLOAD,
    expectedBaseUrl: process.env.TASKWRAITH_HANDOFF_REHEARSAL_BASE_URL,
    expectedSourceCommit: process.env.TASKWRAITH_IDENTITY_HANDOFF_SOURCE_COMMIT,
    ...distributionMetadata
  })
  console.log(
    handoffPayload.installed
      ? `Installed final-beta identity handoff payload: ${handoffPayload.destination}`
      : `Excluded identity handoff payload from ${distributionMetadata.distributionIdentity} ${distributionMetadata.version}`
  )
  validateAppAsarSize(resourcesDir)
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked')
  const platform = context.electronPlatformName || process.platform
  const arch = normalizeArch(context.arch || process.arch)
  const expectedMacArchs = platform === 'darwin' ? expectedMacArchitectures(context, arch) : []

  if (platform === 'darwin') {
    normalizeMacElectronHelperBundles(resourcesDir, context)
  }
  if (platform === 'darwin' && expectedMacArchs.length > 1) {
    removeHostOnlyNodePtyBuildBinding(unpackedDir, expectedMacArchs)
  }
  if (platform === 'win32') {
    removeWindowsNodePtyBuildBinding(unpackedDir, arch)
  }

  const nodePtyBindings = findFiles(unpackedDir, (filePath) => {
    const normalized = filePath.split(path.sep).join('/')
    return (
      normalized.includes('/node_modules/node-pty/') &&
      path.basename(filePath) === 'pty.node' &&
      isCompatibleNodePtyBinding(normalized, platform, arch)
    )
  })

  if (nodePtyBindings.length === 0) {
    throw new Error(
      `Compatible node-pty native binding for ${platform}-${arch} was not packaged under ${unpackedDir}.`
    )
  }

  console.log(`Validated node-pty native binding: ${nodePtyBindings[0]}`)

  if (platform === 'darwin' && expectedMacArchs.length > 0) {
    validateMacNodePtyBindings(unpackedDir, expectedMacArchs)
    validateMacClaudeAgentSdkBinaries(unpackedDir, expectedMacArchs)
    validateMacNapiCanvasBindings(unpackedDir, expectedMacArchs)
  }
  if (platform === 'win32') {
    validateWindowsNodePtyBindings(unpackedDir, arch)
    validateWindowsClaudeAgentSdkBinaries(unpackedDir, arch)
  }

  // macOS-only: confirm the Swift TaskWraithBridgeDaemon was embedded inside
  // a real Contents/Helpers app bundle. The mac build chains run
  // `prebuild:bridge-daemon` before electron-builder; this is the safety
  // net that surfaces a clear error if the binary failed to land in the
  // bundle for any reason (broken swift toolchain, missing config, etc.).
  if (platform === 'darwin') {
    // The helper is built once by `prebuild:bridge-daemon` with a pre-pack
    // default identity. The packaged parent Info.plist is the authority for
    // CFBundleIdentifier and both version strings (beta vs debut appId, build
    // number), so copy them into the helper here — before signing — and then
    // validate the helper against the parent rather than against any literal.
    const parentIdentity = readMacBundleIdentity(resourcesDir, context)
    const bridgeInfoPath = resolveMacBridgeInfoPath(resourcesDir)
    alignMacBridgeHelperIdentity(resourcesDir, parentIdentity)
    const bridgeInfo = readPlistAsJson(bridgeInfoPath, 'TaskWraith Bridge Info.plist')
    validateMacBridgeInfo(bridgeInfo, bridgeInfoPath, parentIdentity)
    const daemonPath = resolveMacBridgeDaemonPath(resourcesDir)
    if (!fs.existsSync(daemonPath)) {
      throw new Error(
        `TaskWraithBridgeDaemon was not packaged at ${daemonPath}. Did \`npm run prebuild:bridge-daemon\` run before electron-builder?`
      )
    }
    const stat = fs.statSync(daemonPath)
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(
        `TaskWraithBridgeDaemon at ${daemonPath} is not a non-empty file (size=${stat.size}).`
      )
    }
    verifyMachOArchitectures(daemonPath, expectedMacArchs, 'TaskWraithBridgeDaemon')
    validateMacAppBinaries(resourcesDir, context, expectedMacArchs)
    console.log(`Validated TaskWraithBridgeDaemon: ${daemonPath} (${stat.size} bytes)`)
  }

  // Developer Preview tw sidecar: official Node runtime under tui-runtime/
  // (not ELECTRON_RUN_AS_NODE — RunAsNode fuse stays disabled below).
  validatePackagedTuiRuntime(resourcesDir, platform, arch, expectedMacArchs)

  const noticeInventory = generateThirdPartyNotices({
    resourcesDir,
    repoRoot: path.resolve(__dirname, '..'),
    electronVersion: context.packager?.config?.electronVersion
  })
  console.log(
    `Generated third-party notices for ${noticeInventory.summary.packageInstanceCount} packaged dependency instance(s).`
  )

  await hardenElectronFuses(context, resourcesDir)
}

const MAC_ELECTRON_HELPER_SUFFIXES = ['', ' (GPU)', ' (Plugin)', ' (Renderer)']

function normalizeMacElectronHelperBundles(resourcesDir, context) {
  const contentsDir = path.dirname(resourcesDir)
  const frameworksDir = path.join(contentsDir, 'Frameworks')
  const mainInfoPath = path.join(contentsDir, 'Info.plist')
  const mainInfo = readPlistAsJson(mainInfoPath, 'packaged app Info.plist')
  const permissionName = boundedBundleName(mainInfo.CFBundleName, 'CFBundleName')
  const appInfo = context.packager && context.packager.appInfo
  const productFilename = boundedBundleName(
    appInfo && (appInfo.productFilename || appInfo.productName),
    'electron-builder product filename'
  )
  const normalized = []

  for (const suffix of MAC_ELECTRON_HELPER_SUFFIXES) {
    const sourceName = `${productFilename} Helper${suffix}`
    const targetName = `${permissionName} Helper${suffix}`
    const sourceApp = path.join(frameworksDir, `${sourceName}.app`)
    const targetApp = path.join(frameworksDir, `${targetName}.app`)
    let changed = false

    if (sourceApp !== targetApp) {
      if (fs.existsSync(sourceApp) && fs.existsSync(targetApp)) {
        throw new Error(`Electron helper normalization found both ${sourceApp} and ${targetApp}.`)
      }
      if (fs.existsSync(sourceApp)) {
        fs.renameSync(sourceApp, targetApp)
        changed = true
      } else if (!fs.existsSync(targetApp)) {
        throw new Error(`Electron helper bundle is missing: ${sourceApp}`)
      }
    } else if (!fs.existsSync(targetApp)) {
      throw new Error(`Electron helper bundle is missing: ${targetApp}`)
    }

    const macosDir = path.join(targetApp, 'Contents', 'MacOS')
    const sourceExecutable = path.join(macosDir, sourceName)
    const targetExecutable = path.join(macosDir, targetName)
    if (sourceExecutable !== targetExecutable) {
      if (fs.existsSync(sourceExecutable) && fs.existsSync(targetExecutable)) {
        throw new Error(
          `Electron helper normalization found both ${sourceExecutable} and ${targetExecutable}.`
        )
      }
      if (fs.existsSync(sourceExecutable)) {
        fs.renameSync(sourceExecutable, targetExecutable)
        changed = true
      } else if (!fs.existsSync(targetExecutable)) {
        throw new Error(`Electron helper executable is missing: ${sourceExecutable}`)
      }
    } else if (!fs.existsSync(targetExecutable)) {
      throw new Error(`Electron helper executable is missing: ${targetExecutable}`)
    }

    const helperInfoPath = path.join(targetApp, 'Contents', 'Info.plist')
    const helperInfo = readPlistAsJson(helperInfoPath, `${targetName} Info.plist`)
    if (helperInfo.CFBundleExecutable !== targetName) {
      replacePlistString(helperInfoPath, 'CFBundleExecutable', targetName)
      changed = true
    }
    if (helperInfo.CFBundleDisplayName !== targetName) {
      replacePlistString(helperInfoPath, 'CFBundleDisplayName', targetName)
      changed = true
    }
    const normalizedInfo = readPlistAsJson(helperInfoPath, `${targetName} Info.plist`)
    if (
      normalizedInfo.CFBundleExecutable !== targetName ||
      normalizedInfo.CFBundleDisplayName !== targetName
    ) {
      throw new Error(`Electron helper metadata did not normalize: ${helperInfoPath}`)
    }
    normalized.push({ sourceName, targetName, changed })
  }

  if (normalized.some((entry) => entry.changed)) {
    console.log(`Normalized Electron helper bundles for permission identity ${permissionName}.`)
  }
  return { permissionName, productFilename, helpers: normalized }
}

function boundedBundleName(value, label) {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 100 ||
    value !== value.trim() ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value === '.' ||
    value === '..'
  ) {
    throw new Error(`${label} is not a bounded macOS bundle name.`)
  }
  return value
}

function replacePlistString(plistPath, key, value) {
  const result = spawnSync('/usr/bin/plutil', ['-replace', key, '-string', value, plistPath], {
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`Could not update ${key} in ${plistPath}.${detail ? `\n${detail}` : ''}`)
  }
}

function resolveMacBridgeInfoPath(resourcesDir) {
  return path.join(
    path.dirname(resourcesDir),
    'Helpers',
    'TaskWraith Bridge.app',
    'Contents',
    'Info.plist'
  )
}

// Parent-app fields the bridge helper must mirror exactly. The helper shares
// the app's TCC consent identity, so its identifier and both version strings
// are copied from the packaged parent Info.plist rather than hard-coded.
const MAC_BUNDLE_IDENTITY_KEYS = Object.freeze([
  ['bundleIdentifier', 'CFBundleIdentifier'],
  ['shortVersion', 'CFBundleShortVersionString'],
  ['bundleVersion', 'CFBundleVersion']
])

function validateMacBridgeInfo(info, infoPath, expected) {
  if (!expected || typeof expected !== 'object') {
    throw new Error(
      `TaskWraith Bridge at ${infoPath} cannot be validated without the parent app bundle identity.`
    )
  }
  for (const [field, key] of MAC_BUNDLE_IDENTITY_KEYS) {
    const want = expected[field]
    if (typeof want !== 'string' || want.trim().length === 0) {
      throw new Error(
        `Parent app bundle identity is missing ${key}; refusing to validate TaskWraith Bridge at ${infoPath}.`
      )
    }
    if (info[key] !== want) {
      throw new Error(
        `TaskWraith Bridge at ${infoPath} must share parent ${key} ${want}, got ${String(info[key])}.`
      )
    }
  }
  if (info.CFBundleExecutable !== 'TaskWraithBridgeDaemon') {
    throw new Error(
      `TaskWraith Bridge at ${infoPath} must declare TaskWraithBridgeDaemon as CFBundleExecutable.`
    )
  }
  if (
    typeof info.NSSpeechRecognitionUsageDescription !== 'string' ||
    info.NSSpeechRecognitionUsageDescription.trim().length === 0
  ) {
    throw new Error(
      `TaskWraith Bridge at ${infoPath} must declare a non-empty NSSpeechRecognitionUsageDescription.`
    )
  }
}

function bundleIdentityFromInfo(info, infoPath) {
  const identity = {}
  for (const [field, key] of MAC_BUNDLE_IDENTITY_KEYS) {
    const value = info && info[key]
    if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
      throw new Error(`${infoPath} must declare a non-empty ${key}.`)
    }
    identity[field] = value
  }
  return identity
}

/**
 * Read the packaged parent app's bundle identity from its finalized
 * Contents/Info.plist. electron-builder has already applied appId, version
 * normalization and the build number by afterPack, so the plist is the
 * authority; the packager's resolved appId is only cross-checked against it.
 */
function readMacBundleIdentity(resourcesDir, context) {
  const infoPath = path.join(path.dirname(resourcesDir), 'Info.plist')
  const info = readPlistAsJson(infoPath, 'packaged app Info.plist')
  const identity = bundleIdentityFromInfo(info, infoPath)
  const appInfo = context && context.packager && context.packager.appInfo
  const resolvedAppId = appInfo && typeof appInfo.id === 'string' ? appInfo.id.trim() : ''
  if (resolvedAppId && resolvedAppId !== identity.bundleIdentifier) {
    throw new Error(
      `packaged app Info.plist at ${infoPath} declares CFBundleIdentifier ${identity.bundleIdentifier} but electron-builder resolved appId ${resolvedAppId}.`
    )
  }
  return identity
}

/**
 * Copy the parent identity into the TaskWraith Bridge helper Info.plist.
 * Idempotent: only keys that differ are rewritten, so running it again on an
 * already-aligned helper (or on both slices of a universal merge) is a no-op.
 * Every other helper key — executable, name, consent descriptions — is left
 * exactly as build-bridge-daemon.cjs wrote it.
 */
function alignMacBridgeHelperIdentity(resourcesDir, expected) {
  const infoPath = resolveMacBridgeInfoPath(resourcesDir)
  const before = readPlistAsJson(infoPath, 'TaskWraith Bridge Info.plist')
  const rewritten = []
  for (const [field, key] of MAC_BUNDLE_IDENTITY_KEYS) {
    const want = expected && expected[field]
    if (typeof want !== 'string' || want.trim().length === 0) {
      throw new Error(`Parent app bundle identity is missing ${key}; cannot align ${infoPath}.`)
    }
    if (before[key] !== want) {
      replacePlistString(infoPath, key, want)
      rewritten.push(key)
    }
  }
  const after = readPlistAsJson(infoPath, 'TaskWraith Bridge Info.plist')
  validateMacBridgeInfo(after, infoPath, expected)
  if (rewritten.length > 0) {
    console.log(
      `Aligned TaskWraith Bridge identity (${rewritten.join(', ')}) with ${expected.bundleIdentifier} ${expected.shortVersion} (${expected.bundleVersion}).`
    )
  }
  return {
    infoPath,
    changed: rewritten.length > 0,
    rewritten,
    identity: bundleIdentityFromInfo(after, infoPath)
  }
}

function readPlistAsJson(plistPath, label) {
  const result = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf8'
  })
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`Could not read ${label}.${detail ? `\n${detail}` : ''}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(
      `${label} did not decode as JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function resolveMacBridgeDaemonPath(resourcesDir) {
  return path.join(
    path.dirname(resourcesDir),
    'Helpers',
    'TaskWraith Bridge.app',
    'Contents',
    'MacOS',
    'TaskWraithBridgeDaemon'
  )
}

function validatePackagedTuiRuntime(resourcesDir, platform, arch, expectedMacArchs) {
  const runtimeRoot = path.join(resourcesDir, 'tui-runtime')
  if (!fs.existsSync(runtimeRoot)) {
    throw new Error(
      `Packaged TUI Node runtime missing at ${runtimeRoot}. ` +
        'Did `npm run prepare:tui-runtime` (or prepare:tui-runtime:mac) run before electron-builder?'
    )
  }

  const binaryName = platform === 'win32' ? 'node.exe' : 'node'
  const requiredDirs = []
  if (platform === 'darwin' && expectedMacArchs.length > 1) {
    requiredDirs.push('darwin-arm64', 'darwin-x64')
  } else if (platform === 'darwin') {
    requiredDirs.push(
      arch === 'x64' || expectedMacArchs[0] === 'x86_64' ? 'darwin-x64' : 'darwin-arm64'
    )
  } else if (platform === 'win32') {
    requiredDirs.push(`win32-${arch === 'arm64' ? 'arm64' : 'x64'}`)
  } else {
    requiredDirs.push(`linux-${arch === 'arm64' ? 'arm64' : 'x64'}`)
  }

  for (const dirName of requiredDirs) {
    const binaryPath = path.join(runtimeRoot, dirName, binaryName)
    if (!fs.existsSync(binaryPath) || !fs.statSync(binaryPath).isFile()) {
      throw new Error(
        `Packaged TUI Node runtime binary missing: ${binaryPath}. ` +
          'Run prepare:tui-runtime with the matching --targets before packaging.'
      )
    }
    const size = fs.statSync(binaryPath).size
    if (size < 1_000_000) {
      throw new Error(`Packaged TUI Node runtime looks too small: ${binaryPath} (${size} bytes)`)
    }
    console.log(`Validated TUI Node runtime: ${binaryPath} (${formatBytes(size)})`)
  }

  // Launchers must ship under bin/ (outside asar).
  const binDir = path.join(resourcesDir, 'bin')
  if (!fs.existsSync(binDir)) {
    throw new Error(`Packaged TUI launcher directory missing: ${binDir}`)
  }
  const launcherName = platform === 'win32' ? 'tw.cmd' : 'tw'
  const launcherPath = path.join(binDir, launcherName)
  if (!fs.existsSync(launcherPath)) {
    throw new Error(`Packaged TUI launcher missing: ${launcherPath}`)
  }
}

function validateAppAsarSize(resourcesDir) {
  if (process.env.TASKWRAITH_DISABLE_BUNDLE_SIZE_GUARD === '1') {
    console.log('Skipped app.asar size guard via TASKWRAITH_DISABLE_BUNDLE_SIZE_GUARD=1')
    return
  }

  const appAsarPath = path.join(resourcesDir, 'app.asar')
  if (!fs.existsSync(appAsarPath)) {
    throw new Error(`app.asar was not packaged at ${appAsarPath}.`)
  }

  const maxBytes = readMegabyteLimit('TASKWRAITH_MAX_ASAR_MB', 500)
  const stat = fs.statSync(appAsarPath)
  if (!stat.isFile()) {
    throw new Error(`app.asar path is not a file: ${appAsarPath}`)
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `app.asar exceeds size limit: ${appAsarPath} is ${formatBytes(stat.size)}; limit is ${formatBytes(maxBytes)}.`
    )
  }
  console.log(`Validated app.asar size: ${formatBytes(stat.size)} <= ${formatBytes(maxBytes)}`)
}

async function hardenElectronFuses(context, resourcesDir) {
  const executablePath = resolveElectronExecutable(context, resourcesDir)
  const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')
  const resetAdHocDarwinSignature = shouldResetAdHocDarwinSignature(context)
  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    // Flipping a fuse changes a byte in Electron Framework. On Apple Silicon,
    // macOS validates the affected code page lazily, so an unsigned package
    // otherwise launches only to be killed with `CODESIGNING, Invalid Page`
    // when Electron first reads that fuse. Release signing replaces this
    // signature later; the ad-hoc signature keeps --dir/debug packages valid.
    // The universal builder merges x64/arm64 temporary bundles before its
    // final afterPack hook; signing either temporary bundle would make their
    // CodeResources differ and prevent that merge.
    resetAdHocDarwinSignature
  })
  console.log(`Hardened Electron fuses: ${executablePath}`)
}

function shouldResetAdHocDarwinSignature(context) {
  if ((context.electronPlatformName || process.platform) !== 'darwin') return false
  const appOutDir = String(context.appOutDir || '')
  return !/-((?:x64)|arm64)-temp$/.test(appOutDir)
}

function resolveElectronExecutable(context, resourcesDir) {
  const appOutDir = context.appOutDir
  const platform = context.electronPlatformName || process.platform
  const appInfo = context.packager && context.packager.appInfo
  const productFilename = appInfo && (appInfo.productFilename || appInfo.productName)
  const productName = appInfo && appInfo.productName
  const appName = appInfo && (appInfo.name || appInfo.sanitizedName)
  // Linux runners are case-sensitive and electron-builder lowercases the linux
  // executable to the package `name` (taskwraith), while macOS/Windows keep the
  // productName casing (TaskWraith). Check both cases so fuse-hardening finds the
  // binary everywhere — a capitalized-only check passed on case-insensitive macOS
  // but failed on the ubuntu CI linux build.
  const base = [productFilename, productName, 'TaskWraith', appName].filter(Boolean)
  const names = Array.from(new Set([...base, ...base.map((n) => n.toLowerCase())]))

  const candidates = []
  if (platform === 'darwin') {
    const contentsDir = path.dirname(resourcesDir)
    for (const name of names) {
      candidates.push(path.join(contentsDir, 'MacOS', name))
    }
  } else if (platform === 'win32') {
    for (const name of names) {
      candidates.push(path.join(appOutDir, `${name}.exe`))
    }
  } else {
    for (const name of names) {
      candidates.push(path.join(appOutDir, name))
    }
  }

  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (found) return found
  throw new Error(`Electron executable was not found. Checked: ${candidates.join(', ')}`)
}

function isCompatibleNodePtyBinding(normalizedPath, platform, arch) {
  if (platform === 'darwin' && arch === 'universal') {
    return /\/node_modules\/node-pty\/prebuilds\/darwin-(?:arm64|x64)\/pty\.node$/.test(
      normalizedPath
    )
  }
  const prebuildNeedle = `/node_modules/node-pty/prebuilds/${platform}-${arch}/pty.node`
  const rebuiltNeedle = '/node_modules/node-pty/build/Release/pty.node'
  return normalizedPath.endsWith(prebuildNeedle) || normalizedPath.endsWith(rebuiltNeedle)
}

function validateMacNodePtyBindings(unpackedDir, expectedArchs) {
  const nodePtyDir = findNodePtyDir(unpackedDir)
  if (!nodePtyDir) {
    throw new Error(`node-pty package was not unpacked under ${unpackedDir}.`)
  }
  if (expectedArchs.length > 1) {
    const requiredPrebuilds = [
      { pathArch: 'darwin-arm64', machArch: 'arm64' },
      { pathArch: 'darwin-x64', machArch: 'x86_64' }
    ]
    for (const prebuild of requiredPrebuilds) {
      const prebuildPath = path.join(nodePtyDir, 'prebuilds', prebuild.pathArch, 'pty.node')
      if (!fs.existsSync(prebuildPath)) {
        throw new Error(`Required node-pty universal prebuild is missing: ${prebuildPath}`)
      }
      verifyMachOArchitectures(prebuildPath, [prebuild.machArch], `node-pty ${prebuild.pathArch}`)
    }
    console.log('Validated node-pty Darwin prebuilds for universal package.')
    return
  }

  const pathArch = expectedArchs[0] === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  const machArch = expectedArchs[0]
  const prebuildPath = path.join(nodePtyDir, 'prebuilds', pathArch, 'pty.node')
  if (fs.existsSync(prebuildPath)) {
    verifyMachOArchitectures(prebuildPath, [machArch], `node-pty ${pathArch}`)
  }
  const buildBinding = path.join(nodePtyDir, 'build', 'Release', 'pty.node')
  if (fs.existsSync(buildBinding)) {
    verifyMachOArchitectures(buildBinding, [machArch], 'node-pty build/Release')
  }
}

function validateMacClaudeAgentSdkBinaries(unpackedDir, expectedArchs) {
  const nodeModulesDir = findNodeModulesDir(unpackedDir)
  if (!nodeModulesDir) return

  const requiredPackages = []
  if (expectedArchs.includes('arm64')) {
    requiredPackages.push({
      packageName: '@anthropic-ai/claude-agent-sdk-darwin-arm64',
      machArch: 'arm64'
    })
  }
  if (expectedArchs.includes('x86_64')) {
    requiredPackages.push({
      packageName: '@anthropic-ai/claude-agent-sdk-darwin-x64',
      machArch: 'x86_64'
    })
  }

  for (const requiredPackage of requiredPackages) {
    const binaryPath = path.join(
      nodeModulesDir,
      ...requiredPackage.packageName.split('/'),
      'claude'
    )
    if (!fs.existsSync(binaryPath)) {
      throw new Error(`Required Claude Agent SDK helper is missing: ${binaryPath}`)
    }
    verifyMachOArchitectures(binaryPath, [requiredPackage.machArch], requiredPackage.packageName)
  }
  if (requiredPackages.length > 0) {
    console.log(
      `Validated Claude Agent SDK Darwin helpers: ${requiredPackages
        .map((item) => item.packageName)
        .join(', ')}`
    )
  }
}

function validateMacNapiCanvasBindings(unpackedDir, expectedArchs) {
  const nodeModulesDir = findNodeModulesDir(unpackedDir)
  if (!nodeModulesDir) return

  const requiredPackages = []
  if (expectedArchs.includes('arm64')) {
    requiredPackages.push({
      packageName: '@napi-rs/canvas-darwin-arm64',
      bindingName: 'skia.darwin-arm64.node',
      machArch: 'arm64'
    })
  }
  if (expectedArchs.includes('x86_64')) {
    requiredPackages.push({
      packageName: '@napi-rs/canvas-darwin-x64',
      bindingName: 'skia.darwin-x64.node',
      machArch: 'x86_64'
    })
  }

  for (const requiredPackage of requiredPackages) {
    const bindingPath = path.join(
      nodeModulesDir,
      ...requiredPackage.packageName.split('/'),
      requiredPackage.bindingName
    )
    if (!fs.existsSync(bindingPath)) {
      throw new Error(
        `Required @napi-rs/canvas Darwin binding is missing: ${bindingPath}. ` +
          'Did `npm run prepare:mac-universal-deps` install both canvas-darwin packages?'
      )
    }
    verifyMachOArchitectures(bindingPath, [requiredPackage.machArch], requiredPackage.packageName)
  }
  if (requiredPackages.length > 0) {
    console.log(
      `Validated @napi-rs/canvas Darwin bindings: ${requiredPackages
        .map((item) => item.packageName)
        .join(', ')}`
    )
  }
}

function validateWindowsNodePtyBindings(unpackedDir, arch) {
  const nodePtyDir = findNodePtyDir(unpackedDir)
  if (!nodePtyDir) {
    throw new Error(`node-pty package was not unpacked under ${unpackedDir}.`)
  }
  const prebuildPath = path.join(nodePtyDir, 'prebuilds', `win32-${arch}`, 'pty.node')
  if (!fs.existsSync(prebuildPath)) {
    throw new Error(`Required node-pty Windows prebuild is missing: ${prebuildPath}`)
  }
  const buildBinding = path.join(nodePtyDir, 'build', 'Release', 'pty.node')
  if (fs.existsSync(buildBinding)) {
    throw new Error(`Host-only node-pty build binding shadows Windows prebuilds: ${buildBinding}`)
  }
  console.log(`Validated node-pty Windows prebuild: ${prebuildPath}`)
}

function validateWindowsClaudeAgentSdkBinaries(unpackedDir, arch) {
  const nodeModulesDir = findNodeModulesDir(unpackedDir)
  if (!nodeModulesDir) return

  const packageName = `@anthropic-ai/claude-agent-sdk-win32-${arch}`
  const packageDir = path.join(nodeModulesDir, ...packageName.split('/'))
  if (!fs.existsSync(packageDir)) {
    console.log(`Claude Agent SDK Windows helper not packaged for ${arch}; skipping helper check.`)
    return
  }
  const binaryPath = path.join(packageDir, 'claude.exe')
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Claude Agent SDK Windows helper is missing: ${binaryPath}`)
  }
  const stat = fs.statSync(binaryPath)
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`Claude Agent SDK Windows helper is not a non-empty file: ${binaryPath}`)
  }
  console.log(`Validated Claude Agent SDK Windows helper: ${binaryPath}`)
}

function removeHostOnlyNodePtyBuildBinding(unpackedDir, expectedArchs) {
  const nodePtyDir = findNodePtyDir(unpackedDir)
  if (!nodePtyDir) return
  const buildBinding = path.join(nodePtyDir, 'build', 'Release', 'pty.node')
  if (!fs.existsSync(buildBinding)) return
  const hasAllArchs = expectedArchs.every((arch) => hasMachOArchitecture(buildBinding, arch))
  if (hasAllArchs) return
  fs.rmSync(path.join(nodePtyDir, 'build'), { recursive: true, force: true })
  console.log(`Removed host-only node-pty build binding from universal package: ${buildBinding}`)
}

function removeWindowsNodePtyBuildBinding(unpackedDir, arch) {
  const nodePtyDir = findNodePtyDir(unpackedDir)
  if (!nodePtyDir) return
  const prebuildPath = path.join(nodePtyDir, 'prebuilds', `win32-${arch}`, 'pty.node')
  const buildBinding = path.join(nodePtyDir, 'build', 'Release', 'pty.node')
  if (!fs.existsSync(prebuildPath) || !fs.existsSync(buildBinding)) return
  fs.rmSync(path.join(nodePtyDir, 'build'), { recursive: true, force: true })
  console.log(`Removed host-only node-pty build binding from Windows package: ${buildBinding}`)
}

function findNodePtyDir(unpackedDir) {
  const candidates = findDirectories(
    unpackedDir,
    (candidate) => {
      const normalized = candidate.split(path.sep).join('/')
      return normalized.endsWith('/node_modules/node-pty')
    },
    8
  )
  return candidates[0]
}

function findNodeModulesDir(unpackedDir) {
  const candidates = findDirectories(
    unpackedDir,
    (candidate) => candidate.split(path.sep).join('/').endsWith('/node_modules'),
    6
  )
  return candidates[0]
}

function validateMacAppBinaries(resourcesDir, context, expectedArchs) {
  if (expectedArchs.length === 0) return
  const executablePath = resolveElectronExecutable(context, resourcesDir)
  verifyMachOArchitectures(executablePath, expectedArchs, 'app executable')

  const contentsDir = path.dirname(resourcesDir)
  const frameworksDir = path.join(contentsDir, 'Frameworks')
  const electronFramework = path.join(
    frameworksDir,
    'Electron Framework.framework',
    'Electron Framework'
  )
  if (fs.existsSync(electronFramework)) {
    verifyMachOArchitectures(electronFramework, expectedArchs, 'Electron Framework')
  }
  for (const helperApp of findDirectories(
    frameworksDir,
    (candidate) => candidate.endsWith('.app'),
    5
  )) {
    const helperMacOSDir = path.join(helperApp, 'Contents', 'MacOS')
    for (const entry of safeReadDir(helperMacOSDir)) {
      if (!entry.isFile()) continue
      verifyMachOArchitectures(
        path.join(helperMacOSDir, entry.name),
        expectedArchs,
        `Electron helper ${path.basename(helperApp)}`
      )
    }
  }
}

function expectedMacArchitectures(context, arch) {
  const appOutDir = String(context.appOutDir || '').toLowerCase()
  if (appOutDir.includes('x64-temp')) return ['x86_64']
  if (appOutDir.includes('arm64-temp')) return ['arm64']
  if (arch === 'universal' || appOutDir.includes('mac-universal')) return ['arm64', 'x86_64']
  if (arch === 'arm64') return ['arm64']
  if (arch === 'x64') return ['x86_64']
  return []
}

function normalizeArch(value) {
  if (typeof value === 'number') {
    try {
      const { Arch } = require('builder-util')
      return Arch[value] || String(value)
    } catch {
      return String(value)
    }
  }
  return String(value || process.arch)
}

function verifyMachOArchitectures(filePath, archs, label) {
  if (process.platform !== 'darwin' || archs.length === 0) return
  for (const arch of archs) {
    if (hasMachOArchitecture(filePath, arch)) continue
    throw new Error(`${label} is missing ${arch} slice: ${filePath}`)
  }
}

function hasMachOArchitecture(filePath, arch) {
  const result = spawnSync('/usr/bin/lipo', [filePath, '-verify_arch', arch], {
    stdio: 'pipe',
    encoding: 'utf8'
  })
  return result.status === 0
}

function resolveResourcesDir(context) {
  const appOutDir = context.appOutDir
  const appInfo = context.packager && context.packager.appInfo
  const productFilename = appInfo && (appInfo.productFilename || appInfo.productName)

  if (context.electronPlatformName === 'darwin') {
    const candidates = [
      productFilename
        ? path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
        : '',
      ...findDirectories(appOutDir, (candidate) => candidate.endsWith('.app'), 2).map((appPath) =>
        path.join(appPath, 'Contents', 'Resources')
      )
    ].filter(Boolean)
    const found = candidates.find((candidate) => fs.existsSync(candidate))
    if (found) return found
  }

  const resourcesDir = path.join(appOutDir, 'resources')
  if (fs.existsSync(resourcesDir)) return resourcesDir
  throw new Error(`Electron resources directory was not found in ${appOutDir}.`)
}

function findDirectories(root, predicate, maxDepth, depth = 0) {
  if (!root || depth > maxDepth) return []
  const entries = safeReadDir(root)
  const matches = []
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name)
    if (!entry.isDirectory()) continue
    if (predicate(fullPath)) {
      matches.push(fullPath)
    }
    matches.push(...findDirectories(fullPath, predicate, maxDepth, depth + 1))
  }
  return matches
}

function findFiles(root, predicate) {
  const matches = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of safeReadDir(current)) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile() && predicate(fullPath)) {
        matches.push(fullPath)
      }
    }
  }
  return matches
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

function readMegabyteLimit(envName, defaultMb) {
  const raw = process.env[envName]
  if (!raw) return defaultMb * 1024 * 1024
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${envName} must be a positive number of megabytes.`)
  }
  return Math.floor(value * 1024 * 1024)
}

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(1)} MB`
}

module.exports = validateNativeModules
module.exports.default = validateNativeModules
module.exports.resolveMacBridgeDaemonPath = resolveMacBridgeDaemonPath
module.exports.resolveMacBridgeInfoPath = resolveMacBridgeInfoPath
module.exports.validateMacBridgeInfo = validateMacBridgeInfo
module.exports.normalizeMacElectronHelperBundles = normalizeMacElectronHelperBundles
module.exports.readPlistAsJson = readPlistAsJson
module.exports.bundleIdentityFromInfo = bundleIdentityFromInfo
module.exports.readMacBundleIdentity = readMacBundleIdentity
module.exports.alignMacBridgeHelperIdentity = alignMacBridgeHelperIdentity
