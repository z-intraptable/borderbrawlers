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
 * Reglas de disparo, según la especificación:
 *
 *   - el **cuerpo a cuerpo** (`punch` y `kick`) sale en cada contacto con un
 *     rival, alternándose;
 *   - las **habilidades especiales** (`skill1` y `skill2`) se disparan solas
 *     cada 8 a 12 segundos, alternándose;
 *   - el **super** se dispara al completar los tres pasos de gigantismo.
 *
 * Nada de esto lo dispara el usuario: no hay comandos. Los golpes salen del
 * contacto entre peleadores y el gigantismo sale de la liquidez del libro.
 *
 * **La plantilla es más grande que la pelea.** Se juega 3 contra 3, pero cada
 * bando tiene diez y nueve nombres disponibles: el que se cae del escenario no
 * vuelve, entra otro. Eso es lo que hace que la pelea no se repita a los dos
 * minutos, y es la razón de que `Match.character` sea un dato por slot y no una
 * constante.
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
  /** Las dos especiales, que se alternan cada 8-12 s. */
  skill1: string;
  skill2: string;
  /** El de los tres pasos de gigantismo. */
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
  { armature: 'Asuri', team: TEAM_GREEN, label: 'ASU', ...BASE,
    skill1: 'attack_claw_dash', skill2: 'attack_pounce', super: 'super_frenesi_felino' },
  { armature: 'Caspian', team: TEAM_GREEN, label: 'CASP', ...BASE,
    skill1: 'attack_gauntlet_hook', skill2: 'dash_wall_run', super: 'super_carrera_del_gremio' },
  { armature: 'Dusk', team: TEAM_GREEN, label: 'DUSK', ...BASE,
    skill1: 'attack_spirit_bolt', skill2: 'summon_totem', super: 'super_invocacion_ancestral' },
  { armature: 'Ezio', team: TEAM_GREEN, label: 'EZIO', ...BASE,
    skill1: 'attack_hidden_blade', skill2: 'throw_smoke_bomb', super: 'super_salto_de_fe' },
  { armature: 'Isaiah', team: TEAM_GREEN, label: 'ISA', ...BASE,
    skill1: 'attack_rocket_lance', skill2: 'hover_thrusters', super: 'super_bombardeo_orbital' },
  { armature: 'WuShang', team: TEAM_GREEN, label: 'WU', ...BASE,
    skill1: 'attack_palm_strike', skill2: 'dash_meditate', super: 'super_puno_del_dragon' },
  { armature: 'Thea', team: TEAM_GREEN, label: 'THEA', ...BASE,
    skill1: 'attack_chain_whip', skill2: 'grapple_pull', super: 'super_tormenta_de_cadenas' },
  { armature: 'Yumiko', team: TEAM_GREEN, label: 'YUMI', ...BASE,
    skill1: 'attack_fox_arrow', skill2: 'summon_kitsune', super: 'super_lluvia_de_flechas' },
  { armature: 'LordVraxx', team: TEAM_GREEN, label: 'VRAX', ...BASE,
    skill1: 'attack_blaster_shot', skill2: 'deploy_mine', super: 'super_barrido_orbital' },
  { armature: 'SirRoland', team: TEAM_GREEN, label: 'ROL', ...BASE,
    skill1: 'attack_lance_thrust', skill2: 'raise_guard', super: 'super_carga_del_caballero' },

  /* --- rojo: el bando vendedor --------------------------------------- */
  { armature: 'Deadpool', team: TEAM_RED, label: 'DP', ...BASE,
    skill1: 'taunt_4th_wall', skill2: 'attack_katana_slash', super: 'super_ui_smash' },
  { armature: 'Ragnir', team: TEAM_RED, label: 'RAGN', ...BASE,
    skill1: 'attack_axe_swipe', skill2: 'leap_pounce', super: 'super_furia_de_la_manada' },
  { armature: 'Cassidy', team: TEAM_RED, label: 'CASS', ...BASE,
    skill1: 'attack_hammer_slam', skill2: 'blunderbuss_shot', super: 'super_ley_del_oeste' },
  { armature: 'Tezca', team: TEAM_RED, label: 'TEZ', ...BASE,
    skill1: 'attack_flame_kick', skill2: 'mask_swap', super: 'super_sol_ardiente' },
  { armature: 'Kor', team: TEAM_RED, label: 'KOR', ...BASE,
    skill1: 'attack_stone_fist', skill2: 'guard_stance', super: 'super_avalancha' },
  { armature: 'Mako', team: TEAM_RED, label: 'MAKO', ...BASE,
    skill1: 'attack_fin_slash', skill2: 'dash_frenzy', super: 'super_marea_carnicera' },
  { armature: 'Gnash', team: TEAM_RED, label: 'GNSH', ...BASE,
    skill1: 'attack_club_smash', skill2: 'throw_spear', super: 'super_estampida_primitiva' },
  { armature: 'Petra', team: TEAM_RED, label: 'PETR', ...BASE,
    skill1: 'attack_gauntlet_burst', skill2: 'dash_grav_kick', super: 'super_pulso_gravitatorio' },
  { armature: 'Thor', team: TEAM_RED, label: 'THOR', ...BASE,
    skill1: 'attack_hammer_toss', skill2: 'call_lightning', super: 'super_ira_del_trueno' },
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
