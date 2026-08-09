import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

describe('paired Host projection production composition', () => {
  it('constructs one gateway inside the remote runtime lifecycle and injects it', () => {
    expect(indexSource).toContain(
      "import { PairedHostProjectionGateway } from './remote/PairedHostProjectionGateway'"
    )

    const start = indexSource.indexOf('const startRuntime = (')
    const end = indexSource.indexOf('const startEmbeddedRelay', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const startRuntime = indexSource.slice(start, end)

    expect(startRuntime).toContain(
      'const hostProjectionGateway = new PairedHostProjectionGateway({'
    )
    expect(startRuntime).toContain("userDataPath: app.getPath('userData')")
    expect(startRuntime).toContain('clientVersion: app.getVersion()')
    expect(startRuntime).toMatch(
      /const runtime = new RemoteBridgeRuntime\(\{[\s\S]*?hostProjectionGateway,[\s\S]*?\}\)/
    )
    expect(startRuntime.indexOf('new PairedHostProjectionGateway')).toBeLessThan(
      startRuntime.indexOf('new RemoteBridgeRuntime')
    )
  })
})
