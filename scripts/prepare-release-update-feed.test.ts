import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')
const {
  prepareReleaseUpdateFeed,
  releaseInventory,
  parseCliArgs
} = require('./prepare-release-update-feed.cjs')
const roots: string[] = []

function fixture(version = '0.1.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskwraith-release-feed-'))
  roots.push(root)
  const inputDirs = ['mac', 'windows', 'linux'].map((name) => path.join(root, name))
  inputDirs.forEach((dir) => fs.mkdirSync(dir))
  const inventory: Record<string, string[]> = releaseInventory(version)
  const feedPaths: Record<string, string> = {}
  for (const [name, artifacts] of Object.entries(inventory)) {
    const dir = inputDirs[name.includes('mac') ? 0 : name.includes('win') ? 1 : 2]
    const files = artifacts.map((artifact) => {
      const bytes = Buffer.from(`fixture bytes ${artifact}`)
      fs.writeFileSync(path.join(dir, artifact), bytes)
      if (/\.(zip|exe)$/.test(artifact))
        fs.writeFileSync(path.join(dir, `${artifact}.blockmap`), 'blockmap')
      return {
        url: artifact,
        sha512: crypto.createHash('sha512').update(bytes).digest('base64'),
        size: bytes.length
      }
    })
    feedPaths[name] = path.join(dir, name)
    fs.writeFileSync(
      feedPaths[name],
      yaml.dump({
        version,
        files,
        path: artifacts[0],
        sha512: files[0].sha512,
        releaseDate: '2026-10-08T00:00:00.000Z'
      })
    )
  }
  return { inputDirs, outputDir: path.join(root, 'prepared'), version, feedPaths }
}

function mutateFeed(filePath: string, mutate: (feed: any) => void) {
  const feed = yaml.load(fs.readFileSync(filePath, 'utf8'))
  mutate(feed)
  fs.writeFileSync(filePath, yaml.dump(feed))
}

afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }))
)

