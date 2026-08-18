#!/usr/bin/env python3
"""
Corta una figura entera en las piezas del esqueleto y escribe el manifiesto.

    python3 scripts/cortar.py recetas/deadpool.json

Quien dibuja entrega UNA imagen del personaje parado. La receta dice dónde
están sus articulaciones, y de ahí sale todo lo demás.

**El esqueleto sale del dibujo, no al revés.** Ésa es la decisión central de
esta herramienta y vale explicarla, porque la versión anterior hacía lo
contrario y no servía. El peleador vectorial tiene proporciones fijas —cabeza de
23 unidades, hombros a 22— y un chibi dibujado a mano casi nunca las respeta: el
primero que llegó tenía la cabeza del doble y las caderas más anchas. Forzar el
dibujo dentro de esas constantes deja los brazos naciendo del aire. Así que la
receta declara dónde están el hombro, la cadera, el codo y la rodilla EN LA
IMAGEN, y el manifiesto se lleva un bloque `rig` con esas medidas traducidas a
unidades. El dibujo manda.

De lo mismo sale el resto de lo que hace:

- **Cada miembro se endereza solo.** El rig cuelga los miembros hacia abajo en
  reposo; el dibujo los tiene donde el dibujante quiso, casi siempre en
  diagonal. Sabiendo qué punto es el hombro y cuál el codo, la rotación que hace
  falta es una cuenta, no un dato que alguien tenga que medir con transportador.
- **El lienzo de cada pieza es la pieza.** Antes cada una se escalaba para
  entrar en un lienzo de tamaño fijo, con un factor distinto por pieza: la
  cabeza se achicaba un 27% y el brazo un 24%, y el personaje quedaba
  desproporcionado consigo mismo. Ahora hay un `scale` único para todas y el
  lienzo es el recorte, que además es lo que Pixi quiere: el ancla del sprite es
  una fracción de su propia textura.

Formato de la receta:

    {
      "source": "arte-crudo/deadpool.png",
      "armature": "Deadpool",
      "unit": 19.4,            # píxeles de la imagen por unidad de rig
      "scale": 0.28,           # reducción única, igual para todas las piezas
      "origin": [1035, 1015],  # el (0,0) del cuerpo en la imagen
      "shoulders": [[830, 1030], [1250, 1020]],
      "hips": [[900, 1420], [1230, 1430]],
      "parts": {
        "head":     {"box": [x, y, w, h], "joint": [1035, 935]},
        "torso":    {"box": [x, y, w, h], "joint": [1035, 1015]},
        "armUpper": {"box": [x, y, w, h], "from": [830, 1030], "to": [470, 1150]},
        ...
      }
    }

  box    recorte en la imagen original: [x, y, ancho, alto]
  joint  para cabeza y torso: el punto que se apoya sobre el esqueleto
  from   para un miembro: la articulación de arriba (hombro, cadera)
  to     para un miembro: la de abajo (codo, rodilla). Define hacia dónde
         apunta, y por lo tanto cuánto hay que girarlo y cuánto mide.

Todas las coordenadas van en píxeles de la imagen original. Ninguna en
fracciones: las fracciones las calcula esto.

Un detalle de `shoulders` que cuesta una vuelta entera si se pasa por alto: van
en el BORDE DE AFUERA del hombro, no donde el brazo toca el torso en el dibujo.
En una figura de tres cuartos con los brazos abiertos, ese punto de contacto cae
bien adentro de la silueta; el rig, en cambio, cuelga los brazos hacia abajo, y
colgados desde ahí quedan tapados por el torso y sólo asoman los puños al
costado de la cintura, como dos bolitas sueltas. `from` de `armUpper` sí es el
punto de contacto: ése define hacia dónde apunta el brazo dibujado.
"""
import json
import math
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

# Qué articulación de arriba le corresponde a cada miembro, para el bloque rig.
LIMBS = ('armUpper', 'armLower', 'legUpper', 'legLower')


