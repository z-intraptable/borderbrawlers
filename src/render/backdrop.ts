import { Container, Graphics, Sprite, Texture } from 'pixi.js';

/**
 * El fondo: dos formaciones de cristales y el cielo teñido hacia el que domina.
 *
 * El volumen por lado es el papel tapiz, según la especificación. La formación
 * verde crece con el volumen comprador y la roja con el vendedor, y el color del
 * cielo se corre hacia el bando que va ganando. Es la única parte de la pantalla
 * que muestra el estado del mercado sin números.
 *
 * **Las hogueras son dibujadas, y los cristales son el respaldo.** La versión
 * original dibujaba las dos formaciones con polígonos porque no había arte; hoy
 * hay dos tiras de llamas cortadas de Kling y `useFlames` las mete en su lugar
 * cuando terminan de cargar. Los polígonos se quedan escritos y no son código
 * muerto: son lo que se ve mientras el arte viaja, y lo que se ve si no está.
 * Cambiar el fondo no puede depender de que un archivo exista.
 *
 * **Los cuadros de la tira son variantes, no una animación.** Ver
 * `createFlameFormation`: es la corrección más importante de este archivo.
 *
 * **Los cristales son polígonos explícitos, no curvas.** La primera versión
 * dibujaba llamas con bezier y salían facetadas, porque Pixi decide cuántos
 * tramos tiene una curva en el espacio LOCAL —cuando la construye— y no vuelve a
 * mirarla al escalar: una curva de una unidad agrandada ciento cincuenta veces
 * se parte en cuatro rectas. Las facetas gustaron y se quedan, pero ahora son
 * geometría declarada. Si dependieran de la subdivisión, cambiarían solas el día
 * que alguien toque una escala, y nadie sabría por qué.
 *
 * **La geometría se construye una sola vez.** Animar la formación redibujando su
 * `Graphics` cada frame reconstruye la malla sesenta veces por segundo para
 * mover un vértice; en vez de eso los cristales son hijos con forma fija y lo
 * que cambia por frame son `scale` y `alpha`, que son propiedades del nodo y no
 * cuestan nada. La misma razón por la que las plataformas no se redimensionan.
 *
 * Vive en coordenadas de PANTALLA, no de mundo: no lo mueve la cámara. Ese es el
 * parallax más barato que existe — el fondo quieto y el escenario moviéndose ya
 * separan los dos planos.
 */

const GREEN_LIT = 0x35d17a;
const GREEN_DARK = 0x0f6b3d;
const RED_LIT = 0xd63c63;
const RED_DARK = 0x7a1330;

/** Cuántos cristales tiene cada formación. */
const SHARDS = 7;

/** Colores del cielo en los dos extremos y en el empate. */
const SKY_NEUTRAL = 0x0b0f19;
const SKY_GREEN = 0x0a2418;
const SKY_RED = 0x24080f;

/**
 * Tamaño en el que se dibuja un cristal antes de escalarlo. Los polígonos no
 * necesitan subdivisión, pero mantener el dibujo cerca de su tamaño final en
 * píxeles deja los cálculos de escala legibles.
 */
const SHARD_UNIT = 100;

interface Shard {
  node: Graphics;
  /** Desfase del pulso, para que no latan todos juntos. */
  phase: number;
  speed: number;
  baseScale: number;
}

/**
 * Una de las dos hogueras. Las hay de cristales y de llamas dibujadas, y el
 * fondo no distingue: le pide el nodo y le pasa el reparto del volumen.
 */
interface Formation {
  node: Container;
  apply(share: number, intensity: number, unit: number, elapsed: number): void;
}

/** Cuántas llamas tiene una hoguera dibujada. */
const FLAMES = 5;
/**
 * Cuánto se abre la hoguera respecto de una llama. Menor que 1 a propósito: las
 * llamas tienen que SOLAPARSE. Separadas se ven cinco velas, encimadas se ve una
 * fogata, que es lo que son.
 */
const FLAME_SPREAD = 0.62;

export interface Backdrop {
  view: Container;
  /** Cambia los cristales por las llamas dibujadas. Se puede llamar tarde. */
  useFlames(green: Texture[], red: Texture[]): void;
  /**
   * @param greenShare parte del volumen del comprador, 0 a 1
   * @param intensity  cuánta actividad hay en total, 0 a 1
   */
  update(greenShare: number, intensity: number, width: number, height: number, elapsed: number): void;
  /** Color del cielo que le corresponde al reparto actual. */
  skyColor(greenShare: number): number;
  destroy(): void;
}

function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * t) << 16)
    | (Math.round(ag + (bg - ag) * t) << 8)
    | Math.round(ab + (bb - ab) * t)
  );
}

/**
 * Un cristal: un prisma de punta, en dos tonos planos.
 *
 * La cara iluminada y la de sombra se cortan sobre la arista central, sin
 * degradé y sin ruido — es lo que pide la ficha de estilo, y es lo que hace que
 * el fondo tenga volumen sin competir con los personajes.
 */
