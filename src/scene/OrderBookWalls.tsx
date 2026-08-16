import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { CuboidCollider, RigidBody } from '@react-three/rapier';
import type { RapierCollider } from '@react-three/rapier';
import type { ProcessedBook } from '../types/binance';
import { BOOK_LEVELS } from '../types/binance';
import type { FeedStats } from '../net/feedCore';

/**
 * Módulo 3 — el escenario.
 *
 * Dos capas deliberadamente desacopladas:
 *
 *   VISUAL  40 instancias en UN draw call, refrescadas a 10 Hz con el snapshot.
 *   FÍSICA  3 colliders en total (2 muros + la plataforma del spread), a 4 Hz.
 *
 * No se envuelve el instancedMesh en <RigidBody>: un InstancedMesh es un único
 * Object3D y no admite un collider por instancia. <InstancedRigidBodies> sí
 * existe, pero crea un cuerpo real por instancia — ahorra draw calls, no ahorra
 * simulación — y como la altura es el volumen, cambiar la forma de 40 colliders
 * diez veces por segundo implica recrearlos y bloquea el hilo principal.
 */

export const INSTANCE_COUNT = BOOK_LEVELS * 2;

/** Semiancho del escenario en unidades de mundo. */
export const STAGE_HALF_WIDTH = 9;
/** Semiancho del hueco central donde vive la plataforma del spread. */
export const SPREAD_HALF_WIDTH = 0.9;
/** Y del piso de las plataformas. Los personajes caen desde arriba. */
export const STAGE_FLOOR_Y = 0;

const PLATFORM_WIDTH = 0.34;
const PLATFORM_DEPTH = 0.9;
const HEIGHT_GAIN = 2.4;
const MIN_HEIGHT = 0.12;

/** Ningún collider más fino que 0,2: los finos son la causa #1 de tunneling. */
const MIN_HALF_EXTENT = 0.15;
const PHYSICS_HZ = 4;
const PHYSICS_INTERVAL = 1 / PHYSICS_HZ;

/** Un nivel por encima de este múltiplo de la mediana se dibuja en HDR. */
const HDR_THRESHOLD = 2.5;
const HDR_GAIN = 2.6;

const BULL = new THREE.Color('#00FF66');
const BEAR = new THREE.Color('#FF0055');

/* Temporales a nivel de módulo. Nada de esto se asigna dentro del bucle. */
const dummy = new THREE.Object3D();
const scratchColor = new THREE.Color();
/** Rapier acepta cualquier {x,y,z}; se reutiliza para no asignar por update. */
const halfExtents = { x: 0, y: 0, z: 0 };
const translation = { x: 0, y: 0, z: 0 };

export interface OrderBookWallsProps {
  book: ProcessedBook;
  stats: FeedStats;
  /**
   * Se resuelve en el montaje y NO debe cambiar en caliente: alternar el tipo
   * de material fuerza compilar y linkear un WebGLProgram nuevo, con freeze.
   */
  lowQuality?: boolean;
}

