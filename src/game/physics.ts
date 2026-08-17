import type { Skyline } from './fighters';

/**
 * Controlador de personaje. Sin Pixi, sin DOM, sin motor de física.
 *
 * Reemplaza a Rapier, y no por ahorrar una dependencia: un motor de cuerpos
 * rígidos simula objetos que se caen, no personajes que se controlan. Con
 * Rapier los peleadores resbalaban por las plataformas, se apilaban uno sobre
 * la cabeza del otro y flotaban al empujarse, y cada arreglo era pelearle al
 * solver. Smash y Brawlhalla tampoco usan cuerpos rígidos para el personaje:
 * usan exactamente esto —velocidad propia y colisión contra rectángulos— porque
 * es lo único que da control crujiente.
 *
 * Y como es una función pura, se testea sin browser. El caso raro —el que está
 * justo en el borde, el que cae sobre una plataforma que sube— se verifica con
 * un assert en vez de mirando un video.
 */

/**
 * Cuánto puede subir de golpe el piso sin que el personaje se despegue.
 *
 * Es lo que hace que una plataforma que sube te LEVANTE en vez de atravesarte.
 * Tiene que ser mayor que lo que una plataforma se mueve en un frame
 * (`PLATFORM_MAX_SPEED / 60`), con margen.
 */
export const SNAP_UP = 0.45;

/**
 * Cuánto puede bajar el piso sin que el personaje se despegue.
 *
 * Chico a propósito: si fuera generoso, caminar hasta el borde de la plataforma
 * te dejaría pegado al vacío en vez de caer. Alcanza para seguir a una
 * plataforma que baja, y no para ignorar un precipicio.
 */
export const SNAP_DOWN = 0.22;

/** Gravedad en unidades de mundo por segundo al cuadrado. */
export const GRAVITY = -34;
/** Tope de caída. Sin esto, una caída larga atraviesa plataformas entre frames. */
export const MAX_FALL_SPEED = 26;

export interface MoveResult {
  x: number;
  y: number;
  vx: number;
  vy: number;
  grounded: boolean;
  /** Plataforma que está pisando, o -1. */
  platform: number;
  /** `true` sólo en el paso en que toca el piso. Sirve para el squash y el polvo. */
  landed: boolean;
}

export function createMoveResult(): MoveResult {
  return { x: 0, y: 0, vx: 0, vy: 0, grounded: false, platform: -1, landed: false };
}

/**
 * Plataforma bajo el personaje, o -1.
 *
 * Con varias solapadas gana la más alta que no esté por encima de los pies: si
 * estás sobre una plataforma alta y una baja a la vez, pisás la alta. Las
 * plataformas del escenario no se solapan en x, pero el personaje es más ancho
 * que un punto y puede tocar dos a la vez sobre un hueco.
 */
export function platformAt(
  sky: Skyline,
  x: number,
  halfWidth: number,
  feetY: number,
  tolerance: number,
): number {
  let best = -1;
  let bestTop = -Infinity;
  for (let i = 0; i < sky.count; i++) {
    if (x + halfWidth < sky.minX[i] || x - halfWidth > sky.maxX[i]) continue;
    const top = sky.topY[i];
    if (top > feetY + tolerance) continue;
    if (top > bestTop) {
      bestTop = top;
      best = i;
    }
  }
  return best;
}

/**
 * Avanza un paso de simulación.
 *
 * Las plataformas son de una vía: se atraviesan saltando desde abajo y se pisan
 * al caer. Sin eso un escenario de plataformas no se juega — cada salto se
 * estrellaría contra el piso de arriba.
 */
export function step(
  sky: Skyline,
  x: number,
  y: number,
  vx: number,
  vy: number,
  halfWidth: number,
  halfHeight: number,
  wasGrounded: boolean,
  dt: number,
  out: MoveResult,
): void {
  const feetBefore = y - halfHeight;

  let nextVy = vy + GRAVITY * dt;
  if (nextVy < -MAX_FALL_SPEED) nextVy = -MAX_FALL_SPEED;

  let nextX = x + vx * dt;
  let nextY = y + nextVy * dt;
  let grounded = false;
  let platform = -1;

  // 1. Si venía parado, intenta seguir pegado al piso. Es lo que hace que una
  //    plataforma que sube lo levante y una que baja no lo deje flotando.
  if (wasGrounded && nextVy <= 0) {
    const feet = nextY - halfHeight;
    const candidate = platformAt(sky, nextX, halfWidth, feet + SNAP_UP, SNAP_UP);
    if (candidate >= 0) {
      const top = sky.topY[candidate];
      if (feet <= top + SNAP_UP && feet >= top - SNAP_DOWN) {
        nextY = top + halfHeight;
        nextVy = 0;
        grounded = true;
        platform = candidate;
      }
    }
  }

  // 2. Aterrizaje: los pies CRUZARON el tope de una plataforma en este paso.
  //    Se compara el antes contra el después en vez de mirar sólo la posición
  //    final, que es lo que evita atravesar una losa fina a alta velocidad.
  if (!grounded && nextVy <= 0) {
    const feetAfter = nextY - halfHeight;
    for (let i = 0; i < sky.count; i++) {
      if (nextX + halfWidth < sky.minX[i] || nextX - halfWidth > sky.maxX[i]) continue;
      const top = sky.topY[i];
      if (feetBefore >= top - 1e-6 && feetAfter <= top) {
        nextY = top + halfHeight;
        nextVy = 0;
        grounded = true;
        platform = i;
        break;
      }
    }
  }

  out.x = nextX;
  out.y = nextY;
  out.vx = vx;
  out.vy = nextVy;
  out.grounded = grounded;
  out.platform = platform;
  out.landed = grounded && !wasGrounded;
}
