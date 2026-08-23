#!/usr/bin/env python3
"""Borra los pedazos de fondo blanco que quedaron ENCERRADOS adentro del dibujo.

`alfa.py` saca el fondo inundando desde los bordes, y eso deja afuera cualquier
región blanca que el propio personaje encierre: el hueco entre las piernas, el
de un brazo en jarra, el de una capa. En la hoja de Asuri quedó un trapecio
blanco entre las piernas que ocupa el 6,6% del cuadro y se ve en cada golpe.

**El tamaño NO alcanza para decidir, y creerlo casi le come la cabeza a Dusk.**
La primera versión borraba toda región encerrada de más del 2,5% del cuadro. Con
esa regla, el 3,0% que marcaba en `dusk/super[0]` era el mechón de pelo blanco:
aplicarlo le dejaba un agujero en la cabeza. Un hueco de fondo y un blanco del
dibujo son topológicamente lo mismo —una mancha blanca rodeada de línea negra—,
así que la máquina puede proponer pero no decidir.

Entonces esto va en dos tiempos:

    python3 scripts/blancos-sueltos.py            # lista y dibuja la hoja de contacto
    python3 scripts/blancos-sueltos.py --aplicar asuri/punch[1] asuri/idle[0]

`--aplicar` sólo borra lo que se le nombra. No hay forma de borrar a ciegas.
"""
from __future__ import annotations

import json
import pathlib
import re
import sys

import numpy as np
from PIL import Image

RAIZ = pathlib.Path(__file__).resolve().parent.parent
ARTE = RAIZ / 'public' / 'art'
SALIDA = RAIZ / 'shots' / 'blancos.png'
LISTA = RAIZ / 'shots' / 'blancos.json'

#: Qué tan blanco y qué tan gris tiene que ser un pixel para ser candidato.
CLARO = 232
GRIS = 14
#: Fracción del cuadro a partir de la cual una región vale la pena mirar.
#: A 0,4% salen 166 regiones y casi todas son dientes, ojos y hebillas. El
#: corte estaba en 1,2% pero los parches de skill/jump de Kor (23/08) medían
#: 0,9-1,05% y se veían perfectamente en el juego: 0,8% los agarra sin volver
#: al ruido de los dientes.
UMBRAL = 0.008


def etiquetar(mask: np.ndarray) -> list[np.ndarray]:
    """Regiones conectadas (4-vecinos) de `mask`, sin scipy y sin BFS por pixel.

    Etiqueta por CORRIDAS: cada fila se parte en tramos contiguos y cada tramo se
    une con los que se solapan en la fila de arriba, con union-find. Recorre los
    tramos, no los pixeles, así que la hoja entera sale en segundos en vez de
    minutos.

    Nota para el que venga después: `ImageDraw.floodfill` parece el camino corto
    y NO sirve acá. Sobre una imagen hecha con `Image.fromarray`, Pillow la marca
    de sólo lectura y `load()` descarta las escrituras SIN error — el relleno
    devuelve cero pixeles cambiados y el detector informa que está todo limpio.
    """
    alto, ancho = mask.shape
    padre: list[int] = [0]

    def raiz(a: int) -> int:
        while padre[a] != a:
            padre[a] = padre[padre[a]]
            a = padre[a]
        return a

    def unir(a: int, b: int) -> None:
        ra, rb = raiz(a), raiz(b)
        if ra != rb:
            padre[max(ra, rb)] = min(ra, rb)

    # Todas las corridas de la máscara de una sola pasada de numpy. Hacerlo fila
    # por fila en Python costaba más que el etiquetado entero.
    pad = np.zeros((alto, ancho + 2), dtype=np.int8)
    pad[:, 1:-1] = mask
    borde = np.diff(pad, axis=1)
    filaI, iniX = np.nonzero(borde == 1)
    _, finX = np.nonzero(borde == -1)
    corte = np.searchsorted(filaI, np.arange(alto + 1))

    etis = np.zeros(len(iniX), dtype=np.int64)
    for y in range(alto):
        a0, a1 = corte[y], corte[y + 1]
        if a0 == a1:
            continue
        p0, p1 = (corte[y - 1], corte[y]) if y else (0, 0)
        j = p0
        for k in range(a0, a1):
            a, b = iniX[k], finX[k]
            # Los tramos vienen ordenados y no se pisan, así que un tramo de
            # arriba que termina antes de `a` tampoco toca a los que siguen: el
            # puntero avanza y no vuelve. Cruzarlos todos contra todos era lo que
            # hacía que la hoja tardara minutos.
            while j < p1 and finX[j] <= a:
                j += 1
            eti = 0
            jj = j
            while jj < p1 and iniX[jj] < b:
                if eti == 0:
                    eti = raiz(int(etis[jj]))
                else:
                    unir(eti, int(etis[jj]))
                jj += 1
            if eti == 0:
                eti = len(padre)
                padre.append(eti)
            etis[k] = eti

    porRaiz: dict[int, list[tuple[int, int, int]]] = {}
    for y in range(alto):
        for k in range(corte[y], corte[y + 1]):
            porRaiz.setdefault(raiz(int(etis[k])), []).append((y, int(iniX[k]), int(finX[k])))
    return list(porRaiz.values())


