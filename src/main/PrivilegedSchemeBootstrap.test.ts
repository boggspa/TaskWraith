import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const bootstrap = readFileSync(join(process.cwd(), 'src/main/bootstrap.ts'), 'utf8')
const main = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

describe('pre-ready Electron bootstrap configuration', () => {
  it('registers privileged schemes synchronously before external Host preparation can yield', () => {
    const configure = bootstrap.indexOf('configureElectronBeforeReady()')
    const start = bootstrap.indexOf('void bootstrapMainProcess({')
    expect(configure).toBeGreaterThanOrEqual(0)
    expect(configure).toBeLessThan(start)
    expect(bootstrap).toContain(
      'protocol.registerSchemesAsPrivileged([TW_MEDIA_PRIVILEGE, MESH_ASSET_PRIVILEGE])'
    )
    expect(main).not.toContain('protocol.registerSchemesAsPrivileged')
  })

  it('moves renderer process switches but leaves post-ready protocol handlers in main', () => {
    expect(bootstrap).toContain("app.commandLine.appendSwitch('enable-gpu-rasterization')")
    expect(bootstrap).toContain("app.commandLine.appendSwitch('enable-zero-copy')")
    expect(bootstrap).toContain("app.commandLine.appendSwitch('js-flags'")
    expect(main).not.toContain("app.commandLine.appendSwitch('enable-gpu-rasterization')")
    expect(main).not.toContain('RENDERER_HEAP_CEILING_MAX_MB')
    expect(main).toContain('registerTwMediaProtocol(')
    expect(main).toContain('registerMeshAssetProtocol(')
  })
})