describe('Release update feed preparation', () => {
  it('preserves verified AppImage embedded blockmap metadata', () => {
    const args = fixture()
    const artifact = path.join(args.inputDirs[2], 'TaskWraith-0.1.0.AppImage')
    const trailer = Buffer.alloc(4)
    trailer.writeUInt32BE(8)
    const bytes = Buffer.concat([fs.readFileSync(artifact), Buffer.alloc(8), trailer])
    fs.writeFileSync(artifact, bytes)
    mutateFeed(args.feedPaths['release-linux.yml'], (feed) => {
      feed.files[0].size = bytes.length
      feed.files[0].sha512 = crypto.createHash('sha512').update(bytes).digest('base64')
      feed.sha512 = feed.files[0].sha512
      feed.files[0].blockMapSize = 8
    })
    prepareReleaseUpdateFeed(args)
    const prepared = yaml.load(
      fs.readFileSync(path.join(args.outputDir, 'release-linux.yml'), 'utf8')
    )
    expect(prepared.files[0].blockMapSize).toBe(8)
    mutateFeed(args.feedPaths['release-linux.yml'], (feed) => {
      feed.files[0].blockMapSize = 9
    })
    expect(() => prepareReleaseUpdateFeed({ ...args, outputDir: `${args.outputDir}-bad` })).toThrow(
      'Embedded blockmap size mismatch'
    )
  })
  it('stages only complete metadata with immutable versioned URLs and preserves source bytes', () => {
    const args = fixture()
    const before = Object.fromEntries(
      Object.entries(args.feedPaths).map(([name, file]) => [name, fs.readFileSync(file, 'utf8')])
    )
    const result = prepareReleaseUpdateFeed(args)
    expect(fs.readdirSync(args.outputDir).sort()).toEqual(Object.keys(args.feedPaths).sort())
    expect(result.feedNames).toEqual(Object.keys(args.feedPaths).sort())
    for (const [name, file] of Object.entries(args.feedPaths)) {
      expect(fs.readFileSync(file, 'utf8')).toBe(before[name])
      const source = yaml.load(before[name])
      const prepared = yaml.load(fs.readFileSync(path.join(args.outputDir, name), 'utf8'))
      expect(prepared.files).toEqual(
        source.files.map((entry: any) => ({
          ...entry,
          url: `https://github.com/boggspa/TaskWraith/releases/download/v0.1.0/${entry.url}`
        }))
      )
      expect(prepared.path).toBe(
        `https://github.com/boggspa/TaskWraith/releases/download/v0.1.0/${source.path}`
      )
      expect(prepared.sha512).toBe(source.sha512)
    }
    expect(() => prepareReleaseUpdateFeed(args)).toThrow('new and separate')
  })

  it.each([
    [
      'version',
      (feed: any) => {
        feed.version = '0.0.9'
      }
    ],
    [
      'hash',
      (feed: any) => {
        feed.files[0].sha512 = 'stale'
      }
    ],
    [
      'size',
      (feed: any) => {
        feed.files[0].size += 1
      }
    ],
    [
      'path',
      (feed: any) => {
        feed.path = '../installer.zip'
      }
    ],
    [
      'legacy hash',
      (feed: any) => {
        feed.sha512 = 'stale'
      }
    ],
    [
      'absolute URL',
      (feed: any) => {
        feed.files[0].url = 'https://evil.test/installer.zip'
      }
    ],
    [
      'wrong tag',
      (feed: any) => {
        feed.files[0].url =
          'https://github.com/boggspa/TaskWraith/releases/download/v0.0.9/TaskWraith-0.1.0-universal-mac.zip'
      }
    ],
    [
      'traversal',
      (feed: any) => {
        feed.files[0].url = '../TaskWraith-0.1.0-universal-mac.zip'
      }
    ],
    [
      'wrong architecture',
      (feed: any) => {
        feed.files[0].url = 'TaskWraith-0.1.0-arm64-mac.zip'
      }
    ],
    [
      'duplicate',
      (feed: any) => {
        feed.files[1] = feed.files[0]
      }
    ],
    [
      'unsupported packages',
      (feed: any) => {
        feed.packages = { x64: { path: 'payload' } }
      }
    ],
    [
      'missing files',
      (feed: any) => {
        feed.files = []
      }
    ]
  ])('rejects %s before creating output', (_label, mutate) => {
    const args = fixture()
    mutateFeed(args.feedPaths['release-mac.yml'], mutate)
    expect(() => prepareReleaseUpdateFeed(args)).toThrow()
    expect(fs.existsSync(args.outputDir)).toBe(false)
  })

  it.each(['release-linux-arm64.yml', 'latest-mac.yml', 'beta.yml'])(
    'rejects unsupported manifest %s',
    (name) => {
      const args = fixture()
      fs.writeFileSync(path.join(args.inputDirs[0], name), 'version: 0.1.0')
      expect(() => prepareReleaseUpdateFeed(args)).toThrow('Unexpected or duplicate')
    }
  )

  it('rejects missing manifests, missing blockmaps, and duplicate platform inputs', () => {
    const args = fixture()
    expect(() => prepareReleaseUpdateFeed({ ...args, inputDirs: [args.inputDirs[0]] })).toThrow(
      'Missing release feeds'
    )
    expect(() =>
      prepareReleaseUpdateFeed({ ...args, inputDirs: [...args.inputDirs, args.inputDirs[0]] })
    ).toThrow('duplicate')
    fs.rmSync(path.join(args.inputDirs[1], 'TaskWraith-0.1.0-win-arm64-setup.exe.blockmap'))
    expect(() => prepareReleaseUpdateFeed(args)).toThrow()
    expect(fs.existsSync(args.outputDir)).toBe(false)
  })

  it('rejects artifact symlinks and output within source directories', () => {
    const args = fixture()
    expect(() =>
      prepareReleaseUpdateFeed({ ...args, outputDir: path.join(args.inputDirs[0], 'feeds') })
    ).toThrow('new and separate')
    const artifact = path.join(args.inputDirs[0], 'TaskWraith-0.1.0-universal-mac.zip')
    fs.renameSync(artifact, `${artifact}.real`)
    fs.symlinkSync(`${artifact}.real`, artifact)
    expect(() => prepareReleaseUpdateFeed(args)).toThrow('regular file')
  })

  it.each(['0.1.1', '1.0.0', '2.0.0'])('prepares future stable Release version %s', (version) => {
    const args = fixture(version)
    const result = prepareReleaseUpdateFeed(args)
    expect(result.version).toBe(version)
    for (const name of result.feedNames) {
      const feed = yaml.load(fs.readFileSync(path.join(args.outputDir, name), 'utf8'))
      expect(feed.version).toBe(version)
      expect(feed.path).toContain(`/v${version}/TaskWraith-${version}`)
    }
  })

  it('rejects noncanonical, prerelease, and build-metadata versions', () => {
    for (const version of [
      '01.0.0',
      '1.00.0',
      '1.0.00',
      '0.1.0-beta.1',
      'v0.1.0',
      '../0.1.0',
      '1.0.0+build'
    ])
      expect(() => releaseInventory(version)).toThrow()
  })

  it('accepts and preserves dates serialized by the installed electron-builder helper', () => {
    const args = fixture()
    const { serializeToYaml } = require('builder-util')
    const releaseDate = new Date().toISOString()
    for (const file of Object.values(args.feedPaths)) {
      const feed = yaml.load(fs.readFileSync(file, 'utf8'))
      feed.releaseDate = releaseDate
      fs.writeFileSync(file, serializeToYaml(feed, false, true))
    }
    const result = prepareReleaseUpdateFeed(args)
    for (const name of result.feedNames) {
      const feed = yaml.load(fs.readFileSync(path.join(args.outputDir, name), 'utf8'))
      expect(feed.releaseDate).toBe(releaseDate)
    }
  })

  it('rejects output through a symlink into input and creates nested separate output', () => {
    const args = fixture()
    const alias = path.join(path.dirname(args.outputDir), 'input-alias')
    fs.symlinkSync(args.inputDirs[0], alias, 'dir')
    expect(() =>
      prepareReleaseUpdateFeed({ ...args, outputDir: path.join(alias, 'prepared') })
    ).toThrow('new and separate')
    const outputDir = path.join(path.dirname(args.outputDir), 'nested', 'staged', 'release')
    const result = prepareReleaseUpdateFeed({ ...args, outputDir })
    expect(fs.readdirSync(result.outputDir).sort()).toEqual(result.feedNames)
  })

  it('requires explicit CLI version, output, and platform directories', () => {
    expect(
      parseCliArgs(['--version', '0.1.0', '--output', 'prepared', 'mac', 'win', 'linux'])
    ).toEqual({ version: '0.1.0', outputDir: 'prepared', inputDirs: ['mac', 'win', 'linux'] })
    expect(() => parseCliArgs(['--output'])).toThrow('Missing value')
    expect(() => parseCliArgs(['--publish'])).toThrow('Unknown option')
    expect(() => prepareReleaseUpdateFeed({ inputDirs: [] })).toThrow()
  })
})
