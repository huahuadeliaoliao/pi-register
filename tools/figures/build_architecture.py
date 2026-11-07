#!/usr/bin/env python3
"""Regenerate the single Register architecture figure (no versioned outputs).

Run: python tools/figures/build_architecture.py
Dependencies: fonttools, pillow, cairosvg. Both fonts are bundled under the OFL.
Typography is outlined for portable SVG; edit strings/geometry here.
Cormorant: repository OFL font. All illustration paths are original.

Evidence / display graph:
- model-managed edits -> candidate -> adoption: src/controller.ts write/stage/boundary.
- historical leaves, only front page current: src/store.ts put; src/projection.ts resolveAdoption.
- fixed bounded page: src/text.ts CAPACITY; no fill-level implication.
- ordinary context -> summary, full page bypasses summarizer:
  src/compaction.ts sanitizeCompaction/protectCompaction/checkCompactionBudget.
- right-hand page is SAME adoption in the NEXT context, not another workspace.
Omit host APIs, SQL machinery, restore, concurrency and branch internals.
Target: 180 mm wide, 600 dpi (~4252 px). Minimum labels: 25 viewBox units (~8 pt).
"""
from pathlib import Path
from html import escape
import argparse
from functools import lru_cache
from PIL import Image
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
import cairosvg

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'assets' / 'architecture'
INK, RED, PAPER = '#292820', '#A24732', '#F5F1E8'
MUTED, FAINT, WHITE = '#777367', '#BEB6A5', '#FCFAF5'
W, H = 1600, 920


def path(d, color=INK, width=2.5, fill='none', extra=''):
    return f'<path d="{d}" fill="{fill}" stroke="{color}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round" {extra}/>'


def group(name, box, content, role='node', parent=None, review=False):
    attr = f' data-parent="{parent}"' if parent else ''
    if review:
        attr += ' data-review="true"'
    return f'<g id="{name}" data-role="{role}" data-bbox="{box}"{attr}>{content}</g>'


@lru_cache(None)
def font(serif=False):
    p = ROOT / 'tools/brand/fonts' / ('Cormorant-Italic.ttf' if serif else 'NotoSans-Regular.ttf')
    f = TTFont(p)
    if serif:
        f = instantiateVariableFont(f, {'wght': 560})
    return f


def label(name, text, x, y, size=26, color=INK, serif=False, align='start', parent=None):
    f = font(serif)
    glyphs, cmap, upem = f.getGlyphSet(), f.getBestCmap(), f['head'].unitsPerEm
    # Use glyph advance widths for positioning and exact outline bounds for QA.
    scale, cursor, pieces, bounds = size / upem, 0, [], []
    for char in text:
        glyph = glyphs[cmap[ord(char)]]
        pen, bp = SVGPathPen(glyphs), BoundsPen(glyphs)
        glyph.draw(pen)
        glyph.draw(bp)
        if bp.bounds:
            a,b,c,d = bp.bounds
            bounds.append((cursor+a,b,cursor+c,d))
        pieces.append(f'<path transform="translate({cursor},0)" d="{pen.getCommands()}"/>')
        cursor += glyph.width
    shift = cursor*scale * (0.5 if align == 'middle' else 1 if align == 'end' else 0)
    left = x-shift
    bx = left + min(a for a,b,c,d in bounds)*scale
    by = y - max(d for a,b,c,d in bounds)*scale
    bw = (max(c for a,b,c,d in bounds)-min(a for a,b,c,d in bounds))*scale
    bh = (max(d for a,b,c,d in bounds)-min(b for a,b,c,d in bounds))*scale
    content = f'<title>{escape(text)}</title><g transform="translate({left},{y}) scale({scale},{-scale})" fill="{color}">{"".join(pieces)}</g>'
    return group(name, f'{bx-1:.2f},{by-1:.2f},{bw+2:.2f},{bh+2:.2f}', content, 'label', parent)


def arrow(name, d, route, source, target, color=INK, width=2.5):
    return path(d, color, width, extra=f'id="{name}" data-role="connector" data-source="{source}" data-target="{target}" data-route="{route}" marker-end="url(#{"arrow-red" if color == RED else "arrow-gray" if color == MUTED else "arrow-ink"})"')


