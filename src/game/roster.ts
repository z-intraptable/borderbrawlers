import { TEAM_GREEN, TEAM_RED } from './fighters';

/**
 * El elenco y sus animaciones.
 *
 * Es una tabla de datos, separada del comportamiento: la simulación decide
 * CUÁNDO se usa una habilidad y esta tabla dice CÓMO se llama la animación que
 * hay que reproducir. Esos nombres son el contrato con el rig de DragonBones —
 * si el rig las llama distinto, no anda, así que conviene que el que riggea
 * trabaje contra esta tabla y no contra la memoria.
 *
 * Reglas de disparo, según la especificación:
 *
 *   - las **habilidades comunes** (`skill1` y `skill2`) se usan todo el tiempo,
 *     en cada golpe, alternándose;
 *   - el **super** se dispara al completar los tres pasos de gigantismo.
 *
 * Nada de esto lo dispara el usuario: no hay comandos. Los golpes salen del
 * contacto entre peleadores y el gigantismo sale de la liquidez del libro.
 */

export interface Character {
  /** Nombre de la armadura en el archivo de DragonBones. */
  armature: string;
  team: number;
  /** Se muestra en el marcador y en los KO. */
  label: string;
  idle: string;
  run: string;
  jump: string;
  hurt: string;
  /** Las dos comunes, que se alternan golpe a golpe. */
  skill1: string;
  skill2: string;
  /** El de los tres pasos de gigantismo. */
  super: string;
}

/**
 * `idle`, `run`, `jump` y `hurt` no estaban en la ficha original pero hacen
 * falta igual: un personaje que sólo tiene animaciones de ataque se ve
 * congelado el 90% del tiempo. Se nombran con la misma convención para que
 * entren en el mismo rig.
 */
export const ROSTER: readonly Character[] = [
  {
    armature: 'EarthWormJim',
    team: TEAM_GREEN,
    label: 'JIM',
    idle: 'idle', run: 'run', jump: 'jump', hurt: 'hurt',
    skill1: 'attack_zapper',
    // La ficha traía a Jim incompleto: le faltaban skill2 y super. Estos son
    // marcadores con la convención del resto; hay que confirmarlos antes de
    // riggear, porque el nombre es el contrato.
    skill2: 'attack_whip',
    super: 'super_pocket_rocket',
  },
  {
    armature: 'Platinio',
    team: TEAM_GREEN,
    label: 'PLAT',
    idle: 'idle', run: 'run', jump: 'jump', hurt: 'hurt',
    skill1: 'attack_snoot_wave',
    skill2: 'dash_invulnerable',
    super: 'super_tornado_platinio',
  },
  {
    armature: 'BlackieMouse',
    team: TEAM_GREEN,
    label: 'BLKY',
    idle: 'idle', run: 'run', jump: 'jump', hurt: 'hurt',
    skill1: 'drop_trap',
    skill2: 'parry_stance',
    super: 'super_yunque_100t',
  },
  {
    armature: 'ChicagoBull',
    team: TEAM_RED,
    label: 'BULL',
    idle: 'idle', run: 'run', jump: 'jump', hurt: 'hurt',
    skill1: 'charge_armor',
    skill2: 'ground_stomp',
    super: 'super_estampida_extincion',
  },
  {
    armature: 'MichaelJordan',
    team: TEAM_RED,
    label: 'MJ',
    idle: 'idle', run: 'run', jump: 'jump', hurt: 'hurt',
    skill1: 'ball_pass',
    skill2: 'dunk_zone_anchor',
    super: 'super_meteor_dunk',
  },
  {
    armature: 'Deadpool',
    team: TEAM_RED,
    label: 'DP',
    idle: 'idle', run: 'run', jump: 'jump', hurt: 'hurt',
    skill1: 'taunt_4th_wall',
    skill2: 'attack_katana_slash',
    super: 'super_ui_smash',
  },
];

export const GREEN_ROSTER = ROSTER.filter((c) => c.team === TEAM_GREEN);
export const RED_ROSTER = ROSTER.filter((c) => c.team === TEAM_RED);

/** El personaje de un slot. Los slots no cambian de bando, así que es fijo. */
export function characterFor(team: number, index: number): Character {
  const list = team === TEAM_GREEN ? GREEN_ROSTER : RED_ROSTER;
  return list[index % list.length];
}

/** Nombre de la animación de la habilidad común número `skill` (0 o 1). */
export function skillAnimation(character: Character, skill: number): string {
  return skill === 0 ? character.skill1 : character.skill2;
}

/**
 * Lista completa de animaciones que tiene que traer cada rig. Es lo que hay que
 * pasarle al que riggea, y lo que habría que verificar contra el archivo
 * exportado antes de darlo por bueno.
 */
export function requiredAnimations(character: Character): string[] {
  return [
    character.idle, character.run, character.jump, character.hurt,
    character.skill1, character.skill2, character.super,
  ];
}
