import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CapsuleCollider, InstancedRigidBodies, useRapier } from '@react-three/rapier';
import { Outlines } from '@react-three/drei';
import type { InstancedRigidBodyProps, RapierRigidBody } from '@react-three/rapier';
import type { TradeRingBuffer, FeedStats } from '../net/feedCore';
import type { StageFocus } from './stageFocus';
import { accumulate, beginFrame, endFrame } from './stageFocus';
import type { ImpactPool } from './ImpactFx';
import { FX_SPARK, FX_STAR, emit } from './ImpactFx';
import {
  FIGHTER_FEET_OFFSET,
  FIGHTER_HALF_HEIGHT,
  FIGHTER_RADIUS,
  createFighterGeometry,
} from './fighterGeometry';
import type { MatchState, Skyline } from '../game/fighters';
import {
  HIT_COOLDOWN,
  SLOT_ACTIVE,
  SLOT_FREE,
  SLOT_RETIRING,
  TEAM_GREEN,
  TEAM_RED,
  hasGroundAhead,
  hitDamage,
  isGrounded,
  isKO,
  knockback,
  momentumBoost,
  nearestEnemy,
  shouldBrakeAtLedge,
  teamMomentum,
  wantsJump,
  weightFor,
  GROWTH_MAX_STAGE,
  SUPER_DAMAGE,
  SUPER_RADIUS,
  bookShare,
  growthScale,
  shouldGrow,
  superForce,
} from '../game/fighters';

/**
 * Módulo 4 — los peleadores.
 *
 * Verde contra rojo, sobre las plataformas del libro. Cada personaje busca al
 * rival más cercano, camina, salta, empuja, y sale volando cada vez más lejos a
 * medida que acumula daño. Los trades del mercado deciden quién aparece, cuánto
 * pesa y qué equipo tiene ímpetu.
 *
 * Lo que decide *qué* hacer está en `src/game/fighters.ts` y se testea con
 * asserts. Este archivo sólo traduce esas decisiones a llamadas de física.
 *
 * Dos cosas heredadas de `@react-three/rapier@2.2.0`, verificadas en su código
 * fuente y no en la documentación:
 *
 * 1. La matriz de cada instancia se recompone todos los frames como
 *    `compose(translation, rotation, state.scale)`, donde `state` vive en
 *    `useRapier().rigidBodyStates`. `setMatrixAt` a mano se pisa en el siguiente
 *    step; la escala por instancia se cambia ahí.
 * 2. El bucle de sincronización saltea los cuerpos dormidos. Dormir en el mismo
 *    frame en que se retira al personaje deja un cubo congelado en el aire con
 *    la escala vieja. Por eso el retiro es en dos fases: un frame para encoger y
 *    teletransportar, y recién al siguiente `sleep()`.
 */

/**
 * 3 contra 3. Con más peleadores no se entiende quién le pega a quién, y el
 * gigantismo —que es de a uno por equipo— deja de leerse.
 */
export const FIGHTERS_PER_TEAM = 3;
export const STOCKS_PER_FIGHTER = 3;

/* --- movimiento ---------------------------------------------------- */

const RUN_SPEED = 3.4;
const JUMP_SPEED = 7.2;
const MAX_JUMPS = 2;
/** Cuánto se puede corregir el rumbo en el aire. Bajo: el salto se compromete. */
const AIR_CONTROL = 0.1;
const GRAVITY_SCALE = 1.9;
const LOOKAHEAD = 0.6;

/**
 * Hitstun: durante este tiempo el personaje NO se controla y vuela libre.
 *
 * Es lo que hace que un empujón se vea como un empujón. Sin esto, el frame
 * siguiente al golpe el peleador vuelve a fijar su velocidad horizontal y anula
 * el knockback: se ve un temblor en vez de un golpe. Es también la razón por la
 * que no hace falta un freeze frame global, que necesitaría estado de React en
 * el camino de datos de mercado.
 */
const HITSTUN = 0.34;
/** A partir de esta distancia entre centros, se empujan. */
const CONTACT_DISTANCE = 0.95;

const SPAWN_Y = 7.5;
const SPAWN_X = 5.5;

/** Fuera de esta caja es KO. */
const BLAST = { minX: -15, maxX: 15, minY: -11, maxY: 24 };

/** Cuántos trades como mucho se consumen por frame. */
const MAX_SPAWNS_PER_FRAME = 4;

/** Cuánto decae el sacudón de cámara por frame. */
const IMPACT_DECAY = 0.9;

