#!/usr/bin/env python3
"""Vuelve a empacar las hojas sin tocar un solo píxel de dibujo.

Existe porque `empacar` cambió de grilla pareja a estantes y las seis hojas
seguían con la distribución vieja. No recorta, no interpola, no borra: desempaca
y vuelve a empacar, así que lo único que cambia es DÓNDE está cada cuadro dentro
del PNG y, con eso, cuánta textura ocupa.

    python3 scripts/reempacar.py            # las seis
    python3 scripts/reempacar.py kor
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
ARTE = RAIZ / 'public' / 'art'

_spec = importlib.util.spec_from_file_location('ra', RAIZ / 'scripts' / 'recortar-accion.py')
ra = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ra)


def main() -> int:
    slugs = sys.argv[1:] or sorted(p.parent.name for p in ARTE.glob('*/hojas.json'))
    for slug in slugs:
        carpeta = ARTE / slug
        datos, piezas = ra.desempacar(carpeta)
        ra.empacar(carpeta, datos, piezas)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
