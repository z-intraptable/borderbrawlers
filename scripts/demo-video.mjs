/**
 * Graba el banco de animación a paso fijo y arma el video.
 *
 *   node scripts/demo-video.mjs [segundos] [quien] [escenario] [fps]
 *   node scripts/demo-video.mjs 8 Ragnir lich 30
 *
 * Se diferencia de `scripts/video-cdp.mjs` en las dos cosas que hacían que ahí
 * no se pudiera grabar algo mirable:
 *
 * 1. **El reloj lo pone el que graba, no la pantalla.** `demo.html?paso=manual`
 *    apaga el ticker y expone `window.__PASO__(dt)`. Con SwiftShader la página
 *    rinde a 6 fps, así que grabar cuadro por cuadro con el reloj de pantalla da
 *    una carrera en cámara lenta y a tirones. Con paso fijo el resultado es el
 *    mismo que en una máquina con GPU, sólo que tarda más en salir.
 *
 * 2. **El cuadro sale del canvas y no del compositor.** `Page.captureScreenshot`
 *    tarda 9 a 17 s por cuadro con la escena llena; `canvas.toDataURL()` lee el
 *    búfer de WebGL directo —por eso el banco arranca con `preserveDrawingBuffer`—
 *    y baja a menos de un segundo. Ocho segundos de video son 240 cuadros: la
 *    diferencia es entre una hora y cuatro minutos.
 *
 * Y el video sale en H.264 con el ffmpeg del sistema, no con el recortado que
 * trae Playwright: ese sólo sabe VP8 y el operador ya avisó que el WebM no se
 * le previsualiza.
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

const segundos = Number(process.argv[2] ?? 8);
const quien = process.argv[3] ?? 'Ragnir';
const escenario = process.argv[4] ?? 'lich';
const fps = Number(process.argv[5] ?? 30);

const OUT = 'shots/demo';
const SIZE = { width: 1280, height: 720 };
const PORT = 5198;
const cuadros = Math.round(segundos * fps);

/* --- vite ------------------------------------------------------------ */

spawnSync('fuser', ['-k', `${PORT}/tcp`], { stdio: 'ignore' });
// `fuser -k` manda la señal y vuelve enseguida; arrancar vite en el mismo
// instante con `--strictPort` falla con "Port is already in use".
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
// Densidad 1 y no 2: con SwiftShader el cuello no es dibujar sino LEER el
// canvas, y a densidad 2 son 3,7 millones de píxeles por cuadro contra 0,9.
// Medido acá, 15 s por cuadro contra menos de dos.
const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const url = `http://localhost:${PORT}/demo.html`
  + `?quien=${quien}&stage=${escenario}&paso=manual`;
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => typeof window.__PASO__ === 'function', null,
  { timeout: 60000 });

// Un rato de calentamiento sin grabar: la primera vez que un sprite se dibuja,
// Pixi sube su textura a la GPU y compila el shader. Con eso adentro, el primer
// cuadro del video sale distinto de todos los demás.
for (let i = 0; i < 8; i++) {
  await page.evaluate((dt) => window.__PASO__(dt), 1 / fps);
}

const t0 = Date.now();
for (let i = 0; i < cuadros; i++) {
  const data = await page.evaluate((dt) => {
    window.__PASO__(dt);
    // JPEG y no PNG: el PNG lo comprime el navegador sin aceleración y es la
    // mitad del costo del cuadro. La calidad final la pone el H.264 de después,
    // y a 96 la diferencia no se ve ni en los contornos negros.
    return window.__APP__.canvas.toDataURL('image/jpeg', 0.96);
  }, 1 / fps);
  const buf = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
  writeFileSync(`${OUT}/cuadros/${String(i).padStart(4, '0')}.jpg`, buf);
  if ((i + 1) % 30 === 0) {
    const s = (Date.now() - t0) / 1000;
    console.log(`  ${i + 1}/${cuadros} cuadros — ${s.toFixed(0)} s`
      + ` (${(s / (i + 1)).toFixed(2)} s/cuadro)`);
  }
}
console.log(`captura lista: ${cuadros} cuadros en ${((Date.now() - t0) / 1000).toFixed(0)} s`);

if (errors.length > 0) {
  console.log(`\n${errors.length} error(es) en la página:`);
  for (const e of [...new Set(errors)].slice(0, 10)) console.log(`  ${e}`);
}

await browser.close();
process.kill(-vite.pid);

/* --- video ----------------------------------------------------------- */

const destino = `${OUT}/${quien.toLowerCase()}-${escenario}.mp4`;
const ff = spawnSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-framerate', String(fps), '-i', `${OUT}/cuadros/%04d.jpg`,
  // `-crf 16` y `slow`: el material es vector plano con contornos negros duros,
  // que es justo donde un bitrate corto deja el borde sucio.
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '16',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  destino,
], { stdio: 'inherit' });
if (ff.status !== 0) throw new Error('ffmpeg falló');
console.log(`\n${destino}`);
