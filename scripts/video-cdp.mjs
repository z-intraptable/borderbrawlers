/**
 * Graba la escena en headless capturando por CDP, no por `page.screenshot`.
 *
 *   node scripts/video-cdp.mjs [cuadros] [escenario] [armadura]
 *
 * Existe porque `page.screenshot` **se cuelga** en este contenedor. Espera a que
 * el compositor entregue un cuadro nuevo, y con el WebGL emulado por SwiftShader
 * esa entrega tarda más cuanto más llena está la escena: medido acá, arranca en
 * 3 s con el libro vacío y pasa de los 30 s de tope una vez que están los seis
 * peleadores y el fondo. El síntoma es una corrida que captura dos cuadros y
 * muere con `Timeout 30000ms exceeded`.
 *
 * `Page.captureScreenshot` de CDP no espera esa entrega. Medido contra la misma
 * página: 9 a 17 s por cuadro con la escena llena, sin colgarse nunca.
 *
 * Lo demás —el porqué de los cuadros sueltos en vez de un `.webm`— sigue siendo
 * lo que explica `scripts/video.mjs`: acá cada cuadro es un estado distinto de
 * la pelea y `scripts/gif.py` los arma a la velocidad que corresponde.
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const frames = Number(process.argv[2] ?? 40);
const scenario = process.argv[3] ?? 'volatile';
const solo = process.argv[4] ?? '';
// Fija un escenario en vez de dejar que el super lo rote: sin esto no hay forma
// de mirar uno concreto, porque el cambio cae dentro del hitstop del super.
const stage = process.argv[5] ?? '';
const banco = solo !== '';
const OUT = 'shots/video';
const SIZE = banco ? { width: 1280, height: 720 } : { width: 960, height: 540 };
const PORT = 5199;

/* --- vite ------------------------------------------------------------ */

spawnSync('fuser', ['-k', `${PORT}/tcp`], { stdio: 'ignore' });
// Esperar a que el puerto se libere de verdad. `fuser -k` manda la señal y
// vuelve enseguida; arrancar vite en el mismo instante con `--strictPort` falla
// con "Port is already in use" y la corrida entera muere en el arranque.
await new Promise((r) => setTimeout(r, 1500));

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
let viteSalida = '';
vite.stderr.on('data', (c) => { viteSalida += c; });
await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error(`vite no arrancó en 60 s:\n${viteSalida}`)), 60000);
  vite.stdout.on('data', (chunk) => {
    viteSalida += chunk;
    if (String(chunk).includes('Local:')) { clearTimeout(timer); resolve(); }
  });
});
console.log('vite listo');

/* --- captura --------------------------------------------------------- */

rmSync(`${OUT}/cuadros`, { recursive: true, force: true });
mkdirSync(`${OUT}/cuadros`, { recursive: true });

const browser = await chromium.launch({
  executablePath: chromium.executablePath(),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({
  viewport: SIZE,
  deviceScaleFactor: banco ? 2 : 1,
});

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const url = banco
  ? `http://localhost:${PORT}/showcase.html?solo=${solo}`
  : `http://localhost:${PORT}/?source=mock&scenario=${scenario}`
    + (stage ? `&stage=${stage}` : '');
await page.goto(url, { waitUntil: 'networkidle' });
// Más respiro que en video.mjs: el libro tarda en llenarse y los primeros
// cuadros de una escena vacía no muestran nada de lo que uno quiere ver.
// El libro tarda en llenarse, el arte de los seis son 36 PNG y el tinte del
// fondo arranca casi en blanco hasta que hay liquidez de los dos lados. Con 5 s
// los primeros cuadros salen sin peleadores y sin losas.
await page.waitForTimeout(Number(process.env.ESPERA ?? 5000));

const cdp = await page.context().newCDPSession(page);

const t0 = Date.now();
let vacios = 0;
for (let i = 0; i < frames; i++) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png', fromSurface: false,
  });
  const buf = Buffer.from(data, 'base64');
  // Un PNG de un color plano comprime a casi nada. Es la señal más barata de
  // que el cuadro salió vacío, y no hace falta decodificarlo para verla.
  if (buf.length < 40000) vacios++;
  writeFileSync(`${OUT}/cuadros/${String(i).padStart(4, '0')}.png`, buf);
  if ((i + 1) % 10 === 0) {
    const s = (Date.now() - t0) / 1000;
    console.log(`  ${i + 1}/${frames} cuadros — ${s.toFixed(0)} s (${(s / (i + 1)).toFixed(1)} s/cuadro)`);
  }
}

console.log(`listo: ${frames} cuadros en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
if (vacios > 0) console.log(`  ${vacios} cuadro(s) sospechosos de estar vacíos`);
if (errors.length > 0) {
  console.log(`\n${errors.length} error(es) en la página:`);
  for (const e of [...new Set(errors)].slice(0, 10)) console.log(`  ${e}`);
}

await browser.close();
process.kill(-vite.pid);
