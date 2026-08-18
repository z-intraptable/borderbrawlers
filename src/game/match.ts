import type { FeedStats, TradeRingBuffer } from '../net/feedCore';
import type { MatchState, Skyline } from './fighters';
import {
  COST_MELEE,
  COST_SKILL,
  COST_SUPER,
  HIT_COOLDOWN,
  SLOT_ACTIVE,
  SLOT_FREE,
  SUPER_DAMAGE,
  SUPER_RADIUS,
  TEAM_GREEN,
  TEAM_RED,
  addCharge,
  bookShare,
  chargeFromTrade,
  createMatchState,
  createSkyline,
  growthScale,
  hasGroundAhead,
  hitDamage,
  isKO,
  knockback,
  momentumBoost,
  pickTarget,
  separation,
  shouldBrakeAtLedge,
  skillDamage,
  skillForce,
  skillRadius,
  superForce,
  ULTRA_HOLD,
  ultraGain,
  ultraStage,
  teamMomentum,
  wantsJump,
  weightFor,
} from './fighters';
import type { MoveResult } from './physics';
import { createMoveResult, step as physicsStep } from './physics';

/**
 * La pelea entera, sin una sola línea de dibujo.
 *
 * Este módulo no sabe que existe Pixi. Mantiene el estado de los seis
 * peleadores en arrays tipados y lo avanza con un paso de tiempo fijo; la capa
 * de render lo lee y lo dibuja. Es la separación que faltaba en la versión de
 * three.js, donde el pool mezclaba decisiones de juego con llamadas de física y
 * no se podía probar nada sin un browser.
 *
 * **En la pelea no queda ninguna decisión al azar.** Había un mulberry32 con
 * semilla fija acá, y su único consumidor era el reloj que sacaba una especial
 * cada 8 a 12 segundos. Al pasar los golpes a la barra de fuerza —que cargan las
 * órdenes— ese reloj sobró, y con él la última fuente de azar: hoy todo lo que
 * pasa en pantalla se puede seguir hasta un trade o una cifra del libro. El
 * replay determinista del VPS, que era la razón de tener el PRNG, sale ahora de
 * que no hay nada que sembrar.
 */

export const FIGHTERS_PER_TEAM = 3;
export const CAPACITY = FIGHTERS_PER_TEAM * 2;
export const STOCKS = 3;

/* --- geometría del escenario ---------------------------------------- */

export const STAGE_HALF_WIDTH = 9;
export const CENTER_HALF_WIDTH = 2.4;
export const PLATFORMS_PER_SIDE = 4;
export const PLATFORM_COUNT = PLATFORMS_PER_SIDE * 2 + 1;

const SIDE_INNER = 3.1;
const SIDE_SLOT = (STAGE_HALF_WIDTH - SIDE_INNER) / PLATFORMS_PER_SIDE;
/** El hueco entre losas es deliberado: sin pozos no hay nada que saltar. */
const SIDE_HALF_WIDTH = SIDE_SLOT / 2 - 0.25;

export const PLATFORM_MIN_Y = 0.6;
export const PLATFORM_MAX_Y = 6.5;
/** Tope de velocidad de una plataforma. Ver `SNAP_UP` en physics.ts. */
const PLATFORM_MAX_SPEED = 2.2;
const PLATFORM_LAMBDA = 2.5;

export function platformCenterX(index: number): number {
  if (index === 0) return 0;
  const side = index <= PLATFORMS_PER_SIDE ? -1 : 1;
  const slot = (index - 1) % PLATFORMS_PER_SIDE;
  return side * (SIDE_INNER + SIDE_SLOT * slot + SIDE_SLOT / 2);
}

export function platformHalfWidth(index: number): number {
  return index === 0 ? CENTER_HALF_WIDTH : SIDE_HALF_WIDTH;
}

/* --- personaje ------------------------------------------------------ */

export const FIGHTER_HALF_WIDTH = 0.3;
export const FIGHTER_HALF_HEIGHT = 0.52;

const RUN_SPEED = 3.6;
const JUMP_SPEED = 11;
const MAX_JUMPS = 2;
const AIR_CONTROL = 0.12;
const LOOKAHEAD = 0.7;
/** Cuánto queda sin control tras recibir un lanzamiento. */
export const HITSTUN = 0.34;
/**
 * El cuerpo a cuerpo aturde mucho menos: si aturdiera como una especial, dos
 * peleadores en contacto se paralizarían mutuamente y no pasaría nada más.
 */
