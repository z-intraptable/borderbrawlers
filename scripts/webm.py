#!/usr/bin/env python3
"""
Arma un WebM con los cuadros de `shots/video/cuadros`.

    python3 scripts/webm.py [ancho] [fps] [nombre]

Existe porque el GIF no alcanza: un GIF tiene 256 colores por cuadro y el
escenario es un degradé, así que el fondo sale con bandas y el personaje pierde
los medios tonos. Un códec de video no tiene ese límite.

**El ffmpeg que se usa es el que trae Playwright**, que viene recortado a lo
mínimo que el navegador necesita para grabar: un solo demuxer de imágenes
(`image2pipe`), un solo decodificador (`mjpeg`) y un solo codificador (`libvpx`,
o sea VP8). No hay decodificador de PNG ni de rawvideo, así que los cuadros
—que salen en PNG— se pasan a JPEG de calidad 95 antes de entrar. Es una pérdida
mucho menor que la del GIF: 95 es visualmente transparente en este material y no
toca la cantidad de colores.

De ahí sale un `.webm`, que no es MP4 porque no hay ningún codificador H.264 en
ese binario. Se ve en cualquier navegador.
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image

RAIZ = Path(__file__).resolve().parent.parent
CUADROS = RAIZ / 'shots' / 'video' / 'cuadros'
SALIDA = RAIZ / 'shots' / 'video'
FFMPEG = Path.home() / '.cache/ms-playwright/ffmpeg-1010/ffmpeg-linux'

# El GIF se veía a 5 cuadros por segundo porque es lo que dura un cuadro de
# captura en tiempo de juego. El video sale a 25 repitiendo cuadros: la cadencia
# es la misma y deja de verse como un video roto en los reproductores.
SALIDA_FPS = 25


def main() -> None:
    ancho = int(sys.argv[1]) if len(sys.argv) > 1 else 960
    fps = float(sys.argv[2]) if len(sys.argv) > 2 else 5
    nombre = sys.argv[3] if len(sys.argv) > 3 else 'gameplay'

    if not FFMPEG.exists():
        raise SystemExit(f'no está el ffmpeg de Playwright en {FFMPEG}')
    archivos = sorted(CUADROS.glob('*.png'))
    if not archivos:
        raise SystemExit(f'no hay cuadros en {CUADROS}')

    destino = SALIDA / f'{nombre}.webm'
    orden = [
        str(FFMPEG), '-y', '-hide_banner', '-loglevel', 'error',
        # `pipe:0` y no `-`: este binario trae el protocolo `pipe` pero no el
        # atajo, y con `-` muere en "Protocol not found".
        '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', str(fps), '-i', 'pipe:0',
        # VP8 con bitrate alto y `-crf` bajo: el material tiene fondo oscuro con
        # degradé, que es justo donde un bitrate corto deja bandas.
        '-c:v', 'libvpx', '-b:v', '6M', '-crf', '8', '-qmin', '0', '-qmax', '30',
        '-r', str(SALIDA_FPS), '-an', '-f', 'webm', str(destino),
    ]
    proceso = subprocess.Popen(orden, stdin=subprocess.PIPE)
    assert proceso.stdin is not None
    for ruta in archivos:
        im = Image.open(ruta).convert('RGB')
        if im.width != ancho:
            alto = round(im.height * ancho / im.width)
            # Par: VP8 trabaja en macrobloques y un alto impar lo hace fallar.
            im = im.resize((ancho, alto + alto % 2), Image.LANCZOS)
        im.save(proceso.stdin, 'JPEG', quality=95, subsampling=0)
    proceso.stdin.close()
    if proceso.wait() != 0:
        raise SystemExit('ffmpeg falló')

    mb = destino.stat().st_size / 1e6
    print(f'{len(archivos)} cuadros · {len(archivos) / fps:.1f} s · {mb:.1f} MB '
          f'· {destino}')


if __name__ == '__main__':
    main()
