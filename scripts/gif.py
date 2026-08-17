#!/usr/bin/env python3
"""
Arma un GIF con los cuadros que dejó `scripts/video.mjs`.

    python3 scripts/gif.py [ancho] [cuadros_por_segundo] [nombre]

**Se arma a 12 cuadros por segundo y eso da velocidad REAL**, que es una
casualidad que conviene entender antes de tocar el número. El bucle del juego
tiene paso fijo de 1/60 con un tope de 5 pasos por cuadro dibujado. En este
contenedor el WebGL lo emula SwiftShader por software y cada cuadro tarda mucho
más que 5/60 de segundo, así que el tope se alcanza siempre: cada cuadro
capturado avanza exactamente 5/60 = 0,083 s de pelea, sin importar cuánto haya
tardado en dibujarse. Reproducidos a 1/0,083 = 12 por segundo, el tiempo vuelve
a correr como corresponde.

El banco de pruebas tiene su propio tope —`dt` recortado a 0,1 s por cuadro— y
por eso va a **10** por segundo en vez de 12. Es el mismo razonamiento con otro
número, y por eso la velocidad es un argumento y no una constante.

En una máquina con GPU nada de esto vale: ahí los cuadros se dibujan más rápido
que el paso fijo, el tope no se alcanza nunca y cada cuadro avanza lo que avanza
el reloj. Este script es para los cuadros de acá.
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
FRAMES = ROOT / 'shots' / 'video' / 'cuadros'
VIDEO = ROOT / 'shots' / 'video' 


def main() -> None:
    width = int(sys.argv[1]) if len(sys.argv) > 1 else 640
    fps = float(sys.argv[2]) if len(sys.argv) > 2 else 12
    out = VIDEO / f'{sys.argv[3] if len(sys.argv) > 3 else "pelea"}.gif'
    # El GIF no guarda fracciones de centésima de segundo.
    delay = max(20, round(1000 / fps / 10) * 10)

    files = sorted(FRAMES.glob('*.png'))
    if not files:
        raise SystemExit(f'no hay cuadros en {FRAMES}: corré scripts/video.mjs primero')

    images = []
    for file in files:
        frame = Image.open(file).convert('RGB')
        height = round(frame.height * width / frame.width)
        frame = frame.resize((width, height), Image.LANCZOS)
        # Paleta adaptativa por cuadro y sin difuminado: la escena son bloques
        # planos y el ruido del difuminado cambia píxeles entre cuadros que
        # deberían ser idénticos, lo que triplica el peso del archivo.
        images.append(frame.quantize(colors=192, dither=Image.Dither.NONE))

    images[0].save(
        out, save_all=True, append_images=images[1:],
        duration=delay, loop=0, optimize=True, disposal=1,
    )
    size = out.stat().st_size / 1_000_000
    print(f'{len(images)} cuadros · {delay} ms · {len(images) * delay / 1000:.1f} s · {size:.1f} MB')
    print(out)


if __name__ == '__main__':
    main()