const MELEE_STUN = 0.12;
/** Separación del cuerpo a cuerpo. Alcanza para no solaparse, no para lanzar. */
const MELEE_NUDGE = 1.6;
const CONTACT = 0.85;
/**
 * Distancia de guardia. Apenas menor que `CONTACT` para que el cuerpo a cuerpo
 * siga saltando: si fuera mayor se quedarían mirándose sin llegar a pegarse.
 */
const ENGAGE_RANGE = 0.78;
/** Cuánto manda la separación cuando ya no hay que cerrar distancia. */
const SPACING_GAIN = 0.55;
/** Polvo mínimo de un aterrizaje, y a qué velocidad de caída se satura. */
const LANDING_SOFT = 0.35;
const LANDING_FULL = 18;
const SPAWN_Y = 8;
const SPAWN_X = 5.5;
const MAX_SPAWNS_PER_STEP = 4;
/**
 * Techo de trades leídos por paso. Es más alto que el de altas porque cargar es
 * mucho más barato que dar de alta, y porque un trade que no carga a nadie es un
 * dato del libro que se perdió. A 60 Hz son 1440 por segundo, muy por encima de
 * cualquier ráfaga real.
 */
const MAX_TRADES_PER_STEP = 24;

const BLAST = { minX: -15, maxX: 15, minY: -11, maxY: 26 };



/* --- eventos para la capa de render ---------------------------------- */

export const EVENT_HIT = 0;
export const EVENT_KO = 1;
export const EVENT_SUPER = 2;
export const EVENT_LAND = 3;
export const EVENT_GROW = 4;
export const EVENT_SKILL = 5;
export const EVENT_MELEE = 6;

/**
 * Cola de eventos del paso. La capa de render la drena y la vacía: es cómo la
 * simulación pide chispas y sacudones sin conocer al que los dibuja.
 */
export interface EventQueue {
  count: number;
  kind: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  magnitude: Float32Array;
  team: Uint8Array;
  /**
   * A qué peleador le pasó, o -1 si el evento no es de nadie en particular.
   *
   * Sin esto la capa de render sabe que alguien tiró una patada y dónde, pero no
   * a quién animar. Es el dato que convierte la cola en el disparador de las
   * animaciones y no sólo de las chispas.
   */
  slot: Int8Array;
}

const EVENT_CAP = 64;

function createEventQueue(): EventQueue {
  return {
    count: 0,
    kind: new Uint8Array(EVENT_CAP),
    x: new Float32Array(EVENT_CAP),
    y: new Float32Array(EVENT_CAP),
    magnitude: new Float32Array(EVENT_CAP),
    team: new Uint8Array(EVENT_CAP),
    slot: new Int8Array(EVENT_CAP),
  };
}

function emit(
  q: EventQueue, kind: number, x: number, y: number,
  magnitude: number, team: number, slot: number,
): void {
  if (q.count >= EVENT_CAP) return;
  const i = q.count++;
  q.kind[i] = kind;
  q.x[i] = x;
  q.y[i] = y;
  q.magnitude[i] = magnitude;
  q.team[i] = team;
  q.slot[i] = slot;
}

/* --- estado ---------------------------------------------------------- */

export interface Match {
  skyline: Skyline;
  state: MatchState;
  events: EventQueue;

  /** Altura objetivo y actual de cada plataforma. */
  targetY: Float64Array;

  slot: Uint8Array;
  team: Uint8Array;
  /**
   * Índice del personaje de la plantilla que le tocó a este slot. Lo fija
   * `createMatch` una sola vez y no cambia más: sin relevos, el que se cae del
   * escenario reaparece él mismo acá.
   *
   * Sigue siendo un array por slot y no una constante a propósito, para que
   * volver a agrandar la plantilla sea sumar entradas en `roster.ts` y devolverle
   * a `activate` el reparto por ronda, sin tocar el resto de la simulación.
   */
  character: Uint8Array;
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  facing: Int8Array;
  grounded: Uint8Array;
  damage: Float32Array;
  weight: Float32Array;
  stocks: Uint8Array;
  jumps: Uint8Array;
  lastJump: Float32Array;
  lastHit: Float32Array;
  hitstun: Float32Array;
  whale: Uint8Array;
  stage: Uint8Array;
  scale: Float32Array;
  claims: Uint8Array;
  /**
   * La barra de fuerza, de 0 a 1. La cargan las órdenes agresoras del bando y la
   * gastan TODOS los golpes: puño, patada, especial y super.
   *
   * Reemplazó a `nextSkill`, que era el reloj que sacaba una especial cada 8 a
   * 12 segundos sin mirar el mercado. Ver el bloque "La barra de fuerza" en
   * `fighters.ts` para por qué, y para qué se pierde a cambio.
   */
  energy: Float32Array;
  /** Cuál usó la última vez: se alternan. */
  lastSkill: Uint8Array;
  /** Golpe o patada: también se alternan, contacto a contacto. */
  lastBlow: Uint8Array;

