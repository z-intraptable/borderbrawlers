/**
 * Reglas de la pelea. Sin three, sin rapier, sin React, sin DOM.
 *
 * Todo lo que decide *qué* hace un personaje vive acá y se testea con asserts;
 * `FighterPool` sólo traduce esas decisiones a llamadas de física. La razón es
 * práctica: el comportamiento de un peleador es la parte que más se va a
 * retocar a ojo, y retocar a ojo sin una red de seguridad es cómo se rompe el
 * caso raro —el que está al borde de la plataforma, el que tiene 300% de daño—
 * sin que nadie se entere hasta verlo en video.
 */

export const TEAM_GREEN = 0;
export const TEAM_RED = 1;

/** Verde = compradores agresores, rojo = vendedores. Regla del agresor. */
export type Team = typeof TEAM_GREEN | typeof TEAM_RED;

export const SLOT_FREE = 0;
export const SLOT_ACTIVE = 1;
export const SLOT_RETIRING = 2;

/* ------------------------------------------------------------------ */
/* Skyline                                                             */
/* ------------------------------------------------------------------ */

/**
 * El escenario visto por la IA: una lista de plataformas con su rango de x y la
 * altura de su tapa.
 *
 * Los personajes preguntan "¿hay piso acá?" varias veces por frame. Hacerlo con
 * un raycast contra el mundo de física costaría una consulta por pregunta y
 * ademas asignaría; acá es un índice y una comparación, porque las alturas ya
 * están calculadas para dibujar. Es el mismo truco que `stageFocus`: un objeto
 * mutable creado una vez, escrito por el escenario y leído por el pool.
 *
 * Los rangos de x son FIJOS. Sólo se mueve `topY`. Una plataforma que además se
 * corriera de costado haría imposible calcular un salto, y se vería como un
 * temblor en vez de como un escenario.
 */
export interface Skyline {
  count: number;
  minX: Float64Array;
  maxX: Float64Array;
  topY: Float64Array;
}

export function createSkyline(count: number): Skyline {
  return {
    count,
    minX: new Float64Array(count),
    maxX: new Float64Array(count),
    topY: new Float64Array(count),
  };
}

/** Índice de la plataforma que cubre `x`, o -1 si ahí no hay nada. */
export function platformIndexAt(sky: Skyline, x: number): number {
  for (let i = 0; i < sky.count; i++) {
    if (x >= sky.minX[i] && x <= sky.maxX[i]) return i;
  }
  return -1;
}

/** Altura del piso bajo `x`. `-Infinity` es el vacío: ahí se cae. */
export function groundYAt(sky: Skyline, x: number): number {
  const i = platformIndexAt(sky, x);
  return i < 0 ? -Infinity : sky.topY[i];
}

/**
 * ¿Está parado? Tolerancia arriba porque el personaje descansa sobre su radio,
 * y velocidad vertical chica para no confundir "tocando el piso" con "pasando
 * a toda velocidad por la altura del piso".
 */
export function isGrounded(
  sky: Skyline,
  x: number,
  y: number,
  vy: number,
  feetOffset: number,
  tolerance = 0.18,
): boolean {
  const ground = groundYAt(sky, x);
  if (ground === -Infinity) return false;
  const feet = y - feetOffset;
  return feet <= ground + tolerance && feet >= ground - tolerance * 3 && Math.abs(vy) < 1.6;
}

/**
 * ¿Hay piso adelante? Sirve para dos cosas opuestas: saltar el pozo cuando el
 * objetivo está del otro lado, y frenar antes de caerse solo cuando no lo está.
 */
export function hasGroundAhead(
  sky: Skyline,
  x: number,
  dir: number,
  lookahead: number,
): boolean {
  return groundYAt(sky, x + dir * lookahead) !== -Infinity;
}

/* ------------------------------------------------------------------ */
/* Decisiones                                                          */
/* ------------------------------------------------------------------ */

/**
 * Enemigo más cercano, o -1 si el equipo rival no tiene a nadie.
 *
 * La distancia vertical se PENALIZA, no se descuenta: subir tres plataformas
 * cuesta varios saltos, así que un rival que está a 6 unidades de altura es peor
 * objetivo que uno a 4 caminando, aunque en línea recta esté más cerca. Con el
 * factor al revés los peleadores se obsesionan con el de arriba y se pasan la
 * pelea saltando contra una pared.
 */