/* --- colores ------------------------------------------------------- */

/**
 * El color ES la regla del agresor hecha visible: `feedCore` ya resolvió
 * `trade.m ? 'sell' : 'buy'`, acá sólo se traduce a equipo. Verde compra, rojo
 * vende. Invertirlo produce una visualización plausible y sistemáticamente al
 * revés.
 */
const GREEN = new THREE.Color('#00FF66');
const RED = new THREE.Color('#FF0055');
const GOLD = new THREE.Color('#FFD700');
/** Fuera del rango 0–1 para que el Bloom lo levante por luminancia. */
const WHALE_GAIN = 2.2;
const scratchColor = new THREE.Color();

/* Temporales a nivel de módulo. */
const vec = { x: 0, y: 0, z: 0 };
const zero = { x: 0, y: 0, z: 0 };
const PARK_Y = -600;

export interface FighterPoolProps {
  trades: TradeRingBuffer;
  stats: FeedStats;
  focus: StageFocus;
  skyline: Skyline;
  fx: ImpactPool;
  match: MatchState;
  lowQuality?: boolean;
}

export function FighterPool(props: FighterPoolProps): React.JSX.Element {
  const { trades, stats, focus, skyline, fx, match, lowQuality = false } = props;
  const perTeam = FIGHTERS_PER_TEAM;
  const capacity = perTeam * 2;
  const { rigidBodyStates } = useRapier();

  const bodies = useRef<(RapierRigidBody | null)[] | null>(null);
  const mesh = useRef<THREE.InstancedMesh | null>(null);
  const clock = useRef(0);

  const geometry = useMemo(createFighterGeometry, []);
  useEffect(() => () => geometry.dispose(), [geometry]);

  /** Quién está creciendo por equipo, y desde cuándo. -1 = nadie. */
  const growing = useRef<Int8Array>(Int8Array.from([-1, -1]));
  const lastStep = useRef<Float32Array>(new Float32Array(2));

  /* Estado del combate en arrays tipados. Nada de esto en estado de React. */
  const s = useMemo(() => ({
    state: new Uint8Array(capacity),
    team: new Uint8Array(capacity),
    damage: new Float32Array(capacity),
    weight: new Float32Array(capacity),
    stocks: new Uint8Array(capacity),
    jumps: new Uint8Array(capacity),
    lastJump: new Float32Array(capacity),
    lastHit: new Float32Array(capacity),
    hitstun: new Float32Array(capacity),
    whale: new Uint8Array(capacity),
    /** Etapa de gigantismo, 0 a GROWTH_MAX_STAGE. */
    stage: new Uint8Array(capacity),
    /** Escala propia del peleador, sin el gigantismo encima. */
    base: new Float32Array(capacity),
    x: new Float64Array(capacity),
    y: new Float64Array(capacity),
    vx: new Float64Array(capacity),
    vy: new Float64Array(capacity),
  }), [capacity]);

  // La mitad de abajo es verde, la de arriba roja. Fijo: un slot no cambia de
  // bando, así el color por instancia se escribe una sola vez al montar.
  useEffect(() => {
    for (let i = 0; i < capacity; i++) s.team[i] = i < perTeam ? TEAM_GREEN : TEAM_RED;
    const m = mesh.current;
    if (m === null) return;
    m.frustumCulled = false;
    for (let i = 0; i < capacity; i++) {
      m.setColorAt(i, s.team[i] === TEAM_GREEN ? GREEN : RED);
    }
    if (m.instanceColor !== null) m.instanceColor.needsUpdate = true;
  }, [capacity, perTeam, s]);

  const instances = useMemo<InstancedRigidBodyProps[]>(() => {
    const list: InstancedRigidBodyProps[] = new Array(capacity);
    for (let i = 0; i < capacity; i++) list[i] = { key: i, position: [0, PARK_Y - i, 0] };
    return list;
  }, [capacity]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    clock.current += dt;
    const now = clock.current;
    const list = bodies.current;
    if (list === null) return;

    /* --- fase 2 del retiro: dormir lo que se encogió el frame pasado --- */
    for (let i = 0; i < capacity; i++) {
      if (s.state[i] !== SLOT_RETIRING) continue;
      list[i]?.sleep();
      s.state[i] = SLOT_FREE;
    }

    /* --- leer la física una vez ------------------------------------- */
    for (let i = 0; i < capacity; i++) {
      if (s.state[i] !== SLOT_ACTIVE) continue;
      const body = list[i];
      if (body === null) continue;
      const t = body.translation();
      const v = body.linvel();
      s.x[i] = t.x; s.y[i] = t.y;
      s.vx[i] = v.x; s.vy[i] = v.y;
    }

    const greenBoost = momentumBoost(teamMomentum(stats.buyVolume, stats.sellVolume, TEAM_GREEN));
    const redBoost = momentumBoost(teamMomentum(stats.buyVolume, stats.sellVolume, TEAM_RED));

    /* --- decidir y mover -------------------------------------------- */
    beginFrame(focus);
    for (let i = 0; i < capacity; i++) {
      if (s.state[i] !== SLOT_ACTIVE) continue;
      const body = list[i];
      if (body === null) continue;

      const grounded = isGrounded(skyline, s.x[i], s.y[i], s.vy[i], FIGHTER_FEET_OFFSET);
      if (grounded) s.jumps[i] = MAX_JUMPS;

      accumulate(focus, s.x[i], s.y[i]);

      // En hitstun no se controla: vuela. Es lo que hace que el golpe se lea.
      if (now - s.hitstun[i] < HITSTUN) continue;

      const target = nearestEnemy(capacity, s.state, s.team, s.x, s.y, i);
      const dx = target >= 0 ? s.x[target] - s.x[i] : -s.x[i];
      const dy = target >= 0 ? s.y[target] - s.y[i] : 0;
      const dir = dx >= 0 ? 1 : -1;

      const groundAhead = hasGroundAhead(skyline, s.x[i], dir, LOOKAHEAD);
      const brake = shouldBrakeAtLedge(groundAhead, dx, dir);
      const boost = s.team[i] === TEAM_GREEN ? greenBoost : redBoost;
      const desiredVx = brake ? 0 : dir * RUN_SPEED * boost;

      vec.x = grounded ? desiredVx : s.vx[i] + (desiredVx - s.vx[i]) * AIR_CONTROL;
      vec.y = s.vy[i];
      vec.z = 0;

      const jump = wantsJump({
        grounded,
        dy,
        dx,
        groundAhead,
        sinceJump: now - s.lastJump[i],
      });
      // Recuperación: cayéndose por debajo del escenario, gasta el salto extra.
      // Sin esto el primer empujón es siempre KO y no hay pelea.
      const recovering = !grounded && s.vy[i] < 0 && s.y[i] < 0 && s.jumps[i] > 0
        && now - s.lastJump[i] > 0.25;

      if ((jump || recovering) && s.jumps[i] > 0) {
        vec.y = JUMP_SPEED;
        s.jumps[i]--;
        s.lastJump[i] = now;
        // Estirón vertical al despegar: el squash & stretch de toda la vida.
        setScale(rigidBodyStates, body, 0.82, 1.28);
      } else if (grounded) {
        setScale(rigidBodyStates, body, 1, 1);
      }

      body.setLinvel(vec, true);
    }

    /* --- empujones ---------------------------------------------------- */
    for (let i = 0; i < capacity; i++) {
      if (s.state[i] !== SLOT_ACTIVE) continue;
      for (let j = i + 1; j < capacity; j++) {
        if (s.state[j] !== SLOT_ACTIVE || s.team[j] === s.team[i]) continue;
        const dx = s.x[j] - s.x[i];
        const dy = s.y[j] - s.y[i];
        const distance = Math.hypot(dx, dy);
        if (distance > CONTACT_DISTANCE) continue;
        if (now - s.lastHit[i] < HIT_COOLDOWN || now - s.lastHit[j] < HIT_COOLDOWN) continue;

        // Se empujan mutuamente: cada uno sale para su lado. Simétrico y sin
        // decidir quién "atacó", que en una pelea de 8 contra 8 sería arbitrario.
        const nx = distance > 1e-6 ? dx / distance : 1;
        const ny = distance > 1e-6 ? dy / distance : 0;
        push(list[j], s, j, nx, ny, s.weight[i]);
        push(list[i], s, i, -nx, -ny, s.weight[j]);
        s.lastHit[i] = now;
        s.lastHit[j] = now;
        s.hitstun[i] = now;
        s.hitstun[j] = now;
        s.damage[i] += hitDamage(s.weight[j]);
        s.damage[j] += hitDamage(s.weight[i]);

        const heavy = s.whale[i] === 1 || s.whale[j] === 1;
        emit(fx, FX_SPARK, s.x[i] + dx / 2, s.y[i] + dy / 2, heavy ? 1.5 : 0.9, 3, 2.6, 1.2);
        if (heavy) focus.impact = 1;
        else if (focus.impact < 0.45) focus.impact = 0.45;
      }
    }

    /* --- KO ------------------------------------------------------------ */
    for (let i = 0; i < capacity; i++) {
      if (s.state[i] !== SLOT_ACTIVE) continue;
      if (!isKO(BLAST, s.x[i], s.y[i])) continue;
      const body = list[i];
      if (body === null) continue;
      // La estrella sale en el borde, no donde ya no se ve al personaje.
      const starX = THREE.MathUtils.clamp(s.x[i], -10, 10);
      const starY = THREE.MathUtils.clamp(s.y[i], -6, 12);
      emit(fx, FX_STAR, starX, starY, 2.2, 3.4, 3.2, 1.6);
      focus.impact = 1;
      if (s.stocks[i] > 0) s.stocks[i]--;
      match.kos[s.team[i] === TEAM_GREEN ? TEAM_RED : TEAM_GREEN]++;
      retire(rigidBodyStates, body, s, i);
    }
    endFrame(focus, IMPACT_DECAY);

    /* --- altas desde la cola de trades --------------------------------- */
    let spawned = 0;
    while (spawned < MAX_SPAWNS_PER_FRAME) {
      const trade = trades.pop();
      if (trade === null) break;
      spawned++;
      const team = trade.side === 'buy' ? TEAM_GREEN : TEAM_RED;
      const slot = freeSlot(s, team, perTeam, capacity);
      if (slot < 0) continue;
      const body = list[slot];
      if (body === null) continue;
      activate(rigidBodyStates, body, s, slot, team, trade.size, trade.whale, stats.tradeMedian, now);
      paint(mesh.current, slot, team, trade.whale);
      if (trade.whale) focus.impact = 1;
    }
    // Si la cola sigue llena, se descarta lo viejo: ya no representa el mercado
    // actual y reproducirlo sería una ráfaga de altas falsas.
    if (trades.count > capacity * 4) trades.clear();

    /* --- gigantismo ----------------------------------------------------- */
    // Cuando la liquidez de un lado del libro se impone, ese equipo agranda a UNO
    // de los suyos, un paso por vez. Al tercero descarga el super y vuelve a su
    // tamaño. De a uno para que se vea venir.
    for (let team = 0; team < 2; team++) {
      const share = bookShare(stats.bidVolume, stats.askVolume, team);
      if (!shouldGrow(share, now - lastStep.current[team])) continue;
      lastStep.current[team] = now;

      let chosen = growing.current[team];
      if (chosen < 0 || s.state[chosen] !== SLOT_ACTIVE) {
        chosen = firstActive(s, team, perTeam, capacity);
        growing.current[team] = chosen;
        if (chosen >= 0) s.stage[chosen] = 0;
      }
      if (chosen < 0) continue;

      const body = list[chosen];
      if (body === null) continue;

      if (s.stage[chosen] >= GROWTH_MAX_STAGE) {
        unleash(list, s, capacity, chosen, fx, focus, now);
        s.stage[chosen] = 0;
        growing.current[team] = -1;
        applyScale(rigidBodyStates, body, s, chosen);
      } else {
        s.stage[chosen]++;
        applyScale(rigidBodyStates, body, s, chosen);
        emit(fx, FX_SPARK, s.x[chosen], s.y[chosen], 1.2 + s.stage[chosen] * 0.5, 2.4, 2.2, 3.2);
      }
    }
    for (let team = 0; team < 2; team++) {
      const chosen = growing.current[team];
      match.charge[team] = chosen >= 0 ? s.stage[chosen] : 0;
    }

    /* --- resumen para el HUD ------------------------------------------- */
    summarize(s, capacity, perTeam, match);
  });

  return (
    <InstancedRigidBodies
      ref={bodies}
      instances={instances}
      type="dynamic"
      colliders={false}
      colliderNodes={[
        <CapsuleCollider
          args={[FIGHTER_HALF_HEIGHT, FIGHTER_RADIUS]}
          friction={0.4}
          restitution={0.05}
        />,
      ]}
      // Siempre de pie. Con rotación libre en Z los peleadores terminan
      // acostados sobre las plataformas y parecen escombros, no personajes; en
      // Smash y en Brawlhalla el personaje también se mantiene erguido y la
      // sensación de golpe la da el vuelo, no el giro.
      lockRotations
      gravityScale={GRAVITY_SCALE}
      linearDamping={0.04}
      angularDamping={2.5}
      ccd
      canSleep
    >
      <instancedMesh
        ref={mesh}
        args={[geometry, undefined, capacity]}
        count={capacity}
        castShadow={false}
        receiveShadow={false}
      >
        {lowQuality
          ? <meshBasicMaterial toneMapped={false} />
          : <meshToonMaterial toneMapped={false} />}
        {/* El contorno negro grueso: es lo que separa "primitiva" de
            "personaje", y la firma visual de Brawlhalla. `Outlines` de drei
            detecta que el padre es un InstancedMesh y comparte su
            `instanceMatrix`, así que sigue solo a los peleadores incluida la
            escala del gigantismo.

            OJO con `screenspace`: el nombre sugiere lo contrario de lo que hace.
            En true desplaza la cáscara en unidades de MUNDO, así que un grosor
            de 4 tapa media pantalla con una mancha negra. El grosor en píxeles
            —constante aunque la cámara haga zoom, que es lo que se quiere acá—
            es el modo por defecto, con `screenspace` apagado. */}
        <Outlines thickness={5} color="#05070d" transparent={false} />
      </instancedMesh>
    </InstancedRigidBodies>
  );
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

