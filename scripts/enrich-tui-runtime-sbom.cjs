#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const COMPONENT_PREFIX = 'taskwraith:tui-node-runtime:'

function requireString(value, label, pattern) {
  if (typeof value !== 'string' || !value || (pattern && !pattern.test(value))) {
    throw new Error(`Invalid ${label}: ${String(value)}`)
  }
  return value
}

function runtimeComponent(runtimeVersion, target) {
  const platform = requireString(
    target.platform,
    'runtime target platform',
    /^(darwin|linux|win32)$/
  )
  const arch = requireString(target.arch, 'runtime target architecture', /^(x64|arm64)$/)
  const binarySha256 = requireString(target.sha256, 'runtime binary SHA-256', /^[a-f0-9]{64}$/)
  const archiveSha256 = requireString(
    target.archiveSha256,
    'runtime archive SHA-256',
    /^[a-f0-9]{64}$/
  )
  const licenseSha256 = requireString(
    target.licenseSha256,
    'runtime license SHA-256',
    /^[a-f0-9]{64}$/
  )
  const source = requireString(
    target.source,
    'runtime distribution source',
    /^https:\/\/nodejs\.org\/dist\/v\d+\.\d+\.\d+\//
  )
  const licenseSource = requireString(
    target.licenseSource,
    'runtime license source',
    /^https:\/\/nodejs\.org\/dist\/v\d+\.\d+\.\d+\/[^#]+#LICENSE$/
  )
  if (licenseSource !== `${source}#LICENSE`) {
    throw new Error(`Runtime license source does not match archive source for ${platform}-${arch}`)
  }

  return {
    type: 'application',
    'bom-ref': `${COMPONENT_PREFIX}${platform}-${arch}@${runtimeVersion}`,
    supplier: { name: 'OpenJS Foundation and Node.js contributors' },
    group: 'org.nodejs',
    name: 'Node.js standalone TUI runtime',
    version: runtimeVersion,
    scope: 'required',
    hashes: [{ alg: 'SHA-256', content: binarySha256 }],
    licenses: [{ license: { id: 'MIT' } }],
    externalReferences: [{ type: 'distribution', url: source }],
    properties: [
      { name: 'taskwraith:tui-runtime:platform', value: platform },
      { name: 'taskwraith:tui-runtime:architecture', value: arch },
      { name: 'taskwraith:tui-runtime:archive-sha256', value: archiveSha256 },
      { name: 'taskwraith:tui-runtime:license-sha256', value: licenseSha256 },
      { name: 'taskwraith:tui-runtime:license-source', value: licenseSource }
    ]
  }
}

function enrichSbom(sbom, runtimeMetadata, expectedVersion) {
  if (sbom?.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components)) {
    throw new Error('SBOM is not a CycloneDX document with a components array')
  }
  const runtimeVersion = requireString(
    runtimeMetadata?.nodeVersion,
    'runtime metadata nodeVersion',
    /^\d+\.\d+\.\d+$/
  )
  if (runtimeVersion !== expectedVersion) {
    throw new Error(
      `Runtime metadata Node ${runtimeVersion} does not match package policy ${expectedVersion}`
    )
  }
  if (!Array.isArray(runtimeMetadata.targets) || runtimeMetadata.targets.length === 0) {
    throw new Error('Runtime metadata contains no prepared targets')
  }

  const retained = sbom.components.filter(
    (component) => !String(component?.['bom-ref'] || '').startsWith(COMPONENT_PREFIX)
  )
  const runtimeComponents = runtimeMetadata.targets.map((target) =>
    runtimeComponent(runtimeVersion, target)
  )
  const refs = runtimeComponents.map((component) => component['bom-ref'])
  if (new Set(refs).size !== refs.length) {
    throw new Error('Runtime metadata contains duplicate platform/architecture targets')
  }
  const dependencies = bindRuntimeDependencies(sbom, refs)
  return {
    ...sbom,
    components: [...retained, ...runtimeComponents],
    dependencies
  }
}

function bindRuntimeDependencies(sbom, runtimeRefs) {
  const rootRef = sbom?.metadata?.component?.['bom-ref']
  const dependencies = sbom?.dependencies
  if (typeof rootRef !== 'string' || !rootRef || !Array.isArray(dependencies)) {
    throw new Error(
      'CycloneDX dependency graph is missing its root component or dependencies array'
    )
  }

  const byRef = new Map()
  for (const dependency of dependencies) {
    if (!dependency || typeof dependency.ref !== 'string' || !Array.isArray(dependency.dependsOn)) {
      throw new Error('CycloneDX dependency graph contains a malformed dependency entry')
    }
    if (byRef.has(dependency.ref)) {
      throw new Error(`CycloneDX dependency graph contains duplicate ref ${dependency.ref}`)
    }
    byRef.set(dependency.ref, {
      ...dependency,
      dependsOn: [...new Set(dependency.dependsOn)]
    })
  }
  const root = byRef.get(rootRef)
  if (!root) {
    throw new Error(`CycloneDX dependency graph has no root entry for ${rootRef}`)
  }
  root.dependsOn = [...new Set([...root.dependsOn, ...runtimeRefs])]
  for (const runtimeRef of runtimeRefs) {
    if (!byRef.has(runtimeRef)) {
      byRef.set(runtimeRef, { ref: runtimeRef, dependsOn: [] })
    }
  }
  return [...byRef.values()]
}

function runCli(argv = process.argv.slice(2), repoRoot = process.cwd()) {
  const sbomPath = path.resolve(repoRoot, argv[0] || 'dist/sbom.cdx.json')
  const runtimePath = path.resolve(repoRoot, argv[1] || 'build/tui-runtime/RUNTIME.json')
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const sbom = JSON.parse(fs.readFileSync(sbomPath, 'utf8'))
  const runtimeMetadata = JSON.parse(fs.readFileSync(runtimePath, 'utf8'))
  const expectedVersion = packageJson.taskwraithRelease?.tuiNodeRuntime?.version
  const enriched = enrichSbom(sbom, runtimeMetadata, expectedVersion)
  fs.writeFileSync(sbomPath, `${JSON.stringify(enriched, null, 2)}\n`)
  const runtimeCount = enriched.components.filter((component) =>
    String(component?.['bom-ref'] || '').startsWith(COMPONENT_PREFIX)
  ).length
  console.log(`[enrich-tui-runtime-sbom] recorded ${runtimeCount} verified Node runtime target(s)`)
  return 0
}

if (require.main === module) {
  try {
    process.exitCode = runCli()
  } catch (error) {
    console.error(
      `[enrich-tui-runtime-sbom] ${error instanceof Error ? error.message : String(error)}`
    )
    process.exitCode = 1
  }
}

module.exports = {
  COMPONENT_PREFIX,
  bindRuntimeDependencies,
  enrichSbom,
  runCli,
  runtimeComponent
}
