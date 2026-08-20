import { Container, Graphics } from 'pixi.js';

/**
 * El fondo: dos formaciones de brasas y el cielo teñido hacia el que domina.
 *
 * El volumen por lado es el papel tapiz, según la especificación. La formación
 * verde crece con el volumen comprador y la roja con el vendedor, y el color del
 * cielo se corre hacia el bando que va ganando. Es la única parte de la pantalla
 * que muestra el estado del mercado sin números.
 *
 * **Antes eran cristales o llamas dibujadas; ahora son partículas.** Las dos
 * versiones anteriores existieron —una tallada a mano en polígonos, la otra
 * con tiras de llamas cortadas de Kling— y las dos se archivaron completas: no
 * quedan comentadas ni a medio sacar, se borraron. Ver `createEmberFormation`
 * para la que está viva.
 *
 * Vive en coordenadas de PANTALLA, no de mundo: no lo mueve la cámara. Ese es el
 * parallax más barato que existe — el fondo quieto y el escenario moviéndose ya
 * separan los dos planos.
 */

const GREEN_LIT = 0x35d17a;
const GREEN_DARK = 0x0f6b3d;
const RED_LIT = 0xd63c63;
const RED_DARK = 0x7a1330;

/** Colores del cielo en los dos extremos y en el empate. */
const SKY_NEUTRAL = 0x0b0f19;
const SKY_GREEN = 0x0a2418;
const SKY_RED = 0x24080f;

/** Una de las dos formaciones de brasas. */
interface Formation {
  node: Container;
  apply(share: number, intensity: number, unit: number, elapsed: number): void;
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

/** Cuántas brasas tiene una formación. Pool fijo, como todo lo demás acá. */
const EMBERS = 22;
/** Cuánto dura el ciclo de una brasa, en segundos: nace abajo, muere arriba. */
const EMBER_CYCLE = 2.6;

/**
 * Brasas subiendo: reemplaza a los cristales y a las llamas dibujadas.
 *
 * Sigue siendo la formación que dice quién domina el libro —mismo contrato
 * `Formation`, mismos parámetros—, pero en vez de una escultura fija que
 * escala, son partículas que nacen abajo y suben, más rápido y más
 * numerosas cuanto más manda ese lado. El dato no se perdió: se mudó de
 * "qué tan alto es el cristal" a "cuántas brasas hay y qué tan rápido suben".
 *
 * **Función pura de `elapsed`, cero estado propio.** Igual que los cristales
 * y las llamas: la posición de la brasa `i` en el instante `t` sale de
 * `(t + fase_i) % CICLO`, así que no hace falta guardar velocidad ni
 * integrar nada cuadro a cuadro. Es la misma razón por la que el resto del
 * archivo no usa `dt`.
 */
function createEmberFormation(lit: number, dark: number): Formation {
  const node = new Container();
  interface Ember {
    g: Graphics;
    phase: number;
    /** Cuánto se aleja del eje central, en unidades de `unit`. */
    drift: number;
    /** Radio base, antes de escalar por `unit`. */
    r: number;
  }
  const embers: Ember[] = [];
  for (let i = 0; i < EMBERS; i++) {
    const g = new Graphics();
    node.addChild(g);
    embers.push({
      g,
      phase: (i / EMBERS) * EMBER_CYCLE,
      drift: (((i * 2654435761) >>> 0) % 1000 / 1000 - 0.5) * 1.4,
      r: 0.05 + (((i * 40503) >>> 0) % 1000 / 1000) * 0.05,
    });
  }

  return {
    node,
    apply(share, intensity, unit, elapsed): void {
      // Más actividad, más brasas vivas a la vez y más rápido el ciclo — el
      // mercado muerto deja dos o tres brasas lentas, uno movido las llena.
      const vivas = Math.round(EMBERS * (0.25 + intensity * 0.75));
      const ritmo = 0.6 + intensity * 1.1;
      // El lado que domina las manda más alto: mismo rol que `tall` en los
      // cristales y `alto` en las llamas.
      const techo = unit * (0.7 + share * 1.8);
      for (let i = 0; i < EMBERS; i++) {
        const e = embers[i];
        e.g.visible = i < vivas;
        if (!e.g.visible) continue;
        const t = ((elapsed * ritmo + e.phase) % EMBER_CYCLE) / EMBER_CYCLE;
        const y = -t * techo;
        const x = Math.sin(t * Math.PI * 2.4 + e.phase * 3) * e.drift * unit * 0.3;
        // Sube, y se apaga en las puntas del recorrido: nace y muere invisible,
        // vive en el medio. `sin(t·π)` da esa forma en una sola cuenta.
        const vida = Math.sin(Math.min(1, t) * Math.PI);
        const r = e.r * unit * (0.6 + vida * 0.6);
        e.g.clear();
        e.g.circle(x, y, r).fill({ color: lit, alpha: vida * 0.9 });
        e.g.circle(x, y, r * 0.45).fill({ color: 0xffffff, alpha: vida * 0.7 });
      }
      node.alpha = 0.5 + share * 0.4;
      void dark;
    },
  };
}

export function createBackdrop(): Backdrop {
  const view = new Container();
  const green = createEmberFormation(GREEN_LIT, GREEN_DARK);
  const red = createEmberFormation(RED_LIT, RED_DARK);
  view.addChild(green.node, red.node);

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