  /**
   * A quién le toca cobrar el próximo trade de cada bando.
   *
   * El reparto es por turno y no en partes iguales a propósito: cargando a los
   * tres a la vez las tres barras se llenan juntas y descargan juntas, que se ve
   * como un pulso y no como una pelea. Por turno se escalonan solas, y además
   * cada orden que entra va visiblemente a UN peleador.
   */
  chargeCursor: Int8Array;

  /**
   * La barra de ultra de cada equipo, de 0 a 1. La cargan las mismas órdenes que
   * las personales, moduladas por la cuota del libro. Al llenarse le da el super
   * al peleador al que le toca, y el turno pasa al siguiente.
   */
  ultra: Float32Array;
  /** A qué carril del bando le toca el próximo ultra: 0, 1, 2 y vuelve. */
  ultraTurn: Uint8Array;

  /** Quién está creciendo por equipo, -1 si nadie. */
  growing: Int8Array;
  clock: number;
  /** Sacudón de cámara, decae solo. */
  shake: number;
}

export function createMatch(): Match {
  const m: Match = {
    skyline: createSkyline(PLATFORM_COUNT),
    state: createMatchState(),
    events: createEventQueue(),
    targetY: new Float64Array(PLATFORM_COUNT).fill(PLATFORM_MIN_Y),
    slot: new Uint8Array(CAPACITY),
    team: new Uint8Array(CAPACITY),
    character: new Uint8Array(CAPACITY),
    x: new Float64Array(CAPACITY),
    y: new Float64Array(CAPACITY),
    vx: new Float64Array(CAPACITY),
    vy: new Float64Array(CAPACITY),
    facing: new Int8Array(CAPACITY).fill(1),
    grounded: new Uint8Array(CAPACITY),
    damage: new Float32Array(CAPACITY),
    weight: new Float32Array(CAPACITY),
    stocks: new Uint8Array(CAPACITY),
    jumps: new Uint8Array(CAPACITY),
    lastJump: new Float32Array(CAPACITY),
    lastHit: new Float32Array(CAPACITY),
    hitstun: new Float32Array(CAPACITY),
    whale: new Uint8Array(CAPACITY),
    stage: new Uint8Array(CAPACITY),
    scale: new Float32Array(CAPACITY).fill(1),
    claims: new Uint8Array(CAPACITY),
    energy: new Float32Array(CAPACITY),
    lastSkill: new Uint8Array(CAPACITY),
    lastBlow: new Uint8Array(CAPACITY),
    chargeCursor: new Int8Array(2),
    ultra: new Float32Array(2),
    ultraTurn: new Uint8Array(2),
    growing: Int8Array.from([-1, -1]),
    clock: 0,
    shake: 0,
  };

  // Ni el bando ni el personaje de un slot cambian nunca: se resuelven una sola
  // vez acá y valen para toda la sesión. Pelean siempre los mismos seis, y el
  // que se cae del escenario reaparece él mismo en su slot.
  for (let i = 0; i < CAPACITY; i++) {
    m.team[i] = i < FIGHTERS_PER_TEAM ? TEAM_GREEN : TEAM_RED;
    m.character[i] = i % FIGHTERS_PER_TEAM;
  }

  // Los rangos en x de las plataformas son fijos: sólo se mueve la altura.
  for (let i = 0; i < PLATFORM_COUNT; i++) {
    const cx = platformCenterX(i);
    const half = platformHalfWidth(i);
    m.skyline.minX[i] = cx - half;
    m.skyline.maxX[i] = cx + half;
    m.skyline.topY[i] = i === 0 ? 0 : PLATFORM_MIN_Y;
  }
  m.targetY[0] = 0;
  return m;
}

const move: MoveResult = createMoveResult();

