import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const yaml: { load: (text: string) => unknown } = require('js-yaml')
const {
  readConfiguredDmgWindow,
  rewriteDmgSettings
}: {
  readConfiguredDmgWindow: (configPath?: string) => {
    height: number
    width: number
    x?: number
    y?: number
  } | null
  rewriteDmgSettings: (data: string, window: { height: number; width: number }) => string
} = require('./patch-electron-builder-dmg-window.cjs')
const layout: {
  artwork: { height: number; width: number }
  background: { height: number; width: number }
  icons: {
    appX: number
    applicationsX: number
    size: number
    textSize: number
    y: number
  }
  window: { height: number; width: number }
} = require('./dmg-layout-contract.cjs')

const repoRoot = path.resolve(import.meta.dirname, '..')
const preloadPath = path.join(repoRoot, 'scripts', 'patch-electron-builder-dmg-window.cjs')

function sampleDmgSettings() {
  return {
    title: 'TaskWraith 1.9.4',
    background: '/tmp/background.tiff',
    contents: [
      { path: '/tmp/TaskWraith.app', type: 'file', x: 172, y: 250 },
      { path: '/Applications', type: 'link', x: 488, y: 250 }
    ],
    window: {
      position: { x: 400, y: 360 },
      size: { width: 960, height: 720 }
    }
  }
}

function readPngDimensions(file: string) {
  const png = fs.readFileSync(file)
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
  expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

describe('DMG opening-window patch', () => {
  it('replaces image-derived bounds while preserving the rest of the dmgbuild settings', () => {
    const source = sampleDmgSettings()
    const rewritten = JSON.parse(
      rewriteDmgSettings(JSON.stringify(source), { width: 660, height: 544 })
    )

    expect(rewritten).toMatchObject({
      title: source.title,
      background: source.background,
      contents: source.contents,
      window: {
        position: { x: 400, y: 448 },
        size: { width: 660, height: 544 }
      }
    })
  })

  it('leaves unrelated writes untouched', () => {
    const source = JSON.stringify({ name: 'not dmgbuild settings' })
    expect(rewriteDmgSettings(source, { width: 660, height: 544 })).toBe(source)
    expect(rewriteDmgSettings('not json', { width: 660, height: 544 })).toBe('not json')
  })

  it('preloads against the exact fs-extra instance used by dmg-builder', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-dmg-window-'))
    const outputPath = path.join(tempDir, 'settings.json')
    const settings = JSON.stringify(sampleDmgSettings())
    const probe = `
      const { createRequire } = require('node:module')
      const requireFromDmgBuilder = createRequire(require.resolve('dmg-builder/out/dmgUtil'))
      requireFromDmgBuilder('fs-extra').writeFile(process.argv[1], process.argv[2])
    `

    try {
      execFileSync(
        process.execPath,
        ['--require', preloadPath, '-e', probe, outputPath, settings],
        { cwd: repoRoot }
      )
      const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'))
      const configuredWindow = readConfiguredDmgWindow()
      expect(configuredWindow).not.toBeNull()
      expect(result.window.size).toEqual({
        width: configuredWindow?.width,
        height: configuredWindow?.height
      })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('routes electron-builder through the preload without exporting NODE_OPTIONS', () => {
    const runner = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'run-electron-builder.cjs'),
      'utf8'
    )
    expect(runner).toContain("require.resolve('electron-builder/out/cli/cli')")
    expect(runner).toContain("'--require', dmgWindowPreload")
    expect(runner).not.toContain('process.env.NODE_OPTIONS')
  })
})

describe('DMG visual layout contract', () => {
  it('keeps Finder configuration aligned with the generated artwork', () => {
    const config = yaml.load(
      fs.readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8')
    ) as {
      dmg: {
        contents: Array<{ x: number; y: number }>
        iconSize: number
        iconTextSize: number
        window: { height: number; width: number }
      }
    }

    expect(config.dmg.window).toEqual(layout.window)
    expect(config.dmg.iconSize).toBe(layout.icons.size)
    expect(config.dmg.iconTextSize).toBe(layout.icons.textSize)
    expect(config.dmg.contents).toMatchObject([
      { x: layout.icons.appX, y: layout.icons.y },
      { x: layout.icons.applicationsX, y: layout.icons.y }
    ])
  })

  it('ships retina bleed assets larger than both the artwork and opening frame', () => {
    expect(layout.background.width).toBeGreaterThan(layout.window.width)
    expect(layout.background.height).toBeGreaterThan(layout.window.height)
    expect(layout.window.height - layout.artwork.height).toBe(124)
    expect(readPngDimensions(path.join(repoRoot, 'build', 'background.png'))).toEqual(
      layout.background
    )
    expect(readPngDimensions(path.join(repoRoot, 'build', 'background@2x.png'))).toEqual({
      width: layout.background.width * 2,
      height: layout.background.height * 2
    })
    expect(readPngDimensions(path.join(repoRoot, 'build', 'swarm-field.png'))).toEqual(
      layout.background
    )
    expect(readPngDimensions(path.join(repoRoot, 'build', 'swarm-field@2x.png'))).toEqual({
      width: layout.background.width * 2,
      height: layout.background.height * 2
    })
  })

  it('uses the current brand line and SF Pro wordmark in the DMG source', () => {
    const exporter = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'export-dmg-background.cjs'),
      'utf8'
    )
    expect(exporter).toContain('>Orchestrate.</text>')
    expect(exporter).toContain('>Collaborate.</text>')
    expect(exporter).toContain('>Deliver.</text>')
    expect(exporter).toContain("'SF Pro Display'")
    expect(exporter).not.toContain('OWN YOUR AGENT')
  })

  it('keeps icon-sized pedestals out of the independently zoomable Finder layer', () => {
    const exporter = fs.readFileSync(
      path.join(repoRoot, 'scripts', 'export-dmg-background.cjs'),
      'utf8'
    )
    expect(exporter).not.toContain('const pedestal')
    expect(exporter).not.toContain('${pedestal(')
  })
})
