#!/usr/bin/env python3
"""
Corta una hoja de llamas de Kling en una tira de cuadros lista para Pixi.

    python3 scripts/hoja-fuego.py arte-crudo/escenarios/fuego-verde.png \
        public/escenarios/fuego-verde 6

No sirve `hoja-sprites.py` para esto, y por dos razones que son justo al revés
de lo que un personaje necesita:

- **Alinea por abajo, no por el centroide.** Una hoguera está clavada al piso;
  si se alinea por el centro de masa, la base se mueve entre cuadros y el fuego
  parece flotar y hundirse.
- **No normaliza el tamaño de cada cuadro.** En un personaje la escala pareja es
  obligatoria —si no, late—. En una llama el cambio de alto ENTRE cuadros es la
  animación: es lo que hace que crezca y baje. Se normaliza la tira entera de
  una vez, tomando el cuadro más alto como referencia.

Sale un PNG con los cuadros en fila y un JSON con la celda, para que el juego
arme un `AnimatedSprite` con una textura sola.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np
from PIL import Image

# `hoja-sprites` tiene guión en el nombre y no se importa por `import`.
import importlib.util

_spec = importlib.util.spec_from_file_location(
    'hojasprites', Path(__file__).resolve().parent / 'hoja-sprites.py')
_hs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_hs)

# Alto del cuadro más alto de la tira, en píxeles. El fuego se dibuja a lo sumo
# a un quinto del alto de pantalla, así que 384 alcanza y sobra.
ALTO = 384
MARGEN = 4


def por_columnas(hoja: Path, cuantos: int) -> list[Image.Image]:
    """Parte la hoja por las columnas vacías.

    A las poses de un personaje no se las puede cortar así —un puño extendido se
    mete en la columna del vecino, y por eso `hoja-sprites.py` etiqueta manchas—,
    pero una llama es vertical y no invade a la de al lado. El corte por columnas
    es exacto acá, y cuesta milisegundos en vez del minuto largo que tarda el
    relleno por líneas en Python sobre cuatro megapíxeles.

    La línea de piso que el generador dibuja bajo las llamas se corta acá y no
    con `sin_borde`. `sin_borde` la BLANQUEA, y esa fila blanca queda adentro del
    dibujo: el relleno de alfa entra por ahí y le come la base a cada llama,
    dejando además las cuñas blancas de abajo de la línea, que ya no tocan
    ningún borde y se quedan opacas. Cortar la hoja arriba de la línea saca las
    dos cosas de una y encima deja a las seis llamas apoyadas en la misma altura.
    """
    im = Image.open(hoja).convert('RGB')
    tinta = _hs.tinta_de(np.asarray(im).astype(np.int16))

    # Una fila de tinta que cruza casi toda la hoja es la línea de piso dibujada:
    # la fila más cargada de una llama no pasa del 65%.
    piso = np.nonzero(tinta.sum(axis=1) / im.width > 0.85)[0]
    if len(piso):
        im = im.crop((0, 0, im.width, int(piso.min())))
        tinta = tinta[:int(piso.min())]
    # No alcanza con "¿hay algún píxel?": donde `sin_borde` raspa la línea de
    # piso quedan una decena de píxeles sueltos por columna, y con eso la hoja
    # entera sale como una sola llama. Se pide tinta de verdad — un 3% de la
    # columna más cargada, o un 1% del alto, lo que sea más — y esas sobras se
    # caen solas sin tocar las puntas finas de las llamas, que miden mucho más.
    carga = tinta.sum(axis=0)
    lleno = carga > max(im.height * 0.01, carga.max() * 0.03)

    tramos, arranque = [], None
    for x, hay in enumerate(lleno):
        if hay and arranque is None:
            arranque = x
        elif not hay and arranque is not None:
            tramos.append((arranque, x))
            arranque = None
    if arranque is not None:
        tramos.append((arranque, len(lleno)))

    if cuantos and len(tramos) != cuantos:
        raise SystemExit(f'salieron {len(tramos)} llamas y se esperaban {cuantos}')
    return [im.crop((a, 0, b, im.height)) for a, b in tramos]


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    origen = Path(sys.argv[1])
    destino = Path(sys.argv[2])
    cuantos = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    # Cuáles de las llamas cortadas entran en la tira, contando desde 1. Sirve
    # para dejar afuera la que el generador dibujó distinta: en la hoja verde la
    # sexta tiene una gota blanca en el medio que ninguna otra tiene, y en un
    # ciclo de seis cuadros eso es un parpadeo.
    quedan = [int(n) for n in sys.argv[4].split(',')] if len(sys.argv) > 4 else []

    figuras = por_columnas(origen, cuantos)
    print(f'  {len(figuras)} llamas en {origen.name}')
    if quedan:
        figuras = [figuras[n - 1] for n in quedan]
        print(f'  quedan {len(figuras)}: {quedan}')

    # Recorte con alfa, guardando la caja de cada una en coordenadas de la hoja
    # para poder alinearlas por la base: la línea de piso es la misma para todas.
    cortes = []
    for fig in figuras:
        con_alfa = _hs.inundar(fig)
        a = np.array(con_alfa.getchannel('A'))
        ys, xs = np.nonzero(a > 40)
        cortes.append(con_alfa.crop(
            (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)))

    escala = ALTO / max(c.height for c in cortes)
    cortes = [c.resize((max(1, round(c.width * escala)),
                        max(1, round(c.height * escala))), Image.LANCZOS)
              for c in cortes]

    celda = (max(c.width for c in cortes) + MARGEN * 2,
             max(c.height for c in cortes) + MARGEN * 2)
    tira = Image.new('RGBA', (celda[0] * len(cortes), celda[1]), (0, 0, 0, 0))
    for i, c in enumerate(cortes):
        # Centrada en x y pegada abajo: el ancla del juego es la base.
        tira.paste(c, (i * celda[0] + (celda[0] - c.width) // 2,
                       celda[1] - MARGEN - c.height))

    destino.parent.mkdir(parents=True, exist_ok=True)
    tira.save(destino.with_suffix('.png'))
    destino.with_suffix('.json').write_text(json.dumps({
        '_': 'Tira de llamas cortada por scripts/hoja-fuego.py. El ancla es la '
             'base del cuadro, no su centro: la hoguera está clavada al piso.',
        'file': destino.with_suffix('.png').name,
        'cell': list(celda),
        'frames': len(cortes),
        'base': MARGEN,
    }, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'  {destino.with_suffix(".png")}  {tira.size}  celda {celda[0]}x{celda[1]}')


if __name__ == '__main__':
    main()