export function updateStageFromBook(
  m: Match,
  bidQtys: Float64Array,
  bidCount: number,
  askQtys: Float64Array,
  askCount: number,
  qtyMedian: number,
): void {
  const reference = qtyMedian > 0 ? qtyMedian : 1;
  for (let i = 1; i < PLATFORM_COUNT; i++) m.targetY[i] = PLATFORM_MIN_Y;

  // Los 20 niveles de cada lado se reparten entre sus 4 plataformas.
  const perPlatform = Math.ceil(bidCount / PLATFORMS_PER_SIDE) || 1;
  for (let level = 0; level < bidCount; level++) {
    const slot = Math.min(PLATFORMS_PER_SIDE - 1, Math.floor(level / perPlatform));
    const height = Math.log1p(bidQtys[level] / reference) * 2.2;
    const index = 1 + slot;
    if (height > m.targetY[index]) m.targetY[index] = height;
  }
  const perAsk = Math.ceil(askCount / PLATFORMS_PER_SIDE) || 1;
  for (let level = 0; level < askCount; level++) {
    const slot = Math.min(PLATFORMS_PER_SIDE - 1, Math.floor(level / perAsk));
    const height = Math.log1p(askQtys[level] / reference) * 2.2;
    const index = 1 + PLATFORMS_PER_SIDE + slot;
    if (height > m.targetY[index]) m.targetY[index] = height;
  }

  for (let i = 1; i < PLATFORM_COUNT; i++) {
    if (m.targetY[i] < PLATFORM_MIN_Y) m.targetY[i] = PLATFORM_MIN_Y;
    if (m.targetY[i] > PLATFORM_MAX_Y) m.targetY[i] = PLATFORM_MAX_Y;
  }
}

function damp(current: number, goal: number, lambda: number, dt: number): number {
  return goal + (current - goal) * Math.exp(-lambda * dt);
}