function createShard(lit: number, dark: number): Graphics {
  const u = SHARD_UNIT;
  const g = new Graphics();

  // Silueta completa, en el tono de sombra.
  g.poly([
    0, -u,
    0.34 * u, -0.64 * u,
    0.30 * u, -0.09 * u,
    0.13 * u, 0,
    -0.13 * u, 0,
    -0.30 * u, -0.09 * u,
    -0.34 * u, -0.64 * u,
  ]).fill(dark);

  // Cara iluminada: la mitad izquierda, contra la arista que va de la punta a
  // la base. La luz viene siempre del mismo lado en toda la escena.
  g.poly([
    0, -u,
    -0.34 * u, -0.64 * u,
    -0.30 * u, -0.09 * u,
    -0.13 * u, 0,
    0, 0,
  ]).fill(lit);

  return g;
}

function createFormation(lit: number, dark: number): Formation {
  const node = new Container();
  const shards: Shard[] = [];
  for (let i = 0; i < SHARDS; i++) {
    const g = createShard(lit, dark);
    // Repartidos a lo ancho, los del centro más altos: la formación tiene un
    // pico en vez de ser una hilera pareja.
    const offset = (i - (SHARDS - 1) / 2) / ((SHARDS - 1) / 2);
    g.x = offset * 0.95 * SHARD_UNIT;
    // Los de atrás primero, para que el pico quede adelante.
    node.addChild(g);
    shards.push({
      node: g,
      phase: i * 1.37,
      speed: 0.7 + i * 0.19,
      baseScale: 0.42 + (1 - Math.abs(offset)) * 0.58,
    });
  }
  // El del medio al frente.
  node.children.sort((a, b) => Math.abs(b.x) - Math.abs(a.x));

  return {
    node,
    apply(share, intensity, unit, elapsed): void {
      // La formación del que domina es más alta, y la actividad total alimenta a
      // las dos: mercado muerto, dos afloramientos chicos.
      const tall = unit * (1.1 + share * 2.6) * (0.45 + intensity * 0.55);
      node.scale.set(unit / SHARD_UNIT, tall / SHARD_UNIT);
      node.alpha = 0.34 + share * 0.36;
      for (const shard of shards) {
        // Un pulso lento, no un parpadeo: son cristales, no fuego. Cada uno con
        // su fase, porque latiendo juntos se verían como una sola forma
        // respirando.
        const pulse = 0.94 + 0.06 * Math.sin(elapsed * shard.speed + shard.phase);
        shard.node.scale.set(1, shard.baseScale * pulse);
      }
    },
  };
}

/**
 * Una hoguera de llamas dibujadas.
 *
 * **Escala uniforme, al revés que los cristales.** Un prisma estirado sigue
 * pareciendo un prisma; una llama estirada parece una llama mal dibujada, porque
 * el ojo conoce la forma. Así que acá el volumen no estira: agranda. Una hoguera
 * que crece entera es además lo que hace una hoguera de verdad cuando le tirás
 * leña, así que el dato se lee igual sin deformar nada.
 *
 * Cada llama va por su cuadro y su fase. Con las cinco en el mismo cuadro la
 * hoguera late como un cartel de neón en vez de arder.
 */
/**
 * Una hoguera dibujada: cinco llamas encimadas que arden.
 *
 * **Acá NO hay flipbook, y esa es toda la corrección.** La versión anterior
 * pasaba los cinco cuadros de la tira a once por segundo, como una animación
 * cuadro a cuadro. Pero los cinco cuadros no son una animación: son cinco
 * dibujos sueltos que un generador hizo por separado, cada uno con su alto, su
 * ancho y su silueta. Pasarlos en fila no hace que la llama ondule — hace que
 * la llama SALTE, porque entre cuadro y cuadro cambia de tamaño y de forma sin
 * ninguna continuidad. Es exactamente lo que se veía mal, y no se arregla
 * generando más cuadros: un generador de imágenes vuelve a dar dibujos sueltos.
 *
 * Lo que sí es una animación es una transformación continua. Así que cada llama
 * se queda **fija en un dibujo** —el suyo, distinto del de sus vecinas, que es
 * de donde sale la variedad— y lo que se mueve son sus números:
 *
 * - **respira**: se estira a lo alto y se afina a lo ancho, conservando el bulto.
 *   Dos senos de frecuencias que no son múltiplos, así el ciclo no se repite a
 *   ojo. Con un seno solo se le ve el compás enseguida.
 * - **se inclina**: `skew.x` con el ancla en la base mueve la punta y deja el pie
 *   clavado, que es como se dobla una llama de verdad.
 * - **chisporrotea**: el `tint` late entre blanco y un gris apenas más oscuro.
 *   El tinte es por vértice, así que no rompe el batch: las cinco llamas siguen
 *   siendo un solo draw call.
 *
 * Ninguna de las tres cambia de textura, y por eso no hay salto posible.
 */