export function OrderBookWalls({ book, stats, lowQuality = false }: OrderBookWallsProps): React.JSX.Element {
  const mesh = useRef<THREE.InstancedMesh | null>(null);
  const bidWall = useRef<RapierCollider | null>(null);
  const askWall = useRef<RapierCollider | null>(null);

  const lastDrawnId = useRef(-1);
  const physicsClock = useRef(0);
  /** Semiespan de precio del escenario, amortiguado para que no salte. */
  const span = useRef(1);

  useEffect(() => {
    const m = mesh.current;
    if (m === null) return;

    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // `instanceColor` arranca en null. La transición null → no-null en el primer
    // setColorAt cambia los parámetros del programa y fuerza una recompilación de
    // shader en medio de la escena. Se inicializan las 40 acá, antes del primer
    // render, aunque todavía no tengan el color definitivo.
    for (let i = 0; i < INSTANCE_COUNT; i++) {
      m.setColorAt(i, i < BOOK_LEVELS ? BULL : BEAR);
    }
    if (m.instanceColor !== null) m.instanceColor.needsUpdate = true;

    // Todas fuera de cámara hasta el primer snapshot, para no mostrar 40 cubos
    // apilados en el origen durante el handshake del WebSocket.
    dummy.position.set(0, -999, 0);
    dummy.scale.set(0.001, 0.001, 0.001);
    dummy.updateMatrix();
    for (let i = 0; i < INSTANCE_COUNT; i++) m.setMatrixAt(i, dummy.matrix);
    m.instanceMatrix.needsUpdate = true;
    m.frustumCulled = false;
  }, []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const m = mesh.current;
    if (m === null) return;

    physicsClock.current += dt;
    const doPhysics = physicsClock.current >= PHYSICS_INTERVAL;

    if (book.lastUpdateId === lastDrawnId.current) {
      if (doPhysics) physicsClock.current = 0;
      return;
    }
    lastDrawnId.current = book.lastUpdateId;

    const mid = book.mid;
    if (mid <= 0) return;

    const qtyRef = stats.bookQtyMedian > 0 ? stats.bookQtyMedian : 1;

    // Semiespan objetivo: el nivel más lejano del snapshot. Amortiguado, porque
    // un span crudo hace que el escenario respire con cada snapshot.
    let farthest = 0;
    if (book.bidCount > 0) farthest = Math.max(farthest, mid - book.bidPrices[book.bidCount - 1]);
    if (book.askCount > 0) farthest = Math.max(farthest, book.askPrices[book.askCount - 1] - mid);
    if (farthest > 0) {
      span.current = THREE.MathUtils.damp(span.current, farthest, 3, dt);
    }
    const usable = STAGE_HALF_WIDTH - SPREAD_HALF_WIDTH;
    const xScale = usable / Math.max(span.current, 1e-9);

    /* --- matrices de instancia -------------------------------------- */
    // Un solo Object3D dummy reutilizado: position → scale → updateMatrix →
    // setMatrixAt. Cero Object3D / Vector3 / Matrix4 / Color creados acá.
    let bidReach = 0;
    let askReach = 0;
    let bidHeight = 0;
    let askHeight = 0;

    for (let i = 0; i < BOOK_LEVELS; i++) {
      // Bids a la izquierda (índices 0..19), asks a la derecha (20..39).
      writeSide(m, i, i, book.bidPrices, book.bidQtys, book.bidCount, mid, -1, xScale, qtyRef);
      writeSide(m, BOOK_LEVELS + i, i, book.askPrices, book.askQtys, book.askCount, mid, 1, xScale, qtyRef);
    }

    for (let i = 0; i < book.bidCount; i++) {
      const x = (mid - book.bidPrices[i]) * xScale + SPREAD_HALF_WIDTH;
      if (x > bidReach) bidReach = x;
      bidHeight += heightFor(book.bidQtys[i], qtyRef);
    }
    for (let i = 0; i < book.askCount; i++) {
      const x = (book.askPrices[i] - mid) * xScale + SPREAD_HALF_WIDTH;
      if (x > askReach) askReach = x;
      askHeight += heightFor(book.askQtys[i], qtyRef);
    }
    if (book.bidCount > 0) bidHeight /= book.bidCount;
    if (book.askCount > 0) askHeight /= book.askCount;

    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor !== null) m.instanceColor.needsUpdate = true;

    /* --- capa física, como mucho 4 veces por segundo ------------------ */
    if (!doPhysics) return;
    physicsClock.current = 0;

    updateWall(bidWall.current, -1, bidReach, bidHeight);
    updateWall(askWall.current, 1, askReach, askHeight);
  });

  return (
    <>
      <instancedMesh
        ref={mesh}
        args={[undefined, undefined, INSTANCE_COUNT]}
        count={INSTANCE_COUNT}
        castShadow={false}
        receiveShadow={false}
      >
        <boxGeometry args={[PLATFORM_WIDTH, 1, PLATFORM_DEPTH]} />
        {lowQuality
          ? <meshBasicMaterial toneMapped={false} />
          : <meshToonMaterial toneMapped={false} />}
      </instancedMesh>

      <RigidBody type="fixed" colliders={false}>
        {/* Plataforma del spread: el centro del ring, siempre en X = 0. */}
        <CuboidCollider
          args={[SPREAD_HALF_WIDTH, 0.18, PLATFORM_DEPTH / 2]}
          position={[0, STAGE_FLOOR_Y - 0.18, 0]}
        />
        {/* Los muros NO replican los 40 niveles: 2 cuboides que aproximan la
            silueta agregada, redimensionados con setHalfExtents sobre la ref. */}
        <CuboidCollider ref={bidWall} args={[MIN_HALF_EXTENT, MIN_HALF_EXTENT, PLATFORM_DEPTH / 2]} />
        <CuboidCollider ref={askWall} args={[MIN_HALF_EXTENT, MIN_HALF_EXTENT, PLATFORM_DEPTH / 2]} />
      </RigidBody>
    </>
  );
}

/** Escala logarítmica anclada a la mediana móvil, no al máximo del instante. */
function heightFor(qty: number, qtyRef: number): number {
  return Math.max(MIN_HEIGHT, Math.log1p(qty / qtyRef) * HEIGHT_GAIN);
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
  const distance = Math.abs(prices[level] - mid) * xScale + SPREAD_HALF_WIDTH;

  dummy.position.set(dir * distance, STAGE_FLOOR_Y + height / 2, 0);
  dummy.scale.set(1, height, 1);
  dummy.updateMatrix();
  m.setMatrixAt(instance, dummy.matrix);

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

/**
 * Redimensiona un muro con setHalfExtents sobre la ref del collider.
 * Nunca desmontando y remontando componentes de React: eso destruiría y
 * recrearía el cuerpo rígido cuatro veces por segundo.
 */
function updateWall(
  collider: RapierCollider | null,
  dir: -1 | 1,
  reach: number,
  height: number,
): void {
  if (collider === null) return;

  const inner = SPREAD_HALF_WIDTH;
  const outer = Math.max(reach, inner + MIN_HALF_EXTENT * 2);

  halfExtents.x = Math.max(MIN_HALF_EXTENT, (outer - inner) / 2);
  halfExtents.y = Math.max(MIN_HALF_EXTENT, height / 2);
  halfExtents.z = PLATFORM_DEPTH / 2;
  collider.setHalfExtents(halfExtents);

  translation.x = dir * (inner + halfExtents.x);
  translation.y = STAGE_FLOOR_Y + halfExtents.y;
  translation.z = 0;
  collider.setTranslationWrtParent(translation);
}