/** Avanza un paso fijo de la simulación. */
export function stepMatch(
  m: Match,
  trades: TradeRingBuffer,
  stats: FeedStats,
  dt: number,
): void {
  m.clock += dt;
  const now = m.clock;
  m.events.count = 0;
  m.shake *= 0.9;
  if (m.shake < 0.001) m.shake = 0;

  /* --- plataformas ------------------------------------------------- */
  for (let i = 1; i < PLATFORM_COUNT; i++) {
    const next = damp(m.skyline.topY[i], m.targetY[i], PLATFORM_LAMBDA, dt);
    const limit = PLATFORM_MAX_SPEED * dt;
    const delta = Math.max(-limit, Math.min(limit, next - m.skyline.topY[i]));
    m.skyline.topY[i] += delta;
  }

  const greenBoost = momentumBoost(teamMomentum(stats.buyVolume, stats.sellVolume, TEAM_GREEN));
  const redBoost = momentumBoost(teamMomentum(stats.buyVolume, stats.sellVolume, TEAM_RED));

  /* --- decidir y mover ---------------------------------------------- */
  m.claims.fill(0);
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;

    const inHitstun = now - m.hitstun[i] < HITSTUN;
    if (!inHitstun) {
      const target = pickTarget(CAPACITY, m.slot, m.team, m.x, m.y, m.claims, i);
      if (target >= 0) m.claims[target]++;
      const dx = target >= 0 ? m.x[target] - m.x[i] : -m.x[i];
      const dy = target >= 0 ? m.y[target] - m.y[i] : 0;
      const dir = dx >= 0 ? 1 : -1;
      const grounded = m.grounded[i] === 1;

      const groundAhead = hasGroundAhead(m.skyline, m.x[i], dir, LOOKAHEAD);
      const brake = shouldBrakeAtLedge(groundAhead, dx, dir);
      const spread = separation(CAPACITY, m.slot, m.team, m.x, m.y, i);
      const boost = m.team[i] === TEAM_GREEN ? greenBoost : redBoost;

      // Distancia de combate: adentro del alcance del golpe se deja de cerrar y
      // se pelea ahí. Sin esto cada uno camina HACIA ADENTRO del rival, el
      // cuerpo a cuerpo los separa 1,6 u/s y ellos vuelven a entrar a 3,6 — el
      // resultado era los seis apilados en el mismo punto del escenario. Con
      // una distancia de guardia, el que ya llegó cede el paso al compañero y
      // la pelea se reparte a lo ancho.
      const closing = Math.abs(dx) > ENGAGE_RANGE;
      const desired = brake ? 0
        : closing ? (dir + spread * 0.5) * RUN_SPEED * boost
          : spread * RUN_SPEED * SPACING_GAIN;

      m.vx[i] = grounded ? desired : m.vx[i] + (desired - m.vx[i]) * AIR_CONTROL;
      if (Math.abs(m.vx[i]) > 0.4) m.facing[i] = m.vx[i] >= 0 ? 1 : -1;

      const jump = wantsJump({ grounded, dy, dx, groundAhead, sinceJump: now - m.lastJump[i] });
      // Recuperación: cayéndose por debajo del escenario gasta el salto extra.
      // Sin esto el primer empujón es siempre KO y no hay pelea.
      const recover = !grounded && m.vy[i] < 0 && m.y[i] < 0 && m.jumps[i] > 0
        && now - m.lastJump[i] > 0.25;
      if ((jump || recover) && m.jumps[i] > 0) {
        m.vy[i] = JUMP_SPEED;
        m.jumps[i]--;
        m.lastJump[i] = now;
        m.grounded[i] = 0;
      }
    }

    // La velocidad de caída ANTES de resolver el contacto: después del paso ya
    // es cero y no queda forma de saber si el aterrizaje fue un saltito o una
    // caída desde arriba de todo. Es lo que gradúa el polvo.
    const fallSpeed = m.vy[i] < 0 ? -m.vy[i] : 0;

    physicsStep(
      m.skyline, m.x[i], m.y[i], m.vx[i], m.vy[i],
      FIGHTER_HALF_WIDTH * m.scale[i], FIGHTER_HALF_HEIGHT * m.scale[i],
      m.grounded[i] === 1, dt, move,
    );
    m.x[i] = move.x;
    m.y[i] = move.y;
    m.vx[i] = move.vx;
    m.vy[i] = move.vy;
    m.grounded[i] = move.grounded ? 1 : 0;
    if (move.grounded) m.jumps[i] = MAX_JUMPS;
    if (move.landed) {
      emit(m.events, EVENT_LAND, m.x[i], m.y[i],
        LANDING_SOFT + fallSpeed / LANDING_FULL, m.team[i], i);
    }
  }

  /* --- especiales: se pagan con la barra ------------------------------- */
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    if (m.energy[i] < COST_SKILL) continue;
    if (now - m.hitstun[i] < HITSTUN) continue;
    // El elegido para el ultra se PLANTA cuando la barra del equipo pasa de
    // `ULTRA_HOLD`: deja de gastar y junta para el super. Sin esto la especial
    // le baja la barra a cero y cuando le toca el ultra no puede pagarlo.
    //
    // Se planta recién ahí y no desde el principio del ciclo a propósito: entre
    // ultra y ultra pasa medio minuto largo, y un peleador que se lo pasa entero
    // sin atacar es un peleador de menos en la pelea. El momento en que se
    // planta es además el momento en que se lo ve crecer, así que se lee.
    if (m.growing[m.team[i]] === i && m.ultra[m.team[i]] >= ULTRA_HOLD) continue;

    // La especial gasta la barra ENTERA, no su precio. Es lo que hace que
    // esperar valga la pena: dos especiales al mínimo hacen menos que una con la
    // barra llena, así que el que aguanta pega más fuerte. Gastando sólo el
    // precio, la barra se drenaría de a 0,45 y todas las especiales saldrían
    // iguales — que es el goteo que este sistema vino a sacar.
    const spent = m.energy[i];
    m.energy[i] = 0;
    const radius = skillRadius(spent);

    m.lastSkill[i] = m.lastSkill[i] === 0 ? 1 : 0;
    emit(m.events, EVENT_SKILL, m.x[i], m.y[i], m.lastSkill[i], m.team[i], i);
    m.shake = Math.max(m.shake, 0.2 + spent * 0.5);

    for (let j = 0; j < CAPACITY; j++) {
      if (j === i || m.slot[j] !== SLOT_ACTIVE || m.team[j] === m.team[i]) continue;
      const dx = m.x[j] - m.x[i];
      const dy = m.y[j] - m.y[i];
      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;
      const nx = distance > 1e-6 ? dx / distance : 1;
      const ny = distance > 1e-6 ? dy / distance : 0;
      const falloff = 0.55 + 0.45 * (1 - distance / radius);
      // Acá sí entra el knockback por daño acumulado: cuanto más viene
      // recibiendo el rival, más lejos lo manda esta misma habilidad. Es lo que
      // hace que la pelea escale en vez de ser plana. `skillForce` le suma la
      // otra escala, la de cuánta orden había atrás del golpe.
      const force = knockback(m.damage[j], m.weight[j], m.weight[i])
        * falloff * skillForce(spent);
      m.vx[j] = nx * force * 1.15;
      m.vy[j] = ny * force * 0.3 + force * 0.5;
      m.grounded[j] = 0;
      m.damage[j] += skillDamage(spent);
      m.hitstun[j] = now;
      m.lastHit[j] = now;
      emit(m.events, EVENT_HIT, m.x[j], m.y[j], 0.8 + spent * 0.9, m.team[j], j);
    }
  }

  /* --- empujones ----------------------------------------------------- */
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    for (let j = i + 1; j < CAPACITY; j++) {
      if (m.slot[j] !== SLOT_ACTIVE || m.team[j] === m.team[i]) continue;
      const dx = m.x[j] - m.x[i];
      const dy = m.y[j] - m.y[i];
      const distance = Math.hypot(dx, dy);
      if (distance > CONTACT) continue;
      if (now - m.lastHit[i] < HIT_COOLDOWN || now - m.lastHit[j] < HIT_COOLDOWN) continue;

      const nx = distance > 1e-6 ? dx / distance : 1;

      // El cuerpo a cuerpo NO lanza: acumula daño y separa apenas. Lanzar es
      // trabajo de las especiales y del super. Es la regla de Smash, y es lo
      // que hace que el daño acumulado signifique algo: sin ella, cada roce
      // manda a volar y no hay nada que construir.
      //
      // El FORCEJEO —separarse— es gratis y pasa siempre: dos cuerpos no pueden
      // ocupar el mismo lugar, y empujar no es pegar. Es además lo único que
      // queda pasando cuando el libro está muerto y nadie tiene con qué golpear.
      m.vx[j] += nx * MELEE_NUDGE;
      m.vx[i] -= nx * MELEE_NUDGE;
      m.lastHit[i] = now; m.lastHit[j] = now;

      // El GOLPE, en cambio, se paga, y cada uno por su cuenta. Antes el
      // contacto disparaba un intercambio automático: los dos se pegaban
      // siempre, hubiera pasado lo que hubiera pasado en el mercado. Ahora un
      // peleador cargado le pega a uno vacío y el vacío sólo se lo come, porque
      // el que no tiene órdenes atrás no tiene con qué pegar.
      const golpeaI = m.energy[i] >= COST_MELEE && !guardando(m, i);
      const golpeaJ = m.energy[j] >= COST_MELEE && !guardando(m, j);
      if (!golpeaI && !golpeaJ) continue;

      // Cada uno tira su golpe, alternando puño y patada. El que recibe queda
      // en hurt, que lo resuelve la capa de render con el hitstun que ya existe.
      if (golpeaI) {
        m.energy[i] -= COST_MELEE;
        m.damage[j] += hitDamage(m.weight[i]);
        m.hitstun[j] = now - HITSTUN + MELEE_STUN;
        m.lastBlow[i] = m.lastBlow[i] === 0 ? 1 : 0;
        emit(m.events, EVENT_MELEE, m.x[i], m.y[i], m.lastBlow[i], m.team[i], i);
      }
      if (golpeaJ) {
        m.energy[j] -= COST_MELEE;
        m.damage[i] += hitDamage(m.weight[j]);
        m.hitstun[i] = now - HITSTUN + MELEE_STUN;
        m.lastBlow[j] = m.lastBlow[j] === 0 ? 1 : 0;
        emit(m.events, EVENT_MELEE, m.x[j], m.y[j], m.lastBlow[j], m.team[j], j);
      }

      const heavy = m.whale[i] === 1 || m.whale[j] === 1;
      emit(m.events, EVENT_HIT, m.x[i] + dx / 2, m.y[i] + dy / 2, heavy ? 1.6 : 1, m.team[i], -1);
      m.shake = Math.max(m.shake, heavy ? 1 : 0.45);
    }
  }

  /* --- KO ------------------------------------------------------------ */
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    if (!isKO(BLAST, m.x[i], m.y[i])) continue;
    emit(m.events, EVENT_KO,
      Math.max(-10, Math.min(10, m.x[i])),
      Math.max(-5, Math.min(12, m.y[i])), 1, m.team[i], i);
    m.state.kos[m.team[i] === TEAM_GREEN ? TEAM_RED : TEAM_GREEN]++;
    if (m.stocks[i] > 0) m.stocks[i]--;
    m.slot[i] = SLOT_FREE;
    m.shake = 1;
  }

  /* --- el ultra: la barra del equipo ---------------------------------- */
  for (let team = 0; team < 2; team++) {
    // A quién le toca. Si el elegido está caído le toca al siguiente vivo, pero
    // el turno NO se pierde: el ciclo es de tres y se respeta, que es lo que
    // hace que el ultra sea previsible en vez de una lotería.
    const from = team === TEAM_GREEN ? 0 : FIGHTERS_PER_TEAM;
    let chosen = -1;
    for (let n = 0; n < FIGHTERS_PER_TEAM; n++) {
      const i = from + (m.ultraTurn[team] + n) % FIGHTERS_PER_TEAM;
      if (m.slot[i] === SLOT_ACTIVE) { chosen = i; break; }
    }

    // El que dejó de ser el elegido vuelve a su tamaño. Sin esto un peleador que
    // se cae mientras crecía reaparece gigante para siempre.
    const antes = m.growing[team];
    if (antes >= 0 && antes !== chosen) {
      m.stage[antes] = 0;
      m.scale[antes] = 1;
    }
    m.growing[team] = chosen;
    if (chosen < 0) continue;

    // El gigantismo es el DIBUJO de la barra del equipo: el elegido crece a
    // medida que se carga, así se ve venir el ultra sin leer ningún número y se
    // sabe de antemano a quién le toca.
    const stage = ultraStage(m.ultra[team]);
    if (stage > m.stage[chosen]) {
      emit(m.events, EVENT_GROW, m.x[chosen], m.y[chosen], stage, team, chosen);
    }
    m.stage[chosen] = stage;
    m.scale[chosen] = growthScale(stage);

    if (m.ultra[team] < 1) continue;
    // La barra del equipo da el DERECHO a tirar el ultra; la personal lo paga.
    // Como el elegido dejó de gastar al llegar a `ULTRA_HOLD`, para cuando la de
    // equipo se llena la suya ya está arriba del mínimo casi siempre.
    if (m.energy[chosen] < COST_SUPER) continue;

    const spent = m.energy[chosen];
    m.energy[chosen] = 0;
    m.ultra[team] = 0;
    m.ultraTurn[team] = (m.ultraTurn[team] + 1) % FIGHTERS_PER_TEAM;
    unleash(m, chosen, now, spent);
    m.stage[chosen] = 0;
    m.scale[chosen] = 1;
  }
  for (let team = 0; team < 2; team++) {
    const chosen = m.growing[team];
    m.state.charge[team] = chosen >= 0 ? m.stage[chosen] : 0;
    m.state.ultra[team] = m.ultra[team];
    m.state.ultraTurn[team] = m.ultraTurn[team];
  }

  /* --- la cola de trades: carga las barras y da de alta ---------------- */
  const greenShare = bookShare(stats.bidVolume, stats.askVolume, TEAM_GREEN);
  const redShare = bookShare(stats.bidVolume, stats.askVolume, TEAM_RED);
  //
  // Antes este bucle sacaba como mucho cuatro trades por paso y tiraba el resto:
  // un trade que llegaba con los tres slots del bando ocupados no hacía
  // absolutamente nada. Ahora TODO trade carga la barra de alguien, y el alta es
  // lo secundario. Es lo que hace que el ritmo de golpes sea el del mercado: en
  // una ráfaga de compras las barras verdes se llenan aunque no entre nadie
  // nuevo, y el bando descarga.
  let spawned = 0;
  let drained = 0;
  while (drained < MAX_TRADES_PER_STEP) {
    // Con el cupo de altas ya lleno y algún slot todavía esperando, se corta.
    // Sacar un trade de la cola sólo para cargar se lo robaría al alta del paso
    // siguiente, y un slot vacío es un peleador que falta en pantalla. Sin esta
    // guarda, seis trades de arranque daban cuatro peleadores en vez de seis:
    // el primer paso se llevaba los seis de la cola y sólo podía dar de alta a
    // cuatro. Una vez que están los seis arriba no vuelve a activarse, que es el
    // caso normal.
    if (spawned >= MAX_SPAWNS_PER_STEP
      && (freeSlot(m, TEAM_GREEN) >= 0 || freeSlot(m, TEAM_RED) >= 0)) break;

    const trade = trades.pop();
    if (trade === null) break;
    drained++;
    const team = trade.side === 'buy' ? TEAM_GREEN : TEAM_RED;
    charge(m, team, chargeFromTrade(trade.size, stats.tradeMedian));
    m.ultra[team] = addCharge(
      m.ultra[team],
      ultraGain(trade.size, stats.tradeMedian, team === TEAM_GREEN ? greenShare : redShare),
    );

    if (spawned >= MAX_SPAWNS_PER_STEP) continue;
    const slot = freeSlot(m, team);
    if (slot < 0) continue;
    spawned++;
    activate(m, slot, team, trade.size, trade.whale, stats.tradeMedian, now);
  }
  if (trades.count > CAPACITY * 6) trades.clear();

  summarize(m);
}

