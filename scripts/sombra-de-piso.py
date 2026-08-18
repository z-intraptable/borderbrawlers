#!/usr/bin/env python3
"""Borra la sombra de piso que Kling dibujó ADENTRO del sprite.

En tres cuadros de Asuri —`punch[0]`, `punch[1]` e `idle[0]`— el generador
dibujó abajo de los pies una elipse gris con su línea de horizonte. `alfa.py`
inunda desde los bordes y se frena ahí, porque la sombra no es blanca: queda
opaca y viaja pegada al personaje. En el juego eso es una mancha gris que lo
sigue por el aire, y encima corre la medición del piso, así que el personaje
parece no apoyar en la plataforma.

Cómo se la reconoce, y por qué no alcanza con "gris y abajo": **la sombra es lo
único del dibujo que no tiene contorno negro**. Todo lo demás en este estilo va
delineado. Entonces se buscan manchas grises, chatas, al ras de los pies y sin
una sola línea negra adentro.

Ojo con una trampa que ya costó una vuelta: la sombra TOCA el contorno de los
pies, así que descartar por "tiene negro cerca" la deja pasar. La prueba va
adentro de la mancha, no en su vecindario.

    python3 scripts/sombra-de-piso.py            # informa
    python3 scripts/sombra-de-piso.py --aplicar
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import sys

import numpy as np
from PIL import Image

RAIZ = pathlib.Path(__file__).resolve().parent.parent
ARTE = RAIZ / 'public' / 'art'

_spec = importlib.util.spec_from_file_location('bs', RAIZ / 'scripts' / 'blancos-sueltos.py')
bs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bs)

#: Una sombra es gris: poco saturada y ni negra ni blanca.
SAT = 30
LUMA = (80, 235)
#: Y es chata y ancha, al ras del piso de la silueta.
ALTO_MAX = 16
ANCHO_MIN = 0.18
RAS = 0.06


def sombras(celda: np.ndarray) -> list[np.ndarray]:
    """Máscaras de las manchas de sombra que hay en un cuadro."""
    alfa = celda[:, :, 3] > 40
    rgb = celda[:, :, :3].astype(np.int16)
    luma = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    gris = (alfa & ((rgb.max(axis=2) - rgb.min(axis=2)) < SAT)
            & (luma >= LUMA[0]) & (luma <= LUMA[1]))
    if not gris.any():
        return []
    filas = np.nonzero(alfa.any(axis=1))[0]
    cols = np.nonzero(alfa.any(axis=0))[0]
    ancho = cols.max() - cols.min() + 1
    alto = filas.max() - filas.min() + 1

    salida = []
    for tramos in bs.etiquetar(gris):
        if bs.tamano(tramos) < 150:
            continue
        x0, y0, x1, y1 = bs.caja(tramos)
        if (y1 - y0 + 1) > ALTO_MAX or (x1 - x0 + 1) < ANCHO_MIN * ancho:
            continue
        if y1 < filas.max() - RAS * alto:
            continue
        m = bs.pintar(tramos, gris.shape)
        if ((luma < 70) & alfa & m).any():
            continue
        salida.append(m)
    return salida


def main() -> int:
    aplicar = '--aplicar' in sys.argv
    total = 0
    for carpeta in sorted(ARTE.iterdir()):
        manifiesto = carpeta / 'hojas.json'
        if not manifiesto.is_file():
            continue
        datos = json.loads(manifiesto.read_text())
        hoja = np.array(Image.open(carpeta / 'hojas.png').convert('RGBA'))
        tocado = False
        for accion, anim in datos['animations'].items():
            for i, cuadro in enumerate(anim['frames']):
                x, y, w, h = cuadro['rect']
                celda = hoja[y:y + h, x:x + w]
                for m in sombras(celda):
                    n = int(m.sum())
                    print(f'  {carpeta.name}/{accion}[{i}]  {n} px de sombra')
                    total += 1
                    if aplicar:
                        celda[:, :, 3][m] = 0
                        tocado = True
                hoja[y:y + h, x:x + w] = celda
        if aplicar and tocado:
            Image.fromarray(hoja).save(carpeta / 'hojas.png')
            print(f'{carpeta.name}/hojas.png reescrito')

    if total == 0:
        print('sin sombras dibujadas')
    elif not aplicar:
        print(f'\n{total} sombra(s). Volvé a correr con --aplicar para borrarlas.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
