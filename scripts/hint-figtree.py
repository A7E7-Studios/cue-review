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


def instance(subset: str, weight: int) -> bytes:
    font = instancer.instantiateVariableFont(TTFont(SOURCE / f'figtree-{subset}-wght-normal.woff2'), {'wght': weight})
    font.flavor = None
    plain = io.BytesIO()
    font.save(plain)
    return plain.getvalue()


def build(subset: str, weight: int) -> pathlib.Path:
    # Hint stems and the x-height for the sizes the app sets text at (11-19 px); Windows' ClearType
    # then snaps them to whole pixels. The latin-ext subset lacks the standard letters ttfautohint
    # measures, so it is hinted in symbol mode with the stem widths and blue zones of the latin face
    # of the same weight, which keeps accented letters aligned with the plain ones.
    reference = {} if subset == 'latin' else {'reference_buffer': instance('latin', weight), 'symbol': True}
    hinted = TTFont(io.BytesIO(ttfautohint.ttfautohint(in_buffer=instance(subset, weight), hinting_range_max=50, windows_compatibility=True, **reference)), recalcTimestamp=False)
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
