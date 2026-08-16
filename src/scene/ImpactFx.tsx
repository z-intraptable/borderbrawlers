import { useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * Chispas de golpe y estrellas de KO.
 *
 * Un pool de quads en un `InstancedMesh`: un draw call para todos los efectos
 * de la escena. Nada de física, nada de React — `FighterPool` llama a `emit()`
 * desde su `useFrame` y este componente los envejece en el suyo.
 *
 * El material va aditivo y sin profundidad de escritura, así que el fundido de
 * salida se hace oscureciendo el color hacia el negro: sobre aditivo, negro es
 * transparente. Eso evita necesitar alpha por instancia, que `InstancedMesh` no
 * expone sin un shader propio.
 */

export const FX_CAPACITY = 48;

export const FX_SPARK = 0;
export const FX_STAR = 1;

export interface ImpactPool {
  /** Cabeza del ring buffer: el efecto más viejo se pisa sin drama. */
  head: number;
  x: Float32Array;
  y: Float32Array;
  /** Edad en segundos. `>= life` significa libre. */
  age: Float32Array;
  life: Float32Array;
  size: Float32Array;
  kind: Uint8Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

export function createImpactPool(): ImpactPool {
  const pool: ImpactPool = {
    head: 0,
    x: new Float32Array(FX_CAPACITY),
    y: new Float32Array(FX_CAPACITY),
    age: new Float32Array(FX_CAPACITY),
    life: new Float32Array(FX_CAPACITY),
    size: new Float32Array(FX_CAPACITY),
    kind: new Uint8Array(FX_CAPACITY),
    r: new Float32Array(FX_CAPACITY),
    g: new Float32Array(FX_CAPACITY),
    b: new Float32Array(FX_CAPACITY),
  };
  pool.age.fill(1);
  pool.life.fill(1);
  return pool;
}

/** Alta de un efecto. Sin asignaciones: sólo escribe en los arrays. */
export function emit(
  pool: ImpactPool,
  kind: number,
  x: number,
  y: number,
  size: number,
  r: number,
  g: number,
  b: number,
): void {
  const i = pool.head;
  pool.head = (pool.head + 1) % FX_CAPACITY;
  pool.x[i] = x;
  pool.y[i] = y;
  pool.age[i] = 0;
  pool.life[i] = kind === FX_STAR ? 0.9 : 0.28;
  pool.size[i] = size;
  pool.kind[i] = kind;
  pool.r[i] = r;
  pool.g[i] = g;
  pool.b[i] = b;
}

const FX_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vTint;
  void main() {
    vUv = uv;
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor;
    #else
      vTint = vec3(1.0);
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FX_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  varying vec3 vTint;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float a = atan(p.y, p.x);
    // Cuatro puntas sobre un núcleo redondo: la silueta clásica del impacto.
    float spikes = 0.5 + 0.5 * pow(abs(cos(a * 2.0)), 6.0);
    float d = r / max(spikes, 0.001);
    float glow = smoothstep(1.0, 0.0, d);
    glow = pow(glow, 2.2);
    // Sobre mezcla aditiva el alpha no importa: lo que apaga es el color.
    gl_FragColor = vec4(vTint * glow, 1.0);
  }
`;

const dummy = new THREE.Object3D();
const scratch = new THREE.Color();

export interface ImpactFxProps {
  pool: ImpactPool;
}

export function ImpactFx({ pool }: ImpactFxProps): React.JSX.Element {
  const mesh = useRef<THREE.InstancedMesh | null>(null);

  useEffect(() => {
    const m = mesh.current;
    if (m === null) return;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    // Inicializar el color de todas antes del primer render evita la
    // recompilación de shader al primer setColorAt en medio de la escena.
    for (let i = 0; i < FX_CAPACITY; i++) m.setColorAt(i, scratch.setRGB(0, 0, 0));
    if (m.instanceColor !== null) m.instanceColor.needsUpdate = true;
    dummy.position.set(0, -999, 0);
    dummy.scale.set(0.001, 0.001, 0.001);
    dummy.updateMatrix();
    for (let i = 0; i < FX_CAPACITY; i++) m.setMatrixAt(i, dummy.matrix);
    m.instanceMatrix.needsUpdate = true;
  }, []);

  useFrame((_, delta) => {
    const m = mesh.current;
    if (m === null) return;
    const dt = Math.min(delta, 0.1);

    for (let i = 0; i < FX_CAPACITY; i++) {
      const life = pool.life[i];
      let age = pool.age[i];
      if (age >= life) {
        dummy.position.set(0, -999, 0);
        dummy.scale.set(0.001, 0.001, 0.001);
        dummy.updateMatrix();
        m.setMatrixAt(i, dummy.matrix);
        continue;
      }
      age += dt;
      pool.age[i] = age;

      const t = age / life;
      const fade = 1 - t;
      // La chispa se abre de golpe y se apaga; la estrella sube mientras gira.
      const star = pool.kind[i] === FX_STAR;
      const scale = pool.size[i] * (star ? 0.6 + t * 0.8 : 0.4 + t * 1.9);
      const rise = star ? t * 2.4 : 0;

      dummy.position.set(pool.x[i], pool.y[i] + rise, 0.4);
      dummy.rotation.z = star ? t * 6 : i * 0.7;
      dummy.scale.set(scale, scale, scale);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);

      // Sobre mezcla aditiva, oscurecer ES desvanecer.
      const k = fade * fade;
      scratch.setRGB(pool.r[i] * k, pool.g[i] * k, pool.b[i] * k);
      m.setColorAt(i, scratch);
    }

    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor !== null) m.instanceColor.needsUpdate = true;
    dummy.rotation.z = 0;
  });

  return (
    <instancedMesh
      ref={mesh}
      args={[undefined, undefined, FX_CAPACITY]}
      count={FX_CAPACITY}
      castShadow={false}
      receiveShadow={false}
    >
      <planeGeometry args={[1, 1]} />
      {/* Un quad plano se ve como lo que es: un cuadrado. La forma la pone el
          shader — núcleo radial con cuatro puntas, que sirve igual para la
          chispa del golpe y para la estrella del KO.

          three declara solo `instanceMatrix` e `instanceColor` en el prefijo
          del vertex shader cuando el objeto es un InstancedMesh, así que un
          ShaderMaterial crudo los recibe sin declararlos a mano. */}
      <shaderMaterial
        vertexShader={FX_VERTEX}
        fragmentShader={FX_FRAGMENT}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        toneMapped={false}
      />
    </instancedMesh>
  );
}
