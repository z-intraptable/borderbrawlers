import type { FeedStats, TradeRingBuffer } from '../net/feedCore';
import type { MatchState, Skyline } from './fighters';
import {
  GROWTH_MAX_STAGE,
  HIT_COOLDOWN,
  SLOT_ACTIVE,
  SLOT_FREE,
  SUPER_DAMAGE,
  SUPER_RADIUS,
  TEAM_GREEN,
  TEAM_RED,
  bookShare,
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
  shouldGrow,
  superForce,
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
const HITSTUN = 0.34;
/**
 * El cuerpo a cuerpo aturde mucho menos: si aturdiera como una especial, dos
 * peleadores en contacto se paralizarían mutuamente y no pasaría nada más.
 */
const MELEE_STUN = 0.12;
/** Separación del cuerpo a cuerpo. Alcanza para no solaparse, no para lanzar. */
const MELEE_NUDGE = 1.6;
const CONTACT = 0.85;
/** Polvo mínimo de un aterrizaje, y a qué velocidad de caída se satura. */
const LANDING_SOFT = 0.35;
const LANDING_FULL = 18;
const SPAWN_Y = 8;
const SPAWN_X = 5.5;
const MAX_SPAWNS_PER_STEP = 4;

const BLAST = { minX: -15, maxX: 15, minY: -11, maxY: 26 };

/**
 * Las habilidades comunes salen solas cada 8 a 12 segundos por peleador.
 *
 * No dependen del contacto ni de que el mercado haga nada: son el ritmo base de
 * la pelea, lo que hace que siempre esté pasando algo aunque el libro esté
 * quieto. El super, en cambio, sale al completar los tres pasos de gigantismo,
 * y ese sí lo maneja la liquidez.
 */
const SKILL_MIN_INTERVAL = 8;
const SKILL_MAX_INTERVAL = 12;
/** Alcance de una habilidad especial. Bastante menos que el super. */
const SKILL_RADIUS = 2.3;
const SKILL_DAMAGE = 12;

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
  };
}

function emit(q: EventQueue, kind: number, x: number, y: number, magnitude: number, team: number): void {
  if (q.count >= EVENT_CAP) return;
  const i = q.count++;
  q.kind[i] = kind;
  q.x[i] = x;
  q.y[i] = y;
  q.magnitude[i] = magnitude;
  q.team[i] = team;
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
  /** Índice del personaje del elenco que le tocó a este slot. */
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
  /** Cuándo le toca la próxima habilidad común, en segundos del reloj. */
  nextSkill: Float32Array;
  /** Cuál usó la última vez: se alternan. */
  lastSkill: Uint8Array;
  /** Golpe o patada: también se alternan, contacto a contacto. */
  lastBlow: Uint8Array;
  /** Semilla del PRNG. La simulación no usa Math.random. */
  seed: number;

  /** Quién está creciendo por equipo, -1 si nadie. */
  growing: Int8Array;
  lastStep: Float32Array;
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
    nextSkill: new Float32Array(CAPACITY),
    lastSkill: new Uint8Array(CAPACITY),
    lastBlow: new Uint8Array(CAPACITY),
    seed: 0x5eed_1234,
    growing: Int8Array.from([-1, -1]),
    lastStep: new Float32Array(2),
    clock: 0,
    shake: 0,
  };

  // Un slot no cambia de bando nunca, así el color y el personaje se resuelven
  // una sola vez.
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

/**
 * mulberry32. La simulación no llama a `Math.random` en ningún lado: con una
 * semilla fija, la misma grabación reproducida dos veces da la misma pelea.
 * Eso es lo que hace que el replay del VPS sirva para comparar dos corridas, y
 * se perdería con un solo `Math.random` en el camino.
 */
