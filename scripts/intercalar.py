#!/usr/bin/env python3
"""Fabrica los cuadros del medio interpolando pieza por pieza.

**Por qué se puede.** Kor está dibujado con los miembros sueltos —puños y pies
flotando al lado del cuerpo, estilo Rayman— así que cada miembro es una mancha
separada que se puede seguir de un cuadro al otro. Eso es exactamente el caso en
el que un intercalado sale bien: se empareja cada pieza con la suya, se la mueve
por su propio camino, y el cuadro del medio queda con la pieza EN EL LUGAR
correcto en vez de con dos poses superpuestas.

**Por qué NO es un fundido.** Un cross-fade mezcla dos imágenes en su sitio y da
fantasmas: se ven los dos puños a la vez, cada uno a media transparencia. Acá
primero se ALINEA cada pieza en la posición intermedia y recién ahí se mezclan
las dos versiones de esa misma pieza — que a esa altura son casi el mismo dibujo
en el mismo lugar. La diferencia entre las dos cosas es la que hay entre
intercalar y ensuciar.

**Dónde falla y hay que mirarlo.** Si una pieza aparece o desaparece entre los
dos cuadros no tiene con quién emparejarse, y lo único honesto es apagarla o
encenderla donde está. Y si el emparejamiento se equivoca —dos piezas parecidas
y cercanas— la pieza viaja al lugar de la otra y se ve peor que el original.
Por eso `--ver` saca la tira a un PNG y no escribe nada.

    python3 scripts/intercalar.py kor jump=1 --ver
    python3 scripts/intercalar.py kor punch=3,kick=3,skill=1
    python3 scripts/intercalar.py kor run=1 --ciclo

Varias acciones en UNA corrida y no una por vez: cada corrida desempaca y
reempaca la hoja entera, así que hacerlas de a una son cinco reescrituras de un
PNG de tres megas para el mismo resultado.
"""
from __future__ import annotations

import importlib.util
import math
import pathlib
import sys

import numpy as np
from PIL import Image

RAIZ = pathlib.Path(__file__).resolve().parent.parent
ARTE = RAIZ / 'public' / 'art'


def _cargar(nombre: str, archivo: str):
    spec = importlib.util.spec_from_file_location(nombre, RAIZ / 'scripts' / archivo)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bs = _cargar('bs', 'blancos-sueltos.py')
ra = _cargar('ra', 'recortar-accion.py')

#: Una mancha más chica que esto es ruido del recorte, no un miembro.
MINIMO = 150
#: Cuánto puede cambiar de tamaño una pieza y seguir siendo la misma.
#: Un puño que se acerca a cámara crece, pero no al doble.
TAMANO_MAX = 2.2
#: Aire alrededor del lienzo de trabajo, en píxeles.
AIRE = 40


def piezas_de(figura: Image.Image, centro: tuple[float, float]) -> list[dict]:
    """Las manchas del cuadro, con su posición RELATIVA al centroide."""
    arr = np.array(figura)
    alfa = arr[:, :, 3] > 40
    salida = []
    for tramos in bs.etiquetar(alfa):
        n = bs.tamano(tramos)
        if n < MINIMO:
            continue
        mask = bs.pintar(tramos, alfa.shape)
        ys, xs = np.nonzero(mask)
        rgba = np.zeros_like(arr)
        rgba[mask] = arr[mask]
        salida.append({
            'area': n,
            # Dos coordenadas de la misma cosa y las dos hacen falta: `px`/`py`
            # es dónde está la pieza DENTRO de su propio recorte, y `dx`/`dy` es
            # dónde está respecto del centroide del cuadro. La segunda es la que
            # permite comparar dos cuadros de distinto tamaño; la primera es la
            # que dice cuánto hay que correr el recorte para dejarla en su lugar.
            'px': float(xs.mean()),
            'py': float(ys.mean()),
            'dx': float(xs.mean()) - centro[0],
            'dy': float(ys.mean()) - centro[1],
            'caja': (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1),
            'rgba': rgba,
        })
    salida.sort(key=lambda p: -p['area'])
    return salida


