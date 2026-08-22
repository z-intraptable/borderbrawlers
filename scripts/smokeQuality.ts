/* Smoke test de detectLowQuality. No forma parte del bundle. */
import { detectLowQuality } from '../src/quality';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${name} ${detail}`);
  } else {
    console.log(`  ok    ${name} ${detail}`);
  }
}

/**
 * `detectLowQuality` primero intenta leer la GPU real vía
 * `WEBGL_debug_renderer_info` (`leerGpu`, en `src/quality.ts`), y esa lectura
 * pasa por `document.createElement('canvas')`. En Node no hay `document`, así
 * que `leerGpu` devuelve `null` sola y la función cae siempre al heurístico
 * de núcleos/píxeles — que es justo lo que este archivo prueba. El camino de
 * GPU real (los patrones de `GPU_GAMA_BAJA`) sólo se ejercita en un browser
 * de verdad, y no hay forma barata de simular `WEBGL_debug_renderer_info`
 * sin un contexto WebGL real detrás.
 */
function con<T>(props: {
  cores?: number;
  width?: number;
  height?: number;
  dpr?: number;
  sinNavigator?: boolean;
}, run: () => T): T {
  const g = globalThis as Record<string, unknown>;
  const previousNavigator = Object.getOwnPropertyDescriptor(g, 'navigator');
  const previousWindow = Object.getOwnPropertyDescriptor(g, 'window');
  // Node 21+ define `navigator` como getter de sólo lectura en el global; una
  // asignación directa (`g.navigator = …`) tira TypeError. `defineProperty`
  // con `configurable: true` lo pisa igual, y ese mismo flag es lo que
  // permite restaurarlo después sin dejar el global de Node roto para el
  // resto de la suite.
  function set(name: string, value: unknown): void {
    Object.defineProperty(g, name, { value, configurable: true, writable: true });
  }
  function restore(name: string, descriptor: PropertyDescriptor | undefined): void {
    if (descriptor === undefined) delete g[name];
    else Object.defineProperty(g, name, descriptor);
  }
  if (props.sinNavigator) {
    restore('navigator', undefined);
    restore('window', undefined);
  } else {
    set('navigator', { hardwareConcurrency: props.cores ?? 8 });
    set('window', {
      innerWidth: props.width ?? 1920,
      innerHeight: props.height ?? 1080,
      devicePixelRatio: props.dpr ?? 1,
    });
  }
  try {
    return run();
  } finally {
    restore('navigator', previousNavigator);
    restore('window', previousWindow);
  }
}

console.log('\n== pocos núcleos, siempre baja calidad ==');
{
  const low = con({ cores: 4, width: 800, height: 600, dpr: 1 }, detectLowQuality);
  check('4 núcleos entra en baja calidad aunque la pantalla sea chica', low === true);

  const low2 = con({ cores: 2, width: 3840, height: 2160, dpr: 1 }, detectLowQuality);
  check('2 núcleos entra en baja calidad', low2 === true);
}

console.log('\n== muchos píxeles con pocos núcleos: el peor caso de un móvil ==');
{
  // 2560x1440 a dpr 2 son 7,37M de píxeles: pasa el umbral de 4M.
  const low = con({ cores: 6, width: 2560, height: 1440, dpr: 2 }, detectLowQuality);
  check('6 núcleos + pantalla grande entra en baja calidad', low === true,
    '(el caso móvil de gama media que el comentario del código describe)');

  const ok = con({ cores: 6, width: 1024, height: 768, dpr: 1 }, detectLowQuality);
  check('6 núcleos + pantalla chica NO entra en baja calidad', ok === false);
}

console.log('\n== ocho núcleos o más: nunca baja calidad, sin importar la pantalla ==');
{
  const ok = con({ cores: 8, width: 3840, height: 2160, dpr: 2 }, detectLowQuality);
  check('8 núcleos con pantalla 4K sigue en calidad normal', ok === false);

  const ok16 = con({ cores: 16, width: 3840, height: 2160, dpr: 2 }, detectLowQuality);
  check('16 núcleos con pantalla 4K sigue en calidad normal', ok16 === false);
}

console.log('\n== el devicePixelRatio se topa en 2 ==');
{
  // dpr 3 y dpr 2 tienen que dar el mismo resultado: la fórmula lo capa con
  // Math.min(dpr, 2). Sin ese tope, un teléfono con dpr 3 contaría el doble
  // de píxeles de los que en verdad dibuja el renderer (`resolution` de Pixi
  // también se topa en 2, ver `startGame`).
  const conDprAlto = con({ cores: 6, width: 2000, height: 1100, dpr: 3 }, detectLowQuality);
  const conDprTope = con({ cores: 6, width: 2000, height: 1100, dpr: 2 }, detectLowQuality);
  check('dpr 3 se comporta igual que dpr 2 (tope aplicado)', conDprAlto === conDprTope);
}

console.log('\n== sin navigator (SSR o entorno sin browser) ==');
{
  const ok = con({ sinNavigator: true }, detectLowQuality);
  check('sin navigator no rompe y devuelve calidad normal', ok === false);
}

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
