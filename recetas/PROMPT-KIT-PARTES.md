# Prompt para pedirle kits de partes a Higgsfield

Qué pedirle al generador para que entregue las **seis piezas** que `cortar.py` y
`src/art/manifest.ts` necesitan, en vez de una figura entera que después hay que
recortar a mano.

Modelo: `nano_banana_pro`, `aspect_ratio: 16:9`, `resolution: 2k`.
Costo medido: **2 créditos por imagen**.

---

## Qué falló en el primer intento

Se generó Ragnir con una versión más suelta de este prompt
(`arte-crudo/kits/ragnir-kit.png`, job `45bc8c40-1bf8-4e81-bd6e-99f7562cb643`).
Salió bien el estilo —vector plano, contorno negro grueso, piezas separadas,
mirando a la derecha— y salió mal la división:

- entregó **cinco** piezas en vez de seis
- **cabeza y torso vinieron soldados** en un bloque, con la hombrera incluida
- **sin corte de codo**: el brazo vino entero con la garra
- una pierna vino **doblada en L**, y `cortar.py` endereza midiendo el vector
  `from`→`to` asumiendo un miembro recto

De ahí salieron las cuatro correcciones que la plantilla de abajo ya incorpora:
cabeza y torso como piezas explícitamente separadas con corte en el cuello, codo
y rodilla como cortes explícitos que producen cuatro piezas de miembro,
prohibición de cualquier articulación doblada, y las piezas en una sola fila
numerada para que el resultado se verifique de un vistazo.

## Qué falló en la tanda de los seis, y cómo se arregló

Generados los seis a 4K (`nano_banana_pro`, 4 créditos cada uno). Cinco pasaron
la cuenta de piezas; aparecieron tres defectos nuevos, y los tres se arreglan
desde el prompt.

- **El miembro vuelve partido en dos.** Es el defecto más común y el que hizo
  fallar a Dusk, a WuShang y a Kor: el antebrazo llega como un segmento MÁS una
  mano suelta debajo, y la pantorrilla como un segmento MÁS una bota suelta.
  `piezas.py` cuenta 7 u 8 en vez de 6. Decir "cada pieza es una sola forma
  conectada" en general **no alcanza**: hay que decirlo pieza por pieza —
  *"the hand fused to the forearm as ONE single piece, never a separate hand
  below the forearm"*—. Con eso Dusk y WuShang pasaron en el segundo intento.
- **Imprime los rótulos igual.** La primera tanda salió con "HEAD ONLY",
  "TORSO ONLY" y demás escritos abajo de cada pieza, pese al `No text` del
  final. Lo que lo sacó fue subirlo a **`ABSOLUTELY NO TEXT ANYWHERE`** con la
  lista larga —sin rótulos, sin leyendas, sin palabras, sin letras—. Un rótulo
  pegado a una pieza la contamina; suelto, `piezas.py` lo filtra por tamaño,
  pero no conviene depender de eso.
- **El filtro de contenido rechaza descripciones de fauces.** Mako volvió con
  estado `nsfw` describiéndolo como *shark humanoid* con *cream jaw with sharp
  teeth*. Reformulado como *friendly cartoon shark mascot wrestler* con *small
  rounded smile* pasó sin problema y el diseño quedó igual de bueno.

Y dos cosas del archivo que devuelve, antes de cortarlo:

- Viene en **5504×3072**, así que `piezas.py` y `fondo.py` tardan minutos. Para
  verificar la cuenta de piezas conviene achicar a ~1376×768 primero: el número
  de componentes no cambia y la vuelta es de segundos.
- El fondo es **blanco opaco, sin alfa**, siempre. Sin pasarlo por `fondo.py`,
  `piezas.py` cuenta una sola pieza que cubre la imagen entera.

## Plantilla

Reemplazar sólo el bloque `DISEÑO` por el del personaje. El resto es andamiaje y
conviene no tocarlo.

