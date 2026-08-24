#!/usr/bin/env python3
"""
Separa una textura de efecto en las dos capas que ya usa el juego.

`src/render/fx.ts` dibuja todo en dos `Graphics`: `glow` —que lleva Bloom y es
donde va el color del bando— e `ink` —el contorno negro, afuera del Bloom—.
Las texturas de Nano Banana vienen en UN color fijo (naranja) y con línea
negra encima; para que le sirvan al juego, que tiñe el mismo efecto de verde o
de rojo según quién lo tira, hay que separarlas:

- **glow**: el relleno se pasa a blanco puro y conserva su alfa según el brillo
  original —el centro caliente queda más opaco que el borde—, así que
  `sprite.tint = color` lo pinta del bando sin perder la caída de luz.
- **ink**: sólo la línea negra, tal cual, para que se dibuje encima sin teñir.

    python3 scripts/separar-vfx.py arte-crudo/vfx/impacto.png public/vfx/impacto
"""
import sys
import pathlib

import numpy as np
from PIL import Image

RAIZ = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RAIZ / 'scripts'))
import importlib.util
_spec = importlib.util.spec_from_file_location('alfa', RAIZ / 'scripts' / 'alfa.py')
_alfa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_alfa)

# Qué tan oscuro tiene que ser un píxel para contar como línea de tinta y no
# como relleno de color. El naranja más oscuro del degradé anda por 180 de
# luminosidad; la línea baja de 70.
UMBRAL_TINTA = 70

# Lado máximo de la textura final, en píxeles.
#
# Las ocho fuentes (Nano Banana/Kling) salen a 1024-2048px; en pantalla el
# burst mide unos 60-150px de lado (`ESCALA` en vfxSprites.ts, sobre un
# personaje de ~80-150px de alto) -- 15-30x más chico que la fuente. PixiJS
# no genera mipmaps para estas texturas, así que ese achique lo hace la GPU
# con un solo filtro bilineal sobre unos pocos texels de la imagen ENTERA
# sin promediar el resto: en una textura con detalle fino disperso (los
# rayos de una explosión, no un blob macizo) el resultado es un moiré que se
# ve como un rectángulo blanco/gris sólido pegado al personaje -- reportado
# con capturas reales, visible tanto en los VFX viejos (impacto/onda) como
# en escudo/esquive, recién agregados.
#
# La corrección real sería habilitar mipmaps en PixiJS; se resuelve acá en
# cambio, más simple y sin tocar el pipeline de render: bajar la fuente a un
# tamaño donde el filtro bilineal de la GPU alcanza solo (2-8x de sobra
# sobre el tamaño real en pantalla), con LANCZOS de PIL que sí promedia la
# imagen completa al reescalar.
MAX_LADO = 512


def separar(origen: pathlib.Path, destino_base: pathlib.Path) -> None:
    con_alfa = _alfa.sacar_fondo(Image.open(origen).convert('RGB'))
    a = np.array(con_alfa)
    rgb = a[:, :, :3].astype(np.float64)
    alfa = a[:, :, 3].astype(np.float64)
    luz = rgb.mean(axis=2)

    es_tinta = (luz < UMBRAL_TINTA) & (alfa > 10)

    def guardar_achicado(capa: np.ndarray, destino: pathlib.Path) -> None:
        img = Image.fromarray(capa.astype(np.uint8), 'RGBA')
        if max(img.size) > MAX_LADO:
            factor = MAX_LADO / max(img.size)
            nuevo = (round(img.width * factor), round(img.height * factor))
            img = img.resize(nuevo, Image.LANCZOS)
        img.save(destino)

    # --- ink: sólo la línea, negra, tal cual ---
    ink = np.zeros_like(a)
    ink[..., 0:3] = 5
    ink[..., 3] = np.where(es_tinta, alfa, 0)
    guardar_achicado(ink, pathlib.Path(f'{destino_base}-ink.png'))

    # --- glow: el relleno, a blanco, con la caída de luz como alfa ---
    # `luz/255` es la caída natural del degradé del generador: el centro
    # blanco puro pesa 1, el naranja oscuro del borde pesa menos. Elevarlo a
    # 0.7 la hace caer más lento — si no, el borde exterior del efecto casi no
    # se ve y la textura se lee más chica de lo que ocupa en píxeles.
    peso = np.clip(luz / 255, 0, 1) ** 0.7
    glow = np.zeros_like(a)
    glow[..., 0:3] = 255
    glow[..., 3] = np.where(es_tinta, 0, alfa * peso)
    guardar_achicado(glow, pathlib.Path(f'{destino_base}-glow.png'))

    print(f'{origen.name}: ink {ink[...,3].astype(bool).mean()*100:.0f}% · '
          f'glow {glow[...,3].astype(bool).mean()*100:.0f}%')


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    separar(pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
