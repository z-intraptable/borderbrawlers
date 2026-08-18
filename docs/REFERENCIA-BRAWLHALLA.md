# Referencia visual: Brawlhalla

**Objetivo declarado por el operador: igualar a Brawlhalla gráfica y
visualmente.** Este archivo fija ese objetivo en números medibles para que
"se parece" deje de ser una opinión y pase a ser algo que se verifica.

Sale de cinco capturas de gameplay de Brawlhalla que el operador pasó por chat
el 17/08/2026. **Las imágenes en sí no están en el repo**: llegaron pegadas en
la conversación y no tengo forma de escribirlas a disco desde ahí. Si se quieren
versionadas hay que copiar los archivos a `docs/referencia/` a mano. Lo que sí
está acá es todo lo que se puede medir de ellas, que es lo que se usa para
trabajar.

---

## Las siete diferencias, ordenadas por cuánto se notan

Cada una con el número de Brawlhalla, el nuestro y de dónde sale el nuestro.
Están ordenadas por impacto visual, no por dificultad.

### 1. El tamaño del personaje — la diferencia más grande de todas

| | Brawlhalla | Antes | **Ahora** |
|---|---|---|---|
| Alto del personaje sobre el alto del cuadro (16:9) | ~19% | 5,5% abierta / 9,7% cerrada | **9,2% abierta / 16,8% cerrada** |

#### El diagnóstico

- La figura medía `ALTO_RIG = 87` unidades de rig (`scripts/receta.py`) y el
  contenedor va con `rig.scale.set(1 / RIG)` con `RIG = 100`
  (`src/art/fighter.ts:60`): el dibujo medía **0,87 unidades de mundo**.
- La cámara ve `halfWidth * 2` de ancho, y estaba acotada entre 8 y 14. En 16:9
  eso da entre 9 y 15,75 unidades de alto visible.
- 0,87 / 15,75 = 5,5%.

Y adentro había un bug, no un ajuste: el collider del peleador mide
`FIGHTER_HALF_HEIGHT * 2 = 1,04` unidades (`src/game/match.ts:79`) contra los
0,87 del dibujo. **El personaje no llenaba ni su propia caja de colisión** — le
sobraba un 17% de aire, que es de paso por qué parecía flotar sobre las losas.

Lo que NO estaba mal: la proporción entre el personaje y el escenario. La losa
central mide 4,6 alturas de personaje contra las ~5,6 de la referencia. El
problema era el encuadre, no el diseño del ring.

#### El arreglo — 18/08/2026

1. **El dibujo pasó a llenar su collider.** `ALTO_RIG` de 87 a 104 en
   `scripts/receta.py`, y las seis recetas y los seis cortes regenerados. Como
   `RIG` está fijo en 100, `ALTO_RIG` **es** el alto en centésimas de unidad de
   mundo, así que 104 calza exacto con el collider de 1,04.
2. **La cámara se cerró.** `MIN_HALF_WIDTH` de 8 a 5,5 y `MAX_HALF_WIDTH` de 14
   a 10 (`src/render/game.ts`). Es de acá que sale la mayor parte de la mejora:
   el zoom estaba encuadrando el mapa entero más cinco unidades de aire muerto
   de cada lado, en vez de encuadrar la pelea.

**Y hubo que arreglar una tercera cosa que el cambio destapó.** Al cerrar el
zoom, las nueve losas se fueron abajo de la pantalla, detrás del marcador: el
tope de altura de la cámara era un número fijo —4,5 unidades— que valía medio
alto visible con la cámara vieja y un alto entero con la nueva. Ahora el tope es
una FRACCIÓN del alto visible (`CAMERA_Y_HIGH` / `CAMERA_Y_LOW`), así que el
piso queda a la misma altura de cuadro con cualquier zoom.

#### Corrección del 18/08/2026: el objetivo no es un número, es un rango

El ~19% de arriba salió de las cinco capturas, y las cinco eran de combate
pegado. Mirando un gameplay entero en movimiento —"Brawlhalla - Gameplay
(PC/UHD)", youtube.com/watch?v=yguECG8fXbo— **la cámara de Brawlhalla se abre y
se cierra igual que la nuestra**, y el tamaño del personaje se mueve con ella:

| Situación | Brawlhalla | Nosotros |
|---|---|---|
| Cuatro desparramados por el mapa | ~8% | 9,2% |
| 1v1 a media distancia | ~13% | — |
| Combate pegado | ~19% | 16,8% |

O sea que el objetivo **ya está cumplido**, y no falta un 2% como decía este
documento antes de mirarlo en movimiento. Cerrar más el zoom mínimo lo pasaría
de largo.

Lo que sí sigue distinto es de dónde sale el rango: Brawlhalla lo mueve
siguiendo a los jugadores por un mapa mucho más chico en relación al personaje.
Medir sobre capturas fijas fue el error — una captura es siempre el momento que
alguien eligió guardar, y nadie guarda el momento en que no pasa nada.

