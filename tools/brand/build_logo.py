#!/usr/bin/env python3
"""Register identity: authored Bezier emblem + optically spaced outlined type.
Run from the repository root: python tools/brand/build_logo.py.
Requires FontTools, CairoSVG and Pillow with Raqm support.
The font is an unmodified OFL source from
https://github.com/google/fonts/tree/main/ofl/cormorant.
The Pi affiliation mark uses official https://pi.dev/logo-auto.svg geometry,
kept in pi-logo.svg and rendered in one colour.
All exported SVG lettering is paths: viewing needs no installed font.
"""
from pathlib import Path
from io import BytesIO
from html import escape
import argparse
import re
import xml.etree.ElementTree as ET
import cairosvg
from PIL import ImageFont
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[1]/'assets'/'brand'
INK = '#292820'
RED = '#A24732'
PAPER = '#F5F1E8'


def wordmark(family='Cormorant', weight=620, size=220, tracking=0, custom_r=False):
    font = TTFont(HERE/'fonts'/f'{family}-Italic.ttf')
    axes = {'wght': weight}
    if family == 'Newsreader':
        axes['opsz'] = 72
    font = instantiateVariableFont(font, axes, inplace=False)
    data = BytesIO()
    font.save(data)
    data.seek(0)
    upem = font['head'].unitsPerEm
    pil = ImageFont.truetype(data, upem)
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    text = 'Register'
    paths = []
    for i, ch in enumerate(text):
        # Raqm's pair positioning, without ligatures, then optical tracking.
        x = pil.getlength(text[:i+1], features=['-liga']) - pil.getlength(ch, features=['-liga']) + i*tracking
        pen = SVGPathPen(glyphs, ntos=lambda n: f'{n:.3f}'.rstrip('0').rstrip('.') if n else '0')
        glyphs[cmap[ord(ch)]].draw(pen)
        outline = pen.getCommands()
        if custom_r and ch == 'R':
            # Replace only the separate leg contour, preserving the font's stem
            # and bowl. The new finish echoes the emblem's continuing line.
            contours = re.findall(r'M[^M]+', outline)
            assert len(contours) == 3, 'The source R must have three contours'
            contours[1] = ('M305.58 333 L376.78 357.58 '
                           'C414 236 450 115 505 55 '
                           'C549 9 608 -10 660 6 L663 -2 '
                           'C611 -33 550 -40 502 -18 '
                           'C433 14 373 132 305.58 333 Z')
            outline = ''.join(contours)
        paths.append(f'<path transform="translate({x:.3f},0)" d="{outline}"/>')
    width = (pil.getlength(text, features=['-liga']) + (len(text)-1)*tracking)*size/upem
    return f'<g transform="scale({size/upem:.8f},{-size/upem:.8f})">'+''.join(paths)+'</g>', width


def emblem(ink=INK, accent=RED, small=False):
    # The quiet back leaf is not a pile of archives: one preceding state.
    rear = '<path d="M 36,266 C 28,265 20,267 13,271 L 43,88 C 47,62 58,47 82,43 C 131,34 176,49 226,25 L 222,52" fill="none" stroke="'+ink+'" stroke-width="4.5" stroke-linejoin="round"/>'
    # The current leaf is drawn as a filled contour, not an equal-width stroke.
    front = '<path d="M 232,55 C 186,73 133,47 89,68 C 67,78 61,97 57,125 L 31,301 C 75,287 126,312 171,296 C 195,288 207,268 212,245 L 204,246 C 198,268 189,281 168,288 C 125,303 77,281 41,288 L 66,126 C 70,101 75,85 94,76 C 135,57 186,82 232,62 Z" fill="'+ink+'"/>'
    right = '<path d="M 232,57 L 241,56 L 218,211 L 210,211 Z" fill="'+ink+'"/>'
    # Two composed lines; the third crosses the open boundary and carries on.
    lines = '<path d="M 94,134 C 124,125 158,137 190,124 C 186,134 167,137 149,136 C 125,134 106,133 94,138 Z M 86,181 C 113,172 142,181 174,171 C 168,182 144,183 124,181 C 108,180 94,181 86,185 Z M 78,235 C 117,222 157,239 199,233 C 230,230 249,226 274,213 C 258,231 235,239 202,241 C 155,245 118,230 78,240 Z" fill="'+ink+'"/>'
    # A current-page index, with a cut tail, not a floating notification badge.
    tab = '<path d="M 231,57 C 239,55 247,54 253,54 C 258,54 260,57 259,62 L 251,106 L 240,100 L 227,107 Z" fill="'+accent+'"/>'
    if small:
        rear = rear.replace('stroke-width="4.5"', 'stroke-width="8"')
        # Optical variant for 24–48 px: thicken the ink, not the surrounding box.
        front = front.replace('/>', f' stroke="{ink}" stroke-width="3" stroke-linejoin="round"/>')
        right = right.replace('/>', f' stroke="{ink}" stroke-width="3"/>')
        lines = lines.replace('/>', f' stroke="{ink}" stroke-width="2.5" stroke-linejoin="round"/>')
    return '<g id="register-emblem">'+rear+front+right+lines+tab+'</g>'


