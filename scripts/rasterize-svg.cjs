#!/usr/bin/env node
// Rasterize a monoline design-asset SVG to transparent PNGs, one per size per
// tone, and PROVE each output is real before writing it.
//
// Why this exists: an earlier pass exported this set with `qlmanage -t`, which
// flattens SVGs onto an opaque WHITE background. Every white render came out a
// blank white square and every black one came out opaque. Nothing complained —
// the files had the right dimensions, `sips -g hasAlpha` said "yes" (a fully
// opaque alpha channel is still an alpha channel), and a blank white PNG is
// indistinguishable from a good one in any preview with a white backdrop. The
// set shipped broken.
//
// So this script does two things the ad-hoc one-liner didn't:
//   1. Uses `sips -s format png`, which honours SVG transparency (verified:
//      alpha spans 0…255 with a genuinely empty background). `qlmanage` does
//      not, and is not a substitute however convenient its -s flag looks.
//   2. Decodes every PNG it just wrote and asserts the pixels are plausible.
//      A blank export fails the build instead of landing in git.
//
// Usage:
//   node scripts/rasterize-svg.cjs <input.svg> --out <dir> --name <base> \
//     [--sizes 32,64,128,256,512,1024] [--tones white,black]
//
// Writes <dir>/<base>-<tone>-<size>.png.

const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const { spawnSync } = require('child_process')

// ── PNG introspection ──────────────────────────────────────────────────────
// Enough of a decoder to answer "is this image actually what we asked for".
// Only handles 8-bit RGBA/RGB (what sips emits); anything else is a hard fail
// rather than a silent pass, since an unrecognized format is exactly the
// blind spot that let the broken set through.
const decodePng = (file) => {
  const buf = fs.readFileSync(file)
  if (buf.subarray(0, 8).toString('binary') !== '\x89PNG\r\n\x1a\n') {
    throw new Error(`${file}: not a PNG`)
  }
  let i = 8
  let width, height, depth, colorType
  const idat = []
  while (i < buf.length) {
    const len = buf.readUInt32BE(i)
    const type = buf.subarray(i + 4, i + 8).toString('ascii')
    const data = buf.subarray(i + 8, i + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    }
    i += 12 + len
  }
  if (depth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(
      `${file}: unsupported PNG (depth ${depth}, colorType ${colorType}) — ` +
        `cannot verify it, so refusing to trust it`
    )
  }
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const rows = []
  let prev = Buffer.alloc(stride)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    const line = Buffer.from(raw.subarray(pos, pos + stride))
    pos += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      if (filter === 1) line[x] = (line[x] + a) & 255
      else if (filter === 2) line[x] = (line[x] + b) & 255
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    rows.push(line)
    prev = line
  }
  return { width, height, colorType, channels, stride, rows }
}

/**
 * A correct monoline export has: an alpha channel, a genuinely empty
 * background (some pixel at alpha 0), real ink (some pixel at full alpha),
 * and an ink coverage in a sane band. The broken qlmanage output failed the
 * very first of these — every pixel sat at alpha 255.
 */
const verify = (file, { minCoverage = 0.005, maxCoverage = 0.6 } = {}) => {
  const img = decodePng(file)
  if (img.colorType !== 6) {
    throw new Error(`${file}: no alpha channel — background is baked in`)
  }
  let clear = 0
  let opaque = 0
  let ink = 0
  const total = img.width * img.height
  for (const line of img.rows) {
    for (let x = 0; x < img.stride; x += 4) {
      const a = line[x + 3]
      if (a === 0) clear++
      else {
        ink++
        if (a === 255) opaque++
      }
    }
  }
  const coverage = ink / total
  if (clear === 0) {
    throw new Error(
      `${file}: every pixel is opaque — the renderer flattened onto a ` +
        `background instead of preserving transparency`
    )
  }
  if (opaque === 0) {
    throw new Error(`${file}: no fully-opaque pixel — the mark did not draw`)
  }
  if (coverage < minCoverage || coverage > maxCoverage) {
    throw new Error(
      `${file}: ink coverage ${(coverage * 100).toFixed(2)}% is outside the ` +
        `expected ${(minCoverage * 100).toFixed(1)}–${(maxCoverage * 100).toFixed(0)}% ` +
        `band — the render is blank, clipped, or filled`
    )
  }
  return { coverage, clear, opaque }
}