const VERTICAL_COST = 1.8;

export function nearestEnemy(
  capacity: number,
  slotState: Uint8Array,
  teams: Uint8Array,
  xs: Float64Array,
  ys: Float64Array,
  self: number,
): number {
  const myTeam = teams[self];
  const x = xs[self];
  const y = ys[self];
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < capacity; i++) {
    if (i === self || slotState[i] !== SLOT_ACTIVE || teams[i] === myTeam) continue;
    const dx = xs[i] - x;
    const dy = (ys[i] - y) * VERTICAL_COST;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Como `nearestEnemy`, pero penalizando a los rivales que ya tienen encima a un
 * compañero.
 *
 * Sin esto los tres del equipo eligen siempre al mismo —el más cercano al
 * centro— y la pelea entera se apelmaza en un punto mientras las plataformas
 * laterales quedan vacías. Con la penalización se reparten solos, sin necesidad
 * de un asignador global ni de roles.
 */
export function pickTarget(
  capacity: number,
  slotState: Uint8Array,
  teams: Uint8Array,
  xs: Float64Array,
  ys: Float64Array,
  claims: Uint8Array,
  self: number,
): number {
  const myTeam = teams[self];
  const x = xs[self];
  const y = ys[self];
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < capacity; i++) {
    if (i === self || slotState[i] !== SLOT_ACTIVE || teams[i] === myTeam) continue;
    const dx = xs[i] - x;
    const dy = (ys[i] - y) * VERTICAL_COST;
    const score = (dx * dx + dy * dy) * (1 + claims[i] * CLAIM_PENALTY);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Cuánto encarece cada compañero que ya eligió a ese rival. */
const CLAIM_PENALTY = 2.5;

/**
 * Separación entre compañeros: cuánto conviene correrse al costado, de -1 a 1.
 *
 * Es steering, no física: empujar con impulsos a los del propio equipo se ve
 * como un choque y arruina el knockback del rival. Acá sólo se le suma una
 * intención de correrse al costado.
 *
 * **Es continua, no ±1.** La versión anterior devolvía tres valores, y sumada a
 * una persecución que vale ±1 nunca podía ganarle: lo más que hacía era reducir
 * a la mitad la velocidad de acercamiento. El resultado era que los seis
 * peleadores terminaban apilados en el mismo punto de la plataforma central. Con
 * la urgencia proporcional a lo encimados que están, el que tiene a alguien
 * pegado se corre de verdad y el que está a distancia cómoda no se mueve.
 */
export const TEAMMATE_SPACING = 1.6;

export function separation(
  capacity: number,
  slotState: Uint8Array,
  teams: Uint8Array,
  xs: Float64Array,
  ys: Float64Array,
  self: number,
): number {
  const myTeam = teams[self];
  let push = 0;
  for (let i = 0; i < capacity; i++) {
    if (i === self || slotState[i] !== SLOT_ACTIVE || teams[i] !== myTeam) continue;
    const dx = xs[self] - xs[i];
    const gap = Math.abs(dx);
    if (gap > TEAMMATE_SPACING) continue;
    if (Math.abs(ys[self] - ys[i]) > TEAMMATE_SPACING * 2) continue;
    // Superpuestos exactos: el signo de dx no dice nada y los dos empujarían
    // para el mismo lado, así que no se separarían nunca. El índice de slot
    // desempata, que es arbitrario pero consistente.
    const dir = gap < 1e-6 ? (self > i ? 1 : -1) : (dx >= 0 ? 1 : -1);
    push += dir * (1 - gap / TEAMMATE_SPACING);
  }
  return push > 1 ? 1 : push < -1 ? -1 : push;
}

export interface JumpContext {
  grounded: boolean;
  /** Altura del objetivo menos la propia. Positivo = está arriba. */
  dy: number;
  /** Distancia horizontal con signo hacia el objetivo. */
  dx: number;
  /** ¿Hay piso en la dirección en la que camina? */
  groundAhead: boolean;
  /** Segundos desde el último salto. Evita el martilleo. */
  sinceJump: number;
}

export const JUMP_COOLDOWN = 0.45;
/** A partir de acá el objetivo cuenta como "arriba" y hay que subir. */
export const JUMP_HEIGHT_THRESHOLD = 0.6;

/**
 * Tres motivos para saltar, en orden de frecuencia real: el objetivo está más
 * arriba, hay un pozo en el camino, o está lo bastante cerca como para caerle
 * encima. El cooldown es lo que separa "peleador" de "resorte".
 */
export function wantsJump(ctx: JumpContext): boolean {
  if (!ctx.grounded) return false;
  if (ctx.sinceJump < JUMP_COOLDOWN) return false;
  if (ctx.dy > JUMP_HEIGHT_THRESHOLD) return true;
  if (!ctx.groundAhead && Math.abs(ctx.dx) > 0.4) return true;
  return false;
}

/**
 * ¿Frena para no caerse? Sólo si el objetivo NO está del otro lado del pozo:
 * si está, se salta. Un peleador que nunca se tira al vacío nunca persigue a
 * nadie hasta el borde, y toda la pelea se queda en el centro.
 */
export function shouldBrakeAtLedge(groundAhead: boolean, dx: number, dir: number): boolean {
  if (groundAhead) return false;
  return Math.sign(dx) !== dir || Math.abs(dx) < 0.4;
}

/**
 * ¿Frena en vez de acelerar para el otro lado?
 *
 * `GROUND_ACCEL` revierte `vx` en una fracción de segundo, pero girar el
 * dibujo tiene su propio enfriamiento (`TURN_COOLDOWN`) para no parpadear. Sin
 * este freno, `vx` cruza al signo nuevo ANTES de que el cooldown deje girar el
 * sprite, y el peleador se ve caminando para atrás: corriendo hacia un lado
 * con el dibujo todavía mirando el otro. Frenando hasta `brakeSpeed` antes de
 * dejar acelerar de nuevo, la velocidad nunca le gana la carrera al dibujo.
 */
export function shouldBrakeToTurn(
  vx: number, facing: number, dir: number, brakeSpeed: number,
): boolean {
  return dir !== facing && Math.abs(vx) > brakeSpeed;
}

/* ------------------------------------------------------------------ */
/* El plan: qué hacer, no cómo moverse                                 */
/* ------------------------------------------------------------------ */

/**
 * Capa de planificación, arriba de las primitivas de movimiento de más
 * arriba (`pickTarget`, `separation`, `wantsJump`, `shouldBrakeAtLedge`,
 * `shouldBrakeToTurn`). Esas siguen ejecutando el plan vigente cuadro a
 * cuadro — quién sigue siendo "cómo moverse". Esto es "qué hacer": cada
 * tanto (`REPLAN_INTERVAL` en match.ts, no cada cuadro — sería carísimo
 * para seis unidades a 60 fps y además se vería nervioso) se evalúan un
 * puñado de acciones candidatas y se elige la de mejor puntaje, mirando un
 * paso adelante para las dos que exponen (especial y super): qué le
 * conviene contestar al rival, y cuánto le resta a la apuesta.
 *
 * Reemplaza al viejo `aTiro` —una sola condición si/no calculada cada
 * cuadro— por una decisión explícita, deliberada, y que compara alternativas
 * en vez de responder a un único umbral. Sigue sin haber azar: empates se
 * resuelven por el orden de `CANDIDATAS`, siempre el mismo.
 */
export const ACCION_ACERCAR = 0;
export const ACCION_RETIRAR = 1;
export const ACCION_SOSTENER = 2;
export const ACCION_ESPECIAL = 3;
export const ACCION_SUPER = 4;
/**
 * Dash/air dodge: un pulso de velocidad de escape, invulnerable a poder y
 * super mientras dura (ver `DODGE_INVULN` en match.ts). Distinta de
 * `ACCION_RETIRAR` en el motivo: retirar es "conviene alejarse por el daño
 * acumulado", esquivar es "el rival YA decidió tirar algo y esto lo esquiva
 * de verdad" -- puede elegirse aunque retirarse no convenga.
 */
export const ACCION_ESQUIVAR = 5;
/**
 * Escudo/parry: se planta y mitiga (no anula) el golpe que viene, ver
 * `SHIELD_MITIGATION` en match.ts. Cubre el hueco que deja el esquive: al
 * borde del vacío `ACCION_ESQUIVAR` no se puede (no hay adónde escapar), y
 * ahí el escudo sigue siendo una opción -- no necesita espacio detrás,
 * porque no se mueve.
 */
export const ACCION_ESCUDO = 6;

const CANDIDATAS = [
  ACCION_ACERCAR, ACCION_RETIRAR, ACCION_SOSTENER, ACCION_ESPECIAL, ACCION_SUPER,
  ACCION_ESQUIVAR, ACCION_ESCUDO,
] as const;

/** Lo que un peleador ve de sí mismo (o del rival, para el paso 1-ply) al planear. */
export interface PlanContext {
  /** Distancia horizontal absoluta al rival. */
  distancia: number;
  /** Barra propia, 0 a 1. */
  energia: number;
  /** Alcance de la especial (`ALCANCE` en match.ts). */
  alcance: number;
  /** Si retirarse lo manda al vacío: no hay piso detrás. */
  cercaDelBorde: boolean;
  /** % de daño acumulado propio y del rival. */
  dañoPropio: number;
  dañoRival: number;
  /**
   * Si el super sigue enfriando (`SUPER_COOLDOWN` en match.ts). Sin esto, con
   * el mercado a mil la barra vuelve a llenarse tan rápido que el super gana
   * SIEMPRE apenas la energía alcanza y la especial no se elige nunca — se
   * midió con un mercado agitado sintético: 0 especiales en 20 partidos
   * enteros. El super es el remate ocasional, no el ataque de rutina.
   */
  superEnfriando: boolean;
  /**
   * El rival ya decidió tirar especial o super (su `plan` de la última
   * replanificación). Es la señal de "hay algo cargado viniendo", no una
   * predicción -- se lee directo del plan vigente del rival, que YA es la
   * telegrafía del golpe. Pura: NO mira si esquivar/escudo están
   * disponibles, eso lo deciden `esquivarListo`/`escudoListo` aparte, para
   * que cada acción defensiva pueda estar habilitada o no por separado.
   */
  amenazado: boolean;
  /** Si `ACCION_ESQUIVAR` no está enfriando (`DODGE_COOLDOWN` en match.ts). */
  esquivarListo: boolean;
  /** Si `ACCION_ESCUDO` no está enfriando (`SHIELD_COOLDOWN` en match.ts). */
  escudoListo: boolean;
}

/**
 * Puntaje de UNA acción candidata para el contexto dado. Más alto es mejor;
 * `-Infinity` es "no se puede" (sin barra, sin alcance, al borde del vacío).
 */
export function puntajeAccion(accion: number, ctx: PlanContext): number {
  switch (accion) {
    case ACCION_SUPER:
      if (ctx.energia < COST_SUPER || ctx.superEnfriando) return -Infinity;
      // Más que el techo de la especial (4 + 1×2 = 6, con la barra llena):
      // con las dos listas a la vez, gana el remate. Conviene todavía más
      // cuanto más daño acumuló el rival: el super lo manda lejos con menos
      // empuje si ya viene golpeado.
      return 7 + ctx.dañoRival * 0.02;
    case ACCION_ESPECIAL:
      if (ctx.energia < COST_SKILL || ctx.distancia > ctx.alcance) return -Infinity;
      // Cuanto más cargada, más vale la pena tirarla ya en vez de acercarse.
      return 4 + ctx.energia * 2;
    case ACCION_RETIRAR:
      if (ctx.cercaDelBorde) return -Infinity;
      // Conviene retirarse cuando uno mismo acumuló más daño que el rival:
      // el próximo golpe que se reciba duele más que el que se da.
      return (ctx.dañoPropio - ctx.dañoRival) * 0.03;
    case ACCION_ESQUIVAR:
      // Al borde del vacío tampoco: el pulso de escape es hacia atrás, igual
      // que retirarse, y ahí atrás no hay piso.
      if (!ctx.amenazado || !ctx.esquivarListo || ctx.cercaDelBorde) return -Infinity;
      // Más que ACERCAR/SOSTENER siempre que haya amenaza real, pero menos
      // que tirar la propia especial/super -- si las dos barras están
      // listas a la vez, conviene más rematar que esquivar.
      return 3;
    case ACCION_ESCUDO:
      if (!ctx.amenazado || !ctx.escudoListo) return -Infinity;
      // Un poco menos que esquivar: mitiga en vez de anular, así que a
      // igualdad de condiciones el esquive gana. Sigue siendo mejor que
      // ACERCAR/SOSTENER, y a diferencia del esquive no necesita piso
      // detrás -- cubre justo el caso en que `ACCION_ESQUIVAR` devuelve
      // -Infinity por estar al borde.
      return 2.5;
    case ACCION_SOSTENER:
      return 0.5;
    case ACCION_ACERCAR:
    default:
      return 1;
  }
}

/**
 * El árbol de decisión completo: puntúa las candidatas y devuelve la mejor.
 *
 * El "1-ply" del minimax simple: a especial y super, que exponen al que las
 * tira (quieto un instante, la barra a cero después), se les resta lo mejor
 * que el rival podría contestar ahora mismo con SU contexto (`ctxRival`) —
 * no lo que el rival vaya a hacer de verdad, sino el techo de lo que podría,
 * que es lo que un rival racional puede aprovechar. Si esa resta lo empareja
 * o le gana a `ACCION_ACERCAR`, no vale la pena abrir el juego.
 */
export function planear(ctx: PlanContext, ctxRival: PlanContext): number {
  let mejor = ACCION_ACERCAR;
  let mejorPuntaje = -Infinity;
  for (const accion of CANDIDATAS) {
    let puntaje = puntajeAccion(accion, ctx);
    if (puntaje === -Infinity) continue;
    if (accion === ACCION_ESPECIAL || accion === ACCION_SUPER) {
      const contraEspecial = puntajeAccion(ACCION_ESPECIAL, ctxRival);
      const contraSuper = puntajeAccion(ACCION_SUPER, ctxRival);
      const respuesta = Math.max(
        contraEspecial === -Infinity ? 0 : contraEspecial,
        contraSuper === -Infinity ? 0 : contraSuper,
      );
      puntaje -= respuesta * 0.3;
    }
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejor = accion;
    }
  }
  return mejor;
}

/* ------------------------------------------------------------------ */
/* Golpes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Ojo con las unidades: esto ahora es VELOCIDAD en unidades por segundo, no un
 * impulso sobre una masa como cuando lo resolvía Rapier. Con los números viejos
 * un golpe al 200% daba 14 u/s por 1,4 de multiplicador horizontal, o sea 19
 * u/s sobre un escenario de 18 de ancho: cada roce cruzaba la pantalla entera y
 * los peleadores se pasaban la pelea en el aire.
 */
export const BASE_KNOCKBACK = 2.4;
export const DAMAGE_SCALE = 0.022;
/**
 * Subió de 9,5 a 16 el 22/08. Hasta acá era el tope de la especial y el
 * super, y el cuerpo a cuerpo no lanzaba nunca —"Lanzar es trabajo de las
 * especiales y del super", quedó dicho en `stepMatch`—, así que 9,5 sólo
 * tenía que mandar a alguien lejos de vez en cuando, con toda la pelea
 * empujando en la misma ráfaga.
 *
 * Con `PODERES_ACTIVOS` en falso, el cuerpo a cuerpo pasó a ser la ÚNICA
 * fuente de empuje, y ahí 9,5 se quedaba corto: en un 1 contra 1 real —el
 * modo por defecto en su recta final— con daño subiendo parejo de los dos
 * lados, medido en `y` mínimo alcanzado en 30 s de pelea sostenida, nadie
 * llegaba ni cerca del borde del escenario (`y` no bajaba de -0,34, contra
 * los -11 de `BLAST.minY`) por más que el daño acumulado pasara del 700%: el
 * salto extra y el aterrizaje rápido recuperaban antes de que el empuje
 * alcanzara a sacar a nadie. Con 16 el mismo 1 contra 1 sí termina en un KO
 * dentro de un minuto y medio, y el torneo vuelve a poder decidir un match.
 */
export const MAX_KNOCKBACK = 16;
/** Daño que suma un empujón, escalado por el peso del que pega. */
export const HIT_DAMAGE = 6;
/**
 * Puño y patada alternan (`lastBlow`) pero pegaban exactamente igual: mismo
 * daño, mismo empuje, sólo cambiaba el dibujo. La patada pega más fuerte y
 * más lejos —tiene más recorrido, es el golpe "grande" del combo de dos—; el
 * puño es el rápido y barato. El promedio de los dos se mantiene igual a
 * `HIT_DAMAGE` para no correr el ritmo de daño acumulado que ya está ajustado
 * contra el resto de la pelea.
 */
export const PUNCH_DAMAGE_MULT = 0.8;
export const KICK_DAMAGE_MULT = 1.2;
/**
 * Cada cuánto puede entrar un golpe cuerpo a cuerpo, en segundos de SIMULACIÓN.
 *
 * Bajó de 0,35 a 0,25 al entrar `RITMO`. La pelea corre a 0,72 de velocidad para
 * que se vean los cuadros de la animación, y eso estira también la cadencia:
 * 0,35 de simulación son 0,49 de reloj de pared, casi medio segundo entre golpe
 * y golpe. Se veía cada movimiento y no se veía una pelea. `0,35 × 0,72 = 0,25`
 * devuelve la cadencia original —un golpe cada 0,35 s de reloj— con las
 * animaciones a la velocidad en que se leen. Si alguna vez `RITMO` vuelve a 1,
 * esto vuelve a 0,35.
 */
export const HIT_COOLDOWN = 0.25;

/**
 * Los combos: cadenas fijas de golpe(0)/patada(1) que reemplazan la pura
 * alternancia de `lastBlow`. No usan ningún dibujo nuevo —el golpe 0 sigue
 * siendo `attack_punch` y el 1 `attack_kick`— lo que cambia es el ORDEN, y que
 * el último golpe de la cadena pega con `COMBO_FINISHER_MULT` de más. Es lo
 * que hace que una racha se sienta como una racha (jab-jab-cruzado) y no como
 * una moneda alternando en cada contacto.
 */
export const COMBO_CHAINS: readonly (readonly number[])[] = [
  [0, 0, 1], // dos jabs y una patada de cierre
  [1, 1, 0], // dos patadas y un puño que corta
  [0, 1, 1], // jab de entrada y patada doble
];
/**
 * Cuánto pega de más el último golpe de una cadena. El cuerpo a cuerpo SÍ
 * lanza (ver `stepMatch`, el bloque "empujones": `knockback` + `stunFor`,
 * escalados por el daño acumulado), así que el finisher ya sale más fuerte y
 * aturde más por esa misma cuenta — no hace falta un número aparte para eso.
 */
export const COMBO_FINISHER_MULT = 1.4;
/**
 * Si pasó más que esto desde el último golpe CONECTADO, la cadena se cortó: el
 * próximo golpe arranca una nueva desde el paso 0 (rotando cuál, para no
 * repetir siempre la misma). Tres veces `HIT_COOLDOWN` porque dos golpes
 * seguidos en un forcejeo activo siempre entran dentro de la ventana; lo que
 * la corta es dejar de pegar, no la cadencia normal del cuerpo a cuerpo.
 */
export const COMBO_WINDOW = HIT_COOLDOWN * 3;

/**
 * La regla que hace que una pelea escale: el empujón crece con el daño que ya
 * acumuló el que lo recibe, y baja con su peso. Al principio nadie se mueve de
 * la plataforma y a los 200% cualquier roce es un KO. Sin esto la pelea es
 * plana: o todos salen volando al primer toque, o no sale nadie nunca.
 */
export function knockback(damage: number, weight: number, attackerWeight: number): number {
  const raw = (BASE_KNOCKBACK + damage * DAMAGE_SCALE * BASE_KNOCKBACK) * attackerWeight;
  return Math.min(MAX_KNOCKBACK, raw / Math.max(0.35, weight));
}

/**
 * Cuánto dura el aturdimiento, en segundos, según la fuerza del empujón.
 *
 * **Era fijo.** Todos los golpes dejaban al rival tildado exactamente 0,34 s,
 * desde el roce del forcejeo hasta el super, y eso es la mitad de por qué la
 * pelea se sentía plana: si el golpe grande y el chico se ven durar lo mismo, no
 * hay golpe grande.
 *
 * La forma sale del documento de arquitectura de fighting games —Brawlhalla lo
 * calcula como `BaseStun + Knockback × 0,055` en cuadros a 60 Hz— pero los
 * números son propios, porque acá el empuje es una velocidad en unidades por
 * segundo y no la escala de ellos. Con el tope de empuje de 9,5 el aturdimiento
 * llega a 0,55 s, casi el doble del que había; un roce queda en 0,12.
 */
export function stunFor(knockback: number): number {
  return Math.min(STUN_MAX, STUN_BASE + Math.max(0, knockback) * STUN_POR_EMPUJE);
}

/** Lo que dura el aturdimiento de un roce, y lo que suma cada unidad de empuje. */
export const STUN_BASE = 0.12;
export const STUN_POR_EMPUJE = 0.045;
export const STUN_MAX = 0.6;

/**
 * Daño de un empujón. Un peso pesado lastima más, y la patada (`esPatada`)
 * más que el puño — ver `PUNCH_DAMAGE_MULT`/`KICK_DAMAGE_MULT`.
 */
export function hitDamage(attackerWeight: number, esPatada: boolean): number {
  const mult = esPatada ? KICK_DAMAGE_MULT : PUNCH_DAMAGE_MULT;
  return HIT_DAMAGE * mult * attackerWeight;
}

/* ------------------------------------------------------------------ */
/* Equipo                                                              */
/* ------------------------------------------------------------------ */

/**
 * Ímpetu del equipo: cuánto del volumen agresor reciente le pertenece. 0,5 es
 * empate. Se usa para acelerar al equipo que está ganando el flujo, que es la
 * forma de que la pelea cuente lo que pasa en el mercado en vez de ser ruido.
 */
export function teamMomentum(buyVolume: number, sellVolume: number, team: number): number {
  const total = buyVolume + sellVolume;
  if (total <= 0) return 0.5;
  const buyShare = buyVolume / total;
  return team === TEAM_GREEN ? buyShare : 1 - buyShare;
}

/** De ímpetu a multiplicador de empuje. Acotado: nunca deja a un equipo quieto. */
export function momentumBoost(momentum: number): number {
  return 0.75 + momentum * 0.7;
}

/* ------------------------------------------------------------------ */
/* Blast zones                                                         */
/* ------------------------------------------------------------------ */

export interface BlastZone {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function isKO(zone: BlastZone, x: number, y: number): boolean {
  return x < zone.minX || x > zone.maxX || y < zone.minY || y > zone.maxY;
}

/* ------------------------------------------------------------------ */
/* El super                                                            */
/* ------------------------------------------------------------------ */

/**
 * Hasta el pivot de 2026-08-23 (ver CLAUDE.md) el super salía del gigantismo:
 * cuando la liquidez de un lado del libro pasaba de un umbral, ese equipo
 * hacía crecer a uno de los suyos en tres pasos y al llegar arriba lo
 * descargaba. Ahora sale directo de la barra personal —la misma que paga las
 * especiales— al llegar a `COST_SUPER`, sin turnos de equipo ni escalado
 * visual: se dispara, y punto.
 */

/** Alcance y potencia del super. */
export const SUPER_RADIUS = 3.4;
export const SUPER_FORCE = 15;
export const SUPER_DAMAGE = 34;

/** Cae con la distancia, pero nunca a cero dentro del radio: es un super. */
export function superForce(distance: number): number {
  const t = Math.max(0, 1 - distance / SUPER_RADIUS);
  return SUPER_FORCE * (0.45 + 0.55 * t);
}

/* ------------------------------------------------------------------ */
/* La barra de fuerza                                                  */
/* ------------------------------------------------------------------ */

/**
 * Cada peleador tiene UNA barra, cargada por las órdenes agresoras de su
 * lado. Desde el pivot de 2026-08-23 (ver CLAUDE.md) es lo ÚNICO que el
 * mercado decide en la pelea: la gastan la especial y el super, nunca el
 * cuerpo a cuerpo.
 *
 * Antes esta barra también pagaba el puño y la patada, y antes de eso ni
 * siquiera existía: el cuerpo a cuerpo pegaba en cada contacto que pasara el
 * cooldown y las especiales salían de un temporizador aleatorio de 8 a 12
 * segundos, sin mirar el mercado para nada. El cuerpo a cuerpo ya volvió a
 * ser incondicional —es el forcejeo constante de la pelea, no el evento—, y
 * lo que la barra dice ahora es más preciso: un especial o un super que se
 * ve **es** el mercado pagándolo, punto.
 *
 * **El precio a pagar, y es real**: con el libro muerto no hay especiales ni
 * super, sólo cuerpo a cuerpo. Un visualizador que inventa esos golpes
 * grandes cuando no hay datos estaría mintiendo, así que la pantalla se
 * queda sin ellos en un mercado sin volumen — el forcejeo sigue sosteniendo
 * la escena en ese caso.
 */

/** Especial. Sale cara para que se vea venir. */
export const COST_SKILL = 0.45;
/**
 * Super. No es un precio fijo sino un MÍNIMO: el super gasta la barra entera y
 * su potencia sale de cuánto había. Puesto como mínimo y no como barra llena
 * para que un mercado flojo no deje al gigante congelado esperando para siempre.
 */
export const COST_SUPER = 0.6;

/**
 * Cuánto carga un trade del tamaño de la mediana. Con 0,14 hacen falta unos
 * siete trades medianos para llenar una barra, que a razón de mercado normal
 * —repartiendo por turno entre los tres del bando— da una descarga cada ocho a
 * catorce segundos por peleador.
 */
const CHARGE_PER_MEDIAN = 0.14;
/**
 * Techo de lo que puede aportar UN trade, en múltiplos de la mediana.
 *
 * Está justo abajo del umbral de ballena —`size > mediana * 8`— para que una
 * ballena llene casi una barra de un saque y se vea el golpe salir de ella. Sin
 * techo, un solo trade monstruoso cargaría a un peleador para diez descargas y
 * la barra dejaría de decir nada.
 */
const CHARGE_CAP = 7;

/**
 * Lo que suma a la barra un trade agresor.
 *
 * Se normaliza por la mediana móvil —la misma que decide quién es ballena— y no
 * por un tamaño absoluto, porque un trade "grande" en BTC no se parece a uno
 * grande en un par chico, y la escena tiene que leerse igual en los dos.
 */
export function chargeFromTrade(size: number, median: number): number {
  // Sin mediana todavía —los primeros veinte trades— no hay con qué comparar, y
  // suponer que todos son medianos es la suposición neutra.
  if (!(median > 0)) return CHARGE_PER_MEDIAN;
  const ratio = Math.min(size / median, CHARGE_CAP);
  return ratio * CHARGE_PER_MEDIAN;
}

/** La barra no pasa de llena: una barra que se desborda deja de leerse. */
export function addCharge(energy: number, delta: number): number {
  const next = energy + delta;
  return next > 1 ? 1 : next < 0 ? 0 : next;
}

/**
 * Alcance de la especial según lo cargado que esté el que la tira.
 *
 * Que el radio crezca con la carga es lo que hace que valga la pena esperar: una
 * especial al mínimo apenas llega al que tiene enfrente, una con la barra llena
 * barre a los tres.
 */
export function skillRadius(energy: number): number {
  return 1.4 + clamp01(energy) * 1.9;
}

/** Daño de una especial según lo que se gastó en ella. */
export function skillDamage(spent: number): number {
  return 6 + clamp01(spent) * 22;
}

/**
 * Multiplicador de empujón de una especial. Al precio mínimo pega menos que el
 * knockback normal, con la barra llena pega la mitad más.
 */
export function skillForce(spent: number): number {
  return 0.5 + clamp01(spent);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/* ------------------------------------------------------------------ */
/* Estado del combate para el HUD                                      */
/* ------------------------------------------------------------------ */

/**
 * Objeto mutable creado una vez, escrito por el pool y muestreado por el HUD a
 * baja frecuencia. Mismo patrón que `stageFocus`: el productor no sabe que
 * existe React.
 */
export interface MatchState {
  /** Daño promedio de los vivos, por equipo. */
  damage: Float32Array;
  stocks: Uint8Array;
  alive: Uint8Array;
  kos: Uint32Array;
  /** Cuántos peleadores le quedan al bando: los puntitos del marcador. */
  plantel: Uint8Array;
  /** Quién ganó el match, o -1 mientras se pelea. */
  ganador: number;
  /** Si se está jugando el torneo 1v1. Lo lee el HUD para no mentir. */
  torneo: boolean;
}

export function createMatchState(): MatchState {
  return {
    damage: new Float32Array(2),
    stocks: new Uint8Array(2),
    alive: new Uint8Array(2),
    kos: new Uint32Array(2),
    plantel: new Uint8Array(2),
    ganador: -1,
    torneo: false,
  };
}
