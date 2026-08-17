/**
 * Graba la escena corriendo, en headless, sobre el feed mock.
 *
 *   node scripts/video.mjs [cuadros] [escenario] [armadura]
 *
 * Deja dos cosas en `shots/video/`: un `.webm` grabado por Playwright, que es
 * un video de verdad, y los cuadros sueltos, con los que `scripts/gif.py` arma
 * un GIF.
 *
 * Por qué las dos. El `.webm` corre en tiempo real, y en este contenedor el
 * WebGL lo emula SwiftShader por software: la escena se dibuja a unos pocos
 * cuadros por segundo y el video sale a tirones aunque el juego esté bien. Los
 * cuadros sueltos, en cambio, se reproducen a la velocidad que uno quiera:
 * cada uno es un estado distinto de la pelea, así que armados a 20 por segundo
 * se ve continuo, sólo que el tiempo pasa más rápido que en la realidad. Para
 * mirar si la animación funciona, eso sirve; el `.webm` sirve para ver el ritmo
 * verdadero en una máquina con GPU.
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';

const frames = Number(process.argv[2] ?? 120);
const scenario = process.argv[3] ?? 'volatile';
/**
 * El tercer argumento es el nombre de una armadura —`asuri`, `deadpool`— y
 * cambia lo que se graba: en vez de la pelea entera, el banco de pruebas con
 * ese personaje solo y recortado. En el plano general un peleador ocupa
 * cuarenta píxeles y no se le ve la animación; el banco lo tiene quieto en una
 * posición fija, así que se captura al doble de densidad y **el recorte lo hace
 * `gif.py` midiendo los cuadros**. Calcular acá dónde cae el personaje no
 * funcionó: entre `resizeTo`, la densidad del dispositivo y el reescalado que
 * hace Playwright para grabar el video, el recorte terminaba en el fondo vacío.
 * Medir el resultado no depende de ninguna de esas tres cosas.
 */
const solo = process.argv[4] ?? '';
const banco = solo !== '';
const OUT = 'shots/video';
const SIZE = banco ? { width: 1280, height: 720 } : { width: 960, height: 540 };
/**
 * Dónde queda un personaje solo en el banco. No es un número medido a ojo: sale
 * de la misma cuenta que hace `src/dev/showcase.ts` con una sola columna, y por
 * eso vale para cualquier personaje y no sólo para el que se probó.
 *
 * La densidad va en 2 y no en 3 a propósito. El banco divide por
 * `renderer.resolution`, que está topeado en 2; con `deviceScaleFactor` en 3 los
 * dos números dejan de coincidir y el recorte cae en el fondo vacío.
 */
const DENSITY = 2;

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

// Se borra sólo lo de esta corrida. Borrar la carpeta entera se llevaba puesto
// el GIF de la anterior, y borrar todos los `.webm` se llevaba el video de la
// otra grabación, que es justo lo que uno quiere conservar. Por eso el video
// crudo cae en una carpeta propia y desechable: Playwright le pone un nombre
// aleatorio recién al cerrar el contexto, así que no hay a quién apuntarle.
rmSync(`${OUT}/cuadros`, { recursive: true, force: true });
rmSync(`${OUT}/crudo`, { recursive: true, force: true });
mkdirSync(`${OUT}/cuadros`, { recursive: true });
mkdirSync(`${OUT}/crudo`, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({
  viewport: SIZE,
  deviceScaleFactor: banco ? DENSITY : 1,
  recordVideo: { dir: `${OUT}/crudo`, size: SIZE },
});
const page = await context.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const url = banco
  ? `http://localhost:5199/showcase.html?solo=${solo}`
  : `http://localhost:5199/?source=mock&scenario=${scenario}`;
await page.goto(url, { waitUntil: 'networkidle' });
// Un respiro para que el libro se llene y los seis estén parados en el piso:
// los primeros cuadros de una escena vacía no son lo que nadie quiere ver.
await page.waitForTimeout(2500);


const started = Date.now();
for (let i = 0; i < frames; i++) {
  await page.screenshot({
    path: `${OUT}/cuadros/${String(i).padStart(4, '0')}.png`,
    animations: 'allow',
  });
}
const elapsed = (Date.now() - started) / 1000;

await context.close();
await browser.close();

const name = banco ? solo : 'pelea';
const webm = readdirSync(`${OUT}/crudo`).find((f) => f.endsWith('.webm'));
if (webm !== undefined) renameSync(`${OUT}/crudo/${webm}`, `${OUT}/${name}.webm`);
rmSync(`${OUT}/crudo`, { recursive: true, force: true });

console.log(`${frames} cuadros en ${elapsed.toFixed(1)} s`);
console.log(`captura real: ${(frames / elapsed).toFixed(1)} cuadros por segundo`);
console.log(errors.length === 0 ? 'consola limpia' : `ERRORES (${errors.length}):`);
for (const e of errors.slice(0, 10)) console.log('  ', e);

try { process.kill(-vite.pid, 'SIGTERM'); } catch { /* ya murió */ }
process.exit(errors.length === 0 ? 0 : 1);
