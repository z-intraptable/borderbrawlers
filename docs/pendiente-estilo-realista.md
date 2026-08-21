# Pendiente — dirección de arte: cel-shading (no fotorrealismo)

Estado al cierre del 20/08/2026. Ese día hubo DOS pivots de dirección de
arte, no uno — importante para no confundirse si se retoma esto:

1. A la mañana: de plano+contorno (el estilo original) a **fotorrealismo**,
   disparado por las brasas del fondo leyéndose como burbujas genéricas (ver
   sección "Qué se decidió" más abajo).
2. A la tarde: se investigaron referencias profesionales (Dragon Ball
   FighterZ, Marvel vs Capcom 3, Tekken, Street Fighter) y se pidió acercar
   el estilo a "esos juegos 2D de última generación". Esos juegos **no son
   fotorrealistas — son cel-shading** (bandas de color planas, tinta negra
   gruesa, luz dura sin degradé). Se marcó la contradicción con lo decidido
   a la mañana y el usuario confirmó: **cel-shading, no fotorrealismo.**

**La dirección vigente hoy es cel-shading estilo DBFZ/MvC/SF**, no
fotorrealismo. Si "hacerlo más realista" vuelve a salir en el futuro,
preguntar primero a cuál de las dos se refiere — ya se gastó un ciclo entero
de regeneración por asumir mal una vez.

## Qué se decidió (pivot original, a la mañana)

El usuario pidió auditar y sacar toda figura geométrica que **simulara ser
un objeto real sin serlo** (el ejemplo que lo disparó: las brasas del fondo
eran círculos con glow, se leían como burbujas genéricas, no como fuego).

## Qué se hizo hoy

1. **Fondo** (`src/render/backdrop.ts`) — se sacaron las brasas de
   partículas. Hoy el order book sólo se lee en el tinte de cielo (un color
   calculado real, no una figura). Sin reemplazo visual todavía: es un hueco
   a propósito hasta tener algo para ese lugar.
2. **Texturas de habilidad/súper** (`public/vfx/*.png`) — las 6 texturas
   (`impacto`, `orbe`, `tajo`, `onda`, `humo`, `esquirlas`) se regeneraron
   con Nano Banana **dos veces en el mismo día**: primero en fotorrealista
   (plasma, vidrio fracturado, humo volumétrico), después —al confirmarse
   cel-shading como la dirección correcta— en cel-shading estilo DBFZ/MvC
   (bandas de color planas, tinta negra gruesa, sin degradé suave). La
   versión que quedó instalada es la de cel-shading. De paso, `impacto` y
   `orbe` —los dos momentos más visibles— llevan motivo de trading (velas
   japonesas, línea de precio) en vez de energía genérica; los otros cuatro
   quedaron genéricos a propósito, para no saturar de iconografía. El
   pipeline de separación (`scripts/separar-vfx.py`, que corta glow/ink por
   luminosidad) funcionó sin cambios para las dos versiones — no depende de
   que el dibujo sea plano ni fotorrealista, sólo de que haya un centro
   claro y líneas oscuras de detalle.
3. **Golpe y patada del cuerpo a cuerpo** (`src/render/fx.ts`) — **no se
   tocaron en ninguno de los dos pivots**. No es una excepción de estilo, es
   un límite de rendimiento: son varios impactos por segundo entre seis
   peleadores, y decodificar una textura por golpe no entra en el
   presupuesto de frame. Esto sigue siendo geometría a mano, y va a seguir
   siéndolo aunque el resto del juego cambie de estilo otra vez — cualquier
   intento de texturizar el cuerpo a cuerpo tiene que resolver antes ese
   problema de rendimiento, no es un simple cambio de arte.
4. **Cámara** (`src/render/game.ts`) — de paso, capturas reales de teléfono
   mostraron que el zoom de los golpes pegaba un salto (`camera.zoom =
   Math.max(...)` sin curva) y que el burst de VFX + el acercamiento juntos
   tapaban al personaje entero en vertical. Se separó `zoom`/`zoomTarget`
   con una curva exponencial, y se bajaron los tamaños de burst y
   `ZOOM_CLAVE`. No forma parte del pivot de estilo, pero se corrigió el
   mismo día por la misma tanda de capturas.
5. **Burst de VFX, otra vuelta** (`src/render/game.ts`) — una tanda nueva de
   capturas (formato apaisado, distinto del teléfono portrait de la vuelta
   anterior) mostró el personaje totalmente tapado en los 5 casos, con el
   pedido explícito de "siempre se vean los personajes, quitamos todos los
   efectos si es necesario". El z-order ya era correcto (el cuerpo se
   reinserta al tope de `world` después de las capas de VFX), así que no era
   un bug de orden de dibujo: el burst medía 1,6-2,4 veces el alto del propio
   personaje y salía centrado en su misma posición — un blob con Bloom más
   grande que el cuerpo lo domina visualmente aunque el cuerpo esté dibujado
   encima. Se bajaron TODOS los `size` de `vfxSprites.burst()` (impacto,
   onda, tajo, orbe, esquirlas, en super/KO/estallido/especial) a bien por
   debajo de un cuerpo de diámetro. Pendiente de confirmar con capturas
   nuevas del usuario.
