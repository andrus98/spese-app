#!/usr/bin/env python3
"""Genera le icone della PWA (PrjSpesa).

Le icone sono riproducibili — `python3 dev/make-icons.py` — invece di essere
binari di provenienza ignota dentro il repo. Il marchio è una A costruita
geometricamente: nero, blu e bianco.

Il segno resta entro il 60% della larghezza, quindi sopravvive sia al
ritaglio circolare delle icone `maskable` di Android sia alla maschera con
angoli arrotondati che iOS applica per conto suo.

Richiede Pillow:  pip3 install Pillow
"""

import pathlib

from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path(__file__).parent.parent / "icons"

# Nero, blu, bianco: la A e' costruita a mano invece di essere un glifo di
# un font, perche' un marchio ha proporzioni proprie — aste piu spesse,
# vertice tagliato netto, traversa bassa — che nessun peso tipografico da'.
BG = (0x08, 0x09, 0x0C)
BLUE = (0x3D, 0x7B, 0xFF)
WHITE = (0xFF, 0xFF, 0xFF)

BASE = 1024  # si disegna grande e si riduce: antialiasing gratis


def draw_a(draw, cx, cy, scale, left, right, bar):
    """Una A geometrica centrata in (cx, cy), in coordinate 0..1.

    Costruita a mano e non presa da un font: un marchio ha proporzioni
    proprie — aste spesse, vertice tagliato netto, traversa bassa — che
    nessun peso tipografico dà.
    """
    half = 0.243 * scale        # semi-apertura in basso
    stroke = 0.104 * scale      # spessore delle aste
    rise = 0.270 * scale        # mezza altezza
    bar_y = cy + 0.095 * scale
    bar_h = 0.086 * scale
    inset = 0.052 * scale

    apex_y = cy - rise
    foot_y = cy + rise

    def pt(x, y):
        return (x * BASE, y * BASE)

    # Asta sinistra.
    draw.polygon([
        pt(cx - stroke / 2, apex_y), pt(cx + stroke / 2, apex_y),
        pt(cx - half + stroke, foot_y), pt(cx - half, foot_y),
    ], fill=left)

    # Asta destra.
    draw.polygon([
        pt(cx - stroke / 2, apex_y), pt(cx + stroke / 2, apex_y),
        pt(cx + half, foot_y), pt(cx + half - stroke, foot_y),
    ], fill=right)

    # Traversa.
    draw.rectangle([pt(cx - half + inset, bar_y),
                    pt(cx + half - inset, bar_y + bar_h)], fill=bar)


def render(size):
    """Quadrato pieno: iOS, il Dock e i launcher Android applicano da soli la
    maschera con angoli arrotondati. Arrotondare anche qui darebbe angoli
    doppi, e riempirli di nero li renderebbe visibili dove la maschera non
    viene applicata."""
    canvas = Image.new("RGB", (BASE, BASE), BG)
    draw = ImageDraw.Draw(canvas)

    # Due A sulla stessa diagonale, spostate dal centro in versi opposti e
    # appena sovrapposte. La seconda ha i colori scambiati: è la
    # sovrapposizione a rendere leggibile lo scambio, quindi devono toccarsi.
    scale = 0.70
    offset = 0.135

    # Prima quella in basso a destra, così l'altra le passa davanti.
    draw_a(draw, 0.5 + offset, 0.5 + offset, scale,
           left=BLUE, right=WHITE, bar=BLUE)
    draw_a(draw, 0.5 - offset, 0.5 - offset, scale,
           left=WHITE, right=BLUE, bar=WHITE)

    return canvas.resize((size, size), Image.LANCZOS), "due A sulla diagonale"


def main():
    OUT.mkdir(exist_ok=True)
    used_font = None
    for size in (180, 192, 512):
        image, used_font = render(size)
        path = OUT / f"icon-{size}.png"
        image.save(path, "PNG", optimize=True)
        print(f"  {path.name:<16} {size}×{size}  {path.stat().st_size / 1024:.1f} KB")
    print(f"\nFont: {used_font}")


if __name__ == "__main__":
    print("Genero le icone…")
    main()