def emparejar(a: list[dict], b: list[dict]) -> list[tuple[int, int]]:
    """Qué pieza de A es cuál de B. Voraz por el par más barato que quede.

    El costo mezcla distancia y diferencia de tamaño: sólo por distancia, un
    puño que cruza el cuerpo se empareja con el pie que le quedó cerca.
    """
    costos = []
    for i, pa in enumerate(a):
        for j, pb in enumerate(b):
            razon = max(pa['area'], pb['area']) / max(1, min(pa['area'], pb['area']))
            if razon > TAMANO_MAX:
                continue
            dist = math.hypot(pa['dx'] - pb['dx'], pa['dy'] - pb['dy'])
            costos.append((dist * (0.6 + 0.4 * razon), i, j))
    costos.sort()
    usadosA: set[int] = set()
    usadosB: set[int] = set()
    pares = []
    for _, i, j in costos:
        if i in usadosA or j in usadosB:
            continue
        usadosA.add(i)
        usadosB.add(j)
        pares.append((i, j))
    return pares


def _pegar(acumRGB, acumA, rgba, ox: float, oy: float, peso: float) -> None:
    """Suma una pieza al lienzo con el origen de su recorte en (ox, oy).

    Premultiplicada por alfa y por su peso, porque las piezas se pisan entre
    ellas y hay que promediar el COLOR por cuánto alfa aporta cada una; sumando
    color sin pesar, donde dos piezas se solapan sale un color que no es de
    ninguna de las dos.
    """
    ox, oy = int(round(ox)), int(round(oy))
    alto, ancho = rgba.shape[0], rgba.shape[1]
    H, W = acumA.shape
    x0, y0 = max(0, ox), max(0, oy)
    x1, y1 = min(W, ox + ancho), min(H, oy + alto)
    if x1 <= x0 or y1 <= y0:
        return
    sub = rgba[y0 - oy:y1 - oy, x0 - ox:x1 - ox]
    a = sub[:, :, 3].astype(np.float64) / 255.0 * peso
    acumRGB[y0:y1, x0:x1] += sub[:, :, :3].astype(np.float64) * a[:, :, None]
    acumA[y0:y1, x0:x1] += a


