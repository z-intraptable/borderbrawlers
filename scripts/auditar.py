"""
Audita candidatos de `arte-crudo/candidatos/` y los ordena por facilidad de corte.

    python3 scripts/auditar.py                      todos, ordenados
    python3 scripts/auditar.py Kor Asuri            solo esos

Los dos criterios eliminatorios de `arte-crudo/candidatos/LEEME.md` —brazos que
no toquen el torso, hueco entre las piernas— son medibles sobre el canal alfa, y
medirlos es mucho más confiable que juzgar cincuenta y ocho dibujos a ojo: la
mirada se cansa y cambia de vara a mitad del lote.

La medida clave es **cuántas piezas sueltas** tiene la silueta. Un dibujo cuyos
miembros flotan despegados del torso llega ya cortado, y ahí el recorte no tiene
que inventar qué hay detrás de nada. Un dibujo de una sola pieza obliga a
adivinar cada juntura.

Lo que NO mide, y por eso el veredicto final sigue siendo visual: si algo cruza
por delante del cuerpo. Un arma en diagonal sobre el pecho es parte de la misma
mancha de alfa que el torso, así que pasa todos los umbrales y arruina el corte
igual. Este script achica el lote; no elige.
"""
import sys
import os
import json
from PIL import Image
import numpy as np

CANDIDATOS = 'arte-crudo/candidatos'
# Por debajo de esto un píxel es fondo. No es 0 a propósito: los bordes
# antialiaseados dejan una orla de alfa bajo que une piezas que el ojo ve
# separadas, y con umbral 0 dos brazos despegados cuentan como una sola pieza.
ALFA = 40
# Las piezas de menos de esto son basura: una pestaña, una chispa, el punto de
# una i. Va en fracción del área de la silueta, no en píxeles, para que no
# dependa del tamaño del dibujo.
MINIMA = 0.004


