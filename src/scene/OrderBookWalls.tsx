import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import type { RapierRigidBody } from '@react-three/rapier';
import type { ProcessedBook } from '../types/binance';
import { BOOK_LEVELS } from '../types/binance';
import type { FeedStats } from '../net/feedCore';
import type { Skyline } from '../game/fighters';
import { createBarTexture, createPlatformTexture, createToonGradient } from './materials';

/**
 * Módulo 3 — el escenario, que ahora es también el piso de la pelea.
 *
 * Tres capas:
 *
 *   BARRAS      40 instancias en UN draw call, la liquidez cruda, a 10 Hz.
 *   PLATAFORMAS 9 losas en UN draw call, lo único que se pisa.
 *   FÍSICA      9 colliders, uno por losa.
 *
 * Dos decisiones que sostienen todo lo demás:
 *
 * 1. **Las losas son `kinematicPosition`, no `fixed`.** Un cuerpo fijo que se
 *    teletransporta con `setTranslation` no barre contra los dinámicos: los
 *    personajes se hundirían o quedarían trabados cuando la plataforma crece
 *    abajo de ellos. Con cuerpos cinemáticos movidos por
 *    `setNextKinematicTranslation`, Rapier resuelve el contacto y el personaje
 *    viaja arriba de la plataforma que sube, que es justo lo que se quiere ver.
 *
 * 2. **Las losas no cambian de tamaño: sólo de altura.** El invariante viejo
 *    decía "sólo 3 colliders" porque recrear 40 colliders diez veces por segundo
 *    bloquea el hilo principal — y sigue siendo cierto. Acá no se recrea ni se
 *    redimensiona nada: 9 cuerpos con medias extensiones constantes que sólo se
 *    mueven en Y. Es más barato que el `setHalfExtents` a 4 Hz que había antes,
 *    y encima da un escenario estable en X, que es condición para que un salto
 *    se pueda calcular.
 */

export const INSTANCE_COUNT = BOOK_LEVELS * 2;

/** Semiancho del escenario en unidades de mundo. */
export const STAGE_HALF_WIDTH = 9;
/**
 * Semiancho de la plataforma central, la que siempre está.
 *
 * Ancha a propósito: es el escenario principal, como el de Battlefield en
 * Smash. Con 0,9 los seis peleadores no entraban y terminaban apilados uno
 * sobre la cabeza del otro en vez de peleando.
 */
export const SPREAD_HALF_WIDTH = 2.4;
/** Y de referencia del escenario. */
export const STAGE_FLOOR_Y = 0;

/* --- geometría de las plataformas ---------------------------------- */

export const PLATFORMS_PER_SIDE = 4;
/** 4 por lado más la central. */
export const PLATFORM_COUNT = PLATFORMS_PER_SIDE * 2 + 1;

const PLATFORM_HALF_HEIGHT = 0.16;
const PLATFORM_DEPTH = 1.2;
/** Desde dónde arrancan las plataformas laterales. */
const SIDE_INNER = 3.1;
const SIDE_SLOT = (STAGE_HALF_WIDTH - SIDE_INNER) / PLATFORMS_PER_SIDE;
/**
 * Semiancho de cada losa. El hueco que queda entre losas (~0,5) es
 * deliberado: sin pozos no hay nada que saltar y la pelea es una fila india.
 */
const PLATFORM_HALF_WIDTH = SIDE_SLOT / 2 - 0.25;

/** Altura mínima: si el mercado se seca, igual tiene que quedar dónde pelear. */
const PLATFORM_MIN_Y = 0.6;
const PLATFORM_MAX_Y = 7.5;
/**
 * Tope de velocidad vertical de una plataforma, en unidades por segundo. Es la
 * red de contención contra el caso feo: una losa que sube de golpe atraviesa al
 * personaje que tiene encima en vez de empujarlo.
 */
const PLATFORM_MAX_SPEED = 2.2;
const PLATFORM_LAMBDA = 2.5;

/* --- barras del libro ---------------------------------------------- */

const BAR_WIDTH = 0.3;
const BAR_DEPTH = 0.5;
const HEIGHT_GAIN = 2.4;
const MIN_HEIGHT = 0.12;

