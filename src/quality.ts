/**
 * Se resuelve UNA vez, al montar `startGame` (`src/render/game.ts`), y decide
 * si se agrega el filtro `AdvancedBloomFilter` a `glowLayer` o no — es el
 * filtro más caro del render y en gama media/baja se nota. No hay toggle de
 * UI ni remontaje en caliente: Pixi no tiene el costo de recompilar
 * `WebGLProgram` que tenía cambiar de material en three.js, así que no hace
 * falta.
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
