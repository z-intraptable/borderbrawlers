import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { StageFocus } from './stageFocus';
import { STAGE_FLOOR_Y, STAGE_HALF_WIDTH } from './OrderBookWalls';

/**
 * Módulo 5 — cámara ortográfica dinámica, estilo Smash Bros.
 *
 * Sigue el centroide de los personajes activos y ajusta el zoom para que la
 * caja que los contiene entre en pantalla, todo amortiguado con `damp`.
 *
 * Trampa que se olvida siempre: R3F sólo llama a `updateProjectionMatrix()`
 * cuando cambia el tamaño del canvas. Si se modifica `camera.zoom` dentro de
 * `useFrame`, hay que llamarlo a mano EN ESE MISMO FRAME o el zoom no tiene
 * ningún efecto visible. No lanza ningún error, así que es un bug confuso.
 */

/** Margen alrededor de la caja de personajes, en unidades de mundo. */
const PADDING = 2.2;
/** Encuadre en reposo: el escenario completo más un poco de aire. */
const IDLE_HALF_WIDTH = STAGE_HALF_WIDTH + 2.5;
const IDLE_HALF_HEIGHT = 6.5;
const IDLE_CENTER_Y = STAGE_FLOOR_Y + 2.6;

/**
 * El zoom NO se clampea directo: en R3F una cámara ortográfica tiene el
 * frustum en unidades de píxel (`camera.right === size.width / 2`), así que un
 * zoom "razonable" ronda 50–100 y depende de la resolución. Lo que se clampea
 * es cuánto mundo se ve, que es independiente de la pantalla.
 */
/**
 * El mínimo es ancho a propósito. Con 4 la cámara se cerraba sobre los
 * peleadores cuando se juntaban y el escenario desaparecía de cuadro: se veían
 * seis muñecos gigantes flotando sobre un fondo vacío, sin plataformas ni
 * referencia de dónde estaba el borde. En Smash la cámara nunca deja de mostrar
 * el ring, y esa es justamente la información que hace entender la pelea.
 */
const MIN_VIEW_HALF_WIDTH = 8;
const MAX_VIEW_HALF_WIDTH = STAGE_HALF_WIDTH + 5;
const MIN_VIEW_HALF_HEIGHT = 5;
const MAX_VIEW_HALF_HEIGHT = 10;

/** Lambda de `damp`: más alto, más rápido. Separados a propósito. */
const ZOOM_LAMBDA = 2.6;
const PAN_LAMBDA = 3.8;

/** Cuánto puede alejarse la cámara del centro del escenario. */
const PAN_LIMIT_X = STAGE_HALF_WIDTH * 0.3;
const PAN_LIMIT_Y_MIN = STAGE_FLOOR_Y - 0.5;
const PAN_LIMIT_Y_MAX = STAGE_FLOOR_Y + 4;

const SHAKE_GAIN = 0.22;

export interface DynamicCameraProps {
  focus: StageFocus;
  enabled?: boolean;
}

export function DynamicCamera({ focus, enabled = true }: DynamicCameraProps): null {
  const camera = useThree((state) => state.camera);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    if (!enabled) return;

    // Semiancho y semialto del frustum a zoom 1. Se lee cada frame porque R3F
    // lo reescribe al cambiar el tamaño del canvas.
    const frustumHalfW = (camera as THREE.OrthographicCamera).right;
    const frustumHalfH = (camera as THREE.OrthographicCamera).top;
    if (!Number.isFinite(frustumHalfW) || frustumHalfW <= 0) return;

    let targetX: number;
    let targetY: number;
    let needHalfW: number;
    let needHalfH: number;

    if (focus.count > 0) {
      targetX = focus.centroidX;
      targetY = focus.centroidY;
      // El encuadre tiene que contener a los peleadores Y al escenario: seguir
      // sólo a los personajes deja el ring fuera de cuadro justo cuando se
      // juntan, que es cuando más falta hace ver dónde está el borde.
      needHalfW = Math.max((focus.maxX - focus.minX) / 2 + PADDING, IDLE_HALF_WIDTH * 0.75);
      needHalfH = Math.max((focus.maxY - focus.minY) / 2 + PADDING, IDLE_HALF_HEIGHT * 0.7);
    } else {
      // Un escenario vacío no puede disparar el zoom al infinito.
      targetX = 0;
      targetY = IDLE_CENTER_Y;
      needHalfW = IDLE_HALF_WIDTH;
      needHalfH = IDLE_HALF_HEIGHT;
    }

    targetX = THREE.MathUtils.clamp(targetX, -PAN_LIMIT_X, PAN_LIMIT_X);
    targetY = THREE.MathUtils.clamp(targetY, PAN_LIMIT_Y_MIN, PAN_LIMIT_Y_MAX);

    needHalfW = THREE.MathUtils.clamp(needHalfW, MIN_VIEW_HALF_WIDTH, MAX_VIEW_HALF_WIDTH);
    needHalfH = THREE.MathUtils.clamp(needHalfH, MIN_VIEW_HALF_HEIGHT, MAX_VIEW_HALF_HEIGHT);

    // El menor de los dos: hay que satisfacer ancho Y alto.
    const targetZoom = Math.min(frustumHalfW / needHalfW, frustumHalfH / needHalfH);

    camera.position.x = THREE.MathUtils.damp(camera.position.x, targetX, PAN_LAMBDA, dt);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, targetY, PAN_LAMBDA, dt);
    camera.zoom = THREE.MathUtils.damp(camera.zoom, targetZoom, ZOOM_LAMBDA, dt);

    if (focus.impact > 0) {
      const amount = focus.impact * SHAKE_GAIN;
      camera.position.x += (Math.random() * 2 - 1) * amount;
      camera.position.y += (Math.random() * 2 - 1) * amount;
    }

    // Obligatorio en el mismo frame que se tocó el zoom.
    camera.updateProjectionMatrix();
  });

  return null;
}
