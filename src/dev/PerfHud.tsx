import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';

/**
 * Medidor de presupuesto de frame. Reemplaza a `r3f-perf`, que arrastra
 * `@react-three/drei@^9` (React 18 / R3F v8) y ensucia todo el árbol de peers.
 *
 * Muestra en vivo el criterio de aceptación de la Parte E:
 * `renderer.info.render.calls <= 12`. El contador se pone rojo al pasarse.
 *
 * Escribe en el DOM por `ref`, no por estado: montar el medidor no puede
 * costar re-renders del árbol que está midiendo.
 */

export interface PerfHudProps {
  /** Umbral de draw calls del criterio de aceptación. */
  maxDrawCalls?: number;
  /** Cada cuántos ms refrescar el texto. El muestreo es por frame igual. */
  refreshMs?: number;
}

const OK = '#00FF66';
const BAD = '#FF0055';
const DIM = '#5b6472';

export function PerfHud({ maxDrawCalls = 12, refreshMs = 250 }: PerfHudProps): null {
  const gl = useThree((state) => state.gl);
  const host = useRef<HTMLDivElement | null>(null);
  const rows = useRef<Record<string, HTMLSpanElement>>({});

  // Acumuladores del período. Nada de esto pasa por React.
  const frames = useRef(0);
  const elapsed = useRef(0);
  const worstFrame = useRef(0);
  const worstCalls = useRef(0);

  useEffect(() => {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;top:8px;right:8px;z-index:9999;padding:8px 10px;' +
      'background:rgba(11,15,25,.82);border:1px solid #263041;border-radius:6px;' +
      'font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e6edf3;' +
      'pointer-events:none;min-width:150px';

    for (const label of ['fps', 'frame ms', 'peor ms', 'draw calls', 'peor calls', 'triángulos', 'programas', 'texturas', 'geometrías']) {
      const line = document.createElement('div');
      line.style.cssText = 'display:flex;justify-content:space-between;gap:12px';
      const name = document.createElement('span');
      name.textContent = label;
      name.style.color = DIM;
      const value = document.createElement('span');
      value.textContent = '—';
      line.append(name, value);
      el.appendChild(line);
      rows.current[label] = value;
    }

    document.body.appendChild(el);
    host.current = el;
    return () => {
      el.remove();
      host.current = null;
      rows.current = {};
    };
  }, []);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    const ms = dt * 1000;
    frames.current++;
    elapsed.current += ms;
    if (ms > worstFrame.current) worstFrame.current = ms;

    const info = gl.info;
    const calls = info.render.calls;
    if (calls > worstCalls.current) worstCalls.current = calls;

    if (elapsed.current < refreshMs || host.current === null) return;

    const avg = elapsed.current / frames.current;
    const set = (label: string, text: string, color?: string): void => {
      const node = rows.current[label];
      if (node === undefined) return;
      node.textContent = text;
      node.style.color = color ?? '#e6edf3';
    };

    set('fps', (1000 / avg).toFixed(0), avg <= 16.6 ? OK : BAD);
    set('frame ms', avg.toFixed(2), avg <= 16.6 ? OK : BAD);
    set('peor ms', worstFrame.current.toFixed(2), worstFrame.current <= 16.6 ? OK : BAD);
    set('draw calls', `${calls} / ${maxDrawCalls}`, calls <= maxDrawCalls ? OK : BAD);
    set('peor calls', String(worstCalls.current), worstCalls.current <= maxDrawCalls ? OK : BAD);
    set('triángulos', info.render.triangles.toLocaleString('es-AR'));
    set('programas', String(info.programs?.length ?? 0));
    set('texturas', String(info.memory.textures));
    set('geometrías', String(info.memory.geometries));

    frames.current = 0;
    elapsed.current = 0;
    worstFrame.current = 0;
  });

  return null;
}
