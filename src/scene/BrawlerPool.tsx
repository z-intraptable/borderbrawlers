import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { BallCollider, InstancedRigidBodies, useRapier } from '@react-three/rapier';
import type { InstancedRigidBodyProps, RapierRigidBody } from '@react-three/rapier';
import type { TradeRingBuffer, FeedStats } from '../net/feedCore';
import { STAGE_FLOOR_Y, STAGE_HALF_WIDTH } from './OrderBookWalls';
import type { StageFocus } from './stageFocus';
import { accumulate, beginFrame, endFrame } from './stageFocus';

/**
 * Módulo 4 — pool de personajes.
 *
 * `@react-three/rapier` no documenta ningún patrón de object pooling. Este
 * archivo implementa uno contra el comportamiento real de la v2.2.0, verificado
 * en su código fuente. Dos cosas que no son obvias y que definen el diseño:
 *
 * 1. La matriz de cada instancia se recompone TODOS los frames como
 *    `compose(translation, rotation, state.scale)`, donde `state` vive en
 *    `useRapier().rigidBodyStates`. Escribir `setMatrixAt` a mano no sirve: se
 *    pisa en el siguiente step. La escala por instancia se cambia ahí.
 *
 * 2. Ese bucle de sincronización saltea los cuerpos dormidos. Si se llama a
 *    `sleep()` en el mismo frame en que se retira el personaje, la última
 *    matriz escrita puede ser la de antes de encogerlo, y queda un cubo
 *    congelado en el aire. Por eso el retiro es en dos fases: un frame para
 *    encoger y teletransportar, y recién al siguiente `sleep()`.
 */

export const MAX_CHARACTERS = 50;
export const MAX_CHARACTERS_LOW = 20;

const CHAR_RADIUS = 0.22;
/** Debajo de esto, el personaje está fuera del ring. */
const Y_KILL = -9;
/** Tiempo máximo activo. Acumulador propio en useFrame, nunca setTimeout. */
const MAX_LIFETIME = 3;

const SPAWN_X = STAGE_HALF_WIDTH + 1.5;
const SPAWN_Y_MIN = STAGE_FLOOR_Y + 1.2;
const SPAWN_Y_MAX = STAGE_FLOOR_Y + 4.5;

/** Una ballena no puede producir una velocidad que atraviese los colliders. */
const IMPULSE_MIN = 0.9;
const IMPULSE_MAX = 6.5;
const IMPULSE_GAIN = 2.2;

const SCALE_MIN = 0.55;
const SCALE_MAX = 1.9;
const SCALE_GAIN = 0.55;
const WHALE_SCALE_MULT = 2;

/** Cuántos trades como mucho se convierten en spawn por frame. */
const MAX_SPAWNS_PER_FRAME = 6;

/** Zona de estacionamiento, bien fuera de cámara. */
const PARK_Y = -600;

/**
 * `setEnabled(false)` es más barato que dormir, pero no está documentado si
 * la librería omite la sincronización de transform de cuerpos deshabilitados.
 * Se deja detrás de esta constante para medirlo más adelante.
 */
const USE_DISABLE_OPTIMIZATION = false;

const SLOT_FREE = 0;
const SLOT_ACTIVE = 1;
const SLOT_RETIRING = 2;

/* Temporales a nivel de módulo. Cero asignaciones dentro de useFrame. */
const vec = { x: 0, y: 0, z: 0 };
const zero = { x: 0, y: 0, z: 0 };

/**
 * El color del personaje ES la regla del agresor hecha visible: el taker manda.
 * `side` ya viene resuelto por `feedCore` como `trade.m ? 'sell' : 'buy'`, así
 * que acá sólo se traduce a color. Las ballenas van en dorado y fuera del rango
 * 0–1: el Bloom levanta por luminancia lo que pasa de 1,0, así que salen
 * brillando sin capas ni SelectiveBloom.
 */
const BULL = new THREE.Color('#00FF66');
const BEAR = new THREE.Color('#FF0055');
const GOLD = new THREE.Color('#FFD700');
const WHALE_HDR_GAIN = 2.4;
const scratchColor = new THREE.Color();

/** Cuánto decae el sacudón de cámara por frame. */
const IMPACT_DECAY = 0.9;

export interface BrawlerPoolProps {
  trades: TradeRingBuffer;
  stats: FeedStats;
  /** El pool lo escribe cada frame; la cámara lo lee. Nunca se reemplaza. */
  focus: StageFocus;
  /** Se resuelve en el montaje. Cambiarlo remontaría todo el pool. */
  lowQuality?: boolean;
}

