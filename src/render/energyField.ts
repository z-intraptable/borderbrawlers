import { Graphics } from 'pixi.js';
import { GodrayFilter } from 'pixi-filters/godray';
import { SimplexNoiseFilter } from 'pixi-filters/simplex-noise';

/**
 * El cielo plano de siempre, con una textura de ruido y rayos que se mueven
 * solos por encima. Es puramente atmosférico —el dato sigue siendo el tinte
 * del cielo y los cristales de volumen, esto no cambia ni agrega ninguno—,
 * así que la intensidad se mantiene baja a propósito: se nota que el fondo
 * respira, no compite con lo que hay que leer.
 *
 * Los dos filtros son de `pixi-filters`, no shaders de mano: en un proyecto
 * sin control de versión visual (no hay screenshot de referencia corriendo
 * en CI) escribir GLSL propio para algo que ya viene probado y mantenido es
 * el lugar equivocado para inventar. `SimplexNoiseFilter` da la textura fina
 * del cielo, `GodrayFilter` los rayos que se desplazan — juntos leen como un
 * campo de energía sin ser ninguno de los dos por separado.
 *
 * Vive en coordenadas de PANTALLA, igual que `backdrop.ts`: es el fondo de
 * todo, no lo mueve la cámara.
 */

export interface EnergyField {
  view: Graphics;
  /** Redimensiona el rectángulo de fondo. Se llama junto con el resto del layout. */
  resize(width: number, height: number): void;
  /**
   * Adelanta el tiempo y corre el tinte hacia el bando que domina.
   *
   * `share` es la misma fracción de 0 a 1 que ya usa `backdrop.skyColor` — 0
   * es rojo dominando, 1 es verde. El campo no INVENTA un dato nuevo, sigue
   * al mismo.
   */
  update(dt: number, share: number): void;
}

/** Techo de opacidad del ruido. Más alto y empieza a comerse el HUD y los cristales. */
const NOISE_STRENGTH = 0.16;
/** Qué tan chicas son las manchas de ruido, en unidades de pantalla. */
const NOISE_SCALE = 3.4;
/** Opacidad de los rayos. Sutil: son atmósfera, no un reflector. */
const RAY_ALPHA = 0.22;

export function createEnergyField(): EnergyField {
  const view = new Graphics();

  const noise = new SimplexNoiseFilter({
    strength: NOISE_STRENGTH,
    noiseScale: NOISE_SCALE,
  });
  const godray = new GodrayFilter({
    angle: -25,
    gain: 0.35,
    lacunarity: 2.1,
    alpha: RAY_ALPHA,
  });
  view.filters = [noise, godray];

  let w = 0;
  let h = 0;
  let time = 0;

  function paint(): void {
    view.clear();
    // El color de relleno no importa —el ruido y los rayos son multiplicativos
    // sobre lo que haya debajo— pero Pixi necesita un contenido con área para
    // aplicarles el filtro; un rect blanco liso es el más barato posible.
    view.rect(0, 0, w, h).fill(0xffffff);
  }

  return {
    view,
    resize(width, height): void {
      if (width === w && height === h) return;
      w = width;
      h = height;
      paint();
    },
    update(dt, share): void {
      time += dt;
      noise.offsetX = time * 0.05;
      noise.offsetY = time * 0.03;
      godray.time = time * 0.4;
      // -25° para el rojo dominando, +25° para el verde: los rayos se
      // inclinan hacia el bando que gana en vez de quedar fijos.
      godray.angle = -25 + share * 50;
    },
  };
}
