#!/usr/bin/env python3
"""
Convierte los clips de Kling en la hoja de sprites de un personaje.

    python3 scripts/hoja-sprites.py ragnir \\
        run=arte-crudo/clips/ragnir-run.mp4:0.6:3.0 \\
        jump=arte-crudo/poses/ragnir-salto.png

Cada argumento es `accion=origen`, y el origen puede ser de dos clases:

- **un clip**, con los segundos del tramo que sirve: `clip.mp4:desde:hasta`. El
  tramo importa, porque el modelo no cicla sino que actúa: en un par de cuadros
  gira a vista frontal y ahí deja de servir como sprite lateral. El recorte se
  elige mirando la tira que este mismo script imprime.
- **una hoja de poses**, una imagen con las figuras en fila sobre blanco. Se
  separan por columnas vacías. Para el salto es lo que corresponde y no un
  clip: pedido como video, el modelo lo mandó hacia el fondo en vez de hacia
  arriba —el personaje se achicaba a un tercio— y en un juego de peleas un
  salto son cinco dibujos, porque el arco lo pone la física.

Sale una sola imagen por personaje, `public/art/<slug>/hojas.png`, con todas las
acciones una abajo de la otra, más `hojas.json` con los rectángulos. Una textura
por personaje y no una por acción: Pixi agrupa por textura, y el techo del
proyecto son dieciséis draw calls con seis peleadores en pantalla.

**El anclaje es lo único delicado.** El juego mueve al personaje por física; del
sprite sólo quiere la POSE. Si los cuadros se alinean por el borde de abajo, el
salto se aplana —los pies se pegan al piso justo cuando tendrían que despegar—;
si se alinean por la posición cruda del video, el salto sale doble, una vez por
la física y otra por el dibujo. Se alinean por el **centroide de la silueta**,
que es el punto que la física mueve y el que menos tiembla entre cuadros.
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


RAIZ = Path(__file__).resolve().parent.parent
ARTE = RAIZ / 'public' / 'art'

# Cuántos cuadros queda cada acción. Doce a 24 por segundo es medio segundo de
# ciclo, que es lo que dura una carrera; más cuadros no se notan y pesan.
CUADROS = 12
# Alto de la figura de pie, en píxeles de la hoja. El juego la dibuja a unos 90
# px con la cámara abierta y 260 con la cerrada, así que 320 deja margen para
# acercarse sin que se pixele, y no tanto como para que la hoja pese de más.
ALTO = 320
# Margen alrededor de cada cuadro, en píxeles de hoja. Sin margen el filtrado
# bilineal de Pixi chupa el píxel del cuadro de al lado y aparece una costura.
MARGEN = 4


# Cuánto puede alejarse del blanco un píxel y seguir contando como fondo. Igual
# criterio que `alfa.py`: el blanco del generador mide 255 plano, pero el códec
# del video deja bordes de 240 y pico.
TOLERANCIA = 46
# Píxeles de contorno que se comen para matar el halo claro que deja el códec.
COMER = 2


def manchar(mask: np.ndarray, semillas: list[tuple[int, int]]) -> np.ndarray:
    """Todo lo que se toca con alguna semilla, dentro de `mask`.

    Relleno por **líneas** y no por píxeles: llena de una toda la corrida
    horizontal y sólo empuja las filas de arriba y de abajo, así que el trabajo
    en Python es proporcional a la cantidad de corridas y no a la de píxeles.
    `ImageDraw.floodfill` de Pillow, que es por píxel y en Python puro, se
    cuelga con dos megapíxeles por cuadro.
    """
    alto, ancho = mask.shape
    marcado = np.zeros_like(mask)
    pila = list(semillas)
    while pila:
        x, y = pila.pop()
        if not mask[y, x] or marcado[y, x]:
            continue
        fila = mask[y]
        izq = x
        while izq > 0 and fila[izq - 1]:
            izq -= 1
        der = x
        while der < ancho - 1 and fila[der + 1]:
            der += 1
        marcado[y, izq:der + 1] = True
        for ny in (y - 1, y + 1):
            if ny < 0 or ny >= alto:
                continue
            candidata = mask[ny, izq:der + 1] & ~marcado[ny, izq:der + 1]
            if not candidata.any():
                continue
            # Sólo el arranque de cada tramo, para no apilar cada píxel.
            previa = np.concatenate(([False], candidata[:-1]))
            for i in np.nonzero(candidata & ~previa)[0]:
                pila.append((izq + int(i), ny))
    return marcado


def inundar(cuadro: Image.Image) -> Image.Image:
    """Le saca el fondo blanco al cuadro y lo deja con alfa real.

    Hace lo mismo que `alfa.sacar_fondo` pero por **líneas** en vez de por
    píxeles. `ImageDraw.floodfill` de Pillow es Python puro: sobre las hojas de
    kit, que se procesan una vez, no molesta; sobre doce cuadros de dos
    megapíxeles cada uno se cuelga. Este llena de una toda la corrida horizontal
    y sólo empuja las filas de arriba y de abajo, así que el trabajo en Python
    es proporcional a la cantidad de corridas y no a la de píxeles.

    Se inunda desde el borde y no se borra "todo lo blanco" porque el personaje
    tiene blancos adentro —los ojos, los dientes, las garras— y borrarlos por
    color se los come. La inundación sólo alcanza lo que se toca con el borde.
    """
    a = np.asarray(cuadro.convert('RGB')).astype(np.int16)
    claro = (a > 255 - TOLERANCIA).all(axis=2)
    alto, ancho = claro.shape
    esquinas = [(0, 0), (ancho - 1, 0), (0, alto - 1), (ancho - 1, alto - 1)]
    fondo = manchar(claro, esquinas)
    alpha = np.where(fondo, 0, 255).astype(np.uint8)
    capa = Image.fromarray(alpha, 'L')
    if COMER > 0:
        capa = capa.filter(ImageFilter.MinFilter(COMER * 2 + 1))
    capa = capa.filter(ImageFilter.GaussianBlur(0.6))
    salida = cuadro.convert('RGBA')
    salida.putalpha(capa)
    return salida


def sin_borde(cuadro: Image.Image) -> Image.Image:
    """Blanquea las columnas y filas oscuras de punta a punta.

    Los clips de Kling vienen con una tira de 25 px pegada al borde derecho, de
    alto completo. No es del personaje pero toca el borde de la imagen, así que
    la inundación de `alfa.py` la toma como parte de la figura y después el
    recorte por caja se lleva media hoja de aire.
    """
    a = np.array(cuadro)
    tinta = a.astype(int).sum(axis=2) < 730
    columna = tinta.all(axis=0)
    fila = tinta.all(axis=1)
    if columna.any() or fila.any():
        a = a.copy()
        a[:, columna] = 255
        a[fila, :] = 255
        return Image.fromarray(a)
    return cuadro


def figuras_de_la_hoja(hoja: Path) -> list[Image.Image]:
    """Separa las figuras de una hoja de poses, una por mancha conexa.

    Por manchas y no por columnas vacías: en la hoja del salto las poses se
    superponen de costado —las garras de una entran en la columna de la
    siguiente— y el corte por columnas devolvía dos figuras en vez de cinco.
    Dos figuras que de verdad se tocan seguirían saliendo juntas, pero eso se ve
    en el conteo que este script imprime y se arregla regenerando la hoja.
    """
    im = sin_borde(Image.open(hoja).convert('RGB'))
    tinta = np.asarray(im).astype(int).sum(axis=2) < 730
    manchas = []
    pendiente = tinta.copy()
    while pendiente.any():
        ys, xs = np.nonzero(pendiente)
        mancha = manchar(tinta, [(int(xs[0]), int(ys[0]))])
        pendiente &= ~mancha
        manchas.append(mancha)
    if not manchas:
        raise SystemExit(f'{hoja}: no se encontró ninguna figura')

    # Las motas —una garra suelta, un resto de firma— se descartan por tamaño.
    pesos = [int(m.sum()) for m in manchas]
    corte = max(pesos) * 0.05
    figuras = [m for m, p in zip(manchas, pesos) if p >= corte]
    # De izquierda a derecha, que es el orden en que se leen las poses.
    figuras.sort(key=lambda m: float(np.nonzero(m.any(axis=0))[0].mean()))

    a = np.asarray(im)
    salida = []
    for mancha in figuras:
        tira = np.full_like(a, 255)
        tira[mancha] = a[mancha]
        salida.append(Image.fromarray(tira))
    return salida


def cuadros_del_clip(clip: Path, desde: float, hasta: float) -> list[Image.Image]:
    """Saca los cuadros del tramo pedido, en RGB."""
    with tempfile.TemporaryDirectory() as tmp:
        orden = ['ffmpeg', '-v', 'error', '-y', '-ss', f'{desde}']
        if hasta > desde:
            orden += ['-to', f'{hasta}']
        orden += ['-i', str(clip), f'{tmp}/%04d.png']
        subprocess.run(orden, check=True)
        rutas = sorted(Path(tmp).glob('*.png'))
        if not rutas:
            raise SystemExit(f'{clip}: el tramo {desde}-{hasta} no dio cuadros')
        return [sin_borde(Image.open(r).convert('RGB')) for r in rutas]


def recortar(cuadro: Image.Image) -> tuple[Image.Image, tuple[float, float], float]:
    """Deja el cuadro con alfa y devuelve su centroide y su alto de silueta.

    El centroide se saca del alfa y no de la caja: la caja se estira cuando el
    personaje extiende un brazo, y entonces el cuerpo se corre aunque no se haya
    movido. El centroide pesa píxeles, así que un brazo estirado lo mueve poco.
    """
    con_alfa = inundar(cuadro)
    a = np.array(con_alfa.getchannel('A'))
    lleno = a > 40
    if not lleno.any():
        raise SystemExit('un cuadro salió vacío: el fondo blanco no era plano')
    ys, xs = np.nonzero(lleno)
    caja = (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    peso = a.astype(np.float64)
    total = peso.sum()
    cx = float((peso.sum(axis=0) * np.arange(a.shape[1])).sum() / total)
    cy = float((peso.sum(axis=1) * np.arange(a.shape[0])).sum() / total)
    # El tamaño se mide por ÁREA y no por alto. El alto de la silueta cambia con
    # la pose —el salto se encoge al recoger las piernas y se estira al despegar—
    # así que normalizar por alto hace que el personaje cambie de tamaño en el
    # aire. El área de tinta se mueve mucho menos: un miembro que se dobla sigue
    # ocupando los mismos píxeles.
    return con_alfa.crop(caja), (cx - caja[0], cy - caja[1]), float(lleno.sum())


def diezmar(cuadros: list, cuantos: int) -> list:
    """Se queda con `cuantos` cuadros repartidos parejo."""
    if len(cuadros) <= cuantos:
        return cuadros
    paso = len(cuadros) / cuantos
    return [cuadros[min(len(cuadros) - 1, round(i * paso))] for i in range(cuantos)]


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    slug = sys.argv[1].lower()
    carpeta = ARTE / slug
    if not carpeta.is_dir():
        raise SystemExit(f'no existe {carpeta}')

    acciones: dict[str, list] = {}
    # Cada acción se escala por su cuenta, porque cada una viene de un origen
    # con su propia resolución: el clip de la carrera son cuadros de 1248x1660 y
    # la hoja del salto mide 2752x1536. Un factor único los deja al doble uno del
    # otro. Lo que iguala a las dos es el ÁREA de silueta, que es lo que no
    # cambia cuando el personaje se encoge.
    escalas: dict[str, float] = {}
    lado_patron = None
    alto_crudo = None

    for arg in sys.argv[2:]:
        nombre, _, resto = arg.partition('=')
        partes = resto.split(':')
        origen = Path(partes[0])
        if not origen.is_absolute():
            origen = RAIZ / origen
        if not origen.exists():
            raise SystemExit(f'no existe {origen}')

        if origen.suffix.lower() in ('.mp4', '.webm', '.mov'):
            desde = float(partes[1]) if len(partes) > 1 and partes[1] else 0.0
            hasta = float(partes[2]) if len(partes) > 2 and partes[2] else 0.0
            crudos = cuadros_del_clip(origen, desde, hasta)
            crudos = diezmar(crudos, CUADROS)
        else:
            # Una hoja de poses ya viene diezmada: cada figura es un cuadro
            # clave y sacar uno rompe la acción.
            crudos = figuras_de_la_hoja(origen)
        piezas = [recortar(c) for c in crudos]
        if alto_crudo is None:
            # La mediana y no el máximo: un cuadro con el brazo en alto no puede
            # decidir la escala de todo el personaje.
            alto_crudo = float(np.median([p[2] for p in piezas]))
        acciones[nombre] = piezas
        # El "lado" de la silueta: la raíz del área, que es una longitud y por lo
        # tanto se puede comparar contra un alto.
        lado = float(np.median([np.sqrt(p[2]) for p in piezas]))
        if lado_patron is None:
            # La primera acción manda: su alto de silueta es el que se lleva a
            # ALTO, y de ahí sale el lado que las demás tienen que igualar.
            alto_crudo = float(np.median([p[0].height for p in piezas]))
            lado_patron = lado * (ALTO / alto_crudo)
        escalas[nombre] = lado_patron / lado
        print(f'  {nombre:8s} {len(crudos):3d} cuadros -> {len(piezas)}'
              f'  (lado de silueta {lado:.0f} px, escala {escalas[nombre]:.3f})')

    assert alto_crudo is not None and alto_crudo > 0

    # Del centroide para abajo hasta los pies, en unidades de rig, medido sobre
    # la PRIMERA acción. El juego coloca al personaje por su centro y la mitad
    # de su alto de colisión son 52 unidades; sin este número el sprite queda
    # hundido en la plataforma o flotando, porque el centroide de un bicho
    # cabezón no cae en el medio de la figura.
    primera_nombre = next(iter(acciones))
    escala_primera = escalas[primera_nombre]
    suelo = float(np.median([(img.height - centro[1]) * escala_primera / (ALTO / 104.0)
                             for img, centro, _ in acciones[primera_nombre]]))

    # Cada acción es una fila. El ancho de celda es el del cuadro más ancho de
    # todas las acciones, para que un solo número alcance para leer la hoja.
    celdas = []
    for nombre, piezas in acciones.items():
        for img, centro, _ in piezas:
            celdas.append((round(img.width * escalas[nombre]),
                           round(img.height * escalas[nombre])))
    celda_w = max(c[0] for c in celdas) + MARGEN * 2
    celda_h = max(c[1] for c in celdas) + MARGEN * 2

    ancho = celda_w * max(len(p) for p in acciones.values())
    alto = celda_h * len(acciones)
    hoja = Image.new('RGBA', (ancho, alto), (0, 0, 0, 0))

    manifiesto = {
        '_': ('Hoja de sprites armada por scripts/hoja-sprites.py desde los clips '
              'de Kling. `anchor` es la fracción del cuadro donde cae el centroide '
              'de la silueta, que es el punto que la física mueve, y `ground` es '
              'cuántas unidades de rig hay de ese centroide a los pies.'),
        'file': 'hojas.png',
        'cell': [celda_w, celda_h],
        # Cuántos píxeles de hoja mide una unidad de rig. La figura de pie mide
        # ALTO píxeles y el rig la quiere de 104 unidades, igual que las piezas.
        'unit': round(ALTO / 104.0, 4),
        'ground': round(suelo, 3),
        'animations': {},
    }

    for fila, (nombre, piezas) in enumerate(acciones.items()):
        cuadros = []
        escala = escalas[nombre]
        for col, (img, centro, _) in enumerate(piezas):
            w, h = round(img.width * escala), round(img.height * escala)
            chico = img.resize((max(1, w), max(1, h)), Image.LANCZOS)
            x = col * celda_w + (celda_w - w) // 2
            y = fila * celda_h + (celda_h - h) // 2
            hoja.alpha_composite(chico, (x, y))
            cuadros.append({
                'rect': [x - MARGEN, y - MARGEN, w + MARGEN * 2, h + MARGEN * 2],
                # Dónde cae el centroide dentro del rectángulo, en fracción.
                'anchor': [round((MARGEN + centro[0] * escala) / (w + MARGEN * 2), 4),
                           round((MARGEN + centro[1] * escala) / (h + MARGEN * 2), 4)],
            })
        manifiesto['animations'][nombre] = {'frames': cuadros}

    (carpeta / 'hojas.png').write_bytes(b'')
    hoja.save(carpeta / 'hojas.png', 'PNG', optimize=True)
    (carpeta / 'hojas.json').write_text(
        json.dumps(manifiesto, indent=2, ensure_ascii=False))
    peso = (carpeta / 'hojas.png').stat().st_size / 1e6
    print(f'{carpeta / "hojas.png"}  {hoja.size}  {peso:.2f} MB'
          f'  ·  celda {celda_w}x{celda_h}  ·  {len(acciones)} acciones')


if __name__ == '__main__':
    main()
