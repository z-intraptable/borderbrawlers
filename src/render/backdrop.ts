import { Container } from 'pixi.js';

/**
 * El fondo: sólo el cielo teñido hacia el que domina.
 *
 * El volumen por lado es el papel tapiz, según la especificación. El color del
 * cielo se corre hacia el bando que va ganando — es la única parte de la
 * pantalla que muestra el estado del mercado sin números.
 *
 * **No hay más objetos dibujados acá.** Hubo dos intentos —cristales
 * tallados a mano en polígonos, después brasas circulares animadas— y los dos
 * se sacaron enteros, sin quedar comentados ni a medio sacar: leían como
 * formas inventadas, no como algo real. Hasta que haya una textura de verdad
 * para ese lugar, el dato vive sólo en el tinte del cielo, que es un color
 * calculado, no una figura fingiendo ser un objeto.
 *
 * Vive en coordenadas de PANTALLA, no de mundo: no lo mueve la cámara.
 */

/** Colores del cielo en los dos extremos y en el empate. */
const SKY_NEUTRAL = 0x0b0f19;
const SKY_GREEN = 0x0a2418;
const SKY_RED = 0x24080f;

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

export function createBackdrop(): Backdrop {
  const view = new Container();

  return {
    view,
    update(_greenShare, _intensity, _width, _height, _elapsed): void {
      // Nada que dibujar por cuadro: el único dato que muestra este fondo
      // hoy es `skyColor`, que se lee en `game.ts` aparte.
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
