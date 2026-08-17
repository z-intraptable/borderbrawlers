#!/usr/bin/env python3
"""
Arma la figura quieta desde el manifiesto, fuera del juego.

    python3 scripts/armar.py kor                       como está hoy
    python3 scripts/armar.py kor shoulderX=15 hipX=8   probando números

Existe para cerrar el lazo de prueba. Ver si un cambio de `shoulderX` junta el
brazo al torso pasaba por levantar vite, abrir el banco en headless y capturar
—cuarenta segundos por intento, con el WebGL emulado por software—. Esto hace lo
mismo en un segundo, porque la pose `idle` no necesita física ni GPU: es cada
pieza colgada de su articulación con rotación cero.

Reproduce lo que hace `createFighterView` en `src/art/fighter.ts`:

  - cada sprite se ancla en el pivote que declara el manifiesto;
  - se escala por `1 / unit`, que traduce píxeles de la imagen a unidades de rig;
  - el brazo cuelga en `(±shoulderX, shoulderY)` y el antebrazo a `armUpper` más
    abajo; la pierna igual con `hipX`, `hipY` y `legUpper`.

Si esto y el juego se ven distinto, el que miente es este archivo.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ZOOM = 6  # píxeles de salida por unidad de rig


def cargar(nombre: str):
    carpeta = ROOT / 'public' / 'art' / nombre.lower()
    manifiesto = json.loads((carpeta / f'{nombre.lower()}.json').read_text())
    piezas = {}
    for parte, spec in manifiesto['parts'].items():
        piezas[parte] = (
            Image.open(carpeta / spec['file']).convert('RGBA'),
            spec['pivot'],
        )
    return manifiesto, piezas


def main() -> None:
    nombre = sys.argv[1] if len(sys.argv) > 1 else 'kor'
    ajustes = {}
    for arg in sys.argv[2:]:
        clave, _, valor = arg.partition('=')
        ajustes[clave] = float(valor)

    manifiesto, piezas = cargar(nombre)
    unit = manifiesto['unit']
    rig = dict(manifiesto.get('rig') or {})
    rig.update(ajustes)

    sx, sy = rig['shoulderX'], rig['shoulderY']
    hx, hy = rig['hipX'], rig['hipY']
    head_y = rig.get('headY', 0.0)
    arm_upper, leg_upper = rig['armUpper'], rig['legUpper']

    # (pieza, x, y) en unidades de rig, en orden de dibujo: lo de atrás primero.
    plan = [
        ('armUpper', -sx, sy), ('armLower', -sx, sy + arm_upper),
        ('legUpper', -hx, hy), ('legLower', -hx, hy + leg_upper),
        ('torso', 0.0, 0.0),
        ('legUpper', hx, hy), ('legLower', hx, hy + leg_upper),
        ('armUpper', sx, sy), ('armLower', sx, sy + arm_upper),
        ('head', 0.0, head_y),
    ]

    # El lienzo sale de la extensión real de lo colocado, no de un número fijo:
    # con los brazos separados la figura es mucho más ancha que el torso.
    caja = [0.0, 0.0, 0.0, 0.0]
    for parte, x, y in plan:
        img, (px, py) = piezas[parte]
        w, h = img.width / unit, img.height / unit
        caja[0] = min(caja[0], x - px * w)
        caja[1] = min(caja[1], y - py * h)
        caja[2] = max(caja[2], x + (1 - px) * w)
        caja[3] = max(caja[3], y + (1 - py) * h)

    margen = 4
    W = int((caja[2] - caja[0] + margen * 2) * ZOOM)
    H = int((caja[3] - caja[1] + margen * 2) * ZOOM)
    lienzo = Image.new('RGBA', (W, H), (14, 16, 22, 255))

    def a_pixel(x, y):
        return (round((x - caja[0] + margen) * ZOOM), round((y - caja[1] + margen) * ZOOM))

    # Atrás en tono más oscuro, igual que el juego.
    oscuro = {0, 1, 2, 3}
    for i, (parte, x, y) in enumerate(plan):
        img, (px, py) = piezas[parte]
        w = max(1, round(img.width / unit * ZOOM))
        h = max(1, round(img.height / unit * ZOOM))
        pieza = img.resize((w, h), Image.LANCZOS)
        if i in oscuro:
            oscurecida = Image.new('RGBA', pieza.size, (90, 90, 100, 0))
            oscurecida.putalpha(pieza.getchannel('A'))
            pieza = Image.blend(pieza, oscurecida, 0.45)
        cx, cy = a_pixel(x, y)
        lienzo.alpha_composite(pieza, (cx - round(px * w), cy - round(py * h)))

    # Las articulaciones, para ver de dónde cuelga cada cosa.
    d = ImageDraw.Draw(lienzo)
    for x, y, col in [(-sx, sy, (255, 90, 120)), (sx, sy, (255, 90, 120)),
                      (-hx, hy, (90, 190, 255)), (hx, hy, (90, 190, 255)),
                      (0, 0, (255, 220, 80))]:
        cx, cy = a_pixel(x, y)
        d.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], fill=col)

    salida = ROOT / 'shots' / f'armado-{nombre.lower()}.png'
    salida.parent.mkdir(exist_ok=True)
    lienzo.convert('RGB').save(salida)
    etiqueta = ' '.join(f'{k}={v:g}' for k, v in ajustes.items()) or 'sin cambios'
    print(f'{salida}  {lienzo.size}  ({etiqueta})')


if __name__ == '__main__':
    main()
