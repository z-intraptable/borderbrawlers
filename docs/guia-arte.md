# Guía paso a paso — dibujar a Deadpool

**Tu trabajo es UNA imagen.** El resto —cortarla en piezas, escalarlas, escribir
el manifiesto— lo hace `scripts/cortar.py`, y el juego las usa solo.

Sin DragonBones, sin editor de imágenes.

Si un personaje no tiene arte, sale con el peleador vectorial. **Eso es a
propósito**: podés ver a Deadpool dibujado peleando contra los otros cinco
vectoriales, en la misma pelea, sin esperar a tenerlos todos.

---

## El recorrido completo

```
  vos                     yo                          el juego
  ───                     ──                          ────────
  generás UNA figura  →   miro dónde cortar       →   la escena la usa sola
  arte-crudo/*.png        recetas/*.json
                          scripts/cortar.py
                          public/art/<personaje>/
```

Las piezas que salen y su tamaño, para referencia:

| Pieza | Lienzo |
|---|---|
| `head.png` | 240 × 240 |
| `torso.png` | 200 × 176 |
| `armupper.png` | 96 × 110 |
| `armlower.png` | 96 × 120 |
| `legupper.png` | 110 × 110 |
| `leglower.png` | 110 × 130 |
| `blade.png` | 200 × 240 |

Los miembros de atrás no son archivos aparte: el juego usa la misma imagen con
un tinte más oscuro.

La escala es **1 unidad de rig = 4 píxeles**. El personaje entero mide 408 px.

---

## Paso 1 — Generar UNA figura entera

No pidas las piezas por separado. Siete dibujos hechos por separado no combinan:
el rojo del brazo no es el del torso y el contorno tiene otro grosor. Se pide una
sola figura y de ahí se cortan las piezas.

Andá a cualquier generador de imagen y pedí esto:

> Full-body character sprite for a 2D platform fighter game, vector cartoon
> style like Brawlhalla. Chibi proportions: oversized round head about one third
> of total body height, small compact torso, chunky rounded limbs, big round
> fists and wide feet.
>
> Design: a masked mercenary in a skin-tight red bodysuit with black panels and
> black belt with pouches. The mask covers the whole head and has two large
> white almond-shaped eye patches with thick black outlines. Two katanas crossed
> in a harness on his back.
>
> Rendering: flat vector shapes, thick continuous black outlines, cel shading in
> solid blocks with hard edges, no gradients, no texture, no noise, no
> brushstrokes, no rim light. Single light source from the left.
>
> Pose: standing straight, facing right in three-quarter view, arms held away
> from the body so they do not overlap the torso, legs slightly apart and fully
> visible.
>
> Transparent background. No shadow on the ground. No text, no logo, no border.
> Square image.

Tres cosas de ese pedido no son negociables y son las que más se olvidan:

- **`arms held away from the body`** — si los brazos tocan el torso, no los podés
  recortar sin romper el torso.
- **`transparent background`** — un fondo blanco después hay que borrarlo a mano
  y siempre queda una orla clara alrededor del contorno.
- **`facing right`** — el código espeja con la escala. Una pieza dibujada hacia
  la izquierda sale al revés en plena pelea.

Si sale con fondo, pedilo de nuevo antes de seguir. Borrar fondos es más trabajo
que volver a generar.

### Si el generador se niega

Los servicios suelen rechazar los pedidos que **nombran** personajes de marca. El
texto de arriba no nombra a ninguno a propósito: describe el diseño. Eso además
da mejor resultado, porque el modelo dibuja lo que se le describe en vez de
promediar todo lo que vio asociado a un nombre.

---

## Paso 2 — Subirme la imagen. El corte lo hago yo.

**Vos no tocás ningún editor.** Me pasás el PNG entero y yo lo miro, calculo
dónde cortar cada pieza y corro la herramienta.

Lo que hago de mi lado, para que sepas qué está pasando:

1. Miro la imagen y anoto la caja de cada pieza en una receta
   (`recetas/deadpool.json`, hay una plantilla al lado).
2. Corro `python3 scripts/cortar.py recetas/deadpool.json`, que recorta, endereza
   los miembros que hayan quedado en diagonal, saca el margen transparente,
   escala cada pieza a su lienzo y la coloca con la articulación sobre el pivote.
3. Escribe `public/art/deadpool/` completo, manifiesto incluido.
4. Lo miro en el banco de pruebas y ajusto las cajas hasta que encastre.