def svg(body, width, height, background=None, title='Register', description='A living record. Thought turns a page; the line continues.'):
    bg = f'<rect width="{width}" height="{height}" fill="{background}"/>' if background else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc"><title id="title">{escape(title)}</title><desc id="desc">{escape(description)}</desc>{bg}{body}</svg>'


def save(name, content, png_width=None):
    (OUT/f'{name}.svg').write_text(content)
    cairosvg.svg2png(bytestring=content.encode(), write_to=str(OUT/f'{name}.png'), output_width=png_width)


def pi_mark(ink=INK):
    source = ET.parse(HERE/'pi-logo.svg')
    paths = ''.join(f'<path d="{node.attrib["d"]}"/>'
                    for node in source.findall('.//{http://www.w3.org/2000/svg}path'))
    # A small, separate affiliation mark, not part of Register's own emblem.
    return (f'<g id="pi-mark" fill="{ink}" transform="translate(699,140) '
            f'scale({42/469.43:.9f}) translate(-165.29,-165.29)">{paths}</g>')


def lockup(ink=INK, accent=RED):
    letters, width = wordmark('Cormorant',620,238,custom_r=True)
    # Optical position: leaf body shares the letter block's centre, while the
    # released final stroke and the descending g keep their own breathing room.
    return ('<g transform="translate(210,170) scale(.80)">'+emblem(ink,accent)+'</g>'
            +f'<g transform="translate(480,343)" fill="{ink}">{letters}</g>')


def final():
    body = lockup()
    display = pi_mark()+'<g transform="translate(20,75)">'+body+'</g>'
    save('register-pi',svg(display,1440,640,PAPER,title='Register — a pi extension'),2160)
    display_dark = pi_mark(PAPER)+'<g transform="translate(20,75)">'+lockup(PAPER,'#D68366')+'</g>'
    save('register-pi-reversed',svg(display_dark,1440,640,INK,title='Register — a pi extension'),2160)
    save('register-horizontal',svg(body,1440,600),2880)
    save('register-preview',svg(body,1440,600,PAPER),2160)
    save('register-monochrome',svg(lockup(INK,INK),1440,600),1440)
    save('register-reversed',svg(lockup(PAPER,'#D68366'),1440,600,INK),1440)
    icon = '<g transform="translate(45,10) scale(1.48)">'+emblem()+'</g>'
    save('register-icon',svg(icon,512,512),1024)
    save('register-icon-paper',svg(icon,512,512,PAPER),512)
    small_icon = '<g transform="translate(45,10) scale(1.48)">'+emblem(small=True)+'</g>'
    save('register-icon-small',svg(small_icon,512,512),64)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUT, help='Output directory for SVG and PNG assets')
    args = parser.parse_args()
    OUT = args.output.resolve()
    OUT.mkdir(parents=True, exist_ok=True)
    final()
    print(f'Wrote Register brand assets to {OUT}')
