"""Builds the app's hinted Figtree faces from the variable font in @fontsource-variable/figtree.

Figtree ships unhinted, so at 12-14 px on a display at 100% scaling its stems blur. This script
takes each weight the styles use out of the variable font, auto-hints it with ttfautohint and
writes WOFF2 files to src/assets/fonts/, which src/ui/fonts.css declares. Run it after updating
the font package:

    pip install fonttools brotli ttfautohint-py
    python scripts/hint-figtree.py
"""
import io
import pathlib

import ttfautohint
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'node_modules' / '@fontsource-variable' / 'figtree' / 'files'
OUT = ROOT / 'src' / 'assets' / 'fonts'
SUBSETS = ('latin', 'latin-ext')
WEIGHTS = (400, 500, 600, 700)
STYLES = {400: 'Regular', 500: 'Medium', 600: 'SemiBold', 700: 'Bold'}


def instance(subset: str, weight: int) -> bytes:
    font = instancer.instantiateVariableFont(TTFont(SOURCE / f'figtree-{subset}-wght-normal.woff2'), {'wght': weight})
    font.flavor = None
    plain = io.BytesIO()
    font.save(plain)
    return plain.getvalue()


def name_face(font: TTFont, weight: int) -> None:
    """Names the face for its weight; the variable font's names describe its default instance."""
    style = STYLES[weight]
    names = font['name']
    for record in list(names.names):
        if record.nameID in (1, 2, 3, 4, 6, 16, 17):
            names.removeNames(nameID=record.nameID)
    plain = style in ('Regular', 'Bold')
    names.setName('Figtree' if plain else f'Figtree {style}', 1, 3, 1, 0x409)
    names.setName(style if plain else 'Regular', 2, 3, 1, 0x409)
    names.setName(f'Figtree-{style};hinted', 3, 3, 1, 0x409)
    names.setName(f'Figtree {style}', 4, 3, 1, 0x409)
    names.setName(f'Figtree-{style}', 6, 3, 1, 0x409)
    names.setName('Figtree', 16, 3, 1, 0x409)
    names.setName(style, 17, 3, 1, 0x409)
    # The style bits follow the names: Bold is the family's bold, every other weight its regular.
    bold = style == 'Bold'
    selection = font['OS/2'].fsSelection & ~0b1100001  # clear ITALIC, BOLD and REGULAR
    font['OS/2'].fsSelection = selection | (0b100000 if bold else 0b1000000)
    font['head'].macStyle = 1 if bold else 0


def build(subset: str, weight: int) -> pathlib.Path:
    # Hint stems and the x-height for the sizes the app sets text at (11-19 px); Windows' ClearType
    # then snaps them to whole pixels. The latin-ext subset lacks the standard letters ttfautohint
    # measures, so it is hinted in symbol mode with the stem widths and blue zones of the latin face
    # of the same weight, which keeps accented letters aligned with the plain ones.
    reference = {} if subset == 'latin' else {'reference_buffer': instance('latin', weight), 'symbol': True}
    hinted = TTFont(io.BytesIO(ttfautohint.ttfautohint(in_buffer=instance(subset, weight), hinting_range_max=50, windows_compatibility=True, **reference)), recalcTimestamp=False)
    name_face(hinted, weight)
    # A fixed timestamp keeps the build reproducible: the same package gives the same files.
    hinted['head'].modified = hinted['head'].created
    hinted.flavor = 'woff2'
    target = OUT / f'figtree-{subset}-{weight}.woff2'
    hinted.save(target)
    return target


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    for subset in SUBSETS:
        for weight in WEIGHTS:
            path = build(subset, weight)
            print(f'{path.relative_to(ROOT).as_posix()}  {path.stat().st_size} bytes')