def tamano(tramos: list[tuple[int, int, int]]) -> int:
    """Pixeles de una región, contados sobre las corridas."""
    return sum(b - a for _, a, b in tramos)


def caja(tramos: list[tuple[int, int, int]]) -> list[int]:
    """Caja envolvente [x0, y0, x1, y1] de una región."""
    return [min(a for _, a, _ in tramos), tramos[0][0],
            max(b for _, _, b in tramos) - 1, tramos[-1][0]]


def pintar(tramos: list[tuple[int, int, int]], forma: tuple[int, int]) -> np.ndarray:
    """Máscara booleana de una región. Sólo para las que sobreviven al umbral."""
    m = np.zeros(forma, dtype=bool)
    for y, a, b in tramos:
        m[y, a:b] = True
    return m


def candidatos() -> list[dict]:
    """Todas las regiones blancas encerradas que pasan el umbral, con su caja."""
    hallados = []
    for carpeta in sorted(ARTE.iterdir()):
        manifiesto = carpeta / 'hojas.json'
        if not manifiesto.is_file():
            continue
        datos = json.loads(manifiesto.read_text())
        hoja = np.array(Image.open(carpeta / 'hojas.png').convert('RGBA'))
        for accion, anim in datos['animations'].items():
            for i, cuadro in enumerate(anim['frames']):
                x, y, w, h = cuadro['rect']
                celda = hoja[y:y + h, x:x + w]
                rgb = celda[:, :, :3].astype(np.int16)
                mask = ((celda[:, :, 3] > 200) & (rgb.min(axis=2) > CLARO)
                        & ((rgb.max(axis=2) - rgb.min(axis=2)) < GRIS))
                if mask.sum() < UMBRAL * w * h:
                    continue
                for tramos in etiquetar(mask):
                    n = tamano(tramos)
                    if n < UMBRAL * w * h:
                        continue
                    hallados.append({
                        'slug': carpeta.name, 'accion': accion, 'i': i,
                        'px': n, 'pct': round(100 * n / (w * h), 2),
                        'caja': caja(tramos), 'rect': [x, y, w, h],
                    })
    return hallados


