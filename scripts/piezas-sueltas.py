#!/usr/bin/env python3
"""Acerca al cuerpo las piezas que se le fueron demasiado lejos, y borra esquirlas.

Kor está dibujado con los miembros sueltos —los puños y los pies flotan al lado
del cuerpo, al estilo Rayman— y eso es del diseño. Lo que NO es del diseño es
cuánto se alejan en algunos cuadros: medido desde el centro del cuerpo, en
unidades de rig sobre una figura de 104,

    jump[3]  73,6      punch[1]  62,1
    jump[0]  71,6      jump[2]   61,2

o sea un puño a dos tercios del alto del cuerpo. En pantalla eso no se lee como
un golem de miembros flotantes: se lee como un personaje que se desarmó.

También aparecen ESQUIRLAS: manchas chicas y lejanas que el agrupador de
`hoja-sprites.py` le asignó a la figura equivocada cuando la hoja traía varias
en hilera. `super[2]` tiene una de 215 px a 53 unidades.

La pieza se mueve entera hacia el cuerpo por su propia dirección, así que la
pose se conserva; lo único que cambia es cuánto se aleja. El ancla se corrige
con el desplazamiento real del centroide, para que el personaje no se corra de
la plataforma.

    python3 scripts/piezas-sueltas.py kor
    python3 scripts/piezas-sueltas.py kor --acercar 50 --esquirlas 400
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

#: Una mancha más chica que esto no es un miembro, es ruido del recorte.
MINIMO = 150


def piezas(alfa: np.ndarray) -> list:
    """Las manchas del cuadro, de la más grande a la más chica."""
    salida = []
    for tramos in bs.etiquetar(alfa):
        n = bs.tamano(tramos)
        if n < MINIMO:
            continue
        m = bs.pintar(tramos, alfa.shape)
        ys, xs = np.nonzero(m)
        salida.append((n, float(xs.mean()), float(ys.mean()), m))
    salida.sort(key=lambda p: -p[0])
    return salida


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    slug = sys.argv[1].lower()
    carpeta = ARTE / slug
    if not carpeta.is_dir():
        raise SystemExit(f'no existe {carpeta}')

    tope = 0.0
    esquirla = 0
    if '--acercar' in sys.argv:
        tope = float(sys.argv[sys.argv.index('--acercar') + 1])
    if '--esquirlas' in sys.argv:
        esquirla = int(sys.argv[sys.argv.index('--esquirlas') + 1])
    aplicar = tope > 0 or esquirla > 0

    datos = json.loads((carpeta / 'hojas.json').read_text())
    hoja = np.array(Image.open(carpeta / 'hojas.png').convert('RGBA'))
    unidad = datos['unit']
    tocado = False

    for accion, anim in datos['animations'].items():
        for i, cuadro in enumerate(anim['frames']):
            x, y, w, h = cuadro['rect']
            celda = hoja[y:y + h, x:x + w]
            alfa = celda[:, :, 3] > 40
            trozos = piezas(alfa)
            if len(trozos) < 2:
                continue
            _, bx, by, _ = trozos[0]

            # El centroide de antes, para poder corregir el ancla con lo que se
            # mueva de verdad. Si el dibujo se corre y el ancla no, el personaje
            # se despega de la plataforma.
            ys0, xs0 = np.nonzero(alfa)
            antes = (float(xs0.mean()), float(ys0.mean()))

            for n, px, py, mask in trozos[1:]:
                dx, dy = px - bx, py - by
                dist = float(np.hypot(dx, dy)) / unidad
                if esquirla > 0 and n < esquirla and dist > 40:
                    print(f'  {slug}/{accion}[{i}]  esquirla de {n} px a '
                          f'{dist:.1f} borrada')
                    celda[:, :, 3][mask] = 0
                    tocado = True
                    continue
                if tope <= 0 or dist <= tope:
                    if not aplicar and dist > 45:
                        print(f'  {slug}/{accion}[{i}]  pieza de {n} px a {dist:.1f}')
                    continue
                # Hacia el cuerpo por su propia dirección: la pose se conserva.
                escala = tope / dist
                mx = int(round(dx * (escala - 1)))
                my = int(round(dy * (escala - 1)))
                if mx == 0 and my == 0:
                    continue
                trozo = np.zeros_like(celda)
                trozo[mask] = celda[mask]
                celda[mask] = 0
                movido = np.roll(np.roll(trozo, my, axis=0), mx, axis=1)
                pega = movido[:, :, 3] > 0
                celda[pega] = movido[pega]
                print(f'  {slug}/{accion}[{i}]  pieza de {n} px: {dist:.1f} -> {tope:.0f}')
                tocado = True

            if tocado:
                nuevo = celda[:, :, 3] > 40
                ys1, xs1 = np.nonzero(nuevo)
                if len(xs1):
                    cuadro['anchor'] = [
                        round(cuadro['anchor'][0] + (float(xs1.mean()) - antes[0]) / w, 4),
                        round(cuadro['anchor'][1] + (float(ys1.mean()) - antes[1]) / h, 4),
                    ]
                hoja[y:y + h, x:x + w] = celda

    if not aplicar:
        print('\nsólo informe. Con --acercar N y --esquirlas N se escribe.')
        return 0
    if tocado:
        Image.fromarray(hoja).save(carpeta / 'hojas.png')
        (carpeta / 'hojas.json').write_text(json.dumps(datos, indent=2, ensure_ascii=False))
        print(f'\n{carpeta.name}: hoja y manifiesto reescritos')
    else:
        print('\nnada que mover')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
