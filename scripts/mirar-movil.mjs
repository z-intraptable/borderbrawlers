/**
 * Captura el juego con la caja de un teléfono en horizontal.
 *
 *   node scripts/mirar-movil.mjs [ancho] [alto] [dpr] [segundos]
 *
 * El resto de las capturas van a 1280x720 con dpr 1, que es una ventana de
 * escritorio. La página publicada se rompió en un teléfono y ahí no se veía:
 * lo que falla es la MEDIDA del host, y a 1280x720 el host mide bien.
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const ancho = Number(process.argv[2] ?? 869);
const alto = Number(process.argv[3] ?? 400);
const dpr = Number(process.argv[4] ?? 3);
const segundos = Number(process.argv[5] ?? 8);
const OUT = 'shots/movil';

spawnSync('fuser', ['-k', '5197/tcp'], { stdio: 'ignore' });
const vite = spawn('npx', ['vite', '--port', '5197', '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('vite no arrancó')), 40000);
  vite.stdout.on('data', (c) => { if (String(c).includes('Local:')) { clearTimeout(t); res(); } });
});

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: chromium.executablePath(),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({
  viewport: { width: ancho, height: alto },
  deviceScaleFactor: dpr,
  isMobile: true,
  hasTouch: true,
});
const errores = [];
page.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });
page.on('pageerror', (e) => errores.push(`pageerror: ${e.message}`));

await page.goto('http://localhost:5197/?source=mock&scenario=normal', { waitUntil: 'load', timeout: 60000 });

for (let i = 1; i <= segundos; i++) {
  await page.waitForTimeout(1000);
  await page.screenshot({
    path: `${OUT}/movil-${String(i).padStart(2, '0')}.png`,
    timeout: 120000, animations: 'disabled',
  });
}

// La medida, que es lo que se sospecha. Todo en píxeles CSS salvo donde se diga.
const medida = await page.evaluate(() => {
  const root = document.getElementById('root');
  const canvas = document.querySelector('canvas');
  const caja = canvas?.getBoundingClientRect();
  return {
    ventana: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio,
    root: root ? `${root.clientWidth}x${root.clientHeight}` : 'sin root',
    rootScroll: root ? `${root.scrollWidth}x${root.scrollHeight}` : '',
    canvasAtributo: canvas ? `${canvas.width}x${canvas.height}` : 'sin canvas',
    canvasEstilo: canvas ? `${canvas.style.width} x ${canvas.style.height}` : '',
    canvasCaja: caja ? `${Math.round(caja.width)}x${Math.round(caja.height)} @ ${Math.round(caja.x)},${Math.round(caja.y)}` : '',
    hijosDeRoot: root ? [...root.children].map((n) => `${n.tagName.toLowerCase()}.${n.className || '-'}`).join(' | ') : '',
  };
});
console.log(JSON.stringify(medida, null, 2));

await browser.close();
try { process.kill(-vite.pid, 'SIGKILL'); } catch { /* ya no está */ }
spawnSync('fuser', ['-k', '5197/tcp'], { stdio: 'ignore' });
if (errores.length > 0) { console.error('errores:'); for (const e of errores.slice(0, 8)) console.error('  ' + e); }
