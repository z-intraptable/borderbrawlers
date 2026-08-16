import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { FeedStats } from '../net/feedCore';
import { bookShare } from '../game/fighters';
import { TEAM_GREEN } from '../game/fighters';

/**
 * El fondo: el volumen del libro, hecho cielo.
 *
 * Dos hogueras, verde a la izquierda y roja a la derecha, cuya altura y furia
 * salen de la liquidez de cada lado del order book. El cielo se tiñe hacia el
 * color del que va ganando. Es la misma información que las barras, contada de
 * una manera que se lee sin mirar: si el cielo está verde, están comprando.
 *
 * Un quad y un shader — un solo draw call, sin texturas que descargar. El fuego
 * es ruido de valor con dominio deformado, que es la receta clásica y la única
 * que da algo orgánico sin un asset detrás.
 *
 * Los núcleos de las llamas se escriben por encima de 1,0 a propósito: el Bloom
 * los levanta por luminancia y quedan encendidos de verdad. El cielo se queda
 * por debajo para no bañar la pantalla entera de halo.
 */

/**
 * Se pasa la posición en MUNDO, no la UV del plano.
 *
 * Con UV, lo que se dibuja depende del tamaño y la posición del quad: el
 * horizonte cae donde termina la geometría, no donde está el piso del
 * escenario, y basta agrandar el plano para que el fuego quede fuera de cuadro.
 * En coordenadas de mundo, "el fuego sale del piso" significa literalmente
 * y = 0, que es donde está el piso.
 */
const VERTEX = /* glsl */ `
  varying vec2 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xy;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vWorld;

  uniform float uTime;
  /** Cuota del libro del lado comprador, 0 a 1. 0,5 es empate. */
  uniform float uGreenShare;
  /** Intensidad absoluta de cada hoguera, ya normalizada. */
  uniform float uGreenFire;
  uniform float uRedFire;

  const vec3 VOID_DARK = vec3(0.043, 0.059, 0.098);
  /** Y del piso del escenario, en unidades de mundo. */
  const float FLOOR_Y = -1.0;
  const vec3 GREEN = vec3(0.0, 1.0, 0.4);
  const vec3 RED = vec3(1.0, 0.0, 0.333);

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
      total += noise(p) * amplitude;
      p *= 2.02;
      amplitude *= 0.5;
    }
    return total;
  }

  /**
   * Una hoguera. "side" es el centro horizontal y "power" cuanto sube.
   * El desplazamiento hacia arriba con el tiempo es lo que la hace lamer.
   */
  float fire(vec2 world, float centerX, float power, float seed) {
    // Todo en unidades de mundo: la base del fuego es el piso del escenario.
    float x = (world.x - centerX) / 5.0;
    float y = (world.y - FLOOR_Y) / 11.0;
    if (y < -0.15) return 0.0;

    // El dominio se deforma con ruido lento: sin esto son rayas verticales.
    float warp = fbm(vec2(x * 2.2 + seed, y * 1.6 - uTime * 0.5)) - 0.5;
    x += warp * 0.45;

    // Columna angosta y flicker de frecuencia alta: es la diferencia entre
    // fuego y niebla. Con el ruido lento y la columna ancha queda una nube
    // teñida, que es lo que había antes.
    float column = exp(-abs(x) * 3.6);
    float flicker = fbm(vec2(x * 6.0 + seed, y * 5.0 - uTime * 1.8));
    float height = power * (0.35 + flicker * 0.85);
    float body = smoothstep(height, height * 0.15, y);
    float tongues = smoothstep(0.35, 0.85, flicker);
    return column * body * (0.25 + tongues * 1.5);
  }

  void main() {
    // Cielo: oscuro arriba, teñido cerca del piso hacia el color del que domina.
    float advantage = uGreenShare - 0.5;
    vec3 tint = mix(RED, GREEN, smoothstep(-0.18, 0.18, advantage));
    float dominance = clamp(abs(advantage) * 3.6, 0.0, 1.0);

    // El cielo tiñe, no ilumina: si compite con los personajes, el escenario se
    // come la pelea. Todo el peso visual va en las llamas.
    float horizon = smoothstep(18.0, FLOOR_Y - 6.0, vWorld.y);
    vec3 sky = VOID_DARK + tint * pow(horizon, 2.0) * 0.07 * (0.3 + dominance);
    sky += tint * pow(horizon, 6.0) * 0.13 * dominance;

    float green = fire(vWorld, -6.0, uGreenFire, 0.0);
    float red = fire(vWorld, 6.0, uRedFire, 37.0);

    // Núcleo por encima de 1,0 para que el Bloom lo encienda de verdad.
    vec3 color = sky + GREEN * green * 2.1 + RED * red * 2.1;
    gl_FragColor = vec4(color, 1.0);
  }
`;

export interface StageBackdropProps {
  stats: FeedStats;
}

/**
 * Tan grande que cubre el frustum en cualquier zoom, y lo bastante atrás como
 * para que nada de la pelea lo toque. La cámara ortográfica no da perspectiva,
 * así que "lejos" acá es sólo orden de dibujado.
 */
const WIDTH = 160;
const HEIGHT = 110;
const DEPTH = -30;
/** Centrado en el escenario: el mapeo es por mundo, así que sólo tiene que cubrir. */
const CENTER_Y = 6;

export function StageBackdrop({ stats }: StageBackdropProps): React.JSX.Element {
  const uniforms = useMemo(() => ({
    uTime: { value: 0 },
    uGreenShare: { value: 0.5 },
    uGreenFire: { value: 0.25 },
    uRedFire: { value: 0.25 },
  }), []);

  const smoothed = useRef({ share: 0.5, green: 0.25, red: 0.25 });

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    uniforms.uTime.value += dt;

    const share = bookShare(stats.bidVolume, stats.askVolume, TEAM_GREEN);
    // La hoguera mide el volumen del lado contra el total: así una sesión
    // tranquila y una frenética se ven distintas, pero ninguna se sale de escala.
    const total = stats.bidVolume + stats.askVolume;
    const scale = total > 0 ? Math.min(1, Math.log1p(total) / 8) : 0;
    const green = 0.18 + share * scale * 1.1;
    const red = 0.18 + (1 - share) * scale * 1.1;

    // Amortiguado: el libro cambia diez veces por segundo y un fondo que
    // parpadea a 10 Hz es insoportable de mirar.
    const s = smoothed.current;
    s.share = THREE.MathUtils.damp(s.share, share, 1.2, dt);
    s.green = THREE.MathUtils.damp(s.green, green, 1.6, dt);
    s.red = THREE.MathUtils.damp(s.red, red, 1.6, dt);

    uniforms.uGreenShare.value = s.share;
    uniforms.uGreenFire.value = s.green;
    uniforms.uRedFire.value = s.red;
  });

  return (
    <mesh position={[0, CENTER_Y, DEPTH]} frustumCulled={false}>
      <planeGeometry args={[WIDTH, HEIGHT]} />
      <shaderMaterial
        vertexShader={VERTEX}
        fragmentShader={FRAGMENT}
        uniforms={uniforms}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}
