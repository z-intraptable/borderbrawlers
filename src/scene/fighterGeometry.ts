import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * La silueta del peleador.
 *
 * **Esta es la costura para el arte.** Todo el juego —física, IA, empujones,
 * KOs— trata al personaje como una cápsula con un radio. Lo único que decide
 * cómo se ve es esta función. Cambiar las primitivas por un plano con atlas de
 * sprites, cuando exista el arte, toca este archivo y el material de
 * `FighterPool`, y nada más: ni el feed, ni la física, ni el comportamiento.
 *
 * Se fusiona todo en UNA geometría a propósito. Un `InstancedMesh` dibuja una
 * geometría por draw call; con cabeza, torso y puños como mallas separadas
 * serían tres draw calls por parte en vez de uno para los 16 personajes.
 *
 * Cabeza grande y cuerpo chico no es un capricho: es lo que hace que una figura
 * se lea a 40 píxeles de alto. Es la misma razón por la que los personajes de
 * Brawlhalla son cabezones.
 */

/**
 * Más grande de lo que pedía la escala del escenario: con 0,22 el peleador
 * quedaba del tamaño de una barra del libro y no se leía. Un personaje tiene
 * que ganarle en presencia al decorado.
 */
export const FIGHTER_RADIUS = 0.34;
/** Media altura del cilindro de la cápsula, sin las tapas. */
export const FIGHTER_HALF_HEIGHT = 0.3;
/** Del centro a los pies. La IA lo necesita para saber si está parado. */
export const FIGHTER_FEET_OFFSET = FIGHTER_RADIUS + FIGHTER_HALF_HEIGHT;

/**
 * Los segmentos están al mínimo que todavía se ve redondo. Con 16 personajes
 * son ~5k triángulos, sobre un presupuesto que hoy usa 4,5k en total: alcanza
 * de sobra, pero no hay motivo para gastar de más en algo que se ve chico.
 */
export function createFighterGeometry(): THREE.BufferGeometry {
  const torso = new THREE.CapsuleGeometry(FIGHTER_RADIUS * 0.78, FIGHTER_HALF_HEIGHT * 1.6, 4, 10);
  torso.translate(0, -FIGHTER_RADIUS * 0.35, 0);

  const head = new THREE.SphereGeometry(FIGHTER_RADIUS * 0.72, 12, 8);
  head.translate(0, FIGHTER_HALF_HEIGHT + FIGHTER_RADIUS * 0.25, 0);

  // Dos puños al frente. Rompen la simetría vertical y dan el gesto de guardia.
  const fistL = new THREE.SphereGeometry(FIGHTER_RADIUS * 0.36, 8, 6);
  fistL.translate(-FIGHTER_RADIUS * 0.85, -FIGHTER_RADIUS * 0.1, FIGHTER_RADIUS * 0.35);
  const fistR = fistL.clone();
  fistR.translate(FIGHTER_RADIUS * 1.7, 0, 0);

  const merged = mergeGeometries([torso, head, fistL, fistR], false);
  torso.dispose();
  head.dispose();
  fistL.dispose();
  fistR.dispose();

  if (merged === null) {
    // mergeGeometries devuelve null si los atributos no coinciden. Con estas
    // primitivas no puede pasar, pero un fallback silencioso es mejor que una
    // escena vacía sin explicación.
    return new THREE.CapsuleGeometry(FIGHTER_RADIUS, FIGHTER_HALF_HEIGHT, 4, 10);
  }
  merged.computeVertexNormals();
  return merged;
}
