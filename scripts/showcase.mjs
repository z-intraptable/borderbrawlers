/**
 * Captura el banco de pruebas del elenco, una imagen por pose.
 *
 * Es la contraparte de `shoot.mjs`: aquel mira la escena entera, este mira sólo
 * a los personajes, grandes y sin nada encima. Cuando se toca una pose, esto es
 * lo que dice si quedó bien.
 *
 *   node scripts/showcase.mjs [solo]
 *
 * `solo` es una lista separada por comas de armaduras — `asuri,deadpool` — y
 * deja sólo a ésos, grandes. Sin eso salen los diecinueve en grilla.
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = 'shots/elenco';
const solo = process.argv[2] ? `&solo=${process.argv[2]}` : '';
/** Las mismas poses que `src/dev/showcase.ts`. Se piden por nombre, una por carga. */
const TOUR = [
  ['idle'], ['run'], ['jump'], ['fall'], ['hurt'],
  ['attack_punch'], ['attack_kick'], ['skill'], ['super'],
];

spawnSync('fuser', ['-k', '5199/tcp'], { stdio: 'ignore' });
const vite = spawn('npx', ['vite', '--port', '5199', '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('vite no arrancó')), 30000);
  vite.stdout.on('data', (chunk) => {
    if (String(chunk).includes('Local:')) { clearTimeout(timer); resolve(); }
  });
});

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: chromium.executablePath(),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const SIZE = { width: 1280, height: 620 };
/**
 * El tamaño que van a tener las imágenes. La ventana, en cambio, crece un píxel
 * por captura y el recorte se hace con `clip` — ver `capturar()`, que explica por
 * qué.
 *
 * El resumen: en este contenedor el WebGL lo emula SwiftShader por software, y
 * ahí el primer cuadro de Pixi se dibuja pero no se entrega. La captura sale con
 * el color de fondo y nada más, sin un solo error en consola, igual que si la
 * escena estuviera vacía. Agrandar la ventana invalida el buffer y lo obliga a
 * entregarlo; achicarla no. Medido: cero píxeles pintados antes, dieciocho mil
 * después.
 */
const page = await browser.newPage({ viewport: SIZE });

/**
 * Cuánto puede pesar un PNG de 1280x620 de un solo color. Una captura en blanco
 * ronda los 3,7 kB porque comprime a nada; una con el personaje dibujado pasa
 * los 15 kB. No hace falta decodificar la imagen para distinguirlas, y así el
 * script no necesita una librería de imágenes para verificar su propio trabajo.
 */
const VACIA = 8000;
const INTENTOS = 6;

let sobra = 0;

/**
 * Captura, y si sale en blanco vuelve a intentar.
 *
 * El empujón de tamaño entrega el cuadro casi siempre, pero no siempre: es una
 * carrera contra el compositor y con nueve poses seguidas fallaban dos o tres,
 * cambiando de pose entre corridas. Perseguir el temporizado exacto es pelearle
 * a algo que no está bajo control; verificar el resultado sí lo está.
 *
 * Si tras `INTENTOS` sigue en blanco, corta con error en vez de dejar una imagen
 * vacía en `shots/`: una captura en blanco que nadie mira se lee como "el
 * personaje no se dibuja" y manda a buscar el defecto al lado equivocado.
 */
async function capturar(destino, etiqueta) {
  for (let intento = 1; intento <= INTENTOS; intento++) {
    sobra += 1;
    await page.setViewportSize({
      width: SIZE.width + sobra,
      height: SIZE.height + sobra,
    });
    await page.waitForTimeout(400);
    const png = await page.screenshot({
      clip: { x: 0, y: 0, width: SIZE.width, height: SIZE.height },
    });
    if (png.length >= VACIA) {
      writeFileSync(destino, png);
      return intento;
    }
  }
  throw new Error(`${etiqueta}: salió en blanco en ${INTENTOS} intentos`);
}

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

for (let i = 0; i < TOUR.length; i++) {
  const [label] = TOUR[i];
  // Una carga por pose, con la pose fijada. Capturar por tiempo sobre el
  // recorrido automático dejaba las imágenes rotuladas con la pose de al lado
  // en cuanto un frame tardaba de más.
  await page.goto(`http://localhost:5199/showcase.html?pose=${label}${solo}`, {
    waitUntil: 'networkidle',
  });
  // Lo justo para que la acción llegue a su punto de extensión máxima.
  await page.waitForTimeout(500);
  const intentos = await capturar(
    `${OUT}/${String(i).padStart(2, '0')}-${label}.png`, label,
  );
  console.log(`  ${label.padEnd(14)} ${intentos > 1 ? `${intentos} intentos` : 'ok'}`);
}

console.log(errors.length === 0 ? 'consola limpia' : `ERRORES (${errors.length}):`);
for (const e of errors.slice(0, 10)) console.log('  ', e);

await browser.close();
try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* ya murió */ }
process.exit(errors.length === 0 ? 0 : 1);
