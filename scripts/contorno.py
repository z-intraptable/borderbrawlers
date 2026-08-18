#!/usr/bin/env python3
"""
Le pone contorno negro a las piezas cortadas de un personaje.

    python3 scripts/contorno.py kor
    python3 scripts/contorno.py            # los seis

Va DESPUÉS de `cortar.py`, sobre lo que quedó en `public/art/<slug>/`, y reescribe
las piezas y los pivotes del manifiesto. Volver a pasar `cortar.py` lo borra: el
orden es cortar y después contornear.

**Por qué existe.** Es la decisión gráfica central de Brawlhalla y la que más lo
separa de lo nuestro (ver docs/REFERENCIA-BRAWLHALLA.md). Ahí el personaje lleva
un contorno negro grueso y constante, y por eso el fondo puede ser saturado,
brillante y lleno de detalle sin comerse la figura. Nosotros hacíamos lo
contrario: apagábamos el fondo a poco más de un tercio de su brillo para que los
peleadores se distinguieran. Funcionaba, pero dejaba el escenario deslavado.

El contorno se hornea en la imagen y no se dibuja en vivo con un filtro. Un
`OutlineFilter` por sprite serían treinta y seis filtros por cuadro contra un
techo de dieciséis draw calls; horneado no cuesta absolutamente nada en
ejecución.

**El grosor se mide en unidades de rig, no en píxeles.** Cada personaje se cortó
de una hoja de distinta resolución —`unit` va de 23 a 42 píxeles por unidad de
rig—, así que un grosor fijo en píxeles saldría al doble en uno que en otro. En
unidades de rig sale igual en los seis, que es lo que quiere decir "constante".
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None

RAIZ = Path(__file__).resolve().parent.parent
ARTE = RAIZ / 'public' / 'art'

# Grosor del contorno, en unidades de rig. La figura entera mide 104, así que
# 1,9 es poco menos del 2% de su altura: a los noventa y pico de píxeles con que
# se dibuja un peleador da algo menos de dos píxeles, que es lo que se ve en la
# referencia. Más grueso convierte al personaje en una mancha cuando la cámara
# se abre; más fino desaparece y el fondo se lo vuelve a comer.
GROSOR_RIG = 1.9

# Color del contorno. Negro puro no: el fondo de estos escenarios es oscuro y un
# contorno #000 se funde con él. Un gris muy oscuro azulado se despega del fondo
# y sigue leyéndose como negro contra los colores del personaje.
COLOR = (10, 13, 20)


def dilatar(alpha: Image.Image, radio: int) -> Image.Image:
    """Ensancha la máscara `radio` píxeles.

    A escala reducida y no a resolución completa: un `MaxFilter` con ventana de
    ochenta píxeles sobre una hoja de cuatro mil es inviable, y el contorno es
    lo único que se está calculando. El reescalado de vuelta lo deja con el
    borde suave, que además es como se ve el de la referencia.
    """
    if radio < 1:
        return alpha
    ancho, alto = alpha.size
    # Factor tal que la ventana quede en unos doce píxeles: chica para el filtro
    # y todavía suficiente para no comerse los dedos ni las orejas.
    factor = max(1, radio // 6)
    chico = alpha.resize((max(1, ancho // factor), max(1, alto // factor)),
                         Image.BILINEAR)
    ventana = max(3, int(2 * (radio / factor)) | 1)
    chico = chico.filter(ImageFilter.MaxFilter(ventana))
    grande = chico.resize((ancho, alto), Image.BILINEAR)
    # Umbral bajo: lo que el reescalado dejó a medias entra al contorno. Con un
    # umbral alto el borde queda mordido y aparecen dientes.
    return grande.point(lambda v: 255 if v > 40 else 0)


def destapar_corte(borde: Image.Image, alpha: Image.Image,
                   corte: str | None) -> Image.Image:
    """Le saca el contorno al lado por donde la pieza se partió.

    Cuando dos piezas salen del MISMO dibujo —el brazo de Ragnir, partido en el
    codo— el borde del corte no es silueta: es el lugar donde la pieza sigue.
    Contornearlo pinta una barra negra que el antebrazo, que se dibuja encima,
    lleva atravesada en la articulación.

    Se borra por columna y no por franja recta porque `straighten` endereza la
    pieza girándola —el antebrazo de Ragnir viene ocho grados torcido— y el
    corte queda en diagonal. La franja recta dejaría media barra puesta.
    """
    if corte not in ('arriba', 'abajo'):
        return borde
    lleno = np.array(alpha) > 40
    fuera = np.array(borde) > 0
    columna_llena = lleno.any(axis=0)
    filas = np.arange(lleno.shape[0])[:, None]
    if corte == 'arriba':
        # Primera fila opaca de cada columna; las columnas vacías se guían por
        # la primera de la pieza entera, para no dejarles un pico al costado.
        limite = np.where(columna_llena, lleno.argmax(axis=0),
                          lleno.any(axis=1).argmax())
        fuera[filas < limite[None, :]] = False
    else:
        alto = lleno.shape[0]
        ultima = alto - 1 - np.flip(lleno, axis=0).argmax(axis=0)
        global_ultima = alto - 1 - np.flip(lleno.any(axis=1)).argmax()
        limite = np.where(columna_llena, ultima, global_ultima)
        fuera[filas > limite[None, :]] = False
    return Image.fromarray((fuera * 255).astype(np.uint8), 'L')


def contornear(carpeta: Path) -> None:
    manifiestos = list(carpeta.glob('*.json'))
    if not manifiestos:
        return
    ruta = manifiestos[0]
    manifiesto = json.loads(ruta.read_text())
    unit = manifiesto['unit']
    radio = round(GROSOR_RIG * unit)

    for nombre, parte in manifiesto['parts'].items():
        origen = carpeta / parte['file']
        pieza = Image.open(origen).convert('RGBA')

        # El lienzo crece por los cuatro lados: el contorno vive fuera de la
        # silueta y sin lugar quedaría cortado contra el borde de la imagen.
        ancho, alto = pieza.size
        lienzo = Image.new('RGBA', (ancho + radio * 2, alto + radio * 2), (0, 0, 0, 0))
        lienzo.paste(pieza, (radio, radio))

        alpha = lienzo.getchannel('A')
        borde = dilatar(alpha, radio)
        borde = destapar_corte(borde, alpha, parte.get('corte'))

        # El contorno va DEBAJO: se pinta la silueta ensanchada de negro y se
        # pega la pieza encima. Restarlo daría lo mismo salvo en los píxeles
        # semitransparentes del borde, donde así se mezcla solo.
        fondo = Image.new('RGBA', lienzo.size, COLOR + (0,))
        fondo.putalpha(borde)
        resultado = Image.alpha_composite(fondo, lienzo)

        # Recorte a lo que de verdad ocupa: el margen sobra donde la dilatación
        # no llegó, y son megabytes de nada en seis personajes por seis piezas.
        caja = resultado.getchannel('A').getbbox()
        if caja is None:
            continue
        resultado = resultado.crop(caja)
        resultado.save(origen, 'PNG', optimize=True)

        # El pivote va en FRACCIÓN de 0 a 1 del tamaño de la pieza, no en
        # píxeles: `loadArt` lo valida y rechaza el manifiesto si se le pasan
        # píxeles. Así que hay que llevarlo a píxeles con el tamaño VIEJO,
        # moverlo como se movió la imagen —`radio` de margen, menos la esquina
        # del recorte— y volverlo a fracción con el tamaño NUEVO.
        #
        # Sin esto los miembros giran desde un punto corrido y el muñeco se
        # desarma; con píxeles en el campo, la escena ni carga.
        px = parte['pivot'][0] * ancho + radio - caja[0]
        py = parte['pivot'][1] * alto + radio - caja[1]
        parte['pivot'] = [px / resultado.width, py / resultado.height]

    manifiesto['_contorno'] = (
        f'Piezas con contorno horneado de {GROSOR_RIG} unidades de rig '
        f'({radio} px acá), por scripts/contorno.py. Volver a pasar cortar.py '
        f'lo borra: primero cortar, después contornear.')
    ruta.write_text(json.dumps(manifiesto, indent=2, ensure_ascii=False))
    print(f'  {carpeta.name}: contorno de {radio} px sobre unit {unit}')


def main() -> None:
    if len(sys.argv) > 1:
        carpetas = [ARTE / a.lower() for a in sys.argv[1:]]
    else:
        carpetas = sorted(c for c in ARTE.iterdir() if c.is_dir())
    for carpeta in carpetas:
        if not carpeta.is_dir():
            raise SystemExit(f'no existe {carpeta}')
        contornear(carpeta)


if __name__ == '__main__':
    main()