7. **Se sacaron los efectos de poder enteros** (`src/render/game.ts`,
   `src/render/fx.ts`) — dos días de achicar tamaños (pasos 4-6) y el
   personaje siguió tapado en video nuevo. El usuario cortó por lo sano:
   "quitarle los efectos visuales y correr el juego solo con golpes y
   patadas". Especial, súper, KO y estallido quedaron con el MISMO fogonazo
   corto que ya llevaba un golpe de cuerpo a cuerpo fuerte —nada de bola de
   energía, rayos, esquirlas, onda, texturas de `vfxSprites` ni el filtro de
   distorsión de pantalla del súper—. El cuerpo a cuerpo (golpe y patada) no
   se tocó: es lo único que queda con efecto propio. `ShockwaveFilter` y las
   funciones `orb`/`beams`/`shards` de `fx.ts` quedan sin usar en
   `game.ts` pero no se borraron de `fx.ts` por si se retoma más adelante
   con otro enfoque (menos tamaño, no cero efecto).
8. **Bug de visibilidad entre relevos, separado del pivot de VFX**
   (`src/render/game.ts`, `drawFighters`) — el usuario reportó que "casi
   siempre el que pierde el round no se visualiza en el siguiente", y un
   video mostró tramos largos de plataforma completamente vacía. Causa real:
   `views` está indexado por SLOT pero las instancias de `FighterView` son
   por ARMADURA (un `Map` en `viewByArmature`, seis peleadores = seis vistas
   nada más). En torneo sólo se activa el slot 0 de cada bando; los slots 1
   y 2 quedan para siempre "inactivos" mirando a Mako/Asuri (o WuShang/Dusk)
   por default y nunca se tocan. Cuando el relevo hace que el slot 0 pase a
   ser Mako, ese mismo cuadro el slot 1 —que sigue "inactivo" pero comparte
   la misma instancia de vista— la volvía a ocultar. Resultado: el segundo y
   tercer peleador del plantel casi nunca se veían, sólo el primero (que no
   colisiona con ningún slot inactivo). Se corrigió comprobando, antes de
   ocultar la vista de un slot inactivo, que ningún OTRO slot activo la esté
   usando en este cuadro.
6. **La bola de energía a mano, otra vuelta más** (`src/render/fx.ts`,
   `orb()`) — el paso 5 sólo achicó `vfxSprites.burst()` (las texturas) y el
   personaje siguió tapado en un video nuevo del usuario. La causa real era
   otra: `orb()` —la bola dibujada a mano con `Graphics`, no una textura—
   nunca se había tocado, y su diámetro real en pantalla es `radio × ~3,1`
   (seis anillos de degradé hasta 1,55× el radio más las púas), no `radio ×
   2` como parecía a simple vista. Con los números viejos (radio 1,1 en el
   KO, hasta 1,05 en el estallido) el orbe solo medía 3-3,4 unidades de
   mundo, tres veces el alto del peleador. Se bajaron todos los radios de
   `orb()`/`wave()` en super/KO/estallido/especial/gigantismo a bien por
   debajo de un cuerpo, y quedó un comentario en `fx.ts` con la cuenta para
   no repetir el error. Pendiente de confirmar con video nuevo.

## Qué falta (lo grande)

**Los seis personajes** (Kor, Mako, Asuri, Ragnir, WuShang, Dusk) siguen con
el pipeline de piezas recortadas + hojas de sprite en el estilo de siempre
(dibujo plano recortado, sin cel-shading todavía). Pasarlos al cel-shading
que ya tienen las texturas de VFX es una producción de otro orden, no un
ajuste:

- Cada personaje tiene su propia receta de corte (`recetas/<personaje>.json`)
  pensada para arte plano con articulaciones separables — un dibujo con
  sombreado (aunque sea por bandas planas, no degradé) puede no cortarse
  igual de limpio (ver la condición de corte documentada en `CLAUDE.md`:
  brazos despegados, sin huecos, nada cruzando por delante del cuerpo).
- Las hojas de sprite de acciones especiales salen de clips de Kling
  (`scripts/hoja-sprites.py`) — eso es seis personajes × generación de
  video, no una imagen suelta de Nano Banana.
- Es plata y tiempo real (créditos de Kling/Higgsfield), no algo para
  arrancar sin decirlo explícitamente.

**No se empezó nada de esto.** Cuando se retome, el primer paso lógico es
elegir UN personaje como piloto (probablemente Kor, que ya tiene más trabajo
de referencia hecho) y validar que el cel-shading sobrevive el corte en
piezas antes de comprometerse con los seis.

## Regla general para lo que sigue

**No usar formas geométricas simples pretendiendo ser algo que no son.** Si
no hay una textura o receta real para un elemento, mejor dejarlo afuera (como
se hizo con el fondo) que inventarlo con `Graphics`. Esto aplica para
cualquier elemento nuevo de ambiente o efecto que se agregue de acá en más.
