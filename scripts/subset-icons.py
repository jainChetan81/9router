#!/usr/bin/env python3
"""Subsets the Material Symbols Outlined variable font to a list of icon names.

Called by scripts/subset-icons.mjs; needs fonttools and brotli:
    uv run --with fonttools --with brotli python scripts/subset-icons.py NAMES.json IN.woff2 OUT.woff2

Icons are drawn as ligatures: the text "home" becomes the home glyph. The subset keeps the glyphs of the
named icons, the letters that spell them and the ligature rules between the two. The layout closure is
off on purpose: with every letter present it would pull every icon back in. The GRAD axis is pinned to
its default (the app never sets it); FILL, wght and opsz stay, so icons render as before.
Prints a JSON object: the names kept, and the names the font does not have.
"""
import json
import string
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer


def ligatures(font):
    """Icon name -> glyph name, read from the font's ligature substitutions."""
    char_of = {glyph: chr(code) for code, glyph in font.getBestCmap().items()}
    out = {}
    for lookup in font["GSUB"].table.LookupList.Lookup:
        for table in lookup.SubTable:
            table = getattr(table, "ExtSubTable", table)
            if not hasattr(table, "ligatures"):
                continue
            for first, items in table.ligatures.items():
                for item in items:
                    try:
                        name = char_of[first] + "".join(char_of[c] for c in item.Component)
                    except KeyError:
                        continue
                    out.setdefault(name, item.LigGlyph)
    return out


def main(names_file, source, target):
    names = json.load(open(names_file))
    font = TTFont(source)
    by_name = ligatures(font)
    kept = sorted(n for n in names if n in by_name)
    missing = sorted(n for n in names if n not in by_name)
    letters = string.ascii_lowercase + string.digits + "_"
    cmap = font.getBestCmap()
    icon_glyphs = [by_name[n] for n in kept]
    code_of = {glyph: code for code, glyph in cmap.items()}
    unicodes = [ord(c) for c in letters] + [code_of[g] for g in icon_glyphs if g in code_of]

    options = subset.Options()
    options.layout_closure = False
    options.layout_features = ["*"]
    options.flavor = "woff2"
    options.notdef_outline = True
    options.name_IDs = [1, 2, 3, 4, 6]
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=unicodes, glyphs=icon_glyphs)
    subsetter.subset(font)
    # Pin the axis after subsetting: the subsetter expects every glyph to still have variation data.
    font = instancer.instantiateVariableFont(font, {"GRAD": None})
    font.flavor = "woff2"
    font.save(target)

    # Read the result back: every kept name must still be a ligature of the subset.
    check = ligatures(TTFont(target))
    lost = [n for n in kept if n not in check]
    if lost:
        sys.exit("subset lost icons: " + ", ".join(lost))
    print(json.dumps({"kept": kept, "missing": missing}))


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