/**
 * Le pasa la carga de un trade a UN peleador del bando, por turno.
 *
 * Salta a los slots vacíos —un caído no cobra— y avanza el cursor sólo cuando
 * encontró a quién cobrarle, así con dos peleadores vivos se turnan entre esos
 * dos y no se pierde una de cada tres órdenes.
 */
function charge(m: Match, team: number, amount: number): void {
  const from = team === TEAM_GREEN ? 0 : FIGHTERS_PER_TEAM;
  for (let n = 0; n < FIGHTERS_PER_TEAM; n++) {
    const lane = (m.chargeCursor[team] + n) % FIGHTERS_PER_TEAM;
    const i = from + lane;
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    m.energy[i] = addCharge(m.energy[i], amount);
    m.chargeCursor[team] = (lane + 1) % FIGHTERS_PER_TEAM;
    return;
  }
}

/**
 * ¿Está guardando para el ultra? El elegido, con la barra del equipo pasada de
 * `ULTRA_HOLD`, no gasta ni en puños: se planta y espera el remate.
 */
function guardando(m: Match, i: number): boolean {
  const team = m.team[i];
  return m.growing[team] === i && m.ultra[team] >= ULTRA_HOLD;
}

function freeSlot(m: Match, team: number): number {
  const from = team === TEAM_GREEN ? 0 : FIGHTERS_PER_TEAM;
  for (let i = from; i < from + FIGHTERS_PER_TEAM; i++) if (m.slot[i] === SLOT_FREE) return i;
  return -1;
}


