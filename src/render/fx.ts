import type { Graphics } from 'pixi.js';

/**
 * Efectos: chispas, polvo, estelas y anillos.
 *
 * Un pool de tamaño fijo en arrays tipados, igual que los peleadores. La versión
 * anterior dibujaba un círculo que se agrandaba y se desvanecía en el lugar del
 * golpe; se veía como una mancha, no como un impacto. Lo que hace que un golpe
 * se sienta es que la materia salga despedida y caiga, así que estas partículas
 * tienen velocidad propia y gravedad.
 *
 * **Cero asignaciones**: ni en `emit`, ni en `update`, ni en `draw`. Todo lo que
 * hace falta ya está reservado y el pool descarta la partícula más vieja cuando
 * se llena. Es el mismo criterio que el resto del proyecto — el documento que
 * revisamos hacía `matrix.apply({x, y})` por hueso y por frame, que asigna dos
 * objetos cada vez, y eso es exactamente lo que acá no puede pasar.
 *
 * Las coordenadas son de MUNDO y con la Y del juego (arriba positivo). La
 * conversión al eje de Pixi se hace en `draw`, en un solo lugar.
 */

export const FX_SPARK = 0;
export const FX_DUST = 1;
export const FX_RING = 2;
export const FX_TRAIL = 3;

const CAPACITY = 320;

/** Gravedad de las partículas. Menos que la de los personajes: flotan un poco. */
const FX_GRAVITY = -16;
/** Rozamiento por segundo. El polvo se frena, las chispas casi no. */
const DRAG = { [FX_SPARK]: 1.6, [FX_DUST]: 4.5, [FX_RING]: 0, [FX_TRAIL]: 3 } as const;

export interface Fx {
  kind: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  age: Float32Array;
  life: Float32Array;
  size: Float32Array;
  color: Uint32Array;
  head: number;
}

export function createFx(): Fx {
  const fx: Fx = {
    kind: new Uint8Array(CAPACITY),
    x: new Float32Array(CAPACITY),
    y: new Float32Array(CAPACITY),
    vx: new Float32Array(CAPACITY),
    vy: new Float32Array(CAPACITY),
    age: new Float32Array(CAPACITY),
    life: new Float32Array(CAPACITY),
    size: new Float32Array(CAPACITY),
    color: new Uint32Array(CAPACITY),
    head: 0,
  };
  // Todas nacen muertas: `age >= life` es la condición de libre.
  fx.age.fill(1);
  fx.life.fill(1);
  return fx;
}

function spawn(
  fx: Fx, kind: number, x: number, y: number,
  vx: number, vy: number, size: number, life: number, color: number,
): void {
  const i = fx.head;
  fx.head = (fx.head + 1) % CAPACITY;
  fx.kind[i] = kind;
  fx.x[i] = x; fx.y[i] = y;
  fx.vx[i] = vx; fx.vy[i] = vy;
  fx.age[i] = 0; fx.life[i] = life;
  fx.size[i] = size; fx.color[i] = color;
}

/**
 * Estallido de chispas en todas direcciones.
 *
 * El ángulo se reparte en abanico con una desviación chica en vez de sortearse
 * libre: un sorteo uniforme deja huecos y grumos visibles con pocas partículas,
 * y acá son entre 6 y 14.
 */
export function burst(
  fx: Fx, x: number, y: number,
  count: number, speed: number, size: number, life: number, color: number,
): void {
  const offset = Math.random() * Math.PI * 2;
  for (let n = 0; n < count; n++) {
    const angle = offset + (n / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    const magnitude = speed * (0.55 + Math.random() * 0.45);
    spawn(
      fx, FX_SPARK, x, y,
      Math.cos(angle) * magnitude,
      Math.sin(angle) * magnitude + speed * 0.25,
      size * (0.6 + Math.random() * 0.6),
      life * (0.7 + Math.random() * 0.6),
      color,
    );
  }
}

/** Polvo al aterrizar: sale para los costados y casi no sube. */
export function dust(fx: Fx, x: number, y: number, strength: number): void {
  const count = 4 + Math.round(strength * 3);
  for (let n = 0; n < count; n++) {
    const dir = n % 2 === 0 ? 1 : -1;
    spawn(
      fx, FX_DUST, x + dir * 0.1, y,
      dir * (0.9 + Math.random() * 1.5) * strength,
      Math.random() * 0.9,
      0.1 + Math.random() * 0.09,
      0.28 + Math.random() * 0.2,
      0xc8d4e8,
    );
  }
}

/** Anillo que se expande. Es el cuerpo de una habilidad o del super. */
export function ring(fx: Fx, x: number, y: number, radius: number, life: number, color: number): void {
  spawn(fx, FX_RING, x, y, 0, 0, radius, life, color);
}

/** Un punto de estela. Se emite por frame en el que sale volando. */
export function trail(fx: Fx, x: number, y: number, size: number, color: number): void {
  spawn(fx, FX_TRAIL, x, y, 0, 0, size, 0.22, color);
}

export function updateFx(fx: Fx, dt: number): void {
  for (let i = 0; i < CAPACITY; i++) {
    if (fx.age[i] >= fx.life[i]) continue;
    fx.age[i] += dt;
    const kind = fx.kind[i];
    if (kind === FX_RING || kind === FX_TRAIL) continue;
    fx.vy[i] += FX_GRAVITY * dt;
    const drag = 1 - Math.min(1, DRAG[kind as 0 | 1] * dt);
    fx.vx[i] *= drag;
    fx.vy[i] *= drag;
    fx.x[i] += fx.vx[i] * dt;
    fx.y[i] += fx.vy[i] * dt;
  }
}

/**
 * Dibuja en dos capas: `plain` para lo que no brilla y `glow` para lo que sí.
 *
 * La separación es lo que permite que el Bloom sea SELECTIVO. Aplicarlo a toda
 * la escena lava los contornos negros, que son la mitad del estilo; aplicándolo
 * sólo a esta capa brillan el super, las habilidades y el aura del gigantismo,
 * y el resto queda limpio.
 */
export function drawFx(fx: Fx, plain: Graphics, glow: Graphics): void {
  plain.clear();
  glow.clear();
  for (let i = 0; i < CAPACITY; i++) {
    if (fx.age[i] >= fx.life[i]) continue;
    const t = fx.age[i] / fx.life[i];
    const fade = (1 - t) * (1 - t);
    const px = fx.x[i];
    const py = -fx.y[i];

    switch (fx.kind[i]) {
      case FX_RING: {
        // El anillo nace chico y termina en `size`; el grosor se afina al
        // expandirse, que es lo que lo hace leer como una onda y no como un
        // círculo que crece.
        const radius = fx.size[i] * (0.15 + t * 0.95);
        glow.circle(px, py, radius)
          .stroke({ width: 0.22 * fade + 0.03, color: fx.color[i], alpha: fade });
        break;
      }
      case FX_SPARK:
        glow.circle(px, py, fx.size[i] * (1 - t * 0.55))
          .fill({ color: fx.color[i], alpha: 0.35 + fade * 0.65 });
        break;
      case FX_TRAIL:
        glow.circle(px, py, fx.size[i] * fade)
          .fill({ color: fx.color[i], alpha: fade * 0.5 });
        break;
      default:
        plain.circle(px, py, fx.size[i] * (1 + t * 1.6))
          .fill({ color: fx.color[i], alpha: fade * 0.45 });
        break;
    }
  }
}
