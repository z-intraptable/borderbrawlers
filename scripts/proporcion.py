#!/usr/bin/env python3
"""
Mide los miembros de cada personaje y marca al que se salió de la fila.

    python3 scripts/proporcion.py

**No escribe nada.** Antes sí: escalaba las piezas del brazo para llevar a todos
a una fracción fija. Fue un error y quedó documentado acá para no repetirlo. El
brazo de Ragnir daba 63% del alto de figura contra 50% de los otros cinco, y la
lectura fácil —"normalizo a todos"— encogía a los cinco que estaban bien para
tapar el defecto del sexto.

Lo que pasaba de verdad se ve mirando las piezas: la hoja de Ragnir
(`arte-crudo/ragnir-kit-alfa.png`) dibujó **dos brazos enteros** bajo las
etiquetas UPPER ARM y LOWER ARM, y `receta.py` los midió como componentes del
alfa sin poder saber que uno sobraba. Encadenados daban un brazo con dos manos y
el doble de largo. Se arregló en `recetas/ragnir.json`, partiendo el brazo bueno
en el codo — no acá.

De ahí la forma de esta herramienta: **mide y compara, no corrige**. Un número
fuera de la fila es un síntoma; la causa está en la hoja o en la receta, que es
donde hay que ir a mirar.
"""
import json
from pathlib import Path

from PIL import Image

RAIZ = Path(__file__).resolve().parent.parent
ARTE = RAIZ / 'public' / 'art'

# El alto de figura contra el que se mide todo. Es la constante del proyecto:
# `receta.py` calcula el `unit` de cada personaje para que los seis entren a la
# pelea midiendo esto mismo.
ALTO_RIG = 104.0

# Cuánto puede PASARSE un personaje de la mediana del grupo antes de que valga
# la pena ir a mirar su hoja.
#
# La comparación es de un solo lado a propósito. Un miembro más corto que el
# resto es estilo —Ragnir es un dragón rechoncho de cabeza enorme y su brazo da
# 34% contra 51% de los humanoides, igual que en el arte del que salió—. Un
# miembro más largo es el defecto: la única forma de que una cadena de dos
# piezas se pase es que las dos piezas sean el mismo miembro entero, que es
# exactamente lo que había pasado. Con dos brazos encadenados Ragnir daba 63% y
# esto lo hubiera marcado.
EXCESO = 0.15


def largo(manifiesto: dict, carpeta: Path, alto: str, bajo: str) -> float:
    """Largo del miembro entero, en unidades de rig, desde su articulación.

    Es la distancia a la que cuelga el segmento de abajo más lo que ese segmento
    mide por debajo de su propio pivote. El pivote viene en fracción, así que
    hace falta abrir la imagen para saber cuántos píxeles son.
    """
    unit = manifiesto['unit']
    pieza = manifiesto['parts'][bajo]
    alto_px = Image.open(carpeta / pieza['file']).height
    return manifiesto['rig'][alto] + (1 - pieza['pivot'][1]) * alto_px / unit


def main() -> None:
    filas = []
    for carpeta in sorted(c for c in ARTE.iterdir() if c.is_dir()):
        manifiestos = list(carpeta.glob('*.json'))
        if not manifiestos:
            continue
        manifiesto = json.loads(manifiestos[0].read_text())
        if 'rig' not in manifiesto:
            continue
        filas.append((
            carpeta.name,
            largo(manifiesto, carpeta, 'armUpper', 'armLower') / ALTO_RIG,
            largo(manifiesto, carpeta, 'legUpper', 'legLower') / ALTO_RIG,
        ))

    if not filas:
        raise SystemExit(f'no hay manifiestos en {ARTE}')

    def mediana(valores):
        v = sorted(valores)
        medio = len(v) // 2
        return v[medio] if len(v) % 2 else (v[medio - 1] + v[medio]) / 2

    mb = mediana([f[1] for f in filas])
    mp = mediana([f[2] for f in filas])
    print(f'{"":10s} {"brazo":>7s} {"pierna":>8s}     (fracción del alto de figura)')
    sospechosos = []
    for nombre, brazo, pierna in filas:
        marcas = ''
        if brazo > mb * (1 + EXCESO):
            marcas += '  <- brazo largo de más'
            sospechosos.append(nombre)
        if pierna > mp * (1 + EXCESO):
            marcas += '  <- pierna larga de más'
            sospechosos.append(nombre)
        print(f'{nombre:10s} {brazo:6.1%} {pierna:7.1%}{marcas}')
    print(f'{"mediana":10s} {mb:6.1%} {mp:7.1%}')

    if sospechosos:
        print(f'\nMirar la hoja y la receta de: {", ".join(sorted(set(sospechosos)))}.'
              f'\nEl arreglo va en recetas/<slug>.json, no acá: esto sólo mide.')


if __name__ == '__main__':
    main()