function activate(
  m: Match, slot: number, team: number,
  size: number, whale: boolean, median: number, now: number,
): void {
  // `m.character[slot]` NO se toca: lo fijó `createMatch` y no cambia nunca.
  // Antes acá se llamaba a `pickCharacter`, que repartía el siguiente de la
  // plantilla en ronda; sin relevos, reactivar un slot es devolverle al mismo
  // peleador que se cayó.
  const weight = weightFor(size, median, whale);
  m.weight[slot] = weight;
  m.damage[slot] = 0;
  m.stocks[slot] = STOCKS;
  m.jumps[slot] = MAX_JUMPS;
  m.lastJump[slot] = now;
  m.lastHit[slot] = now;
  m.hitstun[slot] = -10;
  m.whale[slot] = whale ? 1 : 0;
  m.stage[slot] = 0;
  m.scale[slot] = 1;
  m.lastSkill[slot] = 1;
  // La barra arranca vacía: un peleador que acaba de entrar todavía no tiene
  // órdenes atrás. Las primeras que lleguen de su lado se la cargan.
  m.energy[slot] = 0;

  // Repartidos por carril: los tres apareciendo en el mismo punto caen uno
  // encima del otro y arrancan la pelea amontonados.
  const lane = slot % FIGHTERS_PER_TEAM;
  m.x[slot] = (team === TEAM_GREEN ? -1 : 1) * (SPAWN_X - lane * 1.7);
  m.y[slot] = SPAWN_Y + lane * 0.8;
  m.vx[slot] = 0;
  m.vy[slot] = 0;
  m.facing[slot] = team === TEAM_GREEN ? 1 : -1;
  m.grounded[slot] = 0;
  m.slot[slot] = SLOT_ACTIVE;
}