def page(x, y, scale=1, active=True, marks=True, color=INK, historical=0):
    # Optical weights compensate for small retained leaves, rather than scaling
    # all strokes to hairlines. History changes locally, not by monotonic filling.
    small = historical > 0
    weight = 4.0 if small else 2.8
    s = path('M 17,17 C 75,-1 166,30 230,5 L 214,246 C 211,275 198,291 168,293 C 103,298 57,275 0,291 L 17,17 Z', color, weight, WHITE)
    if active:
        # The cut-tail bookmark shares the logo's asymmetric, gently curved head.
        s += path('M 207,12 Q 224,6 239,6 Q 243,6 242,12 L 234,63 L 220,55 L 205,63 Z', RED, 0, RED)
    if marks:
        # Closed tapered ink shapes provide calligraphic weight without texture.
        s += path('M 45,61 C 81,51 112,65 151,55 C 146,64 116,64 93,62 C 72,59 57,61 45,65 Z', color, 0, color)
        if not small:
            s += path('M 43,84 C 70,78 107,89 133,80', MUTED, 1.8)
        s += path('M 39,122 l 7,7 12,-15', color, 4 if small else 2.6)
        s += path('M 70,123 C 99,117 120,129 151,120', color, 4 if small else 2.8)
        s += path('M 36,151 h 13 v 13 h -13 Z', color, 3.6 if small else 1.8)
        endpoint = 176 if historical == 1 else 126 if historical == 2 else 148
        s += path(f'M 66,155 C 94,147 117,159 {endpoint},151', color, 4 if small else 2.5)
        relation = ('M 43,201 C 90,193 133,207 181,200' if historical == 1 else
                    'M 43,201 C 79,214 121,180 181,200' if historical == 2 else
                    'M 43,201 C 80,186 101,217 132,199 S 164,190 181,200')
        s += path(relation, color, 3.8 if small else 2.3)
        if not small:
            s += path('M 131,199 C 142,220 156,220 172,216', color, 1.5)
        s += '<circle cx="43" cy="201" r="4" fill="'+color+'"/><circle cx="181" cy="200" r="4" fill="'+color+'"/>'
        s += path('M 34,249 C 93,237 136,266 191,247 C 136,272 93,243 34,253 Z', color, 0, color)
    return f'<g transform="translate({x},{y}) scale({scale})">{s}</g>'


def messages():
    s = ''
    for i in range(4):
        x,y = 516+i*47,204+(i%2)*9
        s += path(f'M{x},{y+4} Q{x+30},{y-2} {x+64},{y+3} L{x+62},{y+63} L{x+47},{y+55} Q{x+23},{y+52} {x-2},{y+56} Z', MUTED, 1.7, WHITE)
        s += path(f'M{x+11},{y+19} q19,-3 39,0 M{x+11},{y+31} q15,-2 29,0', FAINT, 1.8)
    return s