def hoja_de_contacto(hallados: list[dict]) -> None:
    """Dibuja cada candidato con la región en magenta, para decidir mirando."""
    hojas: dict[str, Image.Image] = {}
    tiras = []
    for c in hallados:
        if c['slug'] not in hojas:
            hojas[c['slug']] = Image.open(ARTE / c['slug'] / 'hojas.png').convert('RGBA')
        x, y, w, h = c['rect']
        celda = np.array(hojas[c['slug']].crop((x, y, x + w, y + h)))
        rgb = celda[:, :, :3].astype(np.int16)
        mask = ((celda[:, :, 3] > 200) & (rgb.min(axis=2) > CLARO)
                & ((rgb.max(axis=2) - rgb.min(axis=2)) < GRIS))
        for tramos in etiquetar(mask):
            if tamano(tramos) >= UMBRAL * w * h:
                celda[pintar(tramos, mask.shape)] = [255, 0, 180, 255]
        img = Image.fromarray(celda)
        img.thumbnail((190, 190))
        tiras.append((c, img))

    if not tiras:
        return
    COL, ALTO = 8, 210
    filas = (len(tiras) + COL - 1) // COL
    lienzo = Image.new('RGB', (COL * 200, filas * ALTO), (18, 20, 28))
    for n, (c, img) in enumerate(tiras):
        cx, cy = (n % COL) * 200, (n // COL) * ALTO
        lienzo.paste(img, (cx + (200 - img.width) // 2, cy + ALTO - img.height), img)
    SALIDA.parent.mkdir(parents=True, exist_ok=True)
    lienzo.save(SALIDA)
    print(f'\nhoja de contacto: {SALIDA.relative_to(RAIZ)}  (magenta = lo que se borraría)')


def aplicar(nombres: list[str]) -> int:
    """Borra las regiones nombradas como `slug/accion[i]`."""
    pedidos = set()
    for n in nombres:
        m = re.fullmatch(r'([a-z0-9-]+)/([a-z]+)\[(\d+)\](?:#(\d+))?', n)
        if m is None:
            print(f'no entiendo "{n}"; se escribe asi: asuri/punch[1] o asuri/punch[1]#2')
            return 1
        pedidos.add((m.group(1), m.group(2), int(m.group(3)),
                     int(m.group(4)) if m.group(4) else 1))

    borrados = 0
    for slug in sorted({p[0] for p in pedidos}):
        carpeta = ARTE / slug
        datos = json.loads((carpeta / 'hojas.json').read_text())
        hoja = np.array(Image.open(carpeta / 'hojas.png').convert('RGBA'))
        for _, accion, i, cual in sorted(p for p in pedidos if p[0] == slug):
            x, y, w, h = datos['animations'][accion]['frames'][i]['rect']
            celda = hoja[y:y + h, x:x + w]
            rgb = celda[:, :, :3].astype(np.int16)
            mask = ((celda[:, :, 3] > 200) & (rgb.min(axis=2) > CLARO)
                    & ((rgb.max(axis=2) - rgb.min(axis=2)) < GRIS))
            # De la más grande a la más chica, y se borra SÓLO la que se pidió.
            # Borrar todas las que pasan el umbral se lleva puestos los dientes
            # de Asuri, que en un cuadro de puño miden 1,3%.
            regiones = sorted(etiquetar(mask), key=tamano, reverse=True)
            regiones = [r for r in regiones if tamano(r) >= UMBRAL * w * h]
            if cual > len(regiones):
                print(f'  {slug}/{accion}[{i}]#{cual} no existe; hay {len(regiones)}')
                continue
            tramos = regiones[cual - 1]
            celda[:, :, 3][pintar(tramos, mask.shape)] = 0
            hoja[y:y + h, x:x + w] = celda
            print(f'  {slug}/{accion}[{i}]#{cual}  {tamano(tramos)} px borrados')
            borrados += 1
        Image.fromarray(hoja).save(carpeta / 'hojas.png')
        print(f'{slug}/hojas.png reescrito')
    return 0 if borrados else 1


def main() -> int:
    if '--aplicar' in sys.argv:
        resto = sys.argv[sys.argv.index('--aplicar') + 1:]
        if not resto:
            print('--aplicar necesita qué borrar, p.ej. asuri/punch[1]')
            return 1
        return aplicar(resto)

    hallados = candidatos()
    LISTA.parent.mkdir(parents=True, exist_ok=True)
    LISTA.write_text(json.dumps(hallados, indent=1))
    porCuadro: dict[tuple, int] = {}
    for c in hallados:
        clave = (c['slug'], c['accion'], c['i'])
        porCuadro[clave] = porCuadro.get(clave, 0) + 1
    for c in hallados:
        clave = (c['slug'], c['accion'], c['i'])
        suf = '' if porCuadro[clave] == 1 else '  (hay más de una en el cuadro)'
        print(f"  {c['slug']}/{c['accion']}[{c['i']}]  {c['px']} px = {c['pct']}%{suf}")
    print(f'\n{len(hallados)} región(es) candidata(s).')
    hoja_de_contacto(hallados)
    print('Mirá la hoja y borrá sólo las que sean fondo:\n'
          '  python3 scripts/blancos-sueltos.py --aplicar asuri/punch[1] ...')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
