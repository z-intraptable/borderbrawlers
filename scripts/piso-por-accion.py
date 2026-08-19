#!/usr/bin/env python3
"""Le pone a cada animación su propia distancia del centroide a los pies.

**El defecto.** `hoja-sprites.py` mide `ground` UNA vez, sobre la primera acción
de la lista —que en la práctica es `run`—, y el juego usa ese número para todas.
Pero el centroide de una silueta no cae a la misma altura en todas las poses: el
que corre tiene una pierna estirada, el que patea tiene una levantada, el que
está de pie tiene las dos juntas. Medido sobre las seis hojas, la pose de pie
queda entre 1 y 11 unidades de rig por encima de la de correr, y la patada entre
6 y 8 por debajo. En pantalla eso es un personaje que **flota parado y se hunde
en la losa cuando patea**, que es exactamente lo que se ve.

**El arreglo no necesita volver a cortar nada.** El dato ya está en el
manifiesto: `rect[3] * (1 - anchor[1])` son los píxeles del centroide a la base
del CUADRO, y dividido por `unit` da unidades de rig. Así que se calcula por
acción y se escribe al lado de sus cuadros. Cortar las seis hojas de nuevo son
cuarenta minutos; esto son milisegundos y da el mismo número.

**Y hay que descontarle `MARGEN`.** La base del cuadro no son los pies: el
`rect` lleva `MARGEN` píxeles de aire alrededor de la figura, así que sin
restarlo el piso queda 4 píxeles —1,3 unidades de rig— más abajo de donde está,
y los seis personajes se hunden en la losa esa misma cantidad. `recortar-accion.py`
mide lo mismo pero sobre la figura ya recortada, y por eso da el número bueno;
si estos dos no coinciden, el que cortó último gana y el piso cambia sin que
nadie haya tocado el dibujo.

Por ACCIÓN y no por CUADRO a propósito: dentro de una acción los cuadros tienen
que conservar su movimiento relativo. Pegando cada cuadro al piso, el salto se
aplana justo cuando tendría que despegar.

    python3 scripts/piso-por-accion.py
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import statistics
import sys

RAIZ = pathlib.Path(__file__).resolve().parent.parent
ARTE = RAIZ / 'public' / 'art'

_spec = importlib.util.spec_from_file_location('hs', RAIZ / 'scripts' / 'hoja-sprites.py')
hs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hs)


def main() -> int:
    hojas = sorted(ARTE.glob('*/hojas.json'))
    if not hojas:
        print(f'no hay hojas en {ARTE}', file=sys.stderr)
        return 1
    for ruta in hojas:
        datos = json.loads(ruta.read_text(encoding='utf-8'))
        unidad = float(datos['unit'])
        global_ = float(datos['ground'])
        cambios = []
        for nombre, animacion in datos['animations'].items():
            pisos = [(c['rect'][3] * (1 - c['anchor'][1]) - hs.MARGEN) / unidad
                     for c in animacion['frames']]
            piso = round(statistics.median(pisos), 3)
            animacion['ground'] = piso
            cambios.append(f'{nombre}:{piso - global_:+.0f}')
        datos['_'] = (
            'Hoja de sprites armada por scripts/hoja-sprites.py desde los clips de '
            'Kling. `anchor` es la fracción del cuadro donde cae el centroide de la '
            'silueta, que es el punto que la física mueve. `ground` es cuántas '
            'unidades de rig hay de ese centroide a los pies: el de arriba es el de '
            'la primera acción y queda de respaldo, y el de cada animación es el que '
            'vale, porque el centroide no cae a la misma altura parado que pateando. '
            'Lo escribe scripts/piso-por-accion.py.'
        )
        ruta.write_text(json.dumps(datos, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        print(f'{ruta.parent.name:10s} ' + '  '.join(cambios))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