def illustration(wire=False):
    parts = []
    parts.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="180mm" height="103.5mm" viewBox="0 0 {W} {H}"><title>Register — a living workspace</title><desc>Model-managed edits advance one bounded current workspace while revisions remain recoverable. Ordinary conversation is summarized; the complete current workspace is carried unchanged into the next context.</desc>')
    parts.append('<defs>')
    for name,color in [('ink',INK),('red',RED),('gray',MUTED)]:
        parts.append(f'<marker id="arrow-{name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9" fill="none" stroke="{color}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></marker>')
    parts.append(f'</defs><rect width="1600" height="920" fill="{PAPER}"/>')
    if wire:
        for x,y,w,h in [(80,300,320,330),(500,180,280,110),(550,350,270,330),(1100,180,360,540),(250,715,500,110)]:
            parts.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="none" stroke="{INK}"/>')
        parts.append(path('M400,480 H550 M820,500 H1140 M780,240 H1140',INK))
        parts.append('</svg>')
        return ''.join(parts)

    # Open grouping for the next context; no host/interface elements.
    bracket = path('M 1124,184 H 1115 Q 1101,184 1101,198 V 690 Q 1101,704 1115,704 H 1124 M 1436,184 H 1445 Q 1459,184 1459,198 V 690 Q 1459,704 1445,704 H 1436', FAINT, 1.7)
    parts.append(group('next-context', '1098,181,364,526', bracket, 'panel', review=True))
    # Main flow and ordinary-summary lane are visually distinct.
    parts.append(arrow('edit-adoption', 'M 382,476 C 440,476 474,476 546,476', '382,476;546,476', 'editable-leaf','current-page'))
    parts.append(arrow('ordinary-in', 'M 736,242 H 862', '736,242;862,242', 'conversation','compression', MUTED,2))
    parts.append(arrow('ordinary-out', 'M 1005,242 H 1175', '1005,242;1175,242', 'compression','summary', MUTED,2))
    parts.append(arrow('intact-carry', 'M 816,509 C 920,538 1031,538 1148,509', '816,509;875,522;940,530;1000,529;1070,522;1148,509', 'current-page','continued-page',RED,3.6))

    # Retained revisions form a quiet trail below, without a second active bookmark.
    trail = path('M 184,767 C 274,799 390,809 478,738', FAINT, 1.8)
    for step,(x,y,ang) in enumerate([(202,702,-13),(316,728,-5),(428,704,7)],1):
        trail += f'<g transform="rotate({ang},{x+39},{y+51})">'+page(x,y,.34,False,True,MUTED,historical=step)+'</g>'
    parts.append(group('history', '178,685,342,150', trail, review=True))
    # An ancestry continuation, not a data-flow arrow or automatic retrieval.
    parts.append(path('M 507,717 C 526,703 540,694 554,684', FAINT, 1.8, extra='id="revision-thread" data-role="connector" data-source="history" data-target="current-page" data-route="507,717;526,703;540,694;554,684"'))

    # Candidate page: explicit revisions, not automatic extraction from dialogue.
    edit = page(139,368,.84,False,True)
    # The adopted marks already exist on the editing leaf. Only a rejected local
    # line remains crossed out; adoption itself does not transform the contents.
    edit += path('M 194,483 Q 220,477 247,483', MUTED,1.6)
    edit += path('M 190,479 L 250,486', RED,1.8)
    # A longer, narrower nib and hairline barrel highlight echo engraved tooling.
    edit += path('M 213,498 L 242,431 L 284,395 L 306,415 L 266,453 Z',INK,2.3,WHITE)
    edit += path('M 213,498 L 264,439 M 242,431 L 266,453',INK,1.6)
    edit += '<circle cx="264" cy="439" r="3.2" fill="'+INK+'"/>'
    edit += path('M 284,395 L 328,349 Q 337,341 346,350 Q 354,358 346,368 L 306,415 Z',INK,2.3,INK)
    edit += path('M 300,391 L 335,354',WHITE,1.3)
    edit += path('M 284,395 L 306,415 M 290,390 L 312,410',WHITE,1.2)
    parts.append(group('editable-leaf','132,338,242,281',edit,review=True))
    parts.append(group('current-page','548,351,279,348',page(553,359,1.12),review=True))
    parts.append(group('continued-page','1147,351,279,348',page(1152,359,1.12),parent='next-context'))
    parts.append(group('conversation','513,201,218,91',messages()))

    # Compression folds ONLY the ordinary stream.
    fold = path('M 869,204 C 917,204 928,230 996,230 M 869,223 C 917,223 938,230 996,230 M 869,242 H 996 M 869,261 C 917,261 938,254 996,254 M 869,280 C 917,280 928,254 996,254',MUTED,1.8)
    parts.append(group('compression','865,191,135,104',fold))
    summary = path('M 1184,217 C 1240,207 1312,225 1375,214 L 1370,266 C 1310,276 1243,257 1180,269 Z',MUTED,1.6,WHITE)
    summary += path('M 1198,232 C 1252,226 1311,242 1358,232 M 1197,250 C 1245,244 1286,257 1320,250',MUTED,2.2)
    parts.append(group('summary','1177,207,201,67',summary,parent='next-context'))

    parts += [
        label('brand','Register',78,119,85,serif=True),
        label('strap','A living workspace',381,106,35,MUTED,serif=True),
        label('edit-label','Model-managed edits',255,320,27,align='middle'),
        label('adopt-label','Adopt',463,450,25,MUTED,align='middle'),
        label('now-label','Current workspace',688,320,27,align='middle'),
        label('conversation-label','Earlier conversation',621,170,25,MUTED,align='middle'),
        label('compress-label','Summarize',937,170,25,MUTED,align='middle'),
        label('next-label','Next context',1280,155,27,align='middle'),
        label('carry-label','Carry intact',975,485,28,RED,align='middle'),
        label('bound-label','Bounded · 30k tokens',688,735,25,MUTED,align='middle'),
        label('retained-label','History retained',325,861,25,MUTED,align='middle'),
        label('available-label','Always present',1280,735,27,align='middle'),
    ]
    parts.append('</svg>')
    return '\n'.join(parts)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wireframe', type=Path, help='Write only a temporary planning SVG.')
    parser.add_argument('--output', type=Path, default=OUT, help='Output directory for SVG and PNG assets')
    args = parser.parse_args()
    OUT = args.output.resolve()
    if args.wireframe:
        args.wireframe.write_text(illustration(True))
    else:
        OUT.mkdir(parents=True, exist_ok=True)
        svg = OUT / 'register-architecture.svg'
        svg.write_text(illustration())
        png = OUT / 'register-architecture.png'
        cairosvg.svg2png(url=str(svg), write_to=str(png), output_width=4252)
        with Image.open(png) as image:
            image.save(png, dpi=(600, 600))
        print(svg)
