/**
 * Se resuelve UNA vez, al montar `startGame` (`src/render/game.ts`), y decide
 * si se agrega el filtro `AdvancedBloomFilter` a `glowLayer` o no — es el
 * filtro más caro del render y en gama media/baja se nota. No hay toggle de
 * UI ni remontaje en caliente: Pixi no tiene el costo de recompilar
 * `WebGLProgram` que tenía cambiar de material en three.js, así que no hace
 * falta.
 */
// Nombres de GPU que identifican gama baja/media cuando aparecen en el
// string de WEBGL_debug_renderer_info. No es una lista exhaustiva: es sólo
// lo bastante grande para separar "gama baja/media conocida" de "todo lo
// demás", que se trata como capaz por defecto (ver comentario en
// `detectLowQuality` sobre por qué el default cambió de sospechar a confiar).
const GPU_GAMA_BAJA = [
  // Adreno de gama media/baja (Snapdragon 4/6-series y 7-series viejos).
  /adreno \(tm\) (2|3|4|5)\d\d/i,
  /adreno \(tm\) 6[0-1]\d/i,
  // Mali de gama baja/media (Txxx es de hace más de ocho años; G3x/G5x/G6x
  // cubre los SoC de entrada de Exynos/MediaTek, no los Ultra/Pro).
  /mali-t\d/i,
  /mali-g3\d/i,
  /mali-g5\d/i,
  /mali-g6\d/i,
  // PowerVR viejo (iPhone 6s y anteriores, tablets Android de entrada).
  /powervr sgx/i,
  /powervr rogue/i,
];

/**
 * Lee el modelo real de GPU vía WEBGL_debug_renderer_info. Devuelve `null` si
 * el navegador no expone la extensión (algunos, por privacidad, la bloquean
 * o la enmascaran) — en ese caso `detectLowQuality` cae al heurístico viejo.
 */
function leerGpu(): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl');
    if (!gl || !('getExtension' in gl)) return null;
    const info = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info');
    if (!info) return null;
    const renderer = (gl as WebGLRenderingContext)
      .getParameter(info.UNMASKED_RENDERER_WEBGL) as string;
    return typeof renderer === 'string' ? renderer : null;
  } catch {
    return null;
  }
}

export function detectLowQuality(): boolean {
  if (typeof navigator === 'undefined') return false;

  // Primero se intenta identificar la GPU real. Un teléfono de gama alta
  // (iPhone reciente, Galaxy S/Note Ultra) reporta pocos núcleos en
  // `hardwareConcurrency` igual que uno de gama media —Apple nunca contó más
  // de 6-8, sea el chip que sea— así que ese número solo no alcanza para
  // distinguirlos. La GPU sí: un SoC de entrada usa una Adreno o Mali de
  // gama baja identificable por nombre; un flagship no. Si el navegador
  // esconde el string (algunos lo hacen por privacidad), se cae al
  // heurístico anterior en vez de asumir que es débil.
  const gpu = leerGpu();
  if (gpu !== null) {
    return GPU_GAMA_BAJA.some((patron) => patron.test(gpu));
  }

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
