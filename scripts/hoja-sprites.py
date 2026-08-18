#!/usr/bin/env python3
"""
Convierte los clips de Kling en la hoja de sprites de un personaje.

    python3 scripts/hoja-sprites.py ragnir \\
        run=arte-crudo/clips/ragnir-run.mp4:0.6:3.0 \\
        jump=arte-crudo/poses/ragnir-salto.png:5

Cada argumento es `accion=origen`, y el origen puede ser de dos clases:

- **un clip**, con los segundos del tramo que sirve: `clip.mp4:desde:hasta`. El
  tramo importa, porque el modelo no cicla sino que actúa: en un par de cuadros
  gira a vista frontal y ahí deja de servir como sprite lateral. El recorte se
  elige mirando la tira que este mismo script imprime.
- **una hoja de poses**, una imagen con las figuras en fila sobre blanco, y
  opcionalmente cuántas figuras tiene que haber: `hoja.png:5`. Con un tercer
  campo `parejo` —`hoja.png:3:parejo`— cada figura se escala por su cuenta hasta
  igualar el área de silueta de las demás, en vez de compartir una escala. Hace
  falta cuando la hoja viene de un generador que dibujó cada pose de un tamaño
  distinto; sin eso el personaje late al cambiar de cuadro. No es el modo por
  defecto porque en una hoja bien dibujada el área SÍ cambia un poco de pose a
  pose —un cuerpo encogido tapa menos— y forzarla lo estropearía. Para el salto es
  lo que corresponde y no un clip: pedido como video, el modelo lo mandó hacia
  el fondo en vez de hacia arriba —el personaje se achicaba a un tercio— y en un
  juego de peleas un salto son cinco dibujos, porque el arco lo pone la física.

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


def tinta_de(a: np.ndarray) -> np.ndarray:
    """Qué píxeles son dibujo y no fondo, con el mismo criterio que `inundar`.

    Un solo umbral para todo el script, y por canal. La versión anterior medía
    la suma de los tres canales contra 730 —o sea un promedio de 243— y eso
    rompe con los clips: el códec deja una neblina celeste alrededor del pelo
    blanco de Dusk, de unos 242 planos, que pasa el umbral de la suma pero no el
    de canal. Franjas enteras de fondo entraban como tinta, la regla de la línea
    de piso las tomaba por piso y las blanqueaba, y el personaje aparecía
    cortado en tiras a la altura de la cara.
    """
    return ~(a > 255 - TOLERANCIA).all(axis=2)


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


# Qué fracción del ancho tiene que cubrir una fila para ser una línea de piso y
# no parte de un personaje, y cuánto puede medir de alto. Se mide sobre la
# CORRIDA más larga de tinta seguida, no sobre el total de la fila: seis figuras
# en hilera tienen seis hombros a la misma altura y entre todas pasan la mitad
# del ancho sin que haya ninguna línea. Medido por total, la regla les blanqueaba
# esa fila y el personaje salía con una raya blanca cruzándole el pecho.
REGLA_ANCHO = 0.5
REGLA_ALTO = 0.015


def corrida_maxima(fila: np.ndarray) -> int:
    """El tramo de tinta seguida más largo de una fila."""
    bordes = np.diff(np.concatenate(([0], fila.astype(np.int8), [0])))
    ini = np.nonzero(bordes == 1)[0]
    if len(ini) == 0:
        return 0
    return int((np.nonzero(bordes == -1)[0] - ini).max())


def sin_borde(cuadro: Image.Image, piso: bool = True) -> Image.Image:
    """Blanquea las tiras del borde y la línea de piso dibujada.

    Dos cosas que llegan con la imagen y no son el personaje:

    - **La tira del borde**: los clips de Kling vienen con una de 25 px pegada al
      borde derecho, de alto completo. Toca el borde de la imagen, así que la
      inundación la toma como parte de la figura y el recorte por caja se lleva
      media hoja de aire.
    - **La línea de piso** (`piso`, sólo en las hojas de poses): el generador la
      dibuja aunque se le pida que no, y es
      peor, porque **toca los pies**. Fusionada con ellos deja de parecer una
      línea —pasa a ser una mancha ancha Y alta— y ninguna regla de proporción
      la reconoce; lo que se ve después es una figura de 2500 px de ancho que se
      comió a las otras tres. Por eso se corta acá, antes de buscar manchas, y
      por franja fina y ancha en vez de por fila completa: la línea no siempre
      llega de punta a punta.

      En los **clips** esa regla no corre. Un video no trae línea de piso —el
      generador dibuja una en las hojas, no en los cuadros— y en cambio trae
      neblina del códec, franjas de fondo apenas grises que la regla confunde
      con el piso y blanquea: quedaba el personaje tachado con una raya a la
      altura del pecho, un cuadro sí y otro no.
    """
    a = np.array(cuadro)
    tinta = tinta_de(a.astype(np.int16))
    alto, ancho = tinta.shape
    a = a.copy()

    a[:, tinta.all(axis=0)] = 255
    a[tinta.all(axis=1), :] = 255

    if not piso:
        return Image.fromarray(a)

    # Las franjas finas que cruzan media hoja de un tirón: se blanquean enteras.
    minimo = ancho * REGLA_ANCHO
    # El total de la fila es sólo el filtro barato: si ni sumando todos los
    # pedazos llega, no hace falta medir la corrida.
    llena = np.zeros(alto, dtype=bool)
    for y in np.nonzero(tinta.sum(axis=1) > minimo)[0]:
        llena[y] = corrida_maxima(tinta[y]) > minimo
    ini = None
    for y in range(alto + 1):
        if y < alto and llena[y]:
            if ini is None:
                ini = y
        elif ini is not None:
            if y - ini <= max(3, alto * REGLA_ALTO):
                a[ini:y, :] = 255
            ini = None
    return Image.fromarray(a)


def agrupar_por_centro(centros: list[float], cuantos: int,
                       pesos: list[int]) -> set[int]:
    """Reparte manchas en `cuantos` figuras y devuelve dónde cortar la fila.

    Cada figura se ancla en su mancha más grande —el torso— y todo lo demás cae
    en el ancla que tiene más cerca. Las anclas se eligen por área de mayor a
    menor, salteando las que caigan demasiado cerca de una ya elegida, así dos
    pedazos de un mismo cuerpo no se llevan dos anclas.

    Las dos formas evidentes fallan, y las dos fallaron acá:

    - **Cortar por los huecos más grandes**: en la hoja de Kor los huecos más
      anchos son los que separan un puño de su propio cuerpo, no los que separan
      dos figuras. Sus puños y sus pies flotan despegados.
    - **K-medias pesada por área**, que es lo que había: con las poses repartidas
      desparejo —un salto tiene la figura del ápice corrida hacia arriba y las de
      los costados más juntas— arrancaba con los centros repartidos parejo y
      convergía torcida. En la hoja de salto de Kor dejó un cuadro con dos
      cuerpos y otro con dos puños sueltos y ningún cuerpo.

    El ancla no converge a nada: es la mancha grande, y la mancha grande es el
    cuerpo. Por eso no depende de cómo estén repartidas las poses.
    """
    if cuantos <= 1:
        return set()
    lo, hi = min(centros), max(centros)
    # Dos figuras no pueden estar más juntas que media separación pareja; los
    # pedazos sueltos de una misma figura, sí.
    sep = (hi - lo) / (cuantos * 2)
    orden = sorted(range(len(centros)), key=lambda i: -pesos[i])
    nucleos: list[int] = []
    while True:
        nucleos = []
        for i in orden:
            if all(abs(centros[i] - centros[j]) >= sep for j in nucleos):
                nucleos.append(i)
                if len(nucleos) == cuantos:
                    break
        if len(nucleos) == cuantos or sep <= 0:
            break
        sep /= 2

    ancla = sorted(centros[i] for i in nucleos)
    asignado = [min(range(len(ancla)), key=lambda j: abs(c - ancla[j]))
                for c in centros]
    # Los centros vienen ordenados y las anclas también, así que la asignación
    # es monótona: se corta donde cambia de grupo.
    return {i for i in range(len(centros) - 1) if asignado[i] != asignado[i + 1]}


def figuras_de_la_hoja(hoja: Path, esperadas: int = 0) -> list[Image.Image]:
    """Separa las figuras de una hoja de poses sobre blanco.

    Se buscan las manchas conexas y después se agrupan en figuras cortando por
    los huecos más grandes entre centros. Hacen falta los dos pasos:

    - Sólo por columnas vacías no alcanza: en las hojas de golpe el puño
      extendido de una figura se mete en la columna de la siguiente.
    - Sólo por manchas tampoco: Kor es un gólem con los puños y los pies
      FLOTANDO despegados del cuerpo, así que cada pose suya son cinco manchas
      sueltas y saldrían como cinco figuras.

    Cortar por los huecos grandes resuelve los dos casos, porque la distancia
    entre dos figuras siempre es mayor que la distancia entre las partes de una.

    **El etiquetado va a escala reducida.** Una hoja de Kling son cuatro
    megapíxeles y el relleno por líneas es Python: a resolución completa tarda
    minutos. A un tercio son nueve veces menos píxeles y la agrupación no
    cambia, porque lo único que se decide acá es qué mancha va con cuál. El
    recorte final sí sale de la imagen entera.

    `esperadas` es cuántas figuras tiene que haber. No cambia el corte: sólo
    grita si no dio, que es la diferencia entre enterarse acá o descubrirlo
    mirando una hoja con el personaje partido al medio.
    """
    im = sin_borde(Image.open(hoja).convert('RGB'))
    tinta = tinta_de(np.asarray(im).astype(np.int16))

    ESCALA = 3
    chico = Image.fromarray(tinta.astype(np.uint8) * 255, 'L').resize(
        (max(1, im.width // ESCALA), max(1, im.height // ESCALA)), Image.BOX)
    # Umbral bajo: al encoger, una línea fina se diluye, y perderla partiría una
    # figura en dos.
    mask = np.asarray(chico) > 20

    manchas = []
    pendiente = mask.copy()
    ancho_chico = mask.shape[1]
    while True:
        # `argmax` sobre el aplanado y no `nonzero`: nonzero materializa un
        # arreglo con TODOS los índices encendidos en cada vuelta, y son
        # millones.
        plano = pendiente.reshape(-1)
        i = int(plano.argmax())
        if not plano[i]:
            break
        mancha = manchar(mask, [(i % ancho_chico, i // ancho_chico)])
        pendiente &= ~mancha
        manchas.append(mancha)
    if not manchas:
        raise SystemExit(f'{hoja}: no se encontró ninguna figura')

    # Las motas —una garra suelta, un resto de firma— se descartan por tamaño.
    pesos = [int(m.sum()) for m in manchas]
    corte = max(pesos) * 0.004
    manchas = [m for m, w in zip(manchas, pesos) if w >= corte]

    # Y las REGLAS: la línea de piso, fina y larguísima, que el generador dibuja
    # aunque se le pida que no. Pega todas las figuras en una sola mancha y hay
    # que sacarla antes de agrupar. Se reconoce por la proporción: ninguna parte
    # de un personaje mide veinte veces más de ancho que de alto.
    def es_regla(m):
        filas = np.nonzero(m.any(axis=1))[0]
        cols = np.nonzero(m.any(axis=0))[0]
        alto = filas[-1] - filas[0] + 1
        ancho = cols[-1] - cols[0] + 1
        # En los dos sentidos. Horizontal es la línea de piso; vertical es el
        # borde del panel que el generador dibuja entre pose y pose aunque se le
        # pida que no, y que se agrupaba con la figura de al lado: a Ragnir le
        # quedó una raya negra pegada al costado en el puño y en el quieto.
        # Ninguna parte de un personaje es veinte veces más larga que ancha…
        # …pero sí lo son la ceja de Asuri y la franja del cinturón, que el
        # contorno negro deja como manchas sueltas. Por proporción sola se las
        # comía y al personaje le quedaba una banda blanca cruzándole la cara.
        # Lo que separa una raya del generador de una raya del dibujo es el
        # TAMAÑO: la línea de piso cruza la hoja entera de punta a punta y el
        # borde de panel la cruza de arriba abajo, mientras que una franja del
        # personaje no puede pasar del ancho de ese personaje.
        return ((ancho > alto * 20 and ancho > mask.shape[1] * 0.5)
                or (alto > ancho * 20 and alto > mask.shape[0] * 0.5))
    manchas = [m for m in manchas if not es_regla(m)]
    if not manchas:
        raise SystemExit(f'{hoja}: sólo se encontraron líneas, ninguna figura')

    centros = []
    for m in manchas:
        cols = np.nonzero(m.any(axis=0))[0]
        centros.append(((int(cols[0]) + int(cols[-1])) / 2, m))
    centros.sort(key=lambda c: c[0])

    if esperadas > 0:
        if len(centros) < esperadas:
            raise SystemExit(
                f'{hoja}: sólo se encontraron {len(centros)} manchas y se '
                f'esperaban {esperadas} figuras. Mirá la hoja: seguro dos poses '
                f'se tocan.')
        cortes = agrupar_por_centro([c for c, _ in centros], esperadas,
                                    [int(m.sum()) for _, m in centros])
    else:
        # Sin número esperado se cortan los huecos que pasen la mitad del mayor.
        saltos = [centros[i + 1][0] - centros[i][0] for i in range(len(centros) - 1)]
        umbral = max(saltos) * 0.5 if saltos else 0
        cortes = {i for i, s in enumerate(saltos) if s >= umbral}

    grupos, actual = [], centros[0][1]
    for i in range(len(centros) - 1):
        if i in cortes:
            grupos.append(actual)
            actual = centros[i + 1][1]
        else:
            actual = actual | centros[i + 1][1]
    grupos.append(actual)

    if esperadas and len(grupos) != esperadas:
        raise SystemExit(
            f'{hoja}: salieron {len(grupos)} figuras y se esperaban {esperadas}.')

    a = np.asarray(im)
    salida = []
    for grupo in grupos:
        # De vuelta a resolución completa. El engorde de dos píxeles cubre el
        # borde que el achique se comió; lo que sobra no molesta porque después
        # se corta contra la tinta de verdad.
        gordo = Image.fromarray(grupo.astype(np.uint8) * 255, 'L').filter(
            ImageFilter.MaxFilter(5)).resize((im.width, im.height), Image.NEAREST)
        dentro = (np.asarray(gordo) > 0) & tinta
        tira = np.full_like(a, 255)
        tira[dentro] = a[dentro]
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
        return [sin_borde(Image.open(r).convert('RGB'), piso=False) for r in rutas]


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
    por_cuadro: dict[str, list[float]] = {}
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

        parejo = False
        if origen.suffix.lower() in ('.mp4', '.webm', '.mov'):
            desde = float(partes[1]) if len(partes) > 1 and partes[1] else 0.0
            hasta = float(partes[2]) if len(partes) > 2 and partes[2] else 0.0
            crudos = cuadros_del_clip(origen, desde, hasta)
            crudos = diezmar(crudos, CUADROS)
        else:
            # Una hoja de poses ya viene diezmada: cada figura es un cuadro
            # clave y sacar uno rompe la acción. El número que sigue a los dos
            # puntos es cuántas figuras tiene que haber.
            esperadas = int(partes[1]) if len(partes) > 1 and partes[1] else 0
            crudos = figuras_de_la_hoja(origen, esperadas)
            parejo = len(partes) > 2 and partes[2] == 'parejo'
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
        # Una escala por cuadro. Normalmente son todas la misma; con `parejo`,
        # cada una lleva su cuadro al mismo lado de silueta que el resto.
        por_cuadro[nombre] = ([lado_patron / float(np.sqrt(pieza[2])) for pieza in piezas]
                              if parejo else [escalas[nombre]] * len(piezas))
        print(f'  {nombre:8s} {len(crudos):3d} cuadros -> {len(piezas)}'
              f'  (lado de silueta {lado:.0f} px, escala {escalas[nombre]:.3f}'
              f'{", parejo" if parejo else ""})')

    assert alto_crudo is not None and alto_crudo > 0

    # Del centroide para abajo hasta los pies, en unidades de rig, medido sobre
    # la PRIMERA acción. El juego coloca al personaje por su centro y la mitad
    # de su alto de colisión son 52 unidades; sin este número el sprite queda
    # hundido en la plataforma o flotando, porque el centroide de un bicho
    # cabezón no cae en el medio de la figura.
    #
    # **Se mide POR ACCIÓN.** El centroide de una silueta no cae a la misma
    # altura en todas las poses: el que corre tiene una pierna estirada, el que
    # patea una levantada, el que está de pie las dos juntas. Con un solo
    # número para todo el personaje —que es como estaba— la pose de pie quedaba
    # flotando hasta 11 unidades de rig y la patada hundida 8 en la plataforma.
    #
    # Por acción y no por CUADRO a propósito: adentro de una acción los cuadros
    # tienen que conservar su movimiento relativo, y pegando cada cuadro al
    # piso el salto se aplana justo cuando tendría que despegar.
    pisos: dict[str, float] = {}
    for nombre, piezas in acciones.items():
        e = escalas[nombre]
        pisos[nombre] = round(float(np.median(
            [(img.height - centro[1]) * e / (ALTO / 104.0) for img, centro, _ in piezas])), 3)
    primera_nombre = next(iter(acciones))
    suelo = pisos[primera_nombre]

    # Cada acción es una fila. El ancho de celda es el del cuadro más ancho de
    # todas las acciones, para que un solo número alcance para leer la hoja.
    celdas = []
    for nombre, piezas in acciones.items():
        for escala, (img, centro, _) in zip(por_cuadro[nombre], piezas):
            celdas.append((round(img.width * escala), round(img.height * escala)))
    celda_w = max(c[0] for c in celdas) + MARGEN * 2
    celda_h = max(c[1] for c in celdas) + MARGEN * 2

    ancho = celda_w * max(len(p) for p in acciones.values())
    alto = celda_h * len(acciones)
    hoja = Image.new('RGBA', (ancho, alto), (0, 0, 0, 0))

    manifiesto = {
        '_': ('Hoja de sprites armada por scripts/hoja-sprites.py desde los clips '
              'de Kling. `anchor` es la fracción del cuadro donde cae el centroide '
              'de la silueta, que es el punto que la física mueve. `ground` es '
              'cuántas unidades de rig hay de ese centroide a los pies: el de '
              'arriba es el de la primera acción y queda de respaldo, y el de cada '
              'animación es el que vale, porque el centroide no cae a la misma '
              'altura parado que pateando.'),
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
        for col, (escala, (img, centro, _)) in enumerate(zip(por_cuadro[nombre], piezas)):
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
        manifiesto['animations'][nombre] = {'frames': cuadros, 'ground': pisos[nombre]}

    (carpeta / 'hojas.png').write_bytes(b'')
    hoja.save(carpeta / 'hojas.png', 'PNG', optimize=True)
    (carpeta / 'hojas.json').write_text(
        json.dumps(manifiesto, indent=2, ensure_ascii=False))
    peso = (carpeta / 'hojas.png').stat().st_size / 1e6
    print(f'{carpeta / "hojas.png"}  {hoja.size}  {peso:.2f} MB'
          f'  ·  celda {celda_w}x{celda_h}  ·  {len(acciones)} acciones')


if __name__ == '__main__':
    main()
