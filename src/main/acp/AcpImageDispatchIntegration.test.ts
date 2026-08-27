import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

const mainRoot = path.resolve(__dirname, '..')

function source(relativePath: string): string {
  return fs.readFileSync(path.join(mainRoot, relativePath), 'utf8')
}

describe('ACP image dispatch integration', () => {
  it.each([
    ['grok/GrokAcpClient.ts', 'imagePaths: options.imagePaths'],
    ['kimi/KimiAcpClient.ts', 'imagePaths: options.imagePaths'],
    ['mistral/MistralAcpClient.ts', 'imagePaths: options.imagePaths']
  ])('%s forwards the main-authorized image array into the neutral client', (file, seam) => {
    expect(source(file)).toContain(seam)
  })

  it('wires normal provider launches while keeping Kimi maintenance compaction image-free', () => {
    const index = source('index.ts')
    const grokLaunch = index.slice(index.indexOf('grokAcpHandle = runGrokAcpTurn({'))
    const mistralLaunch = index.slice(index.indexOf('mistralAcpHandle = runMistralAcpTurn({'))
    const kimiLaunch = index.slice(index.indexOf('return runKimiAcpTurn({'))
    const compactionLaunch = index.slice(index.lastIndexOf('handle = runKimiAcpTurn({'))

    expect(grokLaunch.slice(0, 800)).toContain('imagePaths: payload.imagePaths')
    expect(mistralLaunch.slice(0, 800)).toContain('imagePaths: payload.imagePaths')
    expect(kimiLaunch.slice(0, 800)).toContain('imagePaths: payload.imagePaths')
    expect(compactionLaunch.slice(0, 800)).not.toContain('imagePaths: payload.imagePaths')
  })
})