```
Technical cut-out asset sheet for a 2D paper-doll animation rig. EXACTLY SIX
separate body pieces of one identical original chibi character, laid out in a
single horizontal row, left to right, evenly spaced, each piece completely
detached and surrounded by empty background, no piece touching or overlapping
another. Pure flat solid white background, no shadows. Side view, character
facing right.

The six pieces, in this exact order and each as its OWN separate island:
1) HEAD ONLY, cut cleanly at the neck, no shoulders and no torso attached;
2) TORSO ONLY, cut cleanly at the neck at the top and at the hips at the bottom,
   no head, with both shoulder stumps but no arms;
3) UPPER ARM, a straight vertical segment from shoulder to elbow only, no hand;
4) LOWER ARM, a straight vertical segment from elbow to hand, hand included;
5) THIGH, a straight vertical segment from hip to knee only, no foot;
6) LOWER LEG, a straight vertical segment from knee to foot, foot included.

Every limb piece is perfectly straight and vertical, aligned to the vertical
axis, with flat cut ends at both joints. Absolutely no bent elbows, no bent
knees, no L-shaped or angled limbs, no curved segments.

DISEÑO: <descripción del personaje, sin arma en mano>

Flat vector cel-shaded cartoon style, thick bold black outlines, two-tone flat
shading, even flat lighting, no gradients, no cast shadows. No text, no labels,
no numbers, no arrows, no dashed lines, no watermark, no logos, no frame
borders, no grid, no assembled full figure anywhere in the image, no duplicate
or mirrored copies, no extra pieces beyond the six.
```

## Bloques DISEÑO de los seis

- **Kor** — squat rock golem, body built from stacked beige stone blocks, dark
  grey curved horns, single glowing orange eye, patches of green moss, no weapon.
- **Ragnir** — stocky red scaled dragon warrior, large dark grey curved horns,
  cream belly and chest plates, crimson scales, clawed hands and feet, no weapon.
- **WuShang** — bald elderly monk, huge dark brown beard, orange sleeveless robe,
  blue prayer beads, grey wrapped forearms and shins, bare feet, no weapon.
- **Asuri** — lean grey feline warrior, tall pointed ears, green eyes, blue and
  yellow banded armour on limbs, large clawed hands, no weapon.
- **Mako** — shark humanoid, teal skin, tall dorsal fin on the head, cream jaw
  with sharp teeth, dark boots and gloves, clawed hands, no weapon.
- **Dusk** — pale spirit elf, spiky white hair, pointed ears, dark blue and
  charcoal armour with a fur collar, grey skin, no weapon.

## Después de generar

1. Bajar el PNG a `arte-crudo/kits/<personaje>-kit.png`.
2. **Verificar la cuenta de piezas** antes de cualquier otra cosa:
   `python3 scripts/piezas.py arte-crudo/kits/<personaje>-kit.png` tiene que dar
   seis componentes. Si da cinco o siete, el kit no sirve y hay que regenerar —
   sale más barato que pelearse con la receta.
3. Confirmar que el fondo tenga **alfa real** y no blanco opaco: `cortar.py`
   recorta por canal alfa. Si vino opaco, pasarlo por `scripts/fondo.py`.
4. Escribir `recetas/<personaje>.json` mapeando cada componente a su nombre de
   pieza. Con las piezas ya separadas y rectas, las cajas salen directas de
   `piezas.py` y `from`/`to` son los extremos verticales de cada segmento.
5. `python3 scripts/cortar.py recetas/<personaje>.json`
6. `node scripts/showcase.mjs <personaje>` y mirar las nueve poses.

## Lo que Higgsfield NO hace acá

**No genera la animación.** Las nueve animaciones las arma el rig del juego
rotando estas piezas por código (`src/art/fighter.ts`). Un video pregenerado no
serviría: el color del efecto dice de qué bando es el peleador y el tamaño
responde a la liquidez del libro, y eso se dibuja en vivo. A Higgsfield se le
piden **piezas**, no movimiento.
