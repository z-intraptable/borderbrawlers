#!/usr/bin/env python3
"""
Parte una hoja de poses en una imagen por pose.

    python3 scripts/cortar-poses.py arte-crudo/poses/dusk-hoja1.png dusk \\
        idle run punch-windup punch-extended

Si la hoja vino en dos renglones, se corta uno por vez con `banda=N`, contando
desde arriba:

    python3 scripts/cortar-poses.py arte-crudo/poses/ragnir-combate.png ragnir \\
        banda=1 kick-windup kick-extended skill super

Y con `banda=todo` no se recorta nada y se cortan las figuras de la hoja entera.
Es lo que corresponde cuando la hoja no trae rótulos y las figuras están a
distinta altura: quedarse con la franja más alta ahí deja alguna afuera —la de
caída, que va tumbada y más baja que las demás—.

Sale `arte-crudo/poses/dusk-idle.png` y compañía, cada una con la figura sola
sobre blanco. Sirve para dos cosas: subir una pose suelta a Kling como cuadro
inicial de un clip, y mirar el corte antes de gastar créditos en animarlo.

Dos cosas que la hoja trae y no son el personaje:

- **Los rótulos.** Se le pide al generador que no escriba nada y a veces igual
  pone IDLE, RUN, PUNCH bajo cada figura. Se sacan quedándose con la banda
  horizontal de tinta más alta: las figuras son una banda y el texto otra, y
  entre las dos hay filas en blanco.
- **La línea de piso**, que `figuras_de_la_hoja` descarta por proporción.

El corte en columnas lo hace `hoja-sprites.py`, que ya sabe agrupar los miembros
sueltos de Kor y separar poses que se tocan de costado.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from importlib import import_module

hojas = import_module('hoja-sprites')

RAIZ = Path(__file__).resolve().parent.parent


def banda_de_figuras(im: Image.Image, cual: int = 0) -> Image.Image:
    """Se queda con una franja horizontal de tinta.

    Los rótulos viven en su propia franja, separada de las figuras por filas
    limpias. Quedarse con la más alta las deja afuera sin tener que reconocer
    texto, y no molesta cuando la hoja vino sin rótulos: ahí hay una sola
    franja y se devuelve entera.

    `cual` elige entre las franjas altas, contando desde arriba y empezando en
    1. Hace falta porque el generador a veces devuelve la hoja en dos renglones
    en vez de uno —a Ragnir le salieron siete poses en dos filas cuando se le
    pidieron seis en una—, y entonces cada renglón se corta por separado. Con
    `cual` en 0 se devuelve la más alta, que es lo que sirve cuando hay una
    sola.
    """
    tinta = hojas.tinta_de(np.asarray(im.convert('RGB')).astype(np.int16))
    filas = tinta.any(axis=1)
    bandas, ini = [], None
    for y, v in enumerate(filas):
        if v and ini is None:
            ini = y
        elif not v and ini is not None:
            bandas.append((ini, y))
            ini = None
    if ini is not None:
        bandas.append((ini, len(filas)))
    if not bandas:
        raise SystemExit('la hoja está vacía')
    if cual > 0:
        # Sólo las franjas altas son renglones de figuras; las bajas son
        # rótulos o la línea de piso.
        alto = max(b[1] - b[0] for b in bandas)
        altas = [b for b in bandas if (b[1] - b[0]) >= alto * 0.4]
        if cual > len(altas):
            raise SystemExit(
                f'la hoja tiene {len(altas)} renglones y se pidió el {cual}')
        y0, y1 = altas[cual - 1]
    else:
        y0, y1 = max(bandas, key=lambda b: b[1] - b[0])
    margen = 10
    return im.crop((0, max(0, y0 - margen), im.width,
                    min(im.height, y1 + margen)))


def main() -> None:
    if len(sys.argv) < 4:
        raise SystemExit(__doc__)
    hoja = Path(sys.argv[1])
    if not hoja.is_absolute():
        hoja = RAIZ / hoja
    slug = sys.argv[2].lower()
    nombres = sys.argv[3:]
    cual = 0
    if nombres and nombres[0].startswith('banda='):
        valor = nombres[0].split('=', 1)[1]
        cual = -1 if valor == 'todo' else int(valor)
        nombres = nombres[1:]

    entera = Image.open(hoja).convert('RGB')
    im = entera if cual < 0 else banda_de_figuras(entera, cual)
    recorte = hoja.parent / f'.{slug}-banda.png'
    im.save(recorte)
    try:
        figuras = hojas.figuras_de_la_hoja(recorte, len(nombres))
    finally:
        recorte.unlink(missing_ok=True)

    for nombre, figura in zip(nombres, figuras):
        a = hojas.tinta_de(np.asarray(figura).astype(np.int16))
        ys, xs = np.nonzero(a)
        caja = (max(0, int(xs.min()) - 14), max(0, int(ys.min()) - 14),
                min(figura.width, int(xs.max()) + 15),
                min(figura.height, int(ys.max()) + 15))
        salida = hoja.parent / f'{slug}-{nombre}.png'
        figura.crop(caja).save(salida)
        print(f'  {nombre:16s} {caja[2] - caja[0]:4d}x{caja[3] - caja[1]:<4d} {salida}')


if __name__ == '__main__':
    main()
