/**
 * La identidad visual del peleador VECTORIAL, el que se dibuja mientras el
 * personaje no tiene arte cortado todavía.
 *
 * **Un personaje dibujado conserva sus propios colores**: `paint()` sale
 * temprano cuando hay arte, así que nada de esto lo toca. Lo que dice de qué
 * bando es cada uno es el **color de sus poderes** —verde el comprador, rojo el
 * vendedor—, que es la regla del agresor hecha visible y el único dato del
 * mercado que se lee de un vistazo. La ropa quedó libre justamente porque el
 * efecto ya lo dice.
 *
 * El muñeco vectorial sí se pinta del color del bando, y ahí sigue valiendo lo
 * de siempre: la forma distingue a uno de otro —cuernos, orejas, vincha,
 * antena, hocico, máscara—, no el color. Es un marcador de posición, y conviene
 * que se note cuál es cuál mientras se van cortando los dibujos.
 *
 * `accent` es el único color propio del muñeco, y se usa en las piezas chicas.
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
  { armature: 'Asuri', accent: 0xf2c14c, gear: GEAR_EARS, blade: true, ball: false },
  { armature: 'Caspian', accent: 0xc9d6e8, gear: GEAR_HEADBAND, blade: true, ball: false },
  { armature: 'Dusk', accent: 0x7ad6c0, gear: GEAR_MASK, blade: false, ball: false },
  { armature: 'Ezio', accent: 0xe8e0cc, gear: GEAR_MASK, blade: true, ball: false },
  { armature: 'Isaiah', accent: 0xf5a24b, gear: GEAR_ANTENNA, blade: false, ball: false },
  { armature: 'WuShang', accent: 0xdfe7f2, gear: GEAR_HEADBAND, blade: false, ball: false },
  { armature: 'Thea', accent: 0xd9b96b, gear: GEAR_HEADBAND, blade: false, ball: true },
  { armature: 'Yumiko', accent: 0xf0ead6, gear: GEAR_EARS, blade: false, ball: false },
  { armature: 'LordVraxx', accent: 0x9ad1ff, gear: GEAR_HORNS, blade: false, ball: false },
  { armature: 'SirRoland', accent: 0xc7cdd8, gear: GEAR_HORNS, blade: true, ball: false },

  { armature: 'Deadpool', accent: 0x1b1f2b, gear: GEAR_MASK, blade: true, ball: false },
  { armature: 'Ragnir', accent: 0xd8c9a8, gear: GEAR_EARS, blade: true, ball: false },
  { armature: 'Cassidy', accent: 0xf0ead6, gear: GEAR_HEADBAND, blade: false, ball: false },
  { armature: 'Tezca', accent: 0xf5a24b, gear: GEAR_MASK, blade: false, ball: false },
  { armature: 'Kor', accent: 0x8f9aa8, gear: GEAR_HORNS, blade: false, ball: false },
  { armature: 'Mako', accent: 0xbcd7e8, gear: GEAR_SNOUT, blade: true, ball: false },
  { armature: 'Gnash', accent: 0xd8c9a8, gear: GEAR_SNOUT, blade: true, ball: false },
  { armature: 'Petra', accent: 0xc9a0ff, gear: GEAR_ANTENNA, blade: false, ball: true },
  { armature: 'Thor', accent: 0xf2e14c, gear: GEAR_HORNS, blade: false, ball: false },
];

/** El aspecto de un `armature`, o uno neutro si no está en la tabla. */
export function lookFor(armature: string): Look {
  const found = LOOKS.find((look) => look.armature === armature);
  return found ?? { armature, accent: 0xdfe7f2, gear: GEAR_NONE, blade: false, ball: false };
}
