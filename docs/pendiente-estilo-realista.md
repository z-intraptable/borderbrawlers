# Pendiente — pivot a estilo realista

Estado al cierre del 20/08/2026. Esto es el resumen de dónde quedó el pivot
de "figuras geométricas inventadas" a "gráficos realistas", para retomarlo
sin tener que releer todo el historial.

## Qué se decidió

El usuario pidió auditar y sacar toda figura geométrica que **simulara ser
un objeto real sin serlo** (el ejemplo que lo disparó: las brasas del fondo
eran círculos con glow, se leían como burbujas genéricas, no como fuego). La
resolución del alcance fue explícita: **no es sólo el fondo — es todo el
juego** (personajes, golpes, habilidades, súper) el que pasa a estilo
realista, dejando atrás la convención de relleno plano + contorno negro que
tenía antes (esa convención era una elección deliberada de género — Smash/
Brawlhalla/DBFZ — no un descuido; el pivot la reemplaza a propósito).

## Qué se hizo hoy

1. **Fondo** (`src/render/backdrop.ts`) — se sacaron las brasas de
   partículas. Hoy el order book sólo se lee en el tinte de cielo (un color
   calculado real, no una figura). Sin reemplazo visual todavía: es un hueco
   a propósito hasta tener algo realista para ese lugar.
2. **Texturas de habilidad/súper** (`public/vfx/*.png`) — las 6 texturas
   (`impacto`, `orbe`, `tajo`, `onda`, `humo`, `esquirlas`) se regeneraron
   con Nano Banana en render fotorrealista (plasma, vidrio fracturado, humo
   volumétrico) en vez de relleno plano naranja. El pipeline de separación
   (`scripts/separar-vfx.py`, que corta glow/ink por luminosidad) sigue
   funcionando igual — no dependía de que el dibujo fuera plano, sólo de que
   hubiera un centro claro y líneas oscuras de detalle.
3. **Golpe y patada del cuerpo a cuerpo** (`src/render/fx.ts`) — **no se
   tocaron a propósito**. No es una excepción de estilo, es un límite de
   rendimiento: son varios impactos por segundo entre seis peleadores, y
   decodificar una textura por golpe no entra en el presupuesto de frame.
   Esto sigue siendo geometría a mano después del pivot, y va a seguir
   siéndolo aunque el resto del juego cambie — cualquier intento de
   texturizar el cuerpo a cuerpo tiene que resolver antes ese problema de
   rendimiento, no es un simple cambio de arte.

## Qué falta (lo grande)

**Los seis personajes** (Kor, Mako, Asuri, Ragnir, WuShang, Dusk) siguen con
el pipeline de piezas recortadas + hojas de sprite en el estilo de siempre
(dibujo plano recortado). Pasarlos a un estilo con sombreado/textura
realista es una producción de otro orden, no un ajuste:

- Cada personaje tiene su propia receta de corte (`recetas/<personaje>.json`)
  pensada para arte plano con articulaciones separables — un dibujo con
  sombreado realista puede no cortarse igual de limpio (ver la condición de
  corte documentada en `CLAUDE.md`: brazos despegados, sin huecos, nada
  cruzando por delante del cuerpo).
- Las hojas de sprite de acciones especiales salen de clips de Kling
  (`scripts/hoja-sprites.py`) — eso es six personajes × generación de video,
  no una imagen suelta de Nano Banana.
- Es plata y tiempo real (créditos de Kling/Higgsfield), no algo para
  arrancar sin decirlo explícitamente.

**No se empezó nada de esto.** Cuando se retome, el primer paso lógico es
elegir UN personaje como piloto (probablemente Kor, que ya tiene más trabajo
de referencia hecho) y validar que el estilo realista sobrevive el corte en
piezas antes de comprometerse con los seis.

## Regla general para lo que sigue

**No usar formas geométricas simples pretendiendo ser algo que no son.** Si
no hay una textura o receta real para un elemento, mejor dejarlo afuera (como
se hizo con el fondo) que inventarlo con `Graphics`. Esto aplica para
cualquier elemento nuevo de ambiente o efecto que se agregue de acá en más.
