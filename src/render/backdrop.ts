import { Container, Graphics } from 'pixi.js';

/**
 * El fondo: dos formaciones de cristales y el cielo teñido hacia el que domina.
 *
 * El volumen por lado es el papel tapiz, según la especificación. La formación
 * verde crece con el volumen comprador y la roja con el vendedor, y el color del
 * cielo se corre hacia el bando que va ganando. Es la única parte de la pantalla
 * que muestra el estado del mercado sin números.
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

export interface Backdrop {
  view: Container;
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

function createFormation(lit: number, dark: number): { node: Container; shards: Shard[] } {
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
  return { node, shards };
}

export function createBackdrop(): Backdrop {
  const view = new Container();
  const green = createFormation(GREEN_LIT, GREEN_DARK);
  const red = createFormation(RED_LIT, RED_DARK);
  view.addChild(green.node, red.node);

  const apply = (
    formation: { node: Container; shards: Shard[] },
    share: number, intensity: number, unit: number, elapsed: number,
  ): void => {
    // La formación del que domina es más alta, y la actividad total alimenta a
    // las dos: mercado muerto, dos afloramientos chicos.
    const tall = unit * (1.1 + share * 2.6) * (0.45 + intensity * 0.55);
    formation.node.scale.set(unit / SHARD_UNIT, tall / SHARD_UNIT);
    formation.node.alpha = 0.34 + share * 0.36;
    for (const shard of formation.shards) {
      // Un pulso lento, no un parpadeo: son cristales, no fuego. Cada uno con su
      // fase, porque latiendo juntos se verían como una sola forma respirando.
      const pulse = 0.94 + 0.06 * Math.sin(elapsed * shard.speed + shard.phase);
      shard.node.scale.set(1, shard.baseScale * pulse);
    }
  };

  return {
    view,
    update(greenShare, intensity, width, height, elapsed): void {
      // La unidad es la altura de pantalla: la formación escala con el viewport
      // en vez de quedar minúscula en un monitor grande.
      const unit = height * 0.22;
      green.node.x = width * 0.16;
      red.node.x = width * 0.84;
      green.node.y = height;
      red.node.y = height;
      apply(green, greenShare, intensity, unit, elapsed);
      apply(red, 1 - greenShare, intensity, unit, elapsed);
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
