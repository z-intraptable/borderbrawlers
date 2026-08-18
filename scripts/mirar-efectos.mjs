/**
 * Captura el banco de efectos a varias edades, en headless.
 *
 *   node scripts/mirar-efectos.mjs [edades separadas por coma]
 *
 * Los efectos duran entre 0,13 y 0,7 segundos, así que una captura sola no
 * dice nada: hay que verlos naciendo, a mitad de vida y apagándose. El banco
 * congela el cuadro con `?edad=`, así que esto es un `goto` por cada edad.
 */
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const edades = (process.argv[2] ?? '0.06,0.16,0.34,0.6').split(',').map(Number);
const OUT = process.argv[3] ?? 'shots/efectos';

spawnSync('fuser', ['-k', '5198/tcp'], { stdio: 'ignore' });
const vite = spawn('npx', ['vite', '--port', '5198', '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'], detached: true,
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('vite no arrancó')), 40000);
  vite.stdout.on('data', (c) => { if (String(c).includes('Local:')) { clearTimeout(timer); resolve(); } });
});

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: chromium.executablePath(),
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

for (const edad of edades) {
  await page.goto(`http://localhost:5198/efectos.html?edad=${edad}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForSelector('body[data-listo="1"]', { timeout: 60000 });
  await page.waitForTimeout(400);
  const file = `${OUT}/edad-${String(edad).replace('.', '_')}.png`;
  await page.screenshot({ path: file, timeout: 120000, animations: 'disabled' });
  console.log(file);
}

await browser.close();
try { process.kill(-vite.pid, 'SIGKILL'); } catch { /* ya no está */ }
spawnSync('fuser', ['-k', '5198/tcp'], { stdio: 'ignore' });

if (errors.length > 0) {
  console.error('errores de consola:');
  for (const e of errors.slice(0, 12)) console.error('  ' + e);
  process.exit(1);
}
console.log('sin errores de consola');
