/**
 * El modo de baja calidad se resuelve UNA vez, en el montaje. Cambiar
 * `MeshToonMaterial` por `MeshBasicMaterial` en caliente fuerza compilar y
 * linkear un `WebGLProgram` nuevo y produce un freeze visible, así que el
 * toggle de la UI remonta la escena entera con una `key` en vez de mutar
 * materiales existentes.
 */
export function detectLowQuality(): boolean {
  if (typeof navigator === 'undefined') return false;

  const cores = navigator.hardwareConcurrency ?? 4;
  const width = typeof window === 'undefined' ? 1920 : window.innerWidth;
  const height = typeof window === 'undefined' ? 1080 : window.innerHeight;
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;

  // Muchos píxeles con pocos núcleos es el peor caso: móviles de gama media.
  const pixels = width * height * Math.min(dpr, 2);

  if (cores <= 4) return true;
  if (pixels > 4_000_000 && cores < 8) return true;
  return false;
}
