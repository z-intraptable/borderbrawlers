#!/usr/bin/env python3
"""
Junta poses sueltas en una hoja, para poder dárselas a `hoja-sprites.py`.

    python3 scripts/juntar-poses.py dusk punch punch-windup punch-extended
    python3 scripts/juntar-poses.py dusk idle idle

Sale `arte-crudo/poses/<slug>-<accion>-crudo.png`, que es lo que come
`hoja-sprites.py` con `accion=esa-hoja.png:N`.

**Por qué no se le pasan los recortes directo.** `hoja-sprites.py` los buscaría
igual, pero antes pasa por `sin_borde`, que blanquea las franjas finas que
cruzan más de media hoja porque en las hojas del generador eso es la línea de
piso dibujada. En un recorte ajustado a una sola figura casi cualquier franja
cruza media hoja —la figura ES la hoja— y la regla se come pedazos del
personaje. Pegadas con margen, ninguna fila llega a la mitad del ancho y la
regla no tiene con qué confundirse.

Y de paso quedan a la misma escala relativa, que es lo que `hoja-sprites.py`
necesita para que el personaje no cambie de tamaño entre un cuadro y el
siguiente: las poses vienen de la misma hoja del generador, así que si se pegan
sin tocarlas la proporción entre ellas ya está bien.
"""
import sys
from pathlib import Path

from PIL import Image

RAIZ = Path(__file__).resolve().parent.parent
POSES = RAIZ / 'arte-crudo' / 'poses'

# Cuánto blanco queda alrededor de cada figura, en fracción de su propio ancho.
# Con esto la figura más ancha ocupa menos de la mitad del ancho de la hoja,
# que es justo el umbral de la regla de la línea de piso.
MARGEN = 0.45


def main() -> None:
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    slug = sys.argv[1].lower()
    accion = sys.argv[2]
    nombres = sys.argv[3:]

    figuras = []
    for nombre in nombres:
        ruta = POSES / f'{slug}-{nombre}.png'
        if not ruta.exists():
            raise SystemExit(f'no está {ruta}')
        figuras.append(Image.open(ruta).convert('RGB'))

    hueco = round(max(f.width for f in figuras) * MARGEN)
    ancho = sum(f.width for f in figuras) + hueco * (len(figuras) + 1)
    alto = max(f.height for f in figuras) + hueco * 2
    hoja = Image.new('RGB', (ancho, alto), (255, 255, 255))

    x = hueco
    for figura in figuras:
        # Alineadas por abajo: es como vienen en la hoja del generador, y el
        # alineado final lo rehace `hoja-sprites.py` por centroide igual.
        hoja.paste(figura, (x, alto - hueco - figura.height))
        x += figura.width + hueco

    salida = POSES / f'{slug}-{accion}-crudo.png'
    hoja.save(salida)
    print(f'  {salida}  ({ancho}x{alto})  {len(figuras)} poses')


if __name__ == '__main__':
    main()
