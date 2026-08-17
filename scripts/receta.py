#!/usr/bin/env python3
"""
Escribe la receta de un kit que viene en fila, midiendo la hoja.

    python3 scripts/receta.py arte-crudo/kor-kit-alfa.png Kor > recetas/kor.json

Vale para las hojas que devuelve el prompt de `recetas/PROMPT-KIT-PARTES.md`:
seis piezas sueltas, en una sola fila, de izquierda a derecha en el orden
cabeza · torso · brazo alto · antebrazo · muslo · pantorrilla.

Con esa hoja la receta sale sola y **no hay que estimar nada a ojo**, que es
donde se rompió Kor la primera vez:

- las cajas son los componentes del alfa, medidos;
- el pivote de un miembro es el centro de su borde SUPERIOR, que es la
  articulación de arriba, y `to` el centro del inferior. Las piezas ya vienen
  rectas y verticales, así que no hay que enderezar nada;
- la cabeza se apoya por el centro de su borde INFERIOR —el cuello— y el torso
  por el centro del suyo SUPERIOR.

**El esqueleto se elige, no se hereda.** Es la lección que costó una tarde: el
dibujo viejo de Kor venía explotado, con las piezas separadas para poder
cortarlas, y tomar las articulaciones de dónde había caído cada pieza copió esos
huecos adentro del juego. Acá las piezas están en fila, así que sus posiciones
en la hoja no dicen NADA sobre dónde se cuelgan. Los hombros y las caderas salen
de proporciones sobre el tamaño medido del torso, y `cortar.py` sólo mira
distancias relativas al origen, así que alcanza con inventar un origen y ubicar
todo respecto de él.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ORDEN = ['head', 'torso', 'armUpper', 'armLower', 'legUpper', 'legLower']

# Alto de figura, en unidades de rig, medido sobre Asuri —la receta que ya
# funcionaba— para que todos entren a la pelea del mismo tamaño.
ALTO_RIG = 87.0

# Proporciones del esqueleto, como fracción del SEMIANCHO y del ALTO medidos del
# torso. Salen de los números con los que Kor quedó bien armado tras la
# corrección: shoulderX 17 y hipX 8 contra un semiancho de torso de 15 unidades,
# shoulderY 7 y hipY 25 contra un alto de 31.
SHOULDER_X = 1.13   # del semiancho del torso; mayor que 1 = el brazo apoya por fuera
HIP_X = 0.53        # del semiancho del torso
SHOULDER_Y = 0.22   # del alto del torso, hacia abajo desde el origen
HIP_Y = 0.80        # del alto del torso
# Cuánto BAJA el cuello respecto del origen, como fracción del alto del torso.
# Positivo: la cabeza se mete adentro del torso, que es lo que corresponde en
# personajes sin cuello. Medido con scripts/armar.py — con el cuello al ras del
# hombro la cabeza queda flotando.
#
# `cortar.py` calcula headY como (joint de la cabeza - origen) / unit, y el
# joint de la cabeza es su posición EN LA FILA, que no dice nada del esqueleto.
# Por eso el origen se despeja de acá y no al revés.
HEAD_Y = 0.19


def componentes(alpha: np.ndarray, minimo: int = 2000):
    """Islas del alfa, por barrido de líneas con union-find. Sin scipy."""
    solido = alpha > 16
    h, w = solido.shape
    padre = {}

    def raiz(a):
        while padre[a] != a:
            padre[a] = padre[padre[a]]
            a = padre[a]
        return a

    def unir(a, b):
        ra, rb = raiz(a), raiz(b)
        if ra != rb:
            padre[rb] = ra

    # Tramos por fila y su enlace con la fila de arriba.
    previa = []
    etiquetas = {}
    for y in range(h):
        fila = solido[y]
        if not fila.any():
            previa = []
            continue
        bordes = np.flatnonzero(np.diff(np.concatenate(([0], fila.view(np.int8), [0]))))
        tramos = list(zip(bordes[::2], bordes[1::2]))
        actual = []
        for x0, x1 in tramos:
            clave = (y, x0)
            padre[clave] = clave
            etiquetas[clave] = (x0, x1, y)
            for py0, py1, pclave in previa:
                if x0 < py1 and py0 < x1:
                    unir(pclave, clave)
            actual.append((x0, x1, clave))
        previa = actual

    cajas = {}
    for clave, (x0, x1, y) in etiquetas.items():
        r = raiz(clave)
        if r not in cajas:
            cajas[r] = [x0, y, x1, y + 1, 0]
        c = cajas[r]
        c[0] = min(c[0], x0); c[1] = min(c[1], y)
        c[2] = max(c[2], x1); c[3] = max(c[3], y + 1)
        c[4] += x1 - x0
    salida = [(x0, y0, x1 - x0, y1 - y0, px)
              for x0, y0, x1, y1, px in cajas.values() if px >= minimo]
    salida.sort(key=lambda c: c[0])
    return salida


def fusionar_apiladas(piezas):
    """Une la mano al antebrazo y la bota a la pantorrilla.

    Es el defecto más común del generador: devuelve el miembro como un segmento
    MÁS la mano o el pie sueltos justo abajo, y ahí la hoja cuenta siete u ocho
    islas en vez de seis. Regenerar sale caro y no siempre sale mejor; fusionar
    es determinista y además es lo que el rig quiere, porque esas dos partes
    **tienen** que moverse juntas.

    El criterio es geométrico y estrecho a propósito: se unen sólo dos islas que
    se solapan en x y están una encima de la otra a menos de un tercio de la
    altura de la de arriba. Dos piezas distintas de la fila no se solapan en x
    —están una al lado de la otra— así que no hay forma de que se toquen por
    accidente. Medido en Kor, las separaciones reales eran de 12 y 25 px contra
    piezas de 800 de alto.
    """
    piezas = [list(p) for p in piezas]
    while len(piezas) > 6:
        mejor = None
        for i in range(len(piezas)):
            for j in range(len(piezas)):
                if i == j:
                    continue
                ax, ay, aw, ah, _ = piezas[i]
                bx, by, bw, bh, _ = piezas[j]
                if by < ay + ah:            # b tiene que estar más abajo
                    continue
                solape = min(ax + aw, bx + bw) - max(ax, bx)
                if solape < 0.45 * min(aw, bw):
                    continue
                hueco = by - (ay + ah)
                if hueco > ah / 3:
                    continue
                if mejor is None or hueco < mejor[0]:
                    mejor = (hueco, i, j)
        if mejor is None:
            break
        _, i, j = mejor
        ax, ay, aw, ah, apx = piezas[i]
        bx, by, bw, bh, bpx = piezas[j]
        x0, y0 = min(ax, bx), min(ay, by)
        x1, y1 = max(ax + aw, bx + bw), max(ay + ah, by + bh)
        piezas[i] = [x0, y0, x1 - x0, y1 - y0, apx + bpx]
        piezas.pop(j)
    piezas.sort(key=lambda c: c[0])
    return [tuple(p) for p in piezas]


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit('uso: receta.py <hoja-alfa.png> <Armadura>')
    ruta, armadura = Path(sys.argv[1]), sys.argv[2]
    alpha = np.asarray(Image.open(ruta).convert('RGBA'))[:, :, 3]
    crudas = componentes(alpha)
    piezas = fusionar_apiladas(crudas)
    if len(crudas) != len(piezas):
        print(f'# {len(crudas)} islas -> {len(piezas)} tras fusionar apiladas',
              file=sys.stderr)
    if len(piezas) != 6:
        raise SystemExit(
            f'{ruta}: {len(piezas)} piezas, se esperaban 6. '
            f'El kit no sirve: regenerar (ver recetas/PROMPT-KIT-PARTES.md).')

    # numpy devuelve int64 y `json` no lo serializa.
    caja = {n: [int(v) for v in p[:4]] for n, p in zip(ORDEN, piezas)}
    tw, th = caja['torso'][2], caja['torso'][3]
    hh = caja['head'][3]
    lu, ll = caja['legUpper'][3], caja['legLower'][3]

    # El alto de figura es cabeza + torso + las dos piezas de pierna.
    alto_px = hh + th + lu + ll
    unit = round(alto_px / ALTO_RIG, 3)

    def centro_x(n):
        return caja[n][0] + caja[n][2] / 2

    # El origen se DESPEJA del cuello de la cabeza, porque `cortar.py` calcula
    # headY como (joint de la cabeza - origen) / unit y el joint de la cabeza
    # está donde la pieza cayó en la fila. Puesto así, headY sale igual a
    # HEAD_Y sin importar dónde esté dibujada la cabeza.
    ox = round(centro_x('torso'))
    cuello = caja['head'][1] + caja['head'][3]
    oy = round(cuello - HEAD_Y * th)

    sx = round(SHOULDER_X * tw / 2)
    sy = round(oy + SHOULDER_Y * th)
    hx = round(HIP_X * tw / 2)
    hy = round(oy + HIP_Y * th)

    def limbo(n):
        x, y, w, h = caja[n]
        return {'box': [x, y, w, h],
                'from': [round(x + w / 2), y],
                'to': [round(x + w / 2), y + h]}

    receta = {
        '_': f'{armadura}. Kit generado en fila con el prompt de '
             f'recetas/PROMPT-KIT-PARTES.md y escrito por scripts/receta.py '
             f'midiendo la hoja: las seis cajas son componentes del alfa, no '
             f'estimaciones. Las piezas ya vienen rectas y verticales.',
        '_esqueleto': 'Los hombros y las caderas NO salen de dónde cayó cada '
                      'pieza en la hoja —están en fila, esa posición no dice '
                      'nada— sino de proporciones sobre el torso medido. '
                      'Verificar con scripts/armar.py antes de dar por bueno.',
        '_unit': f'{unit}: el alto de figura medido ({alto_px} px, cabeza + '
                 f'torso + las dos de pierna) dividido por las {ALTO_RIG} '
                 f'unidades de rig que mide Asuri, para que todos entren a la '
                 f'pelea del mismo tamaño.',
        'source': f'arte-crudo/{armadura.lower()}-kit-alfa.png',
        'armature': armadura,
        'unit': unit,
        'scale': 1,
        'origin': [ox, oy],
        'shoulders': [[ox - sx, sy], [ox + sx, sy]],
        'hips': [[ox - hx, hy], [ox + hx, hy]],
        'parts': {
            'head': {'box': caja['head'],
                     'joint': [round(centro_x('head')), caja['head'][1] + caja['head'][3]]},
            'torso': {'box': caja['torso'],
                      'joint': [round(centro_x('torso')), caja['torso'][1]]},
            'armUpper': limbo('armUpper'),
            'armLower': limbo('armLower'),
            'legUpper': limbo('legUpper'),
            'legLower': limbo('legLower'),
        },
    }
    print(json.dumps(receta, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    main()
