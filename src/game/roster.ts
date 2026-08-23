import { TEAM_GREEN, TEAM_RED } from './fighters';

/**
 * La plantilla y sus animaciones.
 *
 * Es una tabla de datos, separada del comportamiento: la simulación decide
 * CUÁNDO se usa una habilidad y esta tabla dice CÓMO se llama la animación que
 * hay que reproducir. Esos nombres son el contrato con el rig — si el rig las
 * llama distinto, no anda, así que conviene que el que riggea trabaje contra
 * esta tabla y no contra la memoria.
 *
 * Reglas de disparo:
 *
 *   - el **cuerpo a cuerpo** (`punch` y `kick`) sale en cada contacto con un
 *     rival, alternándose por cadena de combo — no depende del mercado;
 *   - las **habilidades especiales** (`skill1` y `skill2`) se disparan cuando
 *     la barra personal, cargada por las órdenes agresoras del bando, llega
 *     a `COST_SKILL`;
 *   - el **super** se dispara con esa misma barra al llegar a `COST_SUPER`,
 *     con prioridad sobre la especial.
 *
 * Nada de esto lo dispara el usuario: no hay comandos. El único lazo con el
 * mercado, desde el pivot de 2026-08-23 (ver CLAUDE.md), es esa barra
 * personal — quién aparece y cuánto pesa ya no depende de ningún trade.
 *
 * **La plantilla es exactamente la pelea: seis, tres por bando.** No hay
 * relevos. El que se cae del escenario reaparece él mismo en su slot, y son
 * siempre los mismos seis en todos los escenarios.
 *
 * Antes la plantilla era más grande que la pelea —diecinueve nombres, y el que
 * se caía dejaba entrar a otro— para que la pelea no se repitiera a los dos
 * minutos. Se recortó a seis por una razón de producción y no de diseño: cada
 * personaje necesita un dibujo cortado en piezas, y seis bien cortados se ven
 * mucho mejor que diecinueve a medias. `Match.character` sigue siendo un dato
 * por slot y no una constante, así que volver a agrandar la plantilla es sumar
 * entradas acá y devolverle a `activate` el reparto por ronda.
 *
 * **El bando ya no se lee en la ropa.** Cada peleador conserva sus colores
 * propios —son personajes dibujados, no siluetas teñidas— y lo que dice de qué
 * lado está es el color de sus poderes: verde el equipo comprador, rojo el
 * vendedor. Por eso la plantilla viene partida al medio de entrada, con el
 * bando fijo por personaje: así el que dibuja el efecto de una habilidad sabe
 * de qué color va antes de dibujarlo, y no hay que teñir nada en runtime.
 */

export interface Character {
  /** Nombre de la carpeta del arte y de la armadura. */
  armature: string;
  team: number;
  /**
   * Peso fijo, para `knockback`/`hitDamage` en `fighters.ts`. Reemplaza al
   * peso derivado del tamaño del trade (pivot de 2026-08-23, ver CLAUDE.md).
   *
   * Parejo en 1 para los seis a propósito: es un placeholder de arranque, no
   * un número de lore. Ajustar por sensación jugando, no por intuición de a
   * quién "debería" pesar más.
   */
  weight: number;
  /** Se muestra en el marcador y en los KO. */
  label: string;
  idle: string;
  run: string;
  jump: string;
  hurt: string;
  /**
   * El cuerpo a cuerpo: sale en cada contacto con un rival, alternando. Es lo
   * que más se ve de todo el rig — un peleador pega decenas de veces por cada
   * habilidad que usa.
   */
  punch: string;
  kick: string;
  /** Las dos especiales, que se alternan y salen cuando la barra llega a
   * `COST_SKILL`. */
  skill1: string;
  skill2: string;
  /** El super, cuando la barra llega a `COST_SUPER`. */
  super: string;
}

/** Las cuatro que tiene todo el mundo igual, para no repetirlas veinte veces. */
const BASE = {
  idle: 'idle', run: 'run', jump: 'jump', hurt: 'hurt',
  punch: 'attack_punch', kick: 'attack_kick',
} as const;

