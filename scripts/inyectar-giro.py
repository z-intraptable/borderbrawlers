#!/usr/bin/env python3
"""
Mete el cuadro de frente —generado con Kling/Nano Banana para arreglar la
desaparición del personaje al girar— como una acción `gira` de UN cuadro,
al lado de las que ya existen, sin tocar ninguna de las otras.

    python3 scripts/inyectar-giro.py kor arte-crudo/giro/kor-frente-final.png
    python3 scripts/inyectar-giro.py ragnir arte-crudo/giro/ragnir-frente-final.png
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
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    slug = sys.argv[1].lower()
    origen = pathlib.Path(sys.argv[2])
    carpeta = ARTE / slug

    figura = Image.open(origen).convert('RGBA')
    # Recorte exacto a la silueta: la imagen ya viene alfa-recortada pero puede
    # traer un borde de aire de la reescala.
    a = np.array(figura.getchannel('A'))
    ys, xs = np.nonzero(a > 40)
    caja = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    figura = figura.crop(caja)
    centro = centroide(figura)

    datos, piezas = ra.desempacar(carpeta)
    piezas['gira'] = [(figura, centro)]
    ra.empacar(carpeta, datos, piezas)
    print(f'{slug}: cuadro de frente metido como acción "gira", '
          f'{figura.width}x{figura.height}px, centroide {round(centro[0],1)},{round(centro[1],1)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
