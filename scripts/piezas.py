"""
Lista los componentes conectados del alfa de un dibujo, con su caja.

    python3 scripts/piezas.py arte-crudo/kor.png

Sirve para escribir una receta de `recetas/` sin medir píxeles a ojo. En un
dibujo cuyos miembros vienen despegados del torso —un gólem de piedra, un robot
articulado— cada componente conectado ES una pieza del rig, así que las cajas
salen medidas y no estimadas. En un dibujo de una sola mancha devuelve un solo
componente, y ahí no ayuda: hay que elegir las junturas de otra manera.

Imprime las cajas en el formato `[x, y, w, h]` que piden las recetas, ordenadas
de arriba a abajo y de izquierda a derecha, que es como se leen las piezas de una
figura de pie.
"""
import sys
import numpy as np
from PIL import Image

ALFA = 40
# Las manchas más chicas que esto son basura del dibujo —una chispa, un reflejo
# suelto— y no piezas. Va en píxeles porque acá interesa el tamaño absoluto.
MINIMO = 400


def componentes(mask):
    """Etiqueta las manchas con dos pasadas y union-find, sin scipy."""
    h, w = mask.shape
    etiqueta = np.zeros((h, w), dtype=np.int32)
    padre = [0]

    def raiz(x):
        while padre[x] != x:
            padre[x] = padre[padre[x]]
            x = padre[x]
        return x

    def unir(a, b):
        ra, rb = raiz(a), raiz(b)
        if ra != rb:
            padre[max(ra, rb)] = min(ra, rb)

    for y in range(h):
        fila = mask[y]
        for x in range(w):
            if not fila[x]:
                continue
            izq = etiqueta[y, x - 1] if x > 0 else 0
            arr = etiqueta[y - 1, x] if y > 0 else 0
            if izq and arr:
                etiqueta[y, x] = min(izq, arr)
                unir(izq, arr)
            elif izq or arr:
                etiqueta[y, x] = izq or arr
            else:
                padre.append(len(padre))
                etiqueta[y, x] = len(padre) - 1

    plano = np.array([raiz(i) if i else 0 for i in range(len(padre))])
    return plano[etiqueta]


def main():
    ruta = sys.argv[1]
    im = Image.open(ruta).convert('RGBA')
    a = np.array(im)
    mask = a[:, :, 3] > ALFA

    etiquetas = componentes(mask)
    piezas = []
    for id_ in np.unique(etiquetas):
        if id_ == 0:
            continue
        ys, xs = np.where(etiquetas == id_)
        if len(ys) < MINIMO:
            continue
        x0, x1 = int(xs.min()), int(xs.max())
        y0, y1 = int(ys.min()), int(ys.max())
        piezas.append({
            'box': [x0, y0, x1 - x0 + 1, y1 - y0 + 1],
            'px': int(len(ys)),
            'cx': int((x0 + x1) / 2),
            'cy': int((y0 + y1) / 2),
        })

    piezas.sort(key=lambda p: (p['cy'], p['cx']))
    print(f'{ruta}: {im.width}x{im.height}, {len(piezas)} piezas\n')
    print(f'{"#":>2}  {"box [x, y, w, h]":<28}{"centro":>12}{"px":>10}')
    print('-' * 54)
    for i, p in enumerate(piezas):
        caja = str(p['box'])
        print(f'{i:>2}  {caja:<28}{f"{p['cx']},{p['cy']}":>12}{p["px"]:>10}')


if __name__ == '__main__':
    main()