/** Un nivel por encima de este múltiplo de la mediana se dibuja en HDR. */
const HDR_THRESHOLD = 2.5;
const HDR_GAIN = 2.6;

const BULL = new THREE.Color('#00FF66');
const BEAR = new THREE.Color('#FF0055');
/** Las losas van en un gris frío que no compite con los equipos. */
const PLATFORM_COLOR = new THREE.Color('#8fa3c8');
const PLATFORM_EDGE = new THREE.Color('#dbe6ff');

/* Temporales a nivel de módulo. Nada de esto se asigna dentro del bucle. */
const dummy = new THREE.Object3D();
const scratchColor = new THREE.Color();
/** Rapier acepta cualquier {x,y,z}; se reutiliza para no asignar por frame. */
const kinematic = { x: 0, y: 0, z: 0 };

export interface OrderBookWallsProps {
  book: ProcessedBook;
  stats: FeedStats;
  /** El escenario lo escribe; la IA de los peleadores lo lee. */
  skyline: Skyline;
  /**
   * Se resuelve en el montaje y NO debe cambiar en caliente: alternar el tipo
   * de material fuerza compilar y linkear un WebGLProgram nuevo, con freeze.
   */
  lowQuality?: boolean;
}

/** Centro en X de cada plataforma. Fijo: sólo se mueve la altura. */
function platformCenterX(index: number): number {
  if (index === 0) return 0;
  const side = index <= PLATFORMS_PER_SIDE ? -1 : 1;
  const slot = (index - 1) % PLATFORMS_PER_SIDE;
  return side * (SIDE_INNER + SIDE_SLOT * slot + SIDE_SLOT / 2);
}

function platformHalfWidth(index: number): number {
  return index === 0 ? SPREAD_HALF_WIDTH : PLATFORM_HALF_WIDTH;
}