type Rig = ReturnType<typeof useRapier>['rigidBodyStates'];
type Fighters = {
  state: Uint8Array; team: Uint8Array; damage: Float32Array; weight: Float32Array;
  stocks: Uint8Array; jumps: Uint8Array; lastJump: Float32Array; lastHit: Float32Array;
  hitstun: Float32Array; whale: Uint8Array; stage: Uint8Array; base: Float32Array;
  x: Float64Array; y: Float64Array; vx: Float64Array; vy: Float64Array;
};

/** La escala por instancia vive en `rigidBodyStates`, no en el InstancedMesh. */
function setScale(states: Rig, body: RapierRigidBody, wide: number, tall: number): void {
  const state = states.get(body.handle);
  if (state !== undefined) state.scale.set(wide, tall, wide);
}

function freeSlot(s: Fighters, team: number, perTeam: number, capacity: number): number {
  const from = team === TEAM_GREEN ? 0 : perTeam;
  const to = team === TEAM_GREEN ? perTeam : capacity;
  for (let i = from; i < to; i++) if (s.state[i] === SLOT_FREE) return i;
  return -1;
}

function push(
  body: RapierRigidBody | null,
  s: Fighters,
  index: number,
  nx: number,
  ny: number,
  attackerWeight: number,
): void {
  if (body === null) return;
  const force = knockback(s.damage[index], s.weight[index], attackerWeight);
  // El empujón es sobre todo HORIZONTAL: en Smash se gana sacando al rival por
  // el costado, no por arriba. Con demasiada componente vertical los peleadores
  // se apilan uno sobre la cabeza del otro en la misma plataforma.
  vec.x = nx * force * 1.35;
  // Algo hacia arriba siempre, si no el empujón desliza por el piso y no
  // despega nunca.
  vec.y = ny * force * 0.35 + force * 0.28;
  vec.z = 0;
  body.setLinvel(vec, true);
}