/**
 * El super del gigantismo. No usa el knockback normal a propósito: tiene que
 * sacar del escenario aunque el rival esté con 0% de daño, o el gigantismo es
 * sólo un personaje más grande.
 */
function unleash(m: Match, self: number, now: number, spent: number): void {
  // Lo que se gastó gradúa el remate: al mínimo pega poco más que el super de
  // antes, con la barra llena pega un tercio más.
  const power = 0.6 + spent * 0.7;
  emit(m.events, EVENT_SUPER, m.x[self], m.y[self], SUPER_RADIUS, m.team[self], self);
  m.shake = 1;
  for (let i = 0; i < CAPACITY; i++) {
    if (i === self || m.slot[i] !== SLOT_ACTIVE || m.team[i] === m.team[self]) continue;
    const dx = m.x[i] - m.x[self];
    const dy = m.y[i] - m.y[self];
    const distance = Math.hypot(dx, dy);
    if (distance > SUPER_RADIUS) continue;
    const force = superForce(distance) * power;
    const nx = distance > 1e-6 ? dx / distance : 1;
    const ny = distance > 1e-6 ? dy / distance : 0;
    m.vx[i] = nx * force * 1.3;
    m.vy[i] = ny * force * 0.4 + force * 0.55;
    m.grounded[i] = 0;
    m.damage[i] += SUPER_DAMAGE * power;
    m.hitstun[i] = now;
    m.lastHit[i] = now;
    emit(m.events, EVENT_HIT, m.x[i], m.y[i], 1.4, m.team[i], i);
  }
}

function summarize(m: Match): void {
  for (let team = 0; team < 2; team++) {
    const from = team === TEAM_GREEN ? 0 : FIGHTERS_PER_TEAM;
    let damage = 0;
    let alive = 0;
    let stocks = 0;
    for (let i = from; i < from + FIGHTERS_PER_TEAM; i++) {
      stocks += m.stocks[i];
      if (m.slot[i] !== SLOT_ACTIVE) continue;
      damage += m.damage[i];
      alive++;
    }
    m.state.damage[team] = alive > 0 ? damage / alive : 0;
    m.state.alive[team] = alive;
    m.state.stocks[team] = stocks;
  }
}