export function OrderBookWalls({ book, stats, skyline, lowQuality = false }: OrderBookWallsProps): React.JSX.Element {
  const bars = useRef<THREE.InstancedMesh | null>(null);
  const slabs = useRef<THREE.InstancedMesh | null>(null);
  const bodies = useRef<(RapierRigidBody | null)[]>([]);

  const lastDrawnId = useRef(-1);
  /** Semiespan de precio del escenario, amortiguado para que no salte. */
  const span = useRef(1);
  /** Altura objetivo y actual de cada plataforma. */
  const targetY = useMemo(() => new Float64Array(PLATFORM_COUNT).fill(PLATFORM_MIN_Y), []);
  const currentY = useMemo(() => new Float64Array(PLATFORM_COUNT).fill(PLATFORM_MIN_Y), []);

  const gradient = useMemo(() => createToonGradient(4), []);
  const platformMap = useMemo(createPlatformTexture, []);
  const barMap = useMemo(createBarTexture, []);
  useEffect(() => () => {
    gradient.dispose();
    platformMap.dispose();
    barMap?.dispose();
  }, [gradient, platformMap, barMap]);

  // Los rangos en X son fijos, así que el skyline se dibuja una sola vez.
  useEffect(() => {
    for (let i = 0; i < PLATFORM_COUNT; i++) {
      const cx = platformCenterX(i);
      const half = platformHalfWidth(i);
      skyline.minX[i] = cx - half;
      skyline.maxX[i] = cx + half;
      skyline.topY[i] = i === 0 ? STAGE_FLOOR_Y : PLATFORM_MIN_Y;
    }
    targetY[0] = STAGE_FLOOR_Y;
    currentY[0] = STAGE_FLOOR_Y;
  }, [skyline, targetY, currentY]);

  useEffect(() => {
    const m = bars.current;
    if (m === null) return;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // `instanceColor` arranca en null. La transición null → no-null en el primer
    // setColorAt fuerza una recompilación de shader en medio de la escena, así
    // que se inicializan todas antes del primer render.
    for (let i = 0; i < INSTANCE_COUNT; i++) m.setColorAt(i, i < BOOK_LEVELS ? BULL : BEAR);
    if (m.instanceColor !== null) m.instanceColor.needsUpdate = true;

    dummy.position.set(0, -999, 0);
    dummy.scale.set(0.001, 0.001, 0.001);
    dummy.updateMatrix();
    for (let i = 0; i < INSTANCE_COUNT; i++) m.setMatrixAt(i, dummy.matrix);
    m.instanceMatrix.needsUpdate = true;
    m.frustumCulled = false;
  }, []);

  useEffect(() => {
    const m = slabs.current;
    if (m === null) return;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < PLATFORM_COUNT; i++) {
      m.setColorAt(i, i === 0 ? PLATFORM_EDGE : PLATFORM_COLOR);
    }
    if (m.instanceColor !== null) m.instanceColor.needsUpdate = true;
    m.frustumCulled = false;
  }, []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);

    /* --- 1. barras del libro, sólo si hay snapshot nuevo -------------- */
    const m = bars.current;
    if (m !== null && book.lastUpdateId !== lastDrawnId.current && book.mid > 0) {
      lastDrawnId.current = book.lastUpdateId;
      redrawBook(m, book, stats, span, dt, targetY);
    }

    /* --- 2. plataformas, todos los frames ---------------------------- */
    // Un cuerpo cinemático quiere su destino cada frame: es lo que hace que
    // Rapier lo barra contra los dinámicos en vez de teletransportarlo.
    const slab = slabs.current;
    for (let i = 0; i < PLATFORM_COUNT; i++) {
      const goal = THREE.MathUtils.clamp(targetY[i], PLATFORM_MIN_Y, PLATFORM_MAX_Y);
      const next = THREE.MathUtils.damp(currentY[i], goal, PLATFORM_LAMBDA, dt);
      const limit = PLATFORM_MAX_SPEED * dt;
      const step = THREE.MathUtils.clamp(next - currentY[i], -limit, limit);
      currentY[i] = i === 0 ? STAGE_FLOOR_Y : currentY[i] + step;
      skyline.topY[i] = currentY[i];

      const body = bodies.current[i];
      if (body !== null && body !== undefined) {
        kinematic.x = platformCenterX(i);
        kinematic.y = currentY[i] - PLATFORM_HALF_HEIGHT;
        kinematic.z = 0;
        body.setNextKinematicTranslation(kinematic);
      }

      if (slab !== null) {
        dummy.position.set(platformCenterX(i), currentY[i] - PLATFORM_HALF_HEIGHT, 0);
        dummy.scale.set(platformHalfWidth(i) * 2, PLATFORM_HALF_HEIGHT * 2, PLATFORM_DEPTH);
        dummy.updateMatrix();
        slab.setMatrixAt(i, dummy.matrix);
      }
    }
    if (slab !== null) slab.instanceMatrix.needsUpdate = true;
  });

  return (
    <>
      {/* Barras: la liquidez cruda, sin colisión. Son el telón, no el piso. */}
      <instancedMesh
        ref={bars}
        args={[undefined, undefined, INSTANCE_COUNT]}
        count={INSTANCE_COUNT}
        castShadow={false}
        receiveShadow={false}
      >
        <boxGeometry args={[BAR_WIDTH, 1, BAR_DEPTH]} />
        {lowQuality
          ? <meshBasicMaterial toneMapped={false} />
          : <meshToonMaterial gradientMap={gradient} toneMapped={false} />}
      </instancedMesh>

      {/* Losas: lo único que se pisa. Un draw call para las nueve. */}
      <instancedMesh
        ref={slabs}
        args={[undefined, undefined, PLATFORM_COUNT]}
        count={PLATFORM_COUNT}
        castShadow={false}
        receiveShadow={false}
      >
        <boxGeometry args={[1, 1, 1]} />
        {lowQuality
          ? <meshBasicMaterial map={platformMap} toneMapped={false} />
          : <meshToonMaterial map={platformMap} gradientMap={gradient} toneMapped={false} />}
      </instancedMesh>

      {Array.from({ length: PLATFORM_COUNT }, (_, i) => (
        <RigidBody
          key={i}
          ref={(el) => { bodies.current[i] = el; }}
          type={i === 0 ? 'fixed' : 'kinematicPosition'}
          colliders={false}
          position={[platformCenterX(i), PLATFORM_MIN_Y - PLATFORM_HALF_HEIGHT, 0]}
        >
          <CuboidCollider
            args={[platformHalfWidth(i), PLATFORM_HALF_HEIGHT, PLATFORM_DEPTH / 2]}
            friction={0.9}
            restitution={0}
          />
        </RigidBody>
      ))}
    </>
  );
}