function nextRandom(m: Match): number {
  m.seed = (m.seed + 0x6d2b79f5) >>> 0;
  let t = m.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function scheduleSkill(m: Match, i: number, now: number): void {
  m.nextSkill[i] = now + SKILL_MIN_INTERVAL
    + nextRandom(m) * (SKILL_MAX_INTERVAL - SKILL_MIN_INTERVAL);
}

/**
 * Altura objetivo de cada plataforma desde el snapshot del libro.
 *
 * La central no se mueve: es el escenario principal y garantiza que siempre
 * haya dónde pelear aunque el mercado se seque.
 */
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
      const desired = brake ? 0 : (dir + spread * 0.5) * RUN_SPEED * boost;

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
      emit(m.events, EVENT_LAND, m.x[i], m.y[i], LANDING_SOFT + fallSpeed / LANDING_FULL, m.team[i]);
    }
  }

  /* --- habilidades comunes -------------------------------------------- */
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    if (now < m.nextSkill[i]) continue;
    if (now - m.hitstun[i] < HITSTUN) continue;
    scheduleSkill(m, i, now);
    m.lastSkill[i] = m.lastSkill[i] === 0 ? 1 : 0;
    emit(m.events, EVENT_SKILL, m.x[i], m.y[i], m.lastSkill[i], m.team[i]);
    m.shake = Math.max(m.shake, 0.35);

    for (let j = 0; j < CAPACITY; j++) {
      if (j === i || m.slot[j] !== SLOT_ACTIVE || m.team[j] === m.team[i]) continue;
      const dx = m.x[j] - m.x[i];
      const dy = m.y[j] - m.y[i];
      const distance = Math.hypot(dx, dy);
      if (distance > SKILL_RADIUS) continue;
      const nx = distance > 1e-6 ? dx / distance : 1;
      const ny = distance > 1e-6 ? dy / distance : 0;
      const falloff = 0.55 + 0.45 * (1 - distance / SKILL_RADIUS);
      // Acá sí entra el knockback por daño acumulado: cuanto más viene
      // recibiendo el rival, más lejos lo manda esta misma habilidad. Es lo que
      // hace que la pelea escale en vez de ser plana.
      const force = knockback(m.damage[j], m.weight[j], m.weight[i]) * falloff;
      m.vx[j] = nx * force * 1.15;
      m.vy[j] = ny * force * 0.3 + force * 0.5;
      m.grounded[j] = 0;
      m.damage[j] += SKILL_DAMAGE;
      m.hitstun[j] = now;
      m.lastHit[j] = now;
      emit(m.events, EVENT_HIT, m.x[j], m.y[j], 1.2, m.team[j]);
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
      m.vx[j] += nx * MELEE_NUDGE;
      m.vx[i] -= nx * MELEE_NUDGE;
      m.lastHit[i] = now; m.lastHit[j] = now;
      m.hitstun[i] = now - HITSTUN + MELEE_STUN;
      m.hitstun[j] = now - HITSTUN + MELEE_STUN;
      m.damage[i] += hitDamage(m.weight[j]);
      m.damage[j] += hitDamage(m.weight[i]);

      // Cada uno tira su golpe, alternando puño y patada. El que recibe queda
      // en hurt, que lo resuelve la capa de render con el hitstun que ya existe.
      m.lastBlow[i] = m.lastBlow[i] === 0 ? 1 : 0;
      m.lastBlow[j] = m.lastBlow[j] === 0 ? 1 : 0;
      emit(m.events, EVENT_MELEE, m.x[i], m.y[i], m.lastBlow[i], m.team[i]);
      emit(m.events, EVENT_MELEE, m.x[j], m.y[j], m.lastBlow[j], m.team[j]);

      const heavy = m.whale[i] === 1 || m.whale[j] === 1;
      emit(m.events, EVENT_HIT, m.x[i] + dx / 2, m.y[i] + dy / 2, heavy ? 1.6 : 1, m.team[i]);
      m.shake = Math.max(m.shake, heavy ? 1 : 0.45);
    }
  }

  /* --- KO ------------------------------------------------------------ */
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    if (!isKO(BLAST, m.x[i], m.y[i])) continue;
    emit(m.events, EVENT_KO,
      Math.max(-10, Math.min(10, m.x[i])),
      Math.max(-5, Math.min(12, m.y[i])), 1, m.team[i]);
    m.state.kos[m.team[i] === TEAM_GREEN ? TEAM_RED : TEAM_GREEN]++;
    if (m.stocks[i] > 0) m.stocks[i]--;
    m.slot[i] = SLOT_FREE;
    m.shake = 1;
  }

  /* --- gigantismo ----------------------------------------------------- */
  for (let team = 0; team < 2; team++) {
    const share = bookShare(stats.bidVolume, stats.askVolume, team);
    if (!shouldGrow(share, now - m.lastStep[team])) continue;
    m.lastStep[team] = now;

    let chosen = m.growing[team];
    if (chosen < 0 || m.slot[chosen] !== SLOT_ACTIVE) {
      chosen = firstActive(m, team);
      m.growing[team] = chosen;
      if (chosen >= 0) m.stage[chosen] = 0;
    }
    if (chosen < 0) continue;

    if (m.stage[chosen] >= GROWTH_MAX_STAGE) {
      unleash(m, chosen, now);
      m.stage[chosen] = 0;
      m.growing[team] = -1;
    } else {
      m.stage[chosen]++;
      emit(m.events, EVENT_GROW, m.x[chosen], m.y[chosen], m.stage[chosen], team);
    }
    m.scale[chosen] = growthScale(m.stage[chosen]);
  }
  for (let team = 0; team < 2; team++) {
    const chosen = m.growing[team];
    m.state.charge[team] = chosen >= 0 ? m.stage[chosen] : 0;
  }

  /* --- altas desde la cola de trades ---------------------------------- */
  let spawned = 0;
  while (spawned < MAX_SPAWNS_PER_STEP) {
    const trade = trades.pop();
    if (trade === null) break;
    spawned++;
    const team = trade.side === 'buy' ? TEAM_GREEN : TEAM_RED;
    const slot = freeSlot(m, team);
    if (slot < 0) continue;
    activate(m, slot, team, trade.size, trade.whale, stats.tradeMedian, now);
  }
  if (trades.count > CAPACITY * 6) trades.clear();

  summarize(m);
}

function firstActive(m: Match, team: number): number {
  const from = team === TEAM_GREEN ? 0 : FIGHTERS_PER_TEAM;
  for (let i = from; i < from + FIGHTERS_PER_TEAM; i++) if (m.slot[i] === SLOT_ACTIVE) return i;
  return -1;
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
  scheduleSkill(m, slot, now);

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
function unleash(m: Match, self: number, now: number): void {
  emit(m.events, EVENT_SUPER, m.x[self], m.y[self], SUPER_RADIUS, m.team[self]);
  m.shake = 1;
  for (let i = 0; i < CAPACITY; i++) {
    if (i === self || m.slot[i] !== SLOT_ACTIVE || m.team[i] === m.team[self]) continue;
    const dx = m.x[i] - m.x[self];
    const dy = m.y[i] - m.y[self];
    const distance = Math.hypot(dx, dy);
    if (distance > SUPER_RADIUS) continue;
    const force = superForce(distance);
    const nx = distance > 1e-6 ? dx / distance : 1;
    const ny = distance > 1e-6 ? dy / distance : 0;
    m.vx[i] = nx * force * 1.3;
    m.vy[i] = ny * force * 0.4 + force * 0.55;
    m.grounded[i] = 0;
    m.damage[i] += SUPER_DAMAGE;
    m.hitstun[i] = now;
    m.lastHit[i] = now;
    emit(m.events, EVENT_HIT, m.x[i], m.y[i], 1.4, m.team[i]);
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
