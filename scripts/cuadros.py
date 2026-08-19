#!/usr/bin/env python3
"""Saca de una acción los cuadros que Kling dibujó con otro personaje.

**Un clip de Kling no mantiene al personaje.** Ya está escrito que un clip no es
un ciclo —adentro conviven poses que no se continúan—, pero hay algo peor y es
que tampoco conserva la FIGURA: en `kor/jump` los cinco cuadros son cinco golems
distintos, uno con un cuerno y otros con dos, con el cuerpo cambiando de 0,91 a
1,25 veces la mediana de la acción. Eso no lo arregla mover piezas: no hay dónde
poner un puño para que el cuadro 1 sea el mismo bicho que el cuadro 2.

Lo único que se puede hacer sin volver a generar el clip es **quedarse con los
cuadros que sí son el mismo personaje**. Una acción con tres cuadros coherentes
se ve mejor que una con cinco donde dos parpadean a otra criatura.

No toca la hoja PNG: los cuadros que se sacan quedan ahí ocupando lugar y no los
mira nadie. Es a propósito — reempacar la hoja movería los `rect` de las otras
ocho acciones, y la regla de estas herramientas es que arreglar una acción no
puede tocar las demás.

    python3 scripts/cuadros.py kor                 # informe de toda la hoja
    python3 scripts/cuadros.py kor jump --sacar 1,4
"""
from __future__ import annotations

import importlib.util
import json
import pathlib
import statistics
import sys

import numpy as np
from PIL import Image

RAIZ = pathlib.Path(__file__).resolve().parent.parent
ARTE = RAIZ / 'public' / 'art'

_spec = importlib.util.spec_from_file_location('hs', RAIZ / 'scripts' / 'hoja-sprites.py')
hs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hs)

#: Cuánto puede apartarse el cuerpo de la mediana de su acción antes de ser otro
#: personaje. Medido sobre los seis: adentro de una acción sana la dispersión no
#: pasa del 12%, y lo que Kling cambia de criatura salta a 25%.
TOLERANCIA = 0.18


def medir(hoja: np.ndarray, cuadro: dict, unidad: float) -> tuple[int, float]:
    """El área de tinta y el alto de la silueta, en unidades de rig."""
    x, y, w, h = cuadro['rect']
    alfa = hoja[y:y + h, x:x + w, 3] > 40
    ys, _ = np.nonzero(alfa)
    alto = float(ys.max() - ys.min()) / unidad if len(ys) else 0.0
    return int(alfa.sum()), alto


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    slug = sys.argv[1].lower()
    ruta = ARTE / slug / 'hojas.json'
    if not ruta.is_file():
        raise SystemExit(f'no existe {ruta}')

    datos = json.loads(ruta.read_text(encoding='utf-8'))
    hoja = np.array(Image.open(ARTE / slug / 'hojas.png').convert('RGBA'))
    unidad = float(datos['unit'])

    accion = sys.argv[2] if len(sys.argv) > 2 and not sys.argv[2].startswith('--') else None
    sacar: list[int] = []
    if '--sacar' in sys.argv:
        sacar = sorted({int(n) for n in sys.argv[sys.argv.index('--sacar') + 1].split(',')})

    for nombre, anim in datos['animations'].items():
        if accion is not None and nombre != accion:
            continue
        medidas = [medir(hoja, c, unidad) for c in anim['frames']]
        if not medidas:
            continue
        areaMed = statistics.median(m[0] for m in medidas)
        altoMed = statistics.median(m[1] for m in medidas)
        print(f'{slug}/{nombre}:')
        for i, (area, alto) in enumerate(medidas):
            ra = area / areaMed if areaMed else 1
            rh = alto / altoMed if altoMed else 1
            fuera = abs(ra - 1) > TOLERANCIA or abs(rh - 1) > TOLERANCIA
            print(f'   [{i}] tinta {ra:5.2f}x  alto {rh:5.2f}x'
                  f'{"   <- se aparta" if fuera else ""}'
                  f'{"   <- SE SACA" if i in sacar else ""}')

    if not sacar:
        print('\nsólo informe. Con ACCION --sacar 1,4 se escribe.')
        return 0
    if accion is None:
        raise SystemExit('para sacar cuadros hay que nombrar la acción')

    anim = datos['animations'][accion]
    quedan = [c for i, c in enumerate(anim['frames']) if i not in sacar]
    if len(quedan) < 2:
        raise SystemExit(f'quedarían {len(quedan)} cuadros: una acción necesita al menos 2')
    anim['frames'] = quedan
    # El piso se vuelve a medir sobre los que quedaron: si el que se sacó era el
    # más alto o el más bajo, la mediana se corre y el personaje flota.
    anim['ground'] = round(statistics.median(
        (c['rect'][3] * (1 - c['anchor'][1]) - hs.MARGEN) / unidad for c in quedan), 3)
    ruta.write_text(json.dumps(datos, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'\n{slug}/{accion}: quedan {len(quedan)} cuadros, piso {anim["ground"]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
