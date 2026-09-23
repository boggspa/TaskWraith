#!/usr/bin/env python3
"""Build the TaskWraith companion icon family from the existing SVG catalogue."""

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
GHOST = DESIGN / 'ghost/ghost-guy-mark-monoline-white.svg'
PRODUCTS = [
    ('observatory', 'TaskWraith Observatory', 'turbo-telescope', '#6EDBE7', '#173B49'),
    ('provider-hub', 'Provider Hub', 'glyph-fanout-routes', '#FFB276', '#493323'),
    ('studio', 'TaskWraith Studio', 'glyph-timeline', '#C6ADFF', '#352B4D'),
]


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


def artwork(name, slug, accent, tone, *, tile=True, ink=None):
    ghost_ink = ink or '#EDF3FA'
    glyph_ink = ink or accent
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
''' if tile else ''
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
'''.format(accent=accent) if tile else ''
    # The unmodified ghost paths stay in their original 128-unit coordinate space.
    # The catalogue icon keeps its original 600-unit geometry, optically balanced
    # inside the common product badge; only line weights and colours are unified.
    svg = f'''<svg xmlns="{SVG}" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-labelledby="title desc">
  <title id="title">{name}</title>
  <desc id="desc">TaskWraith monoline ghost with the {slug.replace('-', ' ')} catalogue glyph.</desc>
{background}{mask}
  <g mask="url(#symbol-clearance)">
    <g transform="translate(-18 -8) scale(7.45)" fill="none" stroke="{ghost_ink}" stroke-width="3.25" stroke-linecap="round" stroke-linejoin="round">
      {ghost_markup()}
    </g>
  </g>
{badge}
  <g transform="translate(551 541) scale(0.5833333333)">
    {glyph_markup(slug, glyph_ink)}
  </g>
</svg>
'''
    return '\n'.join(line.rstrip() for line in svg.splitlines()) + '\n'


def render(source, target, size):
    subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size),
                    '-o', str(target), str(source)], check=True)


def build():
    manifest = {'family': 'TaskWraith companions', 'ghost': {
        'path': str(GHOST.relative_to(DESIGN)), 'sha256': digest(GHOST)}, 'products': []}
    for key, name, slug, accent, tone in PRODUCTS:
        directory = HERE / key
        directory.mkdir(exist_ok=True)
        source = directory / 'app-icon.svg'
        source.write_text(artwork(name, slug, accent, tone))
        (directory / 'mark.svg').write_text(artwork(name, slug, accent, tone, tile=False))
        (directory / 'mark-on-light.svg').write_text(
            artwork(name, slug, accent, tone, tile=False, ink='#202A38'))
        render(source, directory / 'app-icon.png', 1024)
        with tempfile.TemporaryDirectory(prefix=f'taskwraith-{key}-') as tmp:
            iconset = Path(tmp) / 'AppIcon.iconset'
            iconset.mkdir()
            for size in (16, 32, 128, 256, 512):
                for scale in (1, 2):
                    suffix = '@2x' if scale == 2 else ''
                    render(source, iconset / f'icon_{size}x{size}{suffix}.png', size * scale)
            subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o',
                            str(directory / 'app-icon.icns')], check=True)
        glyph = DESIGN / f'agent-pool-icons/icons/{slug}.svg'
        manifest['products'].append({
            'id': key, 'name': name, 'accent': accent,
            'catalogueGlyph': str(glyph.relative_to(DESIGN)),
            'catalogueGlyphSha256': digest(glyph),
            'outputs': {name: digest(directory / name) for name in (
                'app-icon.icns', 'app-icon.png', 'app-icon.svg', 'mark-on-light.svg', 'mark.svg')},
        })
    (HERE / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    board()


def board():
    parts = [f'<svg xmlns="{SVG}" width="1560" height="1020" viewBox="0 0 1560 1020">',
             '<rect width="1560" height="1020" fill="#0D1016"/>',
             '<text x="68" y="76" fill="#A9B6C6" font-family="Helvetica, sans-serif" font-size="17" letter-spacing="4">TASKWRAITH / COMPANION ICONS</text>',
             '<text x="68" y="129" fill="#EDF3FA" font-family="Helvetica, sans-serif" font-size="35" font-weight="600">One ghost. Three disciplines.</text>']
    for i, (key, name, slug, accent, tone) in enumerate(PRODUCTS):
        x = 62 + i * 510
        parts.append(f'<image href="{key}/app-icon.svg" x="{x}" y="174" width="420" height="420"/>')
        parts.append(f'<text x="{x+38}" y="623" fill="#F1F5FA" font-family="Helvetica, sans-serif" font-size="24" font-weight="600">{name}</text>')
        label = {'observatory': 'TELESCOPE / OBSERVE', 'provider-hub': 'FANOUT / CONNECT', 'studio': 'TIMELINE / CREATE'}[key]
        parts.append(f'<text x="{x+38}" y="655" fill="{accent}" font-family="Helvetica, sans-serif" font-size="12" letter-spacing="2">{label}</text>')
        parts.append(f'<rect x="{x+24}" y="700" width="388" height="112" rx="18" fill="#ECEFF4"/>')
        parts.append(f'<text x="{x+42}" y="724" fill="#546176" font-family="Helvetica, sans-serif" font-size="10" letter-spacing="1.5">DOCK SIZES</text>')
        for offset, size in ((44, 64), (140, 48), (230, 32), (310, 16)):
            y = 746 + (64-size)/2
            parts.append(f'<image href="{key}/app-icon.svg" x="{x+offset}" y="{y}" width="{size}" height="{size}"/>')
        parts.append(f'<image href="{key}/mark.svg" x="{x+30}" y="848" width="108" height="108"/>')
        parts.append(f'<text x="{x+155}" y="897" fill="#B6C1CF" font-family="Helvetica, sans-serif" font-size="14">Standalone vector mark</text>')
        parts.append(f'<text x="{x+155}" y="920" fill="#738198" font-family="Helvetica, sans-serif" font-size="12">SVG · PNG · macOS ICNS</text>')
    parts.append('</svg>')
    source = HERE / 'preview.svg'
    source.write_text('\n'.join(parts))
    subprocess.run(['rsvg-convert', '-o', str(HERE / 'preview.png'), str(source)], check=True)


if __name__ == '__main__':
    if not shutil.which('rsvg-convert') or not shutil.which('iconutil'):
        raise SystemExit('Requires librsvg (rsvg-convert) and the macOS iconutil tool.')
    build()
