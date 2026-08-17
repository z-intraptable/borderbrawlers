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

Las piezas que salen son seis, y **una sola por lado**: el brazo y la pierna de
atrás no son archivos aparte, el juego usa la misma imagen con un tinte más
oscuro. Por eso un dibujo con las piernas juntas no es un problema — alcanza con
poder recortar una.

| Pieza | Qué es |
|---|---|
| `head.png` | cabeza, con lo que lleve puesto |
| `torso.png` | tronco, del cuello a la cadera |
| `armupper.png` | del hombro al codo |
| `armlower.png` | del codo al puño, puño incluido |
| `legupper.png` | de la cadera a la rodilla |
| `leglower.png` | de la rodilla al pie |

El tamaño de cada pieza **no está fijado**: el lienzo de cada una es la pieza
misma. Antes había medidas fijas y cada pieza se escalaba por su cuenta para
entrar en la suya —la cabeza al 27%, el brazo al 24%— y el personaje terminaba
desproporcionado consigo mismo. Ahora hay una sola reducción para todas.

Tampoco están fijadas las proporciones del esqueleto. **El dibujo manda**: la
receta dice dónde están el hombro, la cadera, el codo y la rodilla, y de ahí
sale el esqueleto de ese personaje. El primero que llegó tenía la cabeza del
doble que el muñeco vectorial y las caderas más anchas; metido a la fuerza en
las medidas del vectorial, le nacían los brazos del aire.

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

**Vos no tocás ningún editor.** Me pasás el PNG entero y yo lo miro, mido dónde
están las articulaciones y corro las herramientas.

Lo que hago de mi lado, para que sepas qué está pasando:

1. `python3 scripts/fondo.py arte-crudo/deadpool.jpeg arte-crudo/deadpool.png`
   le saca el fondo. Inunda desde el borde, así que los blancos encerrados —los
   ojos— sobreviven, y se come dos píxeles del contorno para que no quede la
   orla clara que deja el JPEG.
2. Miro la imagen con una grilla encima y anoto en la receta la caja de cada
   pieza y sus articulaciones (`recetas/deadpool.json`).
3. `python3 scripts/cortar.py recetas/deadpool.json` recorta, **endereza cada
   miembro solo** —sabiendo dónde están el hombro y el codo, el giro es una
   cuenta—, saca el margen transparente, reduce todo con un factor único y
   calcula el pivote de cada pieza.
4. Escribe `public/art/deadpool/` completo, manifiesto y medidas del esqueleto
   incluidas.
5. Lo miro en el banco de pruebas y ajusto hasta que encastre.

**El fondo no hace falta que sea transparente.** Es mejor si lo es, pero el
paso 1 lo resuelve igual, y también resuelve el caso más común de todos: que el
generador te devuelva el DAMERO gris y blanco pintado como píxeles, que es el
símbolo de la transparencia y no la transparencia.

Lo que sí necesito de tu lado es lo otro: brazos separados del cuerpo y contorno
oscuro cerrado. Si el brazo toca el torso, no hay corte que lo salve.

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
| 1 | **Los brazos en `idle`.** ¿Se ven, o sólo asoman los puños al costado de la cintura? | Los puntos de `shoulders` están muy adentro. Van en el borde de AFUERA del hombro, no donde el brazo toca el torso. |
| 2 | **Los pies en `idle`.** ¿Apoyan? | `to` de `legLower` en Y. |
| 3 | **Los pivotes en `attack_punch`.** ¿El brazo gira desde el hombro? | Si gira desde el codo, `from` de `armUpper` está mal ubicado. |
| 4 | **Los encastres en `super`**, con los brazos arriba. ¿Aparece un hueco en el hombro? | A la caja de `armUpper` le falta hombro: se corre para arriba. |
| 5 | **Las rodillas en `run`.** ¿Se dobla la pierna o se parte? | Falta solape entre las cajas de `legUpper` y `legLower`. |
| 6 | **El tamaño.** ¿Es mucho más grande o chico que los otros cinco? | `unit` en la receta. Más grande lo achica. |
| 7 | Recién ahora: color, contorno, sombras. | |

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
| Sólo asoman los puños al costado de la cintura | Los brazos cuelgan tapados por el torso. `shoulders` va en el borde de afuera del hombro. |
| `"rig" no declara "X" como número` | El manifiesto se escribió con el cortador viejo. Volvé a correr `cortar.py`. |
| `declara "X" y no se pudo cargar` | El nombre del PNG en el JSON no coincide con el archivo real. |
| El personaje es gigante o diminuto | `unit` está mal. Es cuántos píxeles de la imagen mide una unidad del rig. |
| Se ve girado o mirando al revés | La pieza está dibujada hacia la izquierda, o el miembro no quedó vertical al exportar. |
| Los miembros de atrás no se ven | Están tapados por el torso. Es normal en reposo; se ven al moverse. |

---

Vale la aclaración de siempre: los nombres y diseños del elenco son marcas de
terceros y esto es de uso personal.