def straighten(source: Image.Image, box: list, pivot: tuple[float, float],
               angle: float) -> tuple[Image.Image, tuple[float, float]]:
    """Recorta, gira alrededor del pivote y devuelve la pieza con el pivote
    ubicado dentro de ella.

    La rotación se hace con una afín explícita en vez de `Image.rotate`, porque
    ahí el centro de giro y el margen que agrega `expand` se pelean entre sí y
    dejan el pivote corrido unos píxeles. Corrido el pivote, el brazo gira desde
    un punto que no es el hombro, que es exactamente el defecto que esta
    herramienta existe para no tener.
    """
    x, y, w, h = box
    px, py = pivot[0] - x, pivot[1] - y

    cos, sin = math.cos(angle), math.sin(angle)

    # Dónde caen las cuatro esquinas al girar, para saber de qué tamaño tiene
    # que ser el lienzo y dónde queda el pivote adentro.
    corners = []
    for cx, cy in ((0, 0), (w, 0), (0, h), (w, h)):
        dx, dy = cx - px, cy - py
        corners.append((dx * cos - dy * sin, dx * sin + dy * cos))
    left = min(c[0] for c in corners)
    top = min(c[1] for c in corners)
    width = max(1, math.ceil(max(c[0] for c in corners) - left))
    height = max(1, math.ceil(max(c[1] for c in corners) - top))
    qx, qy = -left, -top

    # La afín va de coordenadas de SALIDA a coordenadas de ENTRADA.
    matrix = (
        cos, sin, x + px - cos * qx - sin * qy,
        -sin, cos, y + py + sin * qx - cos * qy,
    )
    piece = source.transform((width, height), Image.AFFINE, matrix,
                             resample=Image.BICUBIC)
    return piece, (qx, qy)


def trim(piece: Image.Image, pivot: tuple[float, float]):
    """Saca el margen transparente y corrige el pivote por lo que se sacó."""
    bbox = piece.getbbox()
    if bbox is None:
        raise SystemExit('una pieza quedó vacía: revisá la caja de recorte')
    return piece.crop(bbox), (pivot[0] - bbox[0], pivot[1] - bbox[1])


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit('uso: python3 scripts/cortar.py <receta.json>')

    recipe = json.loads(Path(sys.argv[1]).read_text())
    source = Image.open(ROOT / recipe['source']).convert('RGBA')
    armature = recipe['armature']
    unit = float(recipe['unit'])
    scale = float(recipe.get('scale', 1))
    ox, oy = recipe['origin']

    folder = ROOT / 'public' / 'art' / armature.lower()
    folder.mkdir(parents=True, exist_ok=True)

    rig: dict[str, float] = {}
    parts: dict[str, dict] = {}

    for name, spec in recipe['parts'].items():
        box = spec['box']
        if 'from' in spec:
            start, end = spec['from'], spec['to']
            vx, vy = end[0] - start[0], end[1] - start[1]
            length = math.hypot(vx, vy)
            # El giro que deja el miembro apuntando derecho para abajo, que es
            # como el rig lo cuelga en reposo.
            angle = math.atan2(vx, vy)
            piece, pivot = straighten(source, box, tuple(start), angle)
            rig[name] = round(length / unit, 3)
        else:
            piece, pivot = straighten(source, box, tuple(spec['joint']), 0.0)

        piece, pivot = trim(piece, pivot)

        if scale != 1:
            size = (max(1, round(piece.width * scale)), max(1, round(piece.height * scale)))
            piece = piece.resize(size, Image.LANCZOS)
            pivot = (pivot[0] * scale, pivot[1] * scale)

        fx = min(1.0, max(0.0, pivot[0] / piece.width))
        fy = min(1.0, max(0.0, pivot[1] / piece.height))

        filename = f'{name.lower()}.png'
        piece.save(folder / filename)
        parts[name] = {'file': filename, 'pivot': [round(fx, 4), round(fy, 4)]}
        # Qué borde de la pieza es un corte y no una silueta. Lo usa
        # `contorno.py` para no hornearle contorno a ese lado.
        if 'corte' in spec:
            parts[name]['corte'] = spec['corte']
        print(f'  {name:9s} {piece.width:4d}x{piece.height:<4d} pivote [{fx:.3f}, {fy:.3f}]')

    (sx1, sy1), (sx2, sy2) = recipe['shoulders']
    (hx1, hy1), (hx2, hy2) = recipe['hips']
    rig['shoulderX'] = round(abs(sx1 - sx2) / 2 / unit, 3)
    rig['shoulderY'] = round(((sy1 + sy2) / 2 - oy) / unit, 3)
    rig['hipX'] = round(abs(hx1 - hx2) / 2 / unit, 3)
    rig['hipY'] = round(((hy1 + hy2) / 2 - oy) / unit, 3)
    rig['headY'] = round((recipe['parts']['head']['joint'][1] - oy) / unit, 3)

    manifest = {
        'armature': armature,
        'unit': round(unit * scale, 4),
        'rig': rig,
        'parts': parts,
    }
    target = folder / f'{armature.lower()}.json'
    target.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')

    print(f'\nrig: {rig}')
    print(f'{len(parts)} piezas y el manifiesto en {target.parent}')


if __name__ == '__main__':
    main()