def componentes(mask):
    """
    Cuántas piezas sueltas tiene la máscara, y qué fracción del área ocupa cada
    una. Union-find sobre la máscara reducida: a resolución completa esto tarda
    minutos y la respuesta no cambia, porque lo que se busca son huecos de
    decenas de píxeles, no de uno.
    """
    h, w = mask.shape
    escala = max(1, max(h, w) // 300)
    m = mask[::escala, ::escala]
    h, w = m.shape

    padre = {}

    def raiz(x):
        while padre[x] != x:
            padre[x] = padre[padre[x]]
            x = padre[x]
        return x

    def unir(a, b):
        ra, rb = raiz(a), raiz(b)
        if ra != rb:
            padre[rb] = ra

    for y in range(h):
        for x in range(w):
            if not m[y, x]:
                continue
            aqui = y * w + x
            padre.setdefault(aqui, aqui)
            # Sólo hay que mirar arriba y a la izquierda: lo de abajo y a la
            # derecha ya nos va a mirar a nosotros cuando le toque.
            if x > 0 and m[y, x - 1]:
                unir(padre.setdefault((y) * w + x - 1, (y) * w + x - 1), aqui)
            if y > 0 and m[y - 1, x]:
                unir(padre.setdefault((y - 1) * w + x, (y - 1) * w + x), aqui)

    cuenta = {}
    for k in padre:
        r = raiz(k)
        cuenta[r] = cuenta.get(r, 0) + 1

    total = sum(cuenta.values())
    if total == 0:
        return []
    partes = sorted((n / total for n in cuenta.values()), reverse=True)
    return [p for p in partes if p >= MINIMA]


def cortes(mask, y):
    """Cuántas manchas separadas cruza una línea horizontal a la altura `y`."""
    fila = mask[y]
    n = 0
    dentro = False
    for v in fila:
        if v and not dentro:
            n += 1
            dentro = True
        elif not v:
            dentro = False
    return n


def auditar(nombre, ruta):
    im = Image.open(ruta).convert('RGBA')
    w, h = im.size
    a = np.array(im)
    alfa = a[:, :, 3]
    mask = alfa > ALFA

    if not mask.any():
        return None

    ys, xs = np.where(mask)
    y0, y1 = ys.min(), ys.max()
    x0, x1 = xs.min(), xs.max()
    alto = y1 - y0 + 1
    recorte = mask[y0:y1 + 1, x0:x1 + 1]

    partes = componentes(recorte)

    # Brazos: en la banda de los hombros, tres manchas es brazo|torso|brazo.
    # Se barre la banda entera y se toma el mejor caso, porque la altura exacta
    # del hombro cambia con cada dibujo.
    #
    # La banda va de 25% a 70% y no de 30% a 55% como al principio. El motivo es
    # un falso negativo concreto: Ragnir tiene los dos brazos perfectamente
    # despegados, pero su cabeza ocupa casi la mitad del alto y le empuja los
    # hombros por debajo del 55%. La banda angosta los pasaba de largo y el
    # dibujo salía reprobado por un criterio que cumple de sobra. Cuanto más
    # chibi el personaje, más abajo caen los hombros.
    banda_brazos = range(int(alto * 0.25), int(alto * 0.70))
    brazos = max((cortes(recorte, y) for y in banda_brazos), default=0)

    # Piernas: en la banda de abajo, dos manchas es pierna|hueco|pierna.
    banda_piernas = range(int(alto * 0.70), int(alto * 0.95))
    piernas = max((cortes(recorte, y) for y in banda_piernas), default=0)

    # Tono medio de lo opaco, para repartir bandos: cálido va a rojo (vendedor),
    # frío a verde (comprador). El bando lo tiene que dar el diseño porque a un
    # sprite dibujado no se lo puede teñir sin embarrarlo.
    rgb = a[:, :, :3][mask].astype(float)
    r, g, b = rgb[:, 0].mean(), rgb[:, 1].mean(), rgb[:, 2].mean()
    calido = r - b

    return {
        'nombre': nombre,
        'w': int(w), 'h': int(h),
        'piezas': len(partes),
        'mayor': round(partes[0], 3) if partes else 1.0,
        'brazos': brazos,
        'piernas': piernas,
        'calido': round(calido, 1),
        'grande': min(w, h) >= 1500,
    }


def puntaje(d):
    """
    Facilidad de corte, de 0 a 100. Los pesos siguen el orden del LEEME: los dos
    eliminatorios primero y con la mayor parte del puntaje.
    """
    p = 0
    # Piezas sueltas: lo que más ayuda, con diferencia. Seis o más es un dibujo
    # que ya viene cortado.
    p += min(40, (d['piezas'] - 1) * 8)
    # Brazos despegados del torso.
    if d['brazos'] >= 3:
        p += 25
    elif d['brazos'] == 2:
        p += 10
    # Hueco entre las piernas.
    if d['piernas'] >= 2:
        p += 25
    # Que ninguna pieza se coma el dibujo entero: si la mayor es casi todo, los
    # miembros están pegados aunque la línea de barrido encuentre huecos.
    if d['mayor'] < 0.55:
        p += 10
    elif d['mayor'] < 0.8:
        p += 5
    return p


def main():
    pedidos = [a.lower() for a in sys.argv[1:]]
    filas = []
    for f in sorted(os.listdir(CANDIDATOS)):
        if not f.lower().endswith(('.webp', '.png', '.jpg', '.jpeg')):
            continue
        nombre = os.path.splitext(f)[0]
        if pedidos and nombre.lower() not in pedidos:
            continue
        d = auditar(nombre, os.path.join(CANDIDATOS, f))
        if d is None:
            print(f'{nombre}: sin alfa, es opaco — hay que sacarle el fondo primero')
            continue
        d['puntaje'] = puntaje(d)
        filas.append(d)

    filas.sort(key=lambda d: -d['puntaje'])

    print(f'\n{"personaje":<14}{"pts":>5}{"piezas":>8}{"mayor":>7}'
          f'{"brazos":>8}{"piernas":>9}{"cálido":>8}{"tamaño":>12}')
    print('-' * 71)
    for d in filas:
        marca = '' if d['grande'] else '  chico'
        print(f'{d["nombre"]:<14}{d["puntaje"]:>5}{d["piezas"]:>8}{d["mayor"]:>7.2f}'
              f'{d["brazos"]:>8}{d["piernas"]:>9}{d["calido"]:>8.0f}'
              f'{str(d["w"]) + "x" + str(d["h"]):>12}{marca}')

    with open('shots/auditoria.json', 'w') as fh:
        json.dump(filas, fh, indent=1, ensure_ascii=False)
    print(f'\n{len(filas)} candidatos. Detalle en shots/auditoria.json')


if __name__ == '__main__':
    os.makedirs('shots', exist_ok=True)
    main()
