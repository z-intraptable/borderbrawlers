#!/usr/bin/env python3
"""
Corta una figura entera en las piezas del esqueleto y escribe el manifiesto.

La idea es que quien dibuja no tenga que abrir un editor. Se entrega UNA imagen
del personaje parado y una receta con las cajas de recorte, y esto produce los
PNG con el tamaño, el centrado y la transparencia que espera `loadArt.ts`.

    python3 scripts/cortar.py recetas/deadpool.json

La receta es un JSON:

    {
      "source": "arte-crudo/deadpool.png",
      "armature": "Deadpool",
      "unit": 4,
      "parts": {
        "head": {
          "box": [410, 60, 250, 250],
          "canvas": [240, 240],
          "pivot": [0.5, 0.5]
        },
        ...
      }
    }

  box     recorte en la imagen original: [x, y, ancho, alto]
  canvas  lienzo final de la pieza, de la ficha
  pivot   dónde queda la articulación en el lienzo final, en fracción de 0 a 1
  rotate  grados a girar ANTES de recortar el sobrante, para enderezar un
          miembro que en el dibujo está en diagonal. Opcional.
  anchor  cómo se apoya la pieza recortada dentro del lienzo: "joint" la pega
          con su borde superior en el pivote —lo que corresponde a un miembro,
          que cuelga de su articulación— y "center" la centra, que es lo que
          corresponde a la cabeza y al torso. Por defecto "joint".

Por qué existe `anchor`: el pivote no es sólo un número del manifiesto, es dónde
tiene que caer físicamente la articulación dentro de la imagen. Un brazo cuyo
hombro no esté en el pivote declarado gira desde el lugar equivocado, y eso no
se arregla después.
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def trim(image: Image.Image) -> Image.Image:
    """Recorta el margen transparente. Sin esto, el pivote depende de cuánto
    aire dejó el recorte y no de dónde está la articulación."""
    bbox = image.getbbox()
    return image if bbox is None else image.crop(bbox)


def fit(piece: Image.Image, width: int, height: int) -> Image.Image:
    """Escala la pieza para que entre en el lienzo, sin deformarla."""
    if piece.width == 0 or piece.height == 0:
        raise SystemExit('una pieza quedó vacía: revisá la caja de recorte')
    factor = min(width / piece.width, height / piece.height)
    if factor >= 1:
        return piece
    size = (max(1, round(piece.width * factor)), max(1, round(piece.height * factor)))
    return piece.resize(size, Image.LANCZOS)


def place(piece: Image.Image, width: int, height: int,
          pivot: list, anchor: str) -> Image.Image:
    canvas = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    px, py = pivot
    x = round(width * px - piece.width / 2)
    if anchor == 'center':
        y = round(height * py - piece.height / 2)
    else:
        # Un miembro cuelga: su borde superior ES la articulación.
        y = round(height * py)
    canvas.alpha_composite(piece, (max(0, x), max(0, y)))
    return canvas


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit('uso: python3 scripts/cortar.py <receta.json>')

    recipe = json.loads(Path(sys.argv[1]).read_text())
    source = Image.open(ROOT / recipe['source']).convert('RGBA')
    armature = recipe['armature']
    folder = ROOT / 'public' / 'art' / armature.lower()
    folder.mkdir(parents=True, exist_ok=True)

    manifest = {'armature': armature, 'unit': recipe['unit'], 'parts': {}}

    for name, spec in recipe['parts'].items():
        x, y, w, h = spec['box']
        piece = source.crop((x, y, x + w, y + h))
        if spec.get('rotate'):
            piece = piece.rotate(-spec['rotate'], resample=Image.BICUBIC, expand=True)
        piece = trim(piece)

        cw, ch = spec['canvas']
        piece = fit(piece, cw, ch)
        pivot = spec['pivot']
        out = place(piece, cw, ch, pivot, spec.get('anchor', 'joint'))

        filename = f'{name.lower()}.png'
        out.save(folder / filename)
        manifest['parts'][name] = {'file': filename, 'pivot': pivot}
        print(f'  {name:9s} {cw}x{ch}  desde [{x}, {y}, {w}, {h}]')

    target = folder / f'{armature.lower()}.json'
    target.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    print(f'\n{len(manifest["parts"])} piezas y el manifiesto en {target.parent}')


if __name__ == '__main__':
    main()