export function BrawlerPool({ trades, stats, focus, lowQuality = false }: BrawlerPoolProps): React.JSX.Element {
  const capacity = lowQuality ? MAX_CHARACTERS_LOW : MAX_CHARACTERS;
  const { rigidBodyStates } = useRapier();

  const bodies = useRef<(RapierRigidBody | null)[] | null>(null);
  const mesh = useRef<THREE.InstancedMesh | null>(null);

  /* Estado del pool en arrays tipados. Nada de esto en estado de React. */
  const slotState = useMemo(() => new Uint8Array(capacity), [capacity]);
  const activatedAt = useMemo(() => new Float32Array(capacity), [capacity]);
  const clock = useRef(0);

  /** Se crea una sola vez y nunca se reemplaza: el pool se monta una vez. */
  const instances = useMemo<InstancedRigidBodyProps[]>(() => {
    const list: InstancedRigidBodyProps[] = new Array(capacity);
    for (let i = 0; i < capacity; i++) {
      list[i] = { key: i, position: [0, PARK_Y - i, 0] };
    }
    return list;
  }, [capacity]);

  useEffect(() => {
    const m = mesh.current;
    if (m === null) return;
    m.frustumCulled = false;
    // instanceColor arranca en null; inicializar las 50 antes del primer render
    // evita la recompilación de shader al primer setColorAt en medio de escena.
    for (let i = 0; i < capacity; i++) m.setColorAt(i, GOLD);
    if (m.instanceColor !== null) m.instanceColor.needsUpdate = true;
  }, [capacity]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    clock.current += dt;
    const now = clock.current;

    const list = bodies.current;
    if (list === null) return;

    /* --- fase 2 del retiro: dormir lo que ya se encogió el frame pasado --- */
    for (let i = 0; i < capacity; i++) {
      if (slotState[i] !== SLOT_RETIRING) continue;
      const body = list[i];
      if (body !== null) {
        if (USE_DISABLE_OPTIMIZATION) body.setEnabled(false);
        else body.sleep();
      }
      slotState[i] = SLOT_FREE;
    }

    /* --- retiro + foco de cámara, en el mismo recorrido --- */
    beginFrame(focus);
    for (let i = 0; i < capacity; i++) {
      if (slotState[i] !== SLOT_ACTIVE) continue;
      const body = list[i];
      if (body === null) continue;
      const t = body.translation();
      if (t.y <= Y_KILL || now - activatedAt[i] >= MAX_LIFETIME) {
        retire(body, i);
        continue;
      }
      accumulate(focus, t.x, t.y);
    }
    endFrame(focus, IMPACT_DECAY);

    /* --- spawns desde la cola, con contrapresión --- */
    let spawned = 0;
    while (spawned < MAX_SPAWNS_PER_FRAME) {
      const trade = trades.pop();
      if (trade === null) break;
      const slot = claimSlot(now);
      const body = list[slot];
      // `break`, no `continue`: con el slot sin cuerpo todavía, seguir iterando
      // vaciaba la cola entera contra nada. Los trades se quedan encolados y
      // se gastan en el próximo frame, que es cuando ya hay cuerpo.
      if (body === null) break;
      activate(body, slot, trade.side === 'buy', trade.size, trade.whale, now);
      if (trade.whale) focus.impact = 1;
      spawned++;
    }
    // Si la cola sigue llena tras el tope del frame, se descarta lo viejo: ya
    // no representa el mercado actual y reproducirlo sería una ráfaga falsa.
    if (trades.count > capacity * 2) trades.clear();

    if (spawned > 0) {
      const m = mesh.current;
      if (m !== null && m.instanceColor !== null) m.instanceColor.needsUpdate = true;
    }
  });

  /** Reciclado: libre primero, después el que ya se está retirando, y recién
   *  ahí el activo más viejo. Nunca crece el pool ni se descarta en silencio. */
  function claimSlot(now: number): number {
    for (let i = 0; i < capacity; i++) if (slotState[i] === SLOT_FREE) return i;
    for (let i = 0; i < capacity; i++) if (slotState[i] === SLOT_RETIRING) return i;
    let oldest = 0;
    let oldestAt = Infinity;
    for (let i = 0; i < capacity; i++) {
      if (activatedAt[i] < oldestAt) { oldestAt = activatedAt[i]; oldest = i; }
    }
    void now;
    return oldest;
  }

  function setScale(body: RapierRigidBody, value: number): void {
    const state = rigidBodyStates.get(body.handle);
    if (state !== undefined) state.scale.set(value, value, value);
  }

  function activate(
    body: RapierRigidBody,
    slot: number,
    fromLeft: boolean,
    size: number,
    whale: boolean,
    now: number,
  ): void {
    const median = stats.tradeMedian > 0 ? stats.tradeMedian : size;
    const magnitude = Math.log1p(size / median);

    let scale = THREE.MathUtils.clamp(SCALE_MIN + magnitude * SCALE_GAIN, SCALE_MIN, SCALE_MAX);
    if (whale) scale = Math.min(SCALE_MAX * WHALE_SCALE_MULT, scale * WHALE_SCALE_MULT);

    const dir = fromLeft ? 1 : -1;
    vec.x = fromLeft ? -SPAWN_X : SPAWN_X;
    vec.y = SPAWN_Y_MIN + (SPAWN_Y_MAX - SPAWN_Y_MIN) * pseudoRandom(slot, now);
    vec.z = 0;
    body.setTranslation(vec, true);

    // Reseteo obligatorio. Sin esto el cuerpo reciclado conserva el momento del
    // uso anterior y sale disparado de forma aparentemente aleatoria.
    body.setLinvel(zero, false);
    body.setAngvel(zero, false);
    body.resetForces(true);

    setScale(body, scale);
    const collider = body.collider(0);
    if (collider !== null) collider.setRadius(CHAR_RADIUS * scale);

    body.wakeUp();

    const impulse = THREE.MathUtils.clamp(magnitude * IMPULSE_GAIN, IMPULSE_MIN, IMPULSE_MAX);
    vec.x = dir * impulse;
    vec.y = impulse * 0.25;
    vec.z = 0;
    body.applyImpulse(vec, true);

    paint(slot, fromLeft, whale);

    slotState[slot] = SLOT_ACTIVE;
    activatedAt[slot] = now;
  }

  /**
   * Un `setColorAt` por spawn, y un solo `needsUpdate` por frame al final del
   * bucle: subir el buffer de colores una vez por instancia costaría 6 uploads
   * por frame en el peor caso.
   */
  function paint(slot: number, fromLeft: boolean, whale: boolean): void {
    const m = mesh.current;
    if (m === null) return;
    if (whale) {
      scratchColor.setRGB(
        GOLD.r * WHALE_HDR_GAIN,
        GOLD.g * WHALE_HDR_GAIN,
        GOLD.b * WHALE_HDR_GAIN,
      );
      m.setColorAt(slot, scratchColor);
    } else {
      m.setColorAt(slot, fromLeft ? BULL : BEAR);
    }
  }

  function retire(body: RapierRigidBody, slot: number): void {
    body.setLinvel(zero, false);
    body.setAngvel(zero, false);
    body.resetForces(true);
    vec.x = 0;
    vec.y = PARK_Y - slot;
    vec.z = 0;
    body.setTranslation(vec, true);
    setScale(body, 0);
    // No se duerme acá: el bucle de sincronización saltea los cuerpos dormidos
    // y la escala 0 no llegaría a escribirse. Se duerme el frame siguiente.
    slotState[slot] = SLOT_RETIRING;
  }

  return (
    <InstancedRigidBodies
      ref={bodies}
      instances={instances}
      type="dynamic"
      colliders={false}
      colliderNodes={[<BallCollider args={[CHAR_RADIUS]} restitution={0.35} friction={0.6} />]}
      ccd
      linearDamping={0.08}
      angularDamping={0.4}
      canSleep
    >
      <instancedMesh
        ref={mesh}
        args={[undefined, undefined, capacity]}
        count={capacity}
        castShadow={false}
        receiveShadow={false}
      >
        <icosahedronGeometry args={[CHAR_RADIUS, 1]} />
        {lowQuality
          ? <meshBasicMaterial toneMapped={false} />
          : <meshToonMaterial toneMapped={false} />}
      </instancedMesh>
    </InstancedRigidBodies>
  );
}

/** Ruido determinista y barato para variar la altura de aparición. */
function pseudoRandom(slot: number, now: number): number {
  const x = Math.sin(slot * 12.9898 + now * 78.233) * 43758.5453;
  return x - Math.floor(x);
}