function activate(
  states: Rig,
  body: RapierRigidBody,
  s: Fighters,
  slot: number,
  team: number,
  size: number,
  whale: boolean,
  median: number,
  now: number,
): void {
  const weight = weightFor(size, median, whale);
  s.weight[slot] = weight;
  s.damage[slot] = 0;
  s.stocks[slot] = STOCKS_PER_FIGHTER;
  s.jumps[slot] = MAX_JUMPS;
  s.lastJump[slot] = now;
  s.lastHit[slot] = now;
  s.hitstun[slot] = -10;
  s.whale[slot] = whale ? 1 : 0;

  vec.x = (team === TEAM_GREEN ? -1 : 1) * SPAWN_X;
  vec.y = SPAWN_Y;
  vec.z = 0;
  body.setTranslation(vec, true);

  // Reseteo obligatorio: sin esto el cuerpo reciclado conserva el momento del
  // uso anterior y sale disparado de forma aparentemente aleatoria.
  body.setLinvel(zero, false);
  body.setAngvel(zero, false);
  body.resetForces(true);
  body.wakeUp();

  s.stage[slot] = 0;
  s.base[slot] = 0.85 + weight * 0.35;
  applyScale(states, body, s, slot);

  s.state[slot] = SLOT_ACTIVE;
}

