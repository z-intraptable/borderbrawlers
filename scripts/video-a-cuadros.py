#!/usr/bin/env python3
"""Baja un video desde una URL directa y lo corta en un PNG por fotograma.

    python3 scripts/video-a-cuadros.py <url> <carpeta-salida> [--fps N]

Ejemplo:

    python3 scripts/video-a-cuadros.py https://ejemplo.com/clip.mp4 shots/cuadros
    python3 scripts/video-a-cuadros.py https://ejemplo.com/clip.mp4 shots/cuadros --fps 12

Pensado para el mismo tipo de trabajo que ya hace `hoja-sprites.py` con los
clips de Kling: mirar un video cuadro por cuadro para elegir poses, detectar
un artefacto de generación, o cortar una acción puntual.

**Sólo para contenido propio o sin restricción de copyright.** Baja el
archivo con un pedido HTTP directo (`curl`), no scrapea ni evade
protecciones de sitios como YouTube — si la URL no es un archivo de video
servido directo, el pedido simplemente falla. No instala `yt-dlp` ni nada
parecido a propósito: este script es para procesar un video que YA es tuyo
(un render, un clip subido a tu propio storage), no para bajar contenido
ajeno.

Requiere `ffmpeg` en el PATH (ya viene en este entorno).
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse


def descargar(url: str, destino: Path) -> None:
    print(f'bajando {url}…')
    resultado = subprocess.run(
        ['curl', '-fsSL', '--retry', '3', '-o', str(destino), url],
        capture_output=True, text=True,
    )
    if resultado.returncode != 0:
        sys.exit(f'no se pudo bajar el video: {resultado.stderr.strip()}')
    if not destino.exists() or destino.stat().st_size == 0:
        sys.exit('la descarga terminó vacía — ¿la URL sirve el archivo directo?')
    print(f'  {destino.stat().st_size / 1e6:.1f} MB')


def cortar(video: Path, salida: Path, fps: float | None) -> int:
    salida.mkdir(parents=True, exist_ok=True)
    patron = str(salida / 'frame-%04d.png')
    comando = ['ffmpeg', '-y', '-i', str(video)]
    if fps is not None:
        comando += ['-vf', f'fps={fps}']
    comando += [patron]
    resultado = subprocess.run(comando, capture_output=True, text=True)
    if resultado.returncode != 0:
        sys.exit(f'ffmpeg falló:\n{resultado.stderr[-2000:]}')
    cuadros = sorted(salida.glob('frame-*.png'))
    return len(cuadros)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('url', help='URL directa a un archivo de video (mp4, webm, mov)')
    ap.add_argument('salida', help='carpeta donde escribir los PNG')
    ap.add_argument('--fps', type=float, default=None,
                     help='cuadros por segundo a extraer (por defecto, todos los del video)')
    args = ap.parse_args()

    parsed = urlparse(args.url)
    if parsed.scheme not in ('http', 'https'):
        sys.exit('la URL tiene que ser http(s), un archivo directo')

    salida = Path(args.salida)
    tmp_video = salida.parent / f'.tmp-descarga{Path(parsed.path).suffix or ".mp4"}'
    salida.mkdir(parents=True, exist_ok=True)

    descargar(args.url, tmp_video)
    try:
        n = cortar(tmp_video, salida, args.fps)
    finally:
        tmp_video.unlink(missing_ok=True)

    print(f'listo: {n} cuadros en {salida}/')


if __name__ == '__main__':
    main()
