#!/usr/bin/env python3
"""Rehace UNA acción de una hoja de sprites, sin tocar las demás.

`hoja-sprites.py` corta el personaje entero y necesita la receta completa: de
dónde sale cada una de las nueve acciones. Esa receta no quedó escrita en
ningún lado, así que arreglar una carrera mal cortada obligaba a reconstruirla
entera y arriesgar las ocho que estaban bien.

Acá se lee la hoja que ya existe, se le devuelven los cuadros a su estado
recortado, se reemplaza la fila de UNA acción, y se vuelve a empacar la grilla.
Lo demás pasa intacto: mismos píxeles, mismo `unit`, mismos `ground`.

El caso que lo motivó: el clip de Kor son tres segundos con CUATRO poses de
brazos distintas —puños al frente, un puño disparado a la izquierda, brazos
abiertos, brazos al costado—, y el diezmado uniforme toma un cuadro de cada
zona. Reproducido, el brazo salta entre poses que no son parte del mismo ciclo.
El arreglo es cortar sólo el tramo coherente.

    # mirar antes de escribir
    python3 scripts/recortar-accion.py kor run=arte-crudo/clips/kor-run.mp4:2.0:3.05 --ver
    # escribir
    python3 scripts/recortar-accion.py kor run=arte-crudo/clips/kor-run.mp4:2.0:3.05
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
VISTA = RAIZ / 'shots' / 'recorte.png'

_spec = importlib.util.spec_from_file_location('hs', RAIZ / 'scripts' / 'hoja-sprites.py')
hs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(hs)


def tinta(img: Image.Image) -> int:
    """Píxeles opacos de una figura: la medida de tamaño que usa el cortador."""
    return int((np.array(img)[:, :, 3] > 40).sum())


def desempacar(carpeta: pathlib.Path) -> tuple[dict, dict[str, list]]:
    """Devuelve el manifiesto y cada cuadro como (figura recortada, centroide)."""
    datos = json.loads((carpeta / 'hojas.json').read_text())
    hoja = Image.open(carpeta / 'hojas.png').convert('RGBA')
    piezas: dict[str, list] = {}
    for nombre, anim in datos['animations'].items():
        fila = []
        for cuadro in anim['frames']:
            x, y, w, h = cuadro['rect']
            ax, ay = cuadro['anchor']
            # El rect lleva MARGEN de aire alrededor de la figura; se lo saco
            # para que el reempaque lo vuelva a poner y no se acumule.
            crudo = hoja.crop((x, y, x + w, y + h))
            figura = crudo.crop((hs.MARGEN, hs.MARGEN, w - hs.MARGEN, h - hs.MARGEN))
            fila.append((figura, (ax * w - hs.MARGEN, ay * h - hs.MARGEN)))
        piezas[nombre] = fila
    return datos, piezas


def cortar(origen: str) -> list:
    """Figuras nuevas de un clip `ruta:desde:hasta` o de una hoja `ruta:cuantas`."""
    partes = origen.split(':')
    ruta = pathlib.Path(partes[0])
    if not ruta.is_absolute():
        ruta = RAIZ / ruta
    if not ruta.exists():
        raise SystemExit(f'no existe {ruta}')
    if ruta.suffix.lower() in ('.mp4', '.webm', '.mov'):
        desde = float(partes[1]) if len(partes) > 1 and partes[1] else 0.0
        hasta = float(partes[2]) if len(partes) > 2 and partes[2] else 0.0
        crudos = hs.diezmar(hs.cuadros_del_clip(ruta, desde, hasta), hs.CUADROS)
    else:
        esperadas = int(partes[1]) if len(partes) > 1 and partes[1] else 0
        crudos = hs.figuras_de_la_hoja(ruta, esperadas)
    return [hs.recortar(c) for c in crudos]


def empacar(carpeta: pathlib.Path, datos: dict, piezas: dict[str, list]) -> None:
    """Vuelve a armar la grilla y reescribe hoja y manifiesto."""
    unidad = datos['unit']

    # **El atlas se empaca por estantes, no en una grilla pareja.**
    #
    # La grilla tenía una fila por acción y tantas columnas como la acción más
    # larga —la carrera, con doce—, así que el puñetazo de dos cuadros dejaba
    # diez celdas vacías. Medido antes de cambiarlo: 12x9 = 108 celdas para 44
    # cuadros, o sea **40% ocupado**. Eran 82,6 Mpx de textura para 33,2 Mpx de
    # dibujo, 331 MB de memoria de GPU, y dos personajes con el atlas más ancho
    # que los 4096 px que declaran de límite muchas GPU de teléfono.
    #
    # Empacado por estantes no hay celda: cada cuadro ocupa lo suyo. Se ordena
    # por alto para que en cada estante entren cuadros parecidos y sobre poco
    # arriba, y se guarda el orden original aparte porque la animación depende
    # de él.
    #
    # Nada del runtime mira la grilla: `loadSheets.ts` sólo lee el `rect` de cada
    # cuadro. Por eso esto se puede cambiar sin tocar una línea del juego.
    todos = []
    for nombre, fila in piezas.items():
        for i, (figura, centro) in enumerate(fila):
            todos.append({
                'accion': nombre, 'i': i, 'fig': figura, 'centro': centro,
                'w': figura.width + hs.MARGEN * 2,
                'h': figura.height + hs.MARGEN * 2,
            })

    area = sum(c['w'] * c['h'] for c in todos)
    # Un ancho que deje el atlas más o menos cuadrado y por debajo del límite de
    # 4096. Se prueba de menor a mayor y se toma el primero que dé un alto que
    # también entre.
    ancho = 4096
    for candidato in (1024, 2048, 4096):
        if area / candidato <= candidato:
            ancho = candidato
            break
    ancho = max(ancho, max(c['w'] for c in todos))

    orden = sorted(todos, key=lambda c: (-c['h'], -c['w']))
    x = y = estante = 0
    for c in orden:
        if x + c['w'] > ancho:
            x = 0
            y += estante
            estante = 0
        c['x'], c['y'] = x, y
        x += c['w']
        estante = max(estante, c['h'])
    alto = y + estante

    hoja = Image.new('RGBA', (ancho, alto), (0, 0, 0, 0))
    puestos: dict[str, dict[int, dict]] = {}
    for c in todos:
        hoja.alpha_composite(c['fig'], (c['x'] + hs.MARGEN, c['y'] + hs.MARGEN))
        puestos.setdefault(c['accion'], {})[c['i']] = {
            'rect': [c['x'], c['y'], c['w'], c['h']],
            'anchor': [round((hs.MARGEN + c['centro'][0]) / c['w'], 4),
                       round((hs.MARGEN + c['centro'][1]) / c['h'], 4)],
        }

    for nombre, fila in piezas.items():
        cuadros = [puestos[nombre][i] for i in range(len(fila))]
        piso = round(float(np.median([(f.height - c[1]) / unidad for f, c in fila])), 3)
        datos['animations'][nombre] = {'frames': cuadros, 'ground': piso}

    datos.pop('cell', None)
    usado = sum(c['w'] * c['h'] for c in todos)
    # **Se escribe a un archivo aparte y recién ahí se renombra.** Guardar una
    # hoja de 2,7 MB con `optimize=True` tarda lo suyo, y un corte en el medio
    # —un timeout, un Ctrl-C— deja el PNG a mitad de escribir. Eso ya pasó: el
    # archivo quedó truncado y la única salida fue recuperarlo de git. El
    # renombrado es atómico, así que o está el viejo entero o el nuevo entero.
    tmp_png = carpeta / 'hojas.png.tmp'
    tmp_json = carpeta / 'hojas.json.tmp'
    hoja.save(tmp_png, 'PNG', optimize=True)
    tmp_json.write_text(json.dumps(datos, indent=2, ensure_ascii=False))
    tmp_png.replace(carpeta / 'hojas.png')
    tmp_json.replace(carpeta / 'hojas.json')
    peso = (carpeta / 'hojas.png').stat().st_size / 1e6
    print(f'{carpeta.name:9s} {ancho}x{alto}  {peso:.2f} MB  ·  '
          f'{len(todos)} cuadros  ·  {usado / (ancho * alto) * 100:.0f}% ocupado  ·  '
          f'{ancho * alto * 4 / 1e6:.0f} MB de GPU')


def main() -> int:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    slug = sys.argv[1].lower()
    carpeta = ARTE / slug
    if not carpeta.is_dir():
        raise SystemExit(f'no existe {carpeta}')
    solo_ver = '--ver' in sys.argv

    datos, piezas = desempacar(carpeta)

    for arg in sys.argv[2:]:
        if arg.startswith('--'):
            continue
        nombre, _, origen = arg.partition('=')
        if nombre not in piezas:
            raise SystemExit(f'{slug} no tiene la acción "{nombre}"')
        nuevas = cortar(origen)

        # La escala sale de igualar el LADO de silueta —la raíz del área— con el
        # de los cuadros que se reemplazan. Es la misma medida que usa el
        # cortador, y es lo que garantiza que el personaje no cambie de tamaño
        # entre una acción rehecha y las que quedaron.
        viejo = float(np.median([np.sqrt(tinta(f)) for f, _ in piezas[nombre]]))
        nuevo = float(np.median([np.sqrt(area) for _, _, area in nuevas]))
        escala = viejo / nuevo
        print(f'{nombre}: {len(piezas[nombre])} -> {len(nuevas)} cuadros, escala {escala:.3f}')

        fila = []
        for img, centro, _ in nuevas:
            w, h = max(1, round(img.width * escala)), max(1, round(img.height * escala))
            fila.append((img.resize((w, h), Image.LANCZOS),
                         (centro[0] * escala, centro[1] * escala)))
        piezas[nombre] = fila

        if solo_ver:
            tira = Image.new('RGB', (sum(f.width + 6 for f, _ in fila),
                                     max(f.height for f, _ in fila)), (16, 18, 26))
            px = 0
            for f, _ in fila:
                tira.paste(f, (px, tira.height - f.height), f)
                px += f.width + 6
            VISTA.parent.mkdir(parents=True, exist_ok=True)
            tira.save(VISTA)
            print(f'vista: {VISTA.relative_to(RAIZ)}  (nada escrito)')

    if not solo_ver:
        empacar(carpeta, datos, piezas)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