/** Escala logarítmica anclada a la mediana móvil, no al máximo del instante. */
function heightFor(qty: number, qtyRef: number): number {
  return Math.max(MIN_HEIGHT, Math.log1p(qty / qtyRef) * HEIGHT_GAIN);
}

/**
 * Redibuja las 40 barras y, de paso, deja la altura objetivo de cada plataforma.
 * Se recorre el libro una sola vez para las dos cosas.
 */
function redrawBook(
  m: THREE.InstancedMesh,
  book: ProcessedBook,
  stats: FeedStats,
  span: { current: number },
  dt: number,
  targetY: Float64Array,
): void {
  const mid = book.mid;
  const qtyRef = stats.bookQtyMedian > 0 ? stats.bookQtyMedian : 1;

  let farthest = 0;
  if (book.bidCount > 0) farthest = Math.max(farthest, mid - book.bidPrices[book.bidCount - 1]);
  if (book.askCount > 0) farthest = Math.max(farthest, book.askPrices[book.askCount - 1] - mid);
  if (farthest > 0) span.current = THREE.MathUtils.damp(span.current, farthest, 3, dt);

  const usable = STAGE_HALF_WIDTH - SIDE_INNER;
  const xScale = usable / Math.max(span.current, 1e-9);

  // La altura de cada plataforma es la barra MÁS ALTA que la toca, no el
  // promedio: con el promedio la mitad de las barras atraviesan la losa.
  for (let i = 1; i < PLATFORM_COUNT; i++) targetY[i] = PLATFORM_MIN_Y;

  for (let level = 0; level < BOOK_LEVELS; level++) {
    writeSide(m, level, level, book.bidPrices, book.bidQtys, book.bidCount, mid, -1, xScale, qtyRef, targetY);
    writeSide(m, BOOK_LEVELS + level, level, book.askPrices, book.askQtys, book.askCount, mid, 1, xScale, qtyRef, targetY);
  }

  m.instanceMatrix.needsUpdate = true;
  if (m.instanceColor !== null) m.instanceColor.needsUpdate = true;
}

function writeSide(
  m: THREE.InstancedMesh,
  instance: number,
  level: number,
  prices: Float64Array,
  qtys: Float64Array,
  count: number,
  mid: number,
  dir: -1 | 1,
  xScale: number,
  qtyRef: number,
  targetY: Float64Array,
): void {
  if (level >= count) {
    dummy.position.set(0, -999, 0);
    dummy.scale.set(0.001, 0.001, 0.001);
    dummy.updateMatrix();
    m.setMatrixAt(instance, dummy.matrix);
    return;
  }

  const qty = qtys[level];
  const height = heightFor(qty, qtyRef);
  const x = dir * (Math.abs(prices[level] - mid) * xScale + SIDE_INNER);

  dummy.position.set(x, STAGE_FLOOR_Y + height / 2, 0);
  dummy.scale.set(1, height, 1);
  dummy.updateMatrix();
  m.setMatrixAt(instance, dummy.matrix);

  // ¿Sobre qué plataforma cae esta barra? Los rangos son fijos, así que es una
  // división, no una búsqueda.
  const side = dir < 0 ? 0 : PLATFORMS_PER_SIDE;
  const slot = Math.floor((Math.abs(x) - SIDE_INNER) / SIDE_SLOT);
  if (slot >= 0 && slot < PLATFORMS_PER_SIDE) {
    const platform = 1 + side + slot;
    if (height > targetY[platform]) targetY[platform] = height;
  }

  // Ruta HDR: MeshToonMaterial expone `emissive` por draw call, no por
  // instancia, así que el brillo selectivo se consigue escribiendo colores
  // fuera del rango 0–1 y dejando que el Bloom los levante por luminancia.
  const base = dir < 0 ? BULL : BEAR;
  const excess = qty / qtyRef;
  if (excess > HDR_THRESHOLD) {
    const gain = 1 + Math.min(HDR_GAIN, (excess - HDR_THRESHOLD) * 0.5);
    scratchColor.setRGB(base.r * gain, base.g * gain, base.b * gain);
    m.setColorAt(instance, scratchColor);
  } else {
    m.setColorAt(instance, base);
  }
}
