/**
 * La identidad visual de cada personaje.
 *
 * **El color lo manda el equipo, la forma manda el personaje.** El verde y el
 * rojo no son decoración: son la regla del agresor hecha visible —verde
 * comprador, rojo vendedor— y es el único dato del mercado que se lee de un
 * vistazo. Si cada personaje trajera su propia paleta, mirar la pantalla dejaría
 * de decir quién está atacando. Así que el traje es siempre del color del bando
 * y lo que distingue a uno de otro es la silueta: cuernos, orejas, vincha,
 * antena, hocico, máscara. Es lo mismo que hace Brawlhalla — se reconoce al
 * personaje por el recorte contra el fondo, no por el color.
 *
 * `accent` es el único color propio, y se usa en las piezas chicas.
 */

export const GEAR_NONE = 0;
export const GEAR_HORNS = 1;
export const GEAR_EARS = 2;
export const GEAR_HEADBAND = 3;
export const GEAR_ANTENNA = 4;
export const GEAR_SNOUT = 5;
export const GEAR_MASK = 6;

export interface Look {
  /** Coincide con `armature` del elenco. */
  armature: string;
  accent: number;
  gear: number;
  /** Lleva una hoja a la espalda que se ve al girar. */
  blade: boolean;
  /** Lleva una pelota en la mano libre. */
  ball: boolean;
}

export const LOOKS: readonly Look[] = [
  { armature: 'EarthWormJim', accent: 0xf2e14c, gear: GEAR_ANTENNA, blade: false, ball: false },
  { armature: 'Platinio', accent: 0xdfe7f2, gear: GEAR_SNOUT, blade: false, ball: false },
  { armature: 'BlackieMouse', accent: 0x1b1f2b, gear: GEAR_EARS, blade: false, ball: false },
  { armature: 'ChicagoBull', accent: 0xf0ead6, gear: GEAR_HORNS, blade: false, ball: false },
  { armature: 'MichaelJordan', accent: 0xf5a24b, gear: GEAR_HEADBAND, blade: false, ball: true },
  { armature: 'Deadpool', accent: 0x1b1f2b, gear: GEAR_MASK, blade: true, ball: false },
];

/** El aspecto de un `armature`, o uno neutro si no está en la tabla. */
export function lookFor(armature: string): Look {
  const found = LOOKS.find((look) => look.armature === armature);
  return found ?? { armature, accent: 0xdfe7f2, gear: GEAR_NONE, blade: false, ball: false };
}
