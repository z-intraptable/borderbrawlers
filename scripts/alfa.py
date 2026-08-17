#!/usr/bin/env python3
"""
Le saca el fondo blanco a una hoja de piezas y la deja con alfa real.

    python3 scripts/alfa.py arte-crudo/kits/kor-kit.png arte-crudo/kor.png

Es el hermano rápido de `scripts/fondo.py`. Hacen cosas distintas y conviene no
confundirlas:

- **`fondo.py`** trabaja sobre la figura de un generador que devuelve el DAMERO
  gris y blanco pintado como píxeles normales, y decide qué es fondo por brillo
  y por gris. Esa decisión cuesta, y a 17 megapíxeles —que es lo que devuelve
  nano_banana_pro a 4K— tarda más de media hora por hoja.
- **`alfa.py`** es para las hojas de kit, donde el fondo es **blanco puro y
  conectado desde el borde**. Eso lo resuelve una inundación desde la esquina,
  que Pillow hace en C: la misma hoja sale en segundos.

Por qué inundación y no "borrá todo lo blanco": los personajes tienen blancos
adentro —el ojo de Mako, la barba de WuShang, las placas crema de Ragnir— y
borrar por color se los come. La inundación sólo alcanza lo que se toca con el
borde de la imagen.

Después se comen dos píxeles hacia adentro. El JPEG y el reescalado dejan un
halo claro alrededor del contorno negro, y ese halo no llega al umbral de fondo:
sin comerlo queda una orla blanca que en el juego se ve como si la pieza
estuviera recortada con tijera.
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

Image.MAX_IMAGE_PIXELS = None

# Cuánto puede alejarse del blanco un píxel y seguir contando como fondo. El
# blanco del generador mide 255 plano, pero el reescalado a 4K deja bordes de
# 240 y pico.
TOLERANCIA = 46
# Píxeles de contorno que se comen para matar el halo.
COMER = 2
SENTINELA = (255, 0, 255)


def sacar_fondo(imagen: Image.Image) -> Image.Image:
    rgb = imagen.convert('RGB')
    marca = rgb.copy()
    # Las cuatro esquinas: si una pieza toca una esquina, las otras tres siguen
    # sirviendo. Con una sola semilla, una hoja mal encuadrada queda sin fondo.
    w, h = marca.size
    for semilla in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        if marca.getpixel(semilla) == SENTINELA:
            continue
        ImageDraw.floodfill(marca, semilla, SENTINELA, thresh=TOLERANCIA)

    pintado = np.asarray(marca)
    fondo = np.all(pintado == np.array(SENTINELA, dtype=np.uint8), axis=-1)
    alpha = np.where(fondo, 0, 255).astype(np.uint8)

    capa = Image.fromarray(alpha, 'L')
    if COMER > 0:
        capa = capa.filter(ImageFilter.MinFilter(COMER * 2 + 1))
    capa = capa.filter(ImageFilter.GaussianBlur(0.6))

    salida = rgb.convert('RGBA')
    salida.putalpha(capa)
    return salida


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit('uso: alfa.py <entrada> <salida.png>')
    entrada, salida = Path(sys.argv[1]), Path(sys.argv[2])
    imagen = Image.open(entrada)
    resultado = sacar_fondo(imagen)
    salida.parent.mkdir(parents=True, exist_ok=True)
    resultado.save(salida)
    transparente = (np.asarray(resultado)[:, :, 3] < 16).mean() * 100
    print(f'{salida}  {resultado.size}  fondo {transparente:.0f}%')


if __name__ == '__main__':
    main()