/**
 * `idle`, `run`, `jump` y `hurt` no estaban en la ficha original pero hacen
 * falta igual: un personaje que sólo tiene animaciones de ataque se ve
 * congelado el 90% del tiempo. Se nombran con la misma convención para que
 * entren en el mismo rig.
 *
 * Quiénes están acá y quiénes no salió de una condición práctica, no de gusto:
 * entran los que se pueden **cortar en piezas** de un solo dibujo — brazos
 * despegados del torso, hueco entre las piernas y nada cruzando por delante del
 * cuerpo. Un arma en diagonal sobre el pecho obliga a inventar lo que hay
 * detrás, y eso ya no es cortar, es dibujar.
 */
export const ROSTER: readonly Character[] = [
  /* --- verde: el bando comprador ------------------------------------- */
  { armature: 'Kor', team: TEAM_GREEN, weight: 1, label: 'KOR', ...BASE,
    skill1: 'attack_stone_fist', skill2: 'guard_stance', super: 'super_avalancha' },
  { armature: 'Mako', team: TEAM_GREEN, weight: 1, label: 'MAKO', ...BASE,
    skill1: 'attack_fin_slash', skill2: 'dash_frenzy', super: 'super_marea_carnicera' },
  { armature: 'Asuri', team: TEAM_GREEN, weight: 1, label: 'ASU', ...BASE,
    skill1: 'attack_claw_dash', skill2: 'attack_pounce', super: 'super_frenesi_felino' },

  /* --- rojo: el bando vendedor --------------------------------------- */
  { armature: 'Ragnir', team: TEAM_RED, weight: 1, label: 'RAGN', ...BASE,
    skill1: 'attack_claw_rake', skill2: 'leap_pounce', super: 'super_aliento_de_fuego' },
  { armature: 'WuShang', team: TEAM_RED, weight: 1, label: 'WU', ...BASE,
    skill1: 'attack_palm_strike', skill2: 'dash_meditate', super: 'super_puno_del_dragon' },
  { armature: 'Dusk', team: TEAM_RED, weight: 1, label: 'DUSK', ...BASE,
    skill1: 'attack_spirit_bolt', skill2: 'summon_totem', super: 'super_invocacion_ancestral' },
];

export const GREEN_ROSTER = ROSTER.filter((c) => c.team === TEAM_GREEN);
export const RED_ROSTER = ROSTER.filter((c) => c.team === TEAM_RED);

/** Cuántos personajes tiene disponible un bando. */
export function rosterSize(team: number): number {
  return team === TEAM_GREEN ? GREEN_ROSTER.length : RED_ROSTER.length;
}

/**
 * El personaje número `index` de un bando. El slot no cambia de bando nunca,
 * pero sí de personaje: al caerse uno entra otro de la plantilla, y `index` es
 * justo lo que cambia.
 */
export function characterFor(team: number, index: number): Character {
  const list = team === TEAM_GREEN ? GREEN_ROSTER : RED_ROSTER;
  return list[index % list.length];
}

/** Nombre de la animación de la habilidad especial número `skill` (0 o 1). */
export function skillAnimation(character: Character, skill: number): string {
  return skill === 0 ? character.skill1 : character.skill2;
}

/** Nombre de la animación de cuerpo a cuerpo número `blow` (0 o 1). */
export function meleeAnimation(character: Character, blow: number): string {
  return blow === 0 ? character.punch : character.kick;
}

/**
 * Lista completa de animaciones que tiene que traer cada rig. Es lo que hay que
 * pasarle al que riggea, y lo que habría que verificar contra el archivo
 * exportado antes de darlo por bueno.
 */
export function requiredAnimations(character: Character): string[] {
  return [
    character.idle, character.run, character.jump, character.hurt,
    character.punch, character.kick,
    character.skill1, character.skill2, character.super,
  ];
}
