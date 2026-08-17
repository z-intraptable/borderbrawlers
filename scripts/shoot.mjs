/**
 * Captura la escena corriendo, en headless, sobre el feed mock.
 *
 * No reemplaza mirar el juego en una máquina con GPU —acá el WebGL lo emula
 * SwiftShader por software y los fps no significan nada—, pero sí prueba lo que
 * más se rompe al tocar la capa de render: que arranque sin un error de consola
 * y que lo que se dibuja esté donde tiene que estar.
 *
 *   node scripts/shoot.mjs [segundos] [escenario]
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const seconds = Number(process.argv[2] ?? 12);
const scenario = process.argv[3] ?? 'normal';
const stage = process.argv[4] ? `&stage=${process.argv[4]}` : '';
const OUT = 'shots';

// `npx` deja un hijo suyo escuchando aunque se le mande SIGTERM al padre, así
// que el puerto se libera a la fuerza antes de arrancar y el servidor se lanza
// como líder de su propio grupo para poder matarlo entero al final.
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
  // El navegador está preinstalado en el contenedor y la versión de Playwright
  // del proyecto no coincide con la suya, así que se apunta al binario.
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(`http://localhost:5199/?source=mock&scenario=${scenario}${stage}`, {
  waitUntil: 'networkidle',
});

for (let i = 1; i <= seconds; i++) {
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/${scenario}-${String(i).padStart(2, '0')}.png` });
}

// Lo que el juego cree de sí mismo, leído del canvas ya corriendo.
const report = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  return { canvas: canvas ? `${canvas.width}x${canvas.height}` : 'sin canvas' };
});

console.log('canvas:', report.canvas);
console.log(errors.length === 0 ? 'consola limpia' : `ERRORES (${errors.length}):`);
for (const e of errors.slice(0, 10)) console.log('  ', e);

await browser.close();
try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* ya murió */ }
process.exit(errors.length === 0 ? 0 : 1);