Lo único que necesito de tu lado es que la imagen cumpla el paso 1: brazos
separados del cuerpo, fondo transparente, mirando a la derecha. Si eso no se
cumple, no hay corte que lo salve.

Si querés hacerlo vos, la receta es un JSON con `box: [x, y, ancho, alto]` por
pieza y la herramienta hace el resto.

## Paso 3 — Mirarlo

```bash
npm run dev
```

Y abrí `http://localhost:5173/showcase.html`

Va a recorrer las nueve poses solo. Para congelar una:
`http://localhost:5173/showcase.html?pose=run`

Poses disponibles: `idle`, `run`, `jump`, `fall`, `hurt`, `attack_punch`,
`attack_kick`, `skill`, `super`.

### Qué mirar, en este orden

Este orden importa: cada punto tapa a los siguientes. No tiene sentido ajustar el
color si los pies flotan.

| # | Qué | Si está mal |
|---|---|---|
| 1 | **Los pies en `idle`.** ¿Apoyan? | Ajustá el `pivot` de `legLower` en Y. Más chico lo baja. |
| 2 | **Los pivotes en `attack_punch`.** ¿El brazo gira desde el hombro? | Si gira desde el codo, el pivote de `armUpper` está muy bajo. |
| 3 | **Los encastres en `super`**, con los brazos arriba. ¿Aparece un hueco en el hombro? | A la caja de `armUpper` le falta hombro: se corre para arriba en la receta. |
| 4 | **Las rodillas en `run`.** ¿Se dobla la pierna o se parte? | Falta solape entre las cajas de `legUpper` y `legLower`. |
| 5 | **El tamaño.** ¿Es mucho más grande o chico que los otros cinco? | `unit` en la receta. Más grande lo achica. |
| 6 | Recién ahora: color, contorno, sombras. | |

### Y en la pelea de verdad

```bash
node scripts/shoot.mjs 10 volatile
```

Deja diez capturas en `shots/`. Termina con `consola limpia` si no hubo errores.

---

## Paso 4 — Los otros cinco

Cuando Deadpool esté bien, los demás son el mismo procedimiento cambiando la
descripción del diseño y la carpeta:

| Personaje | Carpeta | Equipo | Diseño |
|---|---|---|---|
| EarthWormJim | `public/art/earthwormjim/` | verde | Gusano en traje espacial, antena con bolita amarilla |
| Platinio | `public/art/platinio/` | verde | Criatura con hocico alargado, tonos platino |
| BlackieMouse | `public/art/blackiemouse/` | verde | Orejas de ratón redondas y grandes |
| ChicagoBull | `public/art/chicagobull/` | rojo | Cuernos anchos y cortos, color hueso |
| MichaelJordan | `public/art/michaeljordan/` | rojo | Vincha, pelota de básquet en una mano |
| Deadpool | `public/art/deadpool/` | rojo | Máscara con dos óvalos blancos, katanas a la espalda |

**El traje va en el color del equipo, no en el del personaje.** Verde comprador
contra rojo vendedor es la regla del agresor hecha visible, y es el único dato
del mercado que se lee de un vistazo; si cada personaje trajera su paleta, mirar
la pantalla dejaría de decir quién está atacando.

| Uso | Equipo verde | Equipo rojo |
|---|---|---|
| Traje, luz | `#00FF66` | `#FF0055` |
| Traje, sombra | `#00A040` | `#9E0035` |
| Contorno | `#05070D` | `#05070D` |

---

## Si algo no anda

| Síntoma | Qué pasó |
|---|---|
| Sale el muñeco vectorial | No hay arte para ese personaje, o el manifiesto no está donde va. Tiene que ser `public/art/deadpool/deadpool.json`, todo en minúscula. |
| `el pivote de "X" va en fracción de 0 a 1, no en píxeles` | Escribiste `[120, 24]` en vez de `[0.5, 0.10]`. |
| `declara "X" y no se pudo cargar` | El nombre del PNG en el JSON no coincide con el archivo real. |
| El personaje es gigante o diminuto | `unit` está mal. Es cuántos píxeles de la imagen mide una unidad del rig. |
| Se ve girado o mirando al revés | La pieza está dibujada hacia la izquierda, o el miembro no quedó vertical al exportar. |
| Los miembros de atrás no se ven | Están tapados por el torso. Es normal en reposo; se ven al moverse. |

---

Vale la aclaración de siempre: los nombres y diseños del elenco son marcas de
terceros y esto es de uso personal.