function createFlameFormation(frames: Texture[]): Formation {
  const node = new Container();
  interface Llama {
    sprite: Sprite;
    phase: number;
    speed: number;
    baseScale: number;
    /** Cuánto se dobla ésta. Las de afuera se doblan más: tienen menos masa. */
    lean: number;
  }
  const llamas: Llama[] = [];

  for (let i = 0; i < FLAMES; i++) {
    const offset = (i - (FLAMES - 1) / 2) / ((FLAMES - 1) / 2);
    // Cada llama se queda con SU dibujo. Con cinco cuadros y cinco llamas es uno
    // cada una; con menos cuadros se repiten, que es peor pero no rompe.
    const sprite = new Sprite(frames[i % frames.length]);
    // Ancla en la base: la hoguera está apoyada en el piso de la pantalla, y es
    // el punto que `hoja-fuego.py` alineó al cortar.
    sprite.anchor.set(0.5, 1);
    sprite.x = offset * FLAME_SPREAD * SHARD_UNIT;
    node.addChild(sprite);
    llamas.push({
      sprite,
      // Las fases no son múltiplos entre sí para que no lleguen nunca todas al
      // mismo punto del ciclo: cinco llamas latiendo juntas se leen como una
      // sola cosa parpadeando.
      phase: i * 1.87,
      speed: 0.85 + i * 0.11,
      baseScale: 0.55 + (1 - Math.abs(offset)) * 0.45,
      lean: 0.05 + Math.abs(offset) * 0.055,
    });
  }
  // La del medio al frente, como el pico de los cristales.
  node.children.sort((a, b) => Math.abs(b.x) - Math.abs(a.x));

  // De las coordenadas de la tira a las del fondo: la llama dibujada mide lo que
  // mida el cuadro y acá tiene que valer una unidad de cristal.
  const aUnidad = SHARD_UNIT / frames[0].height;

  return {
    node,
    apply(share, intensity, unit, elapsed): void {
      const alto = unit * (0.95 + share * 1.75) * (0.5 + intensity * 0.5);
      node.scale.set(alto / SHARD_UNIT);
      // Más presente que los cristales: el fuego es opaco, no un mineral
      // traslúcido. Igual no llega a 1 — sigue siendo fondo.
      node.alpha = 0.62 + share * 0.28;
      // Con el mercado despierto el fuego arde más rápido, no sólo más grande.
      const ritmo = 0.7 + intensity * 0.8;
      for (const llama of llamas) {
        const w = elapsed * ritmo * llama.speed + llama.phase;
        const sube = 1 + Math.sin(w * 3.1) * 0.09 + Math.sin(w * 5.3 + 1.3) * 0.045;
        // Se afina lo que se estira: una llama no engorda cuando crece.
        const angosta = 1 - (sube - 1) * 0.8;
        const escala = llama.baseScale * aUnidad;
        llama.sprite.scale.set(escala * angosta, escala * sube);
        llama.sprite.skew.x = Math.sin(w * 2.2) * llama.lean
          + Math.sin(w * 3.9 + 0.7) * llama.lean * 0.4;
        const brasa = 0.88 + Math.sin(w * 6.7 + 2.1) * 0.12;
        const nivel = Math.round(brasa * 255);
        llama.sprite.tint = (nivel << 16) | (nivel << 8) | nivel;
      }
    },
  };
}

export function createBackdrop(): Backdrop {
  const view = new Container();
  let green = createFormation(GREEN_LIT, GREEN_DARK);
  let red = createFormation(RED_LIT, RED_DARK);
  view.addChild(green.node, red.node);

  return {
    view,
    useFlames(verdes, rojos): void {
      if (verdes.length === 0 || rojos.length === 0) return;
      const antes = [green, red];
      green = createFlameFormation(verdes);
      red = createFlameFormation(rojos);
      view.addChild(green.node, red.node);
      // Los cristales se destruyen recién después de colgar las llamas: si el
      // fondo quedara vacío aunque sea un frame, se vería un parpadeo negro.
      for (const vieja of antes) vieja.node.destroy({ children: true });
    },
    update(greenShare, intensity, width, height, elapsed): void {
      // La unidad es la altura de pantalla: la formación escala con el viewport
      // en vez de quedar minúscula en un monitor grande.
      const unit = height * 0.22;
      green.node.x = width * 0.16;
      red.node.x = width * 0.84;
      green.node.y = height;
      red.node.y = height;
      green.apply(greenShare, intensity, unit, elapsed);
      red.apply(1 - greenShare, intensity, unit, elapsed);
    },
    skyColor(greenShare): number {
      // Se tiñe desde el neutro hacia el lado que domina, y sólo a partir del
      // 50%: con una diferencia mínima el fondo no tiene por qué cambiar.
      const lead = (greenShare - 0.5) * 2;
      if (lead >= 0) return mix(SKY_NEUTRAL, SKY_GREEN, Math.min(1, lead * 1.4));
      return mix(SKY_NEUTRAL, SKY_RED, Math.min(1, -lead * 1.4));
    },
    destroy(): void {
      view.destroy({ children: true });
    },
  };
}
