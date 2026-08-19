#!/usr/bin/env python3
"""Busca en un clip el tramo que SÍ es un ciclo, para cortar la carrera de ahí.

Los clips de Kling duran tres segundos y no son un ciclo: adentro conviven
varias poses de brazos que no se continúan entre sí. `hoja-sprites.py` diezma
parejo sobre todo el clip, así que se lleva un cuadro de cada zona y al
reproducirlo un brazo salta de un lado al otro. En Kor eran cuatro poses
distintas; medido, el salto entre cuadros consecutivos llegaba a 18 unidades de
rig, o sea un 17% del alto del cuerpo de una sola vez.

Lo que se mide es exactamente eso: cuánto se corre el borde de la silueta —el
punto más a la izquierda y el más a la derecha, respecto del centroide— entre un
cuadro y el siguiente. Un ciclo de verdad mueve las piernas y deja el tronco
quieto, así que ese número se queda chico. Una pose que cambia lo dispara.

Y se le pide además que se MUEVA: sin eso el mejor tramo es siempre uno donde no
pasa nada, que da salto cero y en pantalla es un personaje congelado.

    python3 scripts/ventana-ciclo.py arte-crudo/clips/asuri-run.mp4
"""
from __future__ import annotations

import pathlib
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

RAIZ = pathlib.Path(__file__).resolve().parent.parent
#: Cuántos cuadros tiene la acción ya diezmada. El mismo de `hoja-sprites.py`.
CUADROS = 12
#: Cuadros por segundo del clip.
FPS = 24
#: El tramo más corto que se acepta: menos de esto no alcanza para un ciclo.
MINIMO = 20
#: Cuánta vida se le exige, en fracción de la del clip entero.
VIVEZA = 0.45


def medir(clip: pathlib.Path) -> tuple[np.ndarray, np.ndarray]:
    """Por cuadro: (izquierda, derecha) del borde respecto del centroide, y área."""
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(clip),
                        '-vf', 'scale=200:-1', f'{tmp}/%04d.png'], check=True)
        bordes, areas = [], []
        for f in sorted(pathlib.Path(tmp).glob('*.png')):
            a = np.array(Image.open(f).convert('RGB')).astype(np.int16)
            tinta = a.min(axis=2) < 225
            ys, xs = np.nonzero(tinta)
            if len(xs) == 0:
                bordes.append((0.0, 0.0))
                areas.append(0.0)
                continue
            cx = xs.mean()
            bordes.append((xs.min() - cx, xs.max() - cx))
            areas.append(float(tinta.sum()))
    return np.array(bordes), np.array(areas)


def diezmar(n: int, cuantos: int) -> list[int]:
    """Los mismos índices que elige `hoja-sprites.diezmar`."""
    if n <= cuantos:
        return list(range(n))
    paso = n / cuantos
    return [min(n - 1, round(i * paso)) for i in range(cuantos)]


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    clip = pathlib.Path(sys.argv[1])
    if not clip.is_absolute():
        clip = RAIZ / clip
    bordes, areas = medir(clip)
    n = len(bordes)
    viveza_total = float(areas.std())
    print(f'{clip.name}: {n} cuadros, {n / FPS:.2f} s')

    mejor = None
    for a in range(0, n - MINIMO + 1):
        for b in range(a + MINIMO, n + 1):
            idx = [a + i for i in diezmar(b - a, CUADROS)]
            v = bordes[idx]
            # Cíclico: el último cuadro empalma con el primero, y si ahí hay un
            # salto el ciclo se ve tironear una vez por vuelta.
            salto = float(np.abs(np.diff(np.vstack([v, v[:1]]), axis=0)).max())
            viveza = float(areas[a:b].std())
            if viveza < VIVEZA * viveza_total:
                continue
            if mejor is None or salto < mejor[0] - 1e-9 or (
                    abs(salto - mejor[0]) < 1e-9 and (b - a) > mejor[2] - mejor[1]):
                mejor = (salto, a, b, viveza)

    if mejor is None:
        print('  ningún tramo pasa el mínimo de viveza')
        return 1
    salto, a, b, viveza = mejor
    entero = [i for i in diezmar(n, CUADROS)]
    v = bordes[entero]
    salto_entero = float(np.abs(np.diff(np.vstack([v, v[:1]]), axis=0)).max())
    print(f'  clip entero:  salto {salto_entero:5.1f} px')
    print(f'  mejor tramo:  salto {salto:5.1f} px  cuadros {a}..{b}  '
          f'({a / FPS:.2f}:{b / FPS:.2f})')
    print(f'  python3 scripts/recortar-accion.py SLUG '
          f'run={clip.relative_to(RAIZ)}:{a / FPS:.2f}:{b / FPS:.2f}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
