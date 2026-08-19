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

from PIL import Image, ImageDraw, ImageFilter

OUT = pathlib.Path(__file__).parent.parent / "icons"

# Nero, blu, bianco: la A e' costruita a mano invece di essere un glifo di
# un font, perche' un marchio ha proporzioni proprie — aste piu spesse,
# vertice tagliato netto, traversa bassa — che nessun peso tipografico da'.
BLUE = (0x3D, 0x7B, 0xFF)
WHITE = (0xFF, 0xFF, 0xFF)

# Lo sfondo non e' una tinta piatta: la luce arriva da sinistra in alto,
# quindi il fondo schiarisce li' e si spegne nell'angolo opposto. E' la stessa
# direzione in cui cadono le ombre delle due A — una sorgente sola, altrimenti
# il rilievo si legge come un errore invece che come profondita'.
BG_LIGHT = (0x1B, 0x22, 0x31)
BG_DARK = (0x04, 0x05, 0x09)

BASE = 1024  # si disegna grande e si riduce: antialiasing gratis


def _lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def background():
    """Gradiente diagonale piu' alone freddo in alto a sinistra.

    Si calcola in piccolo e si ingrandisce: un gradiente e' una funzione
    liscia, quindi 96x96 interpolati sono indistinguibili da un milione di
    pixel calcolati a uno a uno, e costano mille volte meno.
    """
    n = 96
    small = Image.new("RGB", (n, n))
    pixels = small.load()
    for y in range(n):
        for x in range(n):
            t = (x + y) / (2 * (n - 1))
            t = t * t * (3 - 2 * t)  # smoothstep: la diagonale non fa bande
            r, g, b = _lerp(BG_LIGHT, BG_DARK, t)
            dx, dy = x / n - 0.22, y / n - 0.16
            distance = (dx * dx + dy * dy) ** 0.5
            glow = max(0.0, 1.0 - distance / 0.80) ** 2.4 * 0.20
            pixels[x, y] = (
                min(255, round(r + BLUE[0] * glow)),
                min(255, round(g + BLUE[1] * glow)),
                min(255, round(b + BLUE[2] * glow)),
            )
    return small.resize((BASE, BASE), Image.BICUBIC).convert("RGBA")


def add_rim(canvas):
    """Filo di luce sul bordo alto.

    E' il dettaglio che fa leggere il quadrato come un oggetto con uno
    spessore invece che come un rettangolo colorato: gli angoli arrotondati
    che iOS aggiunge lo tagliano dove serve, e il filo diventa un riflesso.
    """
    rim = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(rim)
    height = BASE * 0.05
    for y in range(round(height)):
        draw.line([(0, y), (BASE, y)],
                  fill=(255, 255, 255, round(54 * (1 - y / height) ** 1.8)))
    canvas.alpha_composite(rim)


def a_shapes(cx, cy, scale):
    """I tre poligoni di una A geometrica centrata in (cx, cy), coordinate 0..1.

    Costruita a mano e non presa da un font: un marchio ha proporzioni
    proprie — aste spesse, vertice tagliato netto, traversa bassa — che
    nessun peso tipografico dà.

    Restituisce la forma invece di disegnarla perche' la stessa geometria
    serve due volte: una per il segno, una per la sua ombra.
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

    left = [pt(cx - stroke / 2, apex_y), pt(cx + stroke / 2, apex_y),
            pt(cx - half + stroke, foot_y), pt(cx - half, foot_y)]
    right = [pt(cx - stroke / 2, apex_y), pt(cx + stroke / 2, apex_y),
             pt(cx + half, foot_y), pt(cx + half - stroke, foot_y)]
    bar = [pt(cx - half + inset, bar_y), pt(cx + half - inset, bar_y),
           pt(cx + half - inset, bar_y + bar_h), pt(cx - half + inset, bar_y + bar_h)]
    return left, right, bar


def draw_a(draw, cx, cy, scale, left, right, bar):
    """Disegna una A, un colore per asta piu' uno per la traversa."""
    for shape, fill in zip(a_shapes(cx, cy, scale), (left, right, bar)):
        draw.polygon(shape, fill=fill)


def cast_shadow(canvas, cx, cy, scale, blur, drop, alpha):
    """Proietta l'ombra di una A: la stessa forma, spostata sulla diagonale
    della luce, sfocata e scura.

    Lo spostamento e' nella geometria e non nell'immagine gia' disegnata:
    traslare i pixel farebbe rientrare dal lato opposto quello che esce.
    """
    mask = Image.new("L", (BASE, BASE), 0)
    draw = ImageDraw.Draw(mask)
    for shape in a_shapes(cx + drop, cy + drop, scale):
        draw.polygon(shape, fill=alpha)
    canvas.paste(Image.new("RGBA", (BASE, BASE), (0, 0, 0, 255)), (0, 0),
                 mask.filter(ImageFilter.GaussianBlur(blur)))


def render(size):
    """Quadrato pieno: iOS, il Dock e i launcher Android applicano da soli la
    maschera con angoli arrotondati. Arrotondare anche qui darebbe angoli
    doppi, e riempirli di nero li renderebbe visibili dove la maschera non
    viene applicata."""
    canvas = background()
    draw = ImageDraw.Draw(canvas)

    # Due A sulla stessa diagonale, spostate dal centro in versi opposti e
    # sovrapposte. La seconda ha i colori scambiati: e' la sovrapposizione a
    # rendere leggibile lo scambio, quindi devono incastrarsi per bene.
    scale = 0.70
    offset = 0.104
    drop = 0.021  # quanto cade l'ombra, nella direzione della luce

    back = (0.5 + offset, 0.5 + offset)
    front = (0.5 - offset, 0.5 - offset)

    # Ogni A proietta l'ombra PRIMA di essere disegnata: cosi' quella davanti
    # la lascia cadere su quella dietro, ed e' l'ombra a dire quale delle due
    # sta sopra. Senza, l'incastro sembra un errore di stampa.
    cast_shadow(canvas, *back, scale, blur=BASE * 0.020, drop=drop, alpha=145)
    draw_a(draw, *back, scale, left=BLUE, right=WHITE, bar=BLUE)

    cast_shadow(canvas, *front, scale, blur=BASE * 0.024, drop=drop, alpha=170)
    draw_a(draw, *front, scale, left=WHITE, right=BLUE, bar=WHITE)

    add_rim(canvas)
    return canvas.convert("RGB").resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(exist_ok=True)
    for size in (180, 192, 512):
        path = OUT / f"icon-{size}.png"
        render(size).save(path, "PNG", optimize=True)
        print(f"  {path.name:<16} {size}×{size}  {path.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    print("Genero le icone…")
    main()
