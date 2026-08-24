#!/usr/bin/env python3
"""
Mete una imagen generada como acción de UN cuadro, al lado de las que ya
existen en `hojas.json`/`hojas.png`/`hojas.webp`, sin tocar ninguna de las
otras. Generaliza `inyectar-giro.py` (que hacía esto mismo hardcodeado para
la acción "gira") a cualquier nombre de acción.

    python3 scripts/inyectar-pose.py kor escudo arte-crudo/poses/kor-escudo.png
    python3 scripts/inyectar-pose.py ragnir colgado arte-crudo/poses/ragnir-colgado.png

La imagen de entrada tiene que venir con fondo ya recortado (alfa real) --
mismo formato que produce `alfa.py`/`fondo.py` sobre una salida de Kling.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

import numpy as np
from PIL import Image

RAIZ = pathlib.Path(__file__).resolve().parent.parent
ARTE = RAIZ / 'public' / 'art'

_spec = importlib.util.spec_from_file_location('ra', RAIZ / 'scripts' / 'recortar-accion.py')
ra = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ra)


def centroide(figura: Image.Image) -> tuple[float, float]:
    """Mismo criterio que `hoja-sprites.recortar`: centroide pesado por alfa."""
    a = np.array(figura.getchannel('A')).astype(np.float64)
    total = a.sum()
    cx = (a.sum(axis=0) * np.arange(a.shape[1])).sum() / total
    cy = (a.sum(axis=1) * np.arange(a.shape[0])).sum() / total
    return float(cx), float(cy)


def main() -> int:
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    slug = sys.argv[1].lower()
    accion = sys.argv[2].lower()
    origen = pathlib.Path(sys.argv[3])
    carpeta = ARTE / slug
    if not carpeta.is_dir():
        raise SystemExit(f'no existe {carpeta}')

    figura = Image.open(origen).convert('RGBA')
    # Recorte exacto a la silueta: la imagen ya viene alfa-recortada pero puede
    # traer un borde de aire de la reescala.
    a = np.array(figura.getchannel('A'))
    ys, xs = np.nonzero(a > 40)
    if len(xs) == 0:
        raise SystemExit(f'{origen}: no tiene alfa -- ¿se olvidó de sacarle el fondo?')
    caja = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    figura = figura.crop(caja)
    centro = centroide(figura)

    datos, piezas = ra.desempacar(carpeta)
    piezas[accion] = [(figura, centro)]
    ra.empacar(carpeta, datos, piezas)
    print(f'{slug}: "{accion}" metida, {figura.width}x{figura.height}px, '
          f'centroide {round(centro[0], 1)},{round(centro[1], 1)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
