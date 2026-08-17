#!/usr/bin/env python3
"""
Le saca el fondo a una figura y la deja en PNG con transparencia real.

    python3 scripts/fondo.py arte-crudo/deadpool.jpeg arte-crudo/deadpool.png

Existe porque los generadores casi nunca devuelven transparencia. Devuelven
blanco, o —peor y más común— devuelven el DAMERO gris y blanco con el que los
editores dibujan la transparencia, pintado como píxeles normales. En los dos
casos hay que sacarlo antes de cortar, y hacerlo a mano en un editor es
justamente lo que este proyecto no quiere pedirle a nadie.

Cómo lo saca, y por qué así:

- **Por inundación desde el borde**, no por color. Si se borrara todo píxel
  claro, se borrarían también los blancos de los ojos, que están adentro de la
  figura. La inundación sólo alcanza lo que se toca con el borde de la imagen,
  así que un blanco encerrado por el contorno sobrevive.
- **El criterio de "esto es fondo" es claro Y gris**: mucho brillo y poca
  diferencia entre canales. Eso separa el damero del reflejo crema del contorno,
  que es igual de claro pero cálido.
- **Después se come un par de píxeles hacia adentro.** Un JPEG deja un halo
  claro alrededor de las líneas, y ese halo no llega al umbral de fondo: queda
  como una orla blanca que en el juego se ve como si el personaje estuviera
  recortado con tijera. Como el borde de la figura es contorno negro grueso,
  comerle dos píxeles no se nota y la orla desaparece.
- **El alfa se difumina un toque** para que el borde no quede en escalera.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

# Fondo: por encima de este brillo y por debajo de esta diferencia entre
# canales. El damero medido daba 240-254 con diferencia de 0 a 5.
BRIGHT = 225
GREY = 14
# Cuántos píxeles del contorno se come para matar el halo del JPEG.
EAT = 2


def flood_from_border(candidate: np.ndarray) -> np.ndarray:
    """Inundación por líneas desde el borde. Devuelve qué es fondo de verdad."""
    h, w = candidate.shape
    filled = np.zeros((h, w), bool)

    stack: list[tuple[int, int]] = []
    for x in range(w):
        if candidate[0, x]:
            stack.append((x, 0))
        if candidate[h - 1, x]:
            stack.append((x, h - 1))
    for y in range(h):
        if candidate[y, 0]:
            stack.append((0, y))
        if candidate[y, w - 1]:
            stack.append((w - 1, y))

    while stack:
        x, y = stack.pop()
        if filled[y, x] or not candidate[y, x]:
            continue
        left = x
        while left > 0 and candidate[y, left - 1] and not filled[y, left - 1]:
            left -= 1
        right = x
        while right < w - 1 and candidate[y, right + 1] and not filled[y, right + 1]:
            right += 1
        filled[y, left:right + 1] = True

        for ny in (y - 1, y + 1):
            if not (0 <= ny < h):
                continue
            row = candidate[ny, left:right + 1] & ~filled[ny, left:right + 1]
            idx = np.flatnonzero(row)
            if idx.size == 0:
                continue
            # Un empujón por cada tramo contiguo: empujar píxel por píxel
            # convierte esto en algo cuadrático sobre un fondo de 4 megapíxeles.
            breaks = np.flatnonzero(np.diff(idx) > 1)
            starts = np.concatenate(([idx[0]], idx[breaks + 1]))
            for start in starts:
                stack.append((left + int(start), ny))

    return filled


def grow(mask: np.ndarray, steps: int) -> np.ndarray:
    """Agranda la máscara un píxel por paso, en cruz."""
    for _ in range(steps):
        out = mask.copy()
        out[1:, :] |= mask[:-1, :]
        out[:-1, :] |= mask[1:, :]
        out[:, 1:] |= mask[:, :-1]
        out[:, :-1] |= mask[:, 1:]
        mask = out
    return mask


def strip(image: Image.Image) -> Image.Image:
    rgb = np.asarray(image.convert('RGB')).astype(np.int16)
    bright = rgb.min(axis=2) >= BRIGHT
    grey = (rgb.max(axis=2) - rgb.min(axis=2)) <= GREY
    background = grow(flood_from_border(bright & grey), EAT)

    alpha = np.where(background, 0, 255).astype(np.uint8)
    out = image.convert('RGBA')
    out.putalpha(Image.fromarray(alpha).filter(ImageFilter.GaussianBlur(0.6)))
    return out


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit('uso: python3 scripts/fondo.py <entrada> <salida.png>')

    source = Path(sys.argv[1])
    out = strip(Image.open(source))
    out.save(sys.argv[2])

    alpha = np.asarray(out)[:, :, 3]
    solid = int((alpha > 128).sum())
    total = alpha.size
    print(f'{source.name}: queda el {100 * solid / total:.1f}% de la imagen')
    if solid > total * 0.9:
        print('  ojo: casi no se borró nada. ¿El fondo es claro y gris?')
    if solid < total * 0.02:
        print('  ojo: se borró casi todo. La figura debe ser clara y sin contorno.')


if __name__ == '__main__':
    main()
