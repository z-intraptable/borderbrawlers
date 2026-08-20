import { Container, Graphics } from 'pixi.js';

/**
 * Un campo de estrellas fijo, en dos planos de profundidad.
 *
 * Va DETRÁS de todo —del cielo teñido, de las brasas, del fondo pintado si
 * hay uno— y por eso su opacidad es baja: es la primera capa, no la que
 * manda. El paralaje es el más barato que existe, igual que el fondo de
 * `backdrop.ts`: dos velocidades de desplazamiento constante, sin cámara,
 * sin perspectiva de verdad.
 *
 * **Pool fijo, geometría fija.** Cada estrella es un punto con su propio
 * radio y fase de titileo; lo único que cambia por cuadro es `alpha` y la
 * posición X, que se recicla cuando sale de pantalla — el mismo criterio que
 * el resto del render: cero asignaciones después del arranque.
 */

const ESTRELLAS_CERCA = 40;
const ESTRELLAS_LEJOS = 70;

interface Estrella {
  g: Graphics;
  x: number;
  y: number;
  r: number;
  phase: number;
  speed: number;
}

function crearCapa(n: number, radioMax: number, deriva: number): {
  node: Container;
  estrellas: Estrella[];
  deriva: number;
} {
  const node = new Container();
  const estrellas: Estrella[] = [];
  for (let i = 0; i < n; i++) {
    const g = new Graphics();
    // Posición y tamaño deterministas por índice: sin `Math.random`, dos
    // corridas dan el mismo cielo. No hace falta que sea sembrado a
    // propósito —esto es decoración, no la pelea— pero es gratis mantener
    // la misma disciplina que el resto del proyecto.
    const hx = ((i * 2654435761) >>> 0) % 10000 / 10000;
    const hy = ((i * 40503 + 7) >>> 0) % 10000 / 10000;
    const hr = ((i * 96821 + 13) >>> 0) % 10000 / 10000;
    const r = radioMax * (0.4 + hr * 0.6);
    const e: Estrella = { g, x: hx, y: hy * 0.7, r, phase: hx * 37, speed: 1.2 + hr * 1.6 };
    g.circle(0, 0, r).fill(0xffffff);
    node.addChild(g);
    estrellas.push(e);
  }
  return { node, estrellas, deriva };
}

export interface Starfield {
  view: Container;
  resize(width: number, height: number): void;
  update(dt: number, elapsed: number): void;
}

export function createStarfield(): Starfield {
  const view = new Container();
  // Dos capas: la de atrás no se mueve casi nada y titila más lento — es la
  // que da profundidad; la de adelante deriva un poco más rápido.
  const lejos = crearCapa(ESTRELLAS_LEJOS, 1.1, 0.004);
  const cerca = crearCapa(ESTRELLAS_CERCA, 1.6, 0.011);
  view.addChild(lejos.node, cerca.node);
  view.alpha = 0.5;

  let w = 0;
  let h = 0;

  function ubicar(capa: ReturnType<typeof crearCapa>, elapsed: number): void {
    for (const e of capa.estrellas) {
      const corrida = (e.x + elapsed * capa.deriva) % 1;
      const px = corrida * w;
      const py = e.y * h;
      e.g.position.set(px, py);
      const titileo = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(elapsed * e.speed + e.phase));
      e.g.alpha = titileo;
    }
  }

  return {
    view,
    resize(width, height): void {
      w = width;
      h = height;
    },
    update(_dt, elapsed): void {
      if (w === 0 || h === 0) return;
      ubicar(lejos, elapsed);
      ubicar(cerca, elapsed);
    },
  };
}