def intermedio(fa, ca, fb, cb, t: float) -> tuple[Image.Image, tuple[float, float]]:
    """El cuadro que va entre A y B, con `t` de 0 a 1."""
    pa = piezas_de(fa, ca)
    pb = piezas_de(fb, cb)
    pares = emparejar(pa, pb)

    radio = 0
    for p in pa + pb:
        x0, y0, x1, y1 = p['caja']
        radio = max(radio, abs(p['dx']) + (x1 - x0), abs(p['dy']) + (y1 - y0))
    lado = int(radio * 2 + AIRE * 2)
    acumRGB = np.zeros((lado, lado, 3), dtype=np.float64)
    acumA = np.zeros((lado, lado), dtype=np.float64)
    cx = cy = lado / 2

    hechosA = {i for i, _ in pares}
    hechosB = {j for _, j in pares}
    for i, j in pares:
        p, q = pa[i], pb[j]
        # El destino: la posición interpolada. Las dos versiones de la pieza van
        # AL MISMO LUGAR, y por eso lo que se mezcla son dos dibujos casi
        # iguales y no dos poses distintas.
        mx = p['dx'] + (q['dx'] - p['dx']) * t
        my = p['dy'] + (q['dy'] - p['dy']) * t
        # **No se mezclan las dos versiones: se usa la del cuadro más cercano,
        # movida al lugar intermedio.**
        #
        # Mezclarlas parece lo obvio y es lo que arruina el resultado. Aunque las
        # dos piezas queden centradas en el mismo punto, ADENTRO del dibujo no
        # coinciden: el ojo, las facetas de la roca y el musgo están pintados en
        # lugares distintos en cada cuadro, y al 50% se ven los dos a media
        # transparencia. Medido sobre la carrera ya recortada —la buena, con el
        # salto de silueta en 1,2 unidades— igual salían dos ojos.
        #
        # Sin mezcla no hay fantasma posible: los píxeles son los de un cuadro
        # dibujado, sin tocar. Lo que se paga es un salto a mitad de camino, del
        # tamaño de lo que difieran los dos dibujos, que entre cuadros vecinos de
        # un ciclo coherente es poco. Para línea con contorno negro, nítido gana.
        pieza = p if t < 0.5 else q
        _pegar(acumRGB, acumA, pieza['rgba'],
               cx + mx - pieza['px'], cy + my - pieza['py'], 1.0)
    # Las piezas sin pareja: existen en un cuadro y no en el otro, así que van
    # enteras cuando toca su cuadro y no van cuando toca el otro. Apagarlas a
    # media transparencia sería el mismo fantasma en chico.
    for i, p in enumerate(pa):
        if i not in hechosA and t < 0.5:
            _pegar(acumRGB, acumA, p['rgba'],
                   cx + p['dx'] - p['px'], cy + p['dy'] - p['py'], 1.0)
    for j, q in enumerate(pb):
        if j not in hechosB and t >= 0.5:
            _pegar(acumRGB, acumA, q['rgba'],
                   cx + q['dx'] - q['px'], cy + q['dy'] - q['py'], 1.0)

    # **Se divide por el alfa SIN recortar.** Donde dos piezas se pisan, `acumA`
    # llega a 1,8 y el color acumulado viene multiplicado por ese mismo 1,8;
    # dividiéndolo por el alfa ya recortado a 1 el color sale casi al doble y la
    # zona revienta a blanco. Es el fogonazo que aparecía en el puño cada vez que
    # una mano quedaba encima del cuerpo.
    suma = np.maximum(acumA, 1e-4)
    rgb = acumRGB / suma[:, :, None]
    alfa = np.clip(acumA, 0, 1)
    out = np.zeros((lado, lado, 4), dtype=np.uint8)
    out[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    out[:, :, 3] = np.clip(alfa * 255, 0, 255).astype(np.uint8)

    im = Image.fromarray(out)
    caja = im.getbbox()
    if caja is None:
        raise SystemExit('el cuadro intermedio salió vacío')
    im = im.crop(caja)
    a2 = np.array(im)[:, :, 3] > 40
    ys, xs = np.nonzero(a2)
    return im, (float(xs.mean()), float(ys.mean()))


def densificar(fila: list, cuantos: int, ciclo: bool, etiqueta: str) -> list:
    """La acción con `cuantos` cuadros nuevos entre cada par."""
    nueva = []
    ultimo = len(fila) if ciclo else len(fila) - 1
    for k in range(len(fila)):
        nueva.append(fila[k])
        if k >= ultimo:
            continue
        fa, ca = fila[k]
        fb, cb = fila[(k + 1) % len(fila)]
        for n in range(1, cuantos + 1):
            nueva.append(intermedio(fa, ca, fb, cb, n / (cuantos + 1)))
    print(f'  {etiqueta}: {len(fila)} -> {len(nueva)} cuadros')
    return nueva


def main() -> int:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    slug = sys.argv[1].lower()
    pedidos: list[tuple[str, int]] = []
    for arg in sys.argv[2:]:
        if arg.startswith('--'):
            continue
        for parte in arg.split(','):
            nombre, _, n = parte.partition('=')
            pedidos.append((nombre, int(n) if n.isdigit() else 1))
    if not pedidos:
        raise SystemExit(__doc__)
    ciclo = '--ciclo' in sys.argv
    ver = '--ver' in sys.argv

    carpeta = ARTE / slug
    datos, piezas = ra.desempacar(carpeta)
    for nombre, _ in pedidos:
        if nombre not in piezas:
            raise SystemExit(f'{slug} no tiene la acción {nombre}')

    for nombre, cuantos in pedidos:
        nueva = densificar(piezas[nombre], cuantos, ciclo, f'{slug}/{nombre}')
        if ver:
            CW = 240
            tira = Image.new('RGBA', (CW * len(nueva), CW), (24, 24, 28, 255))
            for c, (f, _) in enumerate(nueva):
                e = min((CW - 12) / f.width, (CW - 12) / f.height)
                g = f.resize((max(1, int(f.width * e)), max(1, int(f.height * e))), Image.LANCZOS)
                tira.alpha_composite(g, (c * CW + (CW - g.width) // 2, (CW - g.height) // 2))
            salida = RAIZ / 'shots' / f'intercalado-{slug}-{nombre}.png'
            tira.save(salida)
            print(f'  vista: {salida.relative_to(RAIZ)}')
        else:
            piezas[nombre] = nueva

    if ver:
        print('nada escrito.')
        return 0
    ra.empacar(carpeta, datos, piezas)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