function paint(mesh: THREE.InstancedMesh | null, slot: number, team: number, whale: boolean): void {
  if (mesh === null) return;
  const base = team === TEAM_GREEN ? GREEN : RED;
  if (whale) {
    scratchColor.setRGB(
      base.r * WHALE_GAIN + GOLD.r * 0.5,
      base.g * WHALE_GAIN + GOLD.g * 0.5,
      base.b * WHALE_GAIN + GOLD.b * 0.5,
    );
    mesh.setColorAt(slot, scratchColor);
  } else {
    mesh.setColorAt(slot, base);
  }
  if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
}

function retire(states: Rig, body: RapierRigidBody, s: Fighters, slot: number): void {
  body.setLinvel(zero, false);
  body.setAngvel(zero, false);
  body.resetForces(true);
  vec.x = 0;
  vec.y = PARK_Y - slot;
  vec.z = 0;
  body.setTranslation(vec, true);
  setScale(states, body, 0, 0);
  // No se duerme acá: el bucle de sincronización saltea los cuerpos dormidos y
  // la escala 0 no llegaría a escribirse. Se duerme el frame siguiente.
  s.state[slot] = SLOT_RETIRING;
}

/** Promedios por equipo para el HUD. Se escriben en un objeto ya existente. */
function summarize(s: Fighters, capacity: number, perTeam: number, match: MatchState): void {
  for (let team = 0; team < 2; team++) {
    const from = team === TEAM_GREEN ? 0 : perTeam;
    const to = team === TEAM_GREEN ? perTeam : capacity;
    let damage = 0;
    let alive = 0;
    let stocks = 0;
    for (let i = from; i < to; i++) {
      stocks += s.stocks[i];
      if (s.state[i] !== SLOT_ACTIVE) continue;
      damage += s.damage[i];
      alive++;
    }
    match.damage[team] = alive > 0 ? damage / alive : 0;
    match.alive[team] = alive;
    match.stocks[team] = stocks;
  }
}

