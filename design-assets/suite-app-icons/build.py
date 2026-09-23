#!/usr/bin/env python3
"""Build the approved TaskWraith Studio icon from first-party SVG sources."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET


HERE = Path(__file__).resolve().parent
DESIGN = HERE.parent
SVG = 'http://www.w3.org/2000/svg'
ET.register_namespace('', SVG)
SOURCE_COMMIT = '63603c538d66c862f64440126a8452b98242471c'
GHOST = DESIGN / 'ghost/ghost-guy-mark-monoline-white.svg'
GLYPH = DESIGN / 'agent-pool-icons/icons/glyph-timeline.svg'
PRODUCT = ('studio', 'TaskWraith Studio', 'glyph-timeline', '#C6ADFF', '#352B4D')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ghost_markup():
    group = ET.parse(GHOST).getroot().find(f'{{{SVG}}}g')
    return ''.join(ET.tostring(node, encoding='unicode') for node in group)


def glyph_markup(slug, accent):
    root = ET.parse(DESIGN / f'agent-pool-icons/icons/{slug}.svg').getroot()
    result = []
    for node in root:
        tag = node.tag.rsplit('}', 1)[-1]
        style = node.attrib.pop('class', '')
        if tag in ('title', 'desc', 'style') or style == 'soft':
            continue
        if style == 'dot':
            node.set('fill', accent)
        else:
            node.set('fill', 'none')
            node.set('stroke', accent)
            node.set('stroke-width', '29' if style in ('line', 'accent') else '24')
            node.set('stroke-linecap', 'round')
            node.set('stroke-linejoin', 'round')
        result.append(ET.tostring(node, encoding='unicode'))
    return ''.join(result)


def artwork(name, slug, accent, tone):
    background = f'''
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0.85" y2="1">
      <stop stop-color="#30333B"/>
      <stop offset="0.54" stop-color="#20232A"/>
      <stop offset="1" stop-color="#14171E"/>
    </linearGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="0.8" y2="1">
      <stop stop-color="#89919F" stop-opacity="0.7"/>
      <stop offset="0.42" stop-color="#667081" stop-opacity="0.15"/>
      <stop offset="1" stop-color="#798396" stop-opacity="0.38"/>
    </linearGradient>
    <radialGradient id="wash" cx="0.35" cy="0.1" r="0.95">
      <stop stop-color="{accent}" stop-opacity="0.09"/>
      <stop offset="1" stop-color="{accent}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="badge" x1="0" y1="0" x2="0.8" y2="1">
      <stop stop-color="{tone}"/>
      <stop offset="1" stop-color="#20232B"/>
    </linearGradient>
  </defs>
  <rect x="88" y="94" width="848" height="848" rx="198" fill="#000000" opacity="0.2"/>
  <rect x="88" y="88" width="848" height="848" rx="198" fill="url(#tile)"/>
  <rect x="88" y="88" width="848" height="848" rx="198" fill="url(#wash)"/>
  <rect x="90" y="90" width="844" height="844" rx="196" fill="none" stroke="url(#edge)" stroke-width="3"/>
'''
    mask = '''
  <defs>
    <mask id="symbol-clearance" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
      <rect width="1024" height="1024" fill="#FFFFFF"/>
      <circle cx="726" cy="716" r="169" fill="#000000"/>
    </mask>
  </defs>'''
    badge = '''
  <circle cx="726" cy="716" r="158" fill="url(#badge)"/>
  <circle cx="726" cy="716" r="156.5" fill="none" stroke="{accent}" stroke-opacity="0.28" stroke-width="2"/>
'''.format(accent=accent)
    # The unmodified ghost paths stay in their original 128-unit coordinate space.
    # The catalogue icon keeps its original 600-unit geometry, optically balanced
    # inside the common product badge; only line weights and colours are unified.
    svg = f'''<svg xmlns="{SVG}" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc">
  <title id="title">{name}</title>
  <desc id="desc">TaskWraith monoline ghost with the {slug.replace('-', ' ')} catalogue glyph.</desc>
{background}{mask}
  <g mask="url(#symbol-clearance)">
    <g transform="translate(-18 -8) scale(7.45)" fill="none" stroke="#EDF3FA" stroke-width="3.25" stroke-linecap="round" stroke-linejoin="round">
      {ghost_markup()}
    </g>
  </g>
{badge}
  <g transform="translate(551 541) scale(0.5833333333)">
    {glyph_markup(slug, accent)}
  </g>
</svg>
'''
    return '\n'.join(line.rstrip() for line in svg.splitlines()) + '\n'


def render(source, target, size):
    subprocess.run([
        'rsvg-convert', '-w', str(size), '-h', str(size),
        '-o', str(target), str(source),
    ], check=True)


def build():
    key, name, slug, accent, tone = PRODUCT
    directory = HERE / key
    directory.mkdir(exist_ok=True)
    source = directory / 'app-icon.svg'
    source.write_text(artwork(name, slug, accent, tone))
    render(source, directory / 'app-icon.png', 1024)
    with tempfile.TemporaryDirectory(prefix='taskwraith-studio-') as tmp:
        iconset = Path(tmp) / 'AppIcon.iconset'
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                suffix = '@2x' if scale == 2 else ''
                render(source, iconset / f'icon_{size}x{size}{suffix}.png', size * scale)
        subprocess.run([
            'iconutil', '-c', 'icns', str(iconset),
            '-o', str(directory / 'app-icon.icns'),
        ], check=True)
    manifest = {
        'family': 'TaskWraith companions',
        'scope': 'studio-only',
        'sourceCommit': SOURCE_COMMIT,
        'ghost': {
            'path': str(GHOST.relative_to(DESIGN)),
            'sha256': digest(GHOST),
        },
        'products': [{
            'id': key,
            'name': name,
            'accent': accent,
            'catalogueGlyph': str(GLYPH.relative_to(DESIGN)),
            'catalogueGlyphSha256': digest(GLYPH),
            'outputs': {
                output: digest(directory / output)
                for output in ('app-icon.icns', 'app-icon.png', 'app-icon.svg')
            },
        }],
    }
    (HERE / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')


if __name__ == '__main__':
    if not shutil.which('rsvg-convert') or not shutil.which('iconutil'):
        raise SystemExit('Requires librsvg (rsvg-convert) and the macOS iconutil tool.')
    build()
