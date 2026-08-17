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
import { mkdirSync } from 'node:fs';

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
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 620 } });

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
  await page.screenshot({ path: `${OUT}/${String(i).padStart(2, '0')}-${label}.png` });
}

console.log(errors.length === 0 ? 'consola limpia' : `ERRORES (${errors.length}):`);
for (const e of errors.slice(0, 10)) console.log('  ', e);

await browser.close();
try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* ya murió */ }
process.exit(errors.length === 0 ? 0 : 1);