### 2. Las plataformas son tablones, no bloques

En Brawlhalla hay **una plataforma principal ancha** y **tablones flotantes
finos**. Los tablones son claramente más anchos que altos.

Nuestras nueve losas: la central con `halfWidth 2.4` y las ocho laterales con
`0.4875` (`src/game/physics.ts`). El grosor es sólo dibujo —la física trata la
plataforma como una línea de una vía, mira `topY` y nada más— así que se puede
mover libre.

- Central: 4,8 de ancho, 1,04 de alto → proporción **4,6**. Correcta.
- Laterales: estaban en 0,55 de grosor → proporción **1,4**, casi cuadradas. No
  se leían como plataforma. **Ya corregido a 0,25 → proporción 2,5**
  (`PLATFORM_THICK_SIDE` en `src/render/game.ts`), que además es la proporción
  con la que salió el arte generado y evita estirarlo.

### 3. Los personajes se leen por contorno negro, no por contraste de fondo

Es la decisión gráfica central de Brawlhalla y la que más lo diferencia de lo
nuestro. Ahí los personajes tienen un **contorno negro grueso y constante**, y
por eso el fondo puede ser saturado, brillante y lleno de detalle sin comerse la
figura.

Nosotros hacemos lo contrario: apagamos el fondo con `DIM = 0x5d6675`
(`src/render/stage.ts:24`) hasta poco más de un tercio de su brillo, justamente
para que los peleadores se distingan. Funciona, pero el precio es que el
escenario se ve deslavado y el resultado no se parece a la referencia.

**El cambio correcto es invertir el criterio**: contorno negro en las piezas del
personaje y subir `DIM`. El contorno es lo que compra el derecho a tener un
fondo vivo.

### 4. Paleta complementaria y saturada

Brawlhalla usa complementarios fuertes: turquesa contra dorado, violeta contra
naranja. Nada de gris. El fondo es tan saturado como el personaje y la lectura
igual funciona, por lo del contorno.

Choca de frente con lo que dice `src/render/stage.ts`, que existe para apagar el
fondo. Ver el punto 3: es el mismo cambio.

### 5. Cartel de nombre sobre cada personaje

Cada peleador lleva su nombre arriba con un triangulito de color que apunta
hacia abajo, al personaje. Cumple dos funciones: dice quién es cada uno y —más
importante para nosotros— **de qué bando es**, por el color del triángulo.

Nosotros no tenemos nada de eso. Encaja perfecto con el invariante de CLAUDE.md
de que "el bando se lee en los poderes, no en la ropa": el triángulo sería otra
lectura del bando, verde comprador y rojo vendedor, y no obliga a teñir al
personaje.

### 6. Los efectos son manchas grandes y brillantes

Los golpes en Brawlhalla ocupan una porción grande del cuadro, son de color
plano saturado y tienen forma clara —arcos, estallidos, estelas—, no partículas
chiquitas. Lo nuestro tira a partícula fina.

Es lo que se va a generar en Kling con los créditos ya disponibles.

### 7. HUD arriba a la derecha

Retratos circulares con el número de daño abajo. Nosotros hoy no tenemos HUD de
pelea. Es lo último de la lista porque no cambia cómo se ve la pelea en sí.

---

## Lo que NO hay que copiar

Brawlhalla es un juego con jugadores. Nosotros somos un visualizador del order
book de Binance, y eso impone dos límites que la referencia no tiene:

- **Nada puede tapar el instrumento.** El fondo, los efectos y el HUD son
  escenografía. Los cristales de volumen, el tinte del cielo y el color de los
  poderes son *datos*: dicen quién está ganando en el libro. Si un efecto
  precioso hace que no se lea el lado agresor, el efecto está mal, por lindo que
  sea.
- **Presupuesto de 16,6 ms por frame**, que manda por encima de todo. El techo
  de draw calls es 16 con la pelea entera. Un contorno por pieza son seis
  contornos por peleador por seis peleadores: hay que medirlo con `PerfHud`
  antes de darlo por bueno, no después.

---

## Estado

| # | Objetivo | Estado |
|---|---|---|
| 1 | Tamaño del personaje, del 8% al 19% según el zoom | **hecho** — 9,2% a 16,8%, el rango correcto |
| 2 | Plataformas como tablones | **hecho** — laterales a 0,25 |
| 3 | Contorno negro + subir `DIM` | pendiente |
| 4 | Paleta saturada complementaria | pendiente (mismo cambio que 3) |
| 5 | Cartel de nombre con triángulo de bando | pendiente |
| 6 | Efectos como manchas grandes | pendiente — se generan en Kling |
| 7 | HUD arriba a la derecha | pendiente, último |