/** Primer peleador vivo de un equipo. -1 si el equipo está entero afuera. */
function firstActive(s: Fighters, team: number, perTeam: number, capacity: number): number {
  const from = team === TEAM_GREEN ? 0 : perTeam;
  const to = team === TEAM_GREEN ? perTeam : capacity;
  for (let i = from; i < to; i++) if (s.state[i] === SLOT_ACTIVE) return i;
  return -1;
}

/**
 * Escala final = la propia del peleador por la del gigantismo. El collider se
 * actualiza junto con lo que se ve: un gigante con la cápsula chica atraviesa
 * a todos y el efecto se ve roto sin que se entienda por qué.
 */
function applyScale(states: Rig, body: RapierRigidBody, s: Fighters, i: number): void {
  const scale = s.base[i] * growthScale(s.stage[i]);
  setScale(states, body, scale, scale);
  const collider = body.collider(0);
  if (collider !== null) collider.setRadius(FIGHTER_RADIUS * scale);
}

/**
 * El super: al completar los tres pasos de gigantismo, todo rival dentro del
 * radio sale despedido. No usa el knockback normal a propósito — este golpe
 * tiene que sacar del escenario aunque el rival esté con 0% de daño, porque si
 * no, el gigantismo es sólo un personaje más grande.
 */
function unleash(
  list: (RapierRigidBody | null)[],
  s: Fighters,
  capacity: number,
  self: number,
  fx: ImpactPool,
  focus: StageFocus,
  now: number,
): void {
  emit(fx, FX_SPARK, s.x[self], s.y[self], SUPER_RADIUS * 1.6, 4, 3.4, 1.4);
  focus.impact = 1;

  for (let i = 0; i < capacity; i++) {
    if (i === self || s.state[i] !== SLOT_ACTIVE || s.team[i] === s.team[self]) continue;
    const dx = s.x[i] - s.x[self];
    const dy = s.y[i] - s.y[self];
    const distance = Math.hypot(dx, dy);
    if (distance > SUPER_RADIUS) continue;

    const body = list[i];
    if (body === null) continue;
    const force = superForce(distance);
    const nx = distance > 1e-6 ? dx / distance : 1;
    const ny = distance > 1e-6 ? dy / distance : 0;
    vec.x = nx * force;
    vec.y = ny * force * 0.5 + force * 0.6;
    vec.z = 0;
    body.setLinvel(vec, true);

    s.damage[i] += SUPER_DAMAGE;
    s.hitstun[i] = now;
    s.lastHit[i] = now;
    emit(fx, FX_SPARK, s.x[i], s.y[i], 1.4, 4, 2.4, 1.2);
  }
}
