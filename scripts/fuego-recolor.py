#!/usr/bin/env python3
"""Saca la hoguera roja de la verde, en vez de usar dos dibujos distintos.

**Por qué.** Las dos tiras venían de generaciones separadas y no eran hermanas:
la verde son llamas anchas de 196 px, la roja son velas finas de 107, y las dos
se normalizan por ALTO al dibujarse. O sea que en pantalla la hoguera verde era
una masa de fuego y la roja cinco velitas separadas — dos bandos con dos fondos
distintos, cuando lo único que tiene que cambiar entre ellos es el color.

Se conserva el dibujo verde, que es el bueno de los dos (tiene núcleo claro y
lee como fogata), y se lo remapea a fuego rojo por LUMINANCIA. Remapear por
luminancia y no por tono mantiene el contorno negro negro y el núcleo claro
claro: lo único que cambia es por qué colores pasa la rampa en el medio.

La tira roja además sale espejada y con los cuadros al revés, así las dos
hogueras no son la misma silueta repetida.

Los originales de las dos generaciones quedan en `arte-crudo/escenarios/`.

    python3 scripts/fuego-recolor.py
"""
from __future__ import annotations

import json
import pathlib
import sys

from PIL import Image

RAIZ = pathlib.Path(__file__).resolve().parent.parent
VERDE = RAIZ / 'public' / 'escenarios' / 'fuego-verde.png'
ROJO = RAIZ / 'public' / 'escenarios' / 'fuego-rojo.png'

# La rampa: luminancia del pixel verde -> color de fuego. Los tramos de abajo
# son cortos a propósito, para que el contorno negro no se tiña de bordó.
RAMPA: list[tuple[float, tuple[int, int, int]]] = [
    (0, (0, 0, 0)),
    (45, (86, 6, 14)),
    (100, (168, 18, 22)),
    (140, (222, 46, 20)),
    (190, (252, 132, 24)),
    (232, (255, 206, 96)),
    (255, (255, 244, 198)),
]


def rampa(lum: float) -> tuple[int, int, int]:
    if lum <= RAMPA[0][0]:
        return RAMPA[0][1]
    for (l0, c0), (l1, c1) in zip(RAMPA, RAMPA[1:]):
        if lum <= l1:
            t = (lum - l0) / (l1 - l0) if l1 > l0 else 0.0
            return (
                round(c0[0] + (c1[0] - c0[0]) * t),
                round(c0[1] + (c1[1] - c0[1]) * t),
                round(c0[2] + (c1[2] - c0[2]) * t),
            )
    return RAMPA[-1][1]


def main() -> int:
    if not VERDE.exists():
        print(f'falta {VERDE}', file=sys.stderr)
        return 1
    datos = json.loads(VERDE.with_suffix('.json').read_text(encoding='utf-8'))
    ancho, alto = datos['cell']
    cuadros = int(datos['frames'])

    verde = Image.open(VERDE).convert('RGBA')

    # La tabla se calcula una vez sobre los 256 valores de luminancia posibles:
    # el remapeo pixel a pixel sobre 980x392 con interpolación en Python tarda,
    # y con tabla es una búsqueda.
    tabla = [rampa(l) for l in range(256)]

    origen = verde.load()
    rojo = Image.new('RGBA', verde.size)
    destino = rojo.load()
    assert origen is not None and destino is not None
    for y in range(verde.height):
        for x in range(verde.width):
            r, g, b, a = origen[x, y]
            if a == 0:
                continue
            lum = round(0.2126 * r + 0.7152 * g + 0.0722 * b)
            nr, ng, nb = tabla[min(255, max(0, lum))]
            destino[x, y] = (nr, ng, nb, a)

    # Espejada y con los cuadros dados vuelta: misma familia, distinta hoguera.
    tira = Image.new('RGBA', rojo.size)
    for i in range(cuadros):
        cuadro = rojo.crop((i * ancho, 0, (i + 1) * ancho, alto))
        cuadro = cuadro.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        tira.paste(cuadro, ((cuadros - 1 - i) * ancho, 0))

    tira.save(ROJO)
    ROJO.with_suffix('.json').write_text(json.dumps({
        '_': ('Sale de fuego-verde.png con scripts/fuego-recolor.py: mismo dibujo, '
              'rampa de fuego y espejado. Las dos hogueras tienen que ser hermanas.'),
        'file': 'fuego-rojo.png',
        'cell': [ancho, alto],
        'frames': cuadros,
        'base': datos.get('base', 4),
    }, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'{ROJO.name}: {cuadros} llamas de {ancho}x{alto}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
