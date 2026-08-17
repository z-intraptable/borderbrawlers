"""
Arma una hoja de contactos con todos los candidatos, para elegir mirando.

    python3 scripts/hoja.py

Deja `shots/candidatos.png`. Cada celda trae el dibujo sobre un fondo a cuadros
—para que se vea dónde hay transparencia y dónde no—, el nombre, el puntaje de
`scripts/auditar.py` y el bando que le toca por color. Van ordenados por puntaje,
así que los más fáciles de cortar quedan arriba.

El fondo a cuadros no es decoración: un dibujo que viene con fondo blanco opaco
en vez de transparente se delata solo, porque tapa el damero. Eso ya pasó con
algún candidato del lote.
"""
import os
import json
from PIL import Image, ImageDraw, ImageFont

CANDIDATOS = 'arte-crudo/candidatos'
SALIDA = 'shots/candidatos.png'
COLS = 8
CELDA = 300
ROTULO = 46
MARGEN = 6

FONDO = (24, 26, 32)
CLARO = (58, 62, 72)
OSCURO = (44, 47, 55)
TEXTO = (232, 234, 238)
TENUE = (150, 155, 165)
VERDE = (0, 255, 102)
ROJO = (255, 0, 85)
ELEGIDO = (255, 208, 64)

# Los seis que propuse, para que se vean marcados y el operador pueda comparar
# contra el resto de un vistazo en vez de buscarlos por nombre.
PROPUESTOS = {'Kor', 'Ragnir', 'Tezca', 'Asuri', 'Dusk', 'Mako'}


def fuente(tam):
    for ruta in (
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ):
        if os.path.exists(ruta):
            return ImageFont.truetype(ruta, tam)
    return ImageFont.load_default()


def damero(tam, paso=12):
    im = Image.new('RGB', (tam, tam), CLARO)
    d = ImageDraw.Draw(im)
    for y in range(0, tam, paso):
        for x in range(0, tam, paso):
            if (x // paso + y // paso) % 2:
                d.rectangle([x, y, x + paso - 1, y + paso - 1], fill=OSCURO)
    return im


def main():
    with open('shots/auditoria.json') as fh:
        datos = {d['nombre']: d for d in json.load(fh)}

    nombres = sorted(datos, key=lambda n: (-datos[n]['puntaje'], n))
    filas = (len(nombres) + COLS - 1) // COLS
    W = COLS * CELDA
    H = filas * (CELDA + ROTULO)

    hoja = Image.new('RGB', (W, H), FONDO)
    d = ImageDraw.Draw(hoja)
    f_nombre = fuente(21)
    f_dato = fuente(17)
    fondo_celda = damero(CELDA - MARGEN * 2)

    for i, nombre in enumerate(nombres):
        col, fila = i % COLS, i // COLS
        cx, cy = col * CELDA, fila * (CELDA + ROTULO)
        dato = datos[nombre]

        caja = CELDA - MARGEN * 2
        hoja.paste(fondo_celda, (cx + MARGEN, cy + MARGEN))

        ruta = None
        for ext in ('.webp', '.png', '.jpg', '.jpeg'):
            p = os.path.join(CANDIDATOS, nombre + ext)
            if os.path.exists(p):
                ruta = p
                break
        if ruta:
            im = Image.open(ruta).convert('RGBA')
            im.thumbnail((caja, caja), Image.LANCZOS)
            ox = cx + MARGEN + (caja - im.width) // 2
            oy = cy + MARGEN + (caja - im.height) // 2
            hoja.paste(im, (ox, oy), im)

        propuesto = nombre in PROPUESTOS
        if propuesto:
            d.rectangle(
                [cx + 2, cy + 2, cx + CELDA - 3, cy + CELDA + ROTULO - 3],
                outline=ELEGIDO, width=3,
            )

        ty = cy + CELDA + 2
        bando = ROJO if dato['calido'] > 0 else VERDE
        # El punto de bando va antes del nombre: es lo primero que hay que ver
        # cuando lo que se está armando es un equipo de tres y tres.
        d.ellipse([cx + MARGEN, ty + 7, cx + MARGEN + 11, ty + 18], fill=bando)
        d.text((cx + MARGEN + 18, ty + 3), nombre,
               font=f_nombre, fill=ELEGIDO if propuesto else TEXTO)
        d.text((cx + MARGEN + 18, ty + 24),
               f'{dato["puntaje"]} pts · {dato["piezas"]}pz · '
               f'{dato["w"]}x{dato["h"]}',
               font=f_dato, fill=TENUE)

    hoja.save(SALIDA)
    print(f'{len(nombres)} candidatos en {SALIDA} ({W}x{H})')
    print('borde dorado = los seis que propuse')
    print('punto verde/rojo = bando que le toca por color medido')


if __name__ == '__main__':
    main()