// ── Rendering ──────────────────────────────────────────────────────────────
const renderPng = (svgPath, pngPath, size) => {
  // `sips -s format png` honours SVG alpha; `qlmanage -t` does not. Do not
  // "simplify" this back to qlmanage — see the header.
  const res = spawnSync(
    'sips',
    ['-s', 'format', 'png', '-z', String(size), String(size), svgPath, '--out', pngPath],
    { encoding: 'utf8' }
  )
  if (res.status !== 0) {
    throw new Error(res.stderr || res.stdout || `sips failed for ${pngPath}`)
  }
}

const parseArgs = (argv) => {
  const [input] = argv
  const flag = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? fallback : argv[i + 1]
  }
  if (!input || input.startsWith('--')) {
    throw new Error(
      'usage: node scripts/rasterize-svg.cjs <input.svg> --out <dir> --name <base> ' +
        '[--sizes 32,64,...] [--tones white,black]'
    )
  }
  return {
    input,
    out: flag('out', path.dirname(input)),
    name: flag('name', path.basename(input, '.svg')),
    sizes: flag('sizes', '32,64,128,256,512,1024').split(',').map(Number),
    tones: flag('tones', 'white,black').split(','),
  }
}

const main = () => {
  const opts = parseArgs(process.argv.slice(2))
  const svg = fs.readFileSync(opts.input, 'utf8')
  fs.mkdirSync(opts.out, { recursive: true })
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-raster-'))

  const written = []
  try {
    for (const tone of opts.tones) {
      // The asset is authored against currentColor so it can inherit the app
      // theme; a raster has to commit to a literal.
      const toned = svg.replace(/(stroke|fill)="currentColor"/g, `$1="${tone}"`)
      if (toned === svg && /currentColor/.test(svg)) {
        throw new Error(`${opts.input}: currentColor present but not substituted`)
      }
      const tonedPath = path.join(tmpDir, `${opts.name}-${tone}.svg`)
      fs.writeFileSync(tonedPath, toned)

      for (const size of opts.sizes) {
        const outPath = path.join(opts.out, `${opts.name}-${tone}-${size}.png`)
        renderPng(tonedPath, outPath, size)
        const { coverage } = verify(outPath)
        written.push({ outPath, size, tone, coverage })
      }
    }

    // Cross-check: two tones of the same mark must differ byte-wise. Identical
    // output across tones is the signature of a renderer ignoring its input —
    // which is precisely how the broken set looked.
    for (const size of opts.sizes) {
      const perTone = opts.tones.map((t) =>
        fs.readFileSync(path.join(opts.out, `${opts.name}-${t}-${size}.png`))
      )
      for (let a = 0; a < perTone.length; a++) {
        for (let b = a + 1; b < perTone.length; b++) {
          if (perTone[a].equals(perTone[b])) {
            throw new Error(
              `${opts.name} @${size}: ${opts.tones[a]} and ${opts.tones[b]} rendered ` +
                `byte-identically — the renderer is ignoring the SVG`
            )
          }
        }
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  for (const { outPath, coverage } of written) {
    console.log(`${path.relative(process.cwd(), outPath)}  ink ${(coverage * 100).toFixed(1)}%`)
  }
  console.log(`\n${written.length} PNG(s) written and verified.`)
}

if (require.main === module) main()

// Exported so the verification can be exercised directly — including against a
// known-bad render — rather than only ever running on output we hope is good.
module.exports = { decodePng, verify }
