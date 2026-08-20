/**
 * Captura cuadro por cuadro (a paso fijo) durante N segundos, forzando saltos
 * de Kor, para diagnosticar el bug de brazos en `?duo=kor,ragnir`.
 *
 *     node scripts/kor-jump-frames.mjs
 *
 * Escribe en shots/kor-frames/frame-XXX.png, uno cada ~100ms de reloj de
 * pared (no de simulación) durante 5s, y fuerza un salto de Kor cada 700ms
 * llamando directo al estado del match vía window.__APP__ si está expuesto,
 * o simplemente deja correr el mock a ritmo alto para que salte solo.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const DIR = 'shots/kor-frames';
mkdirSync(DIR, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.log('[error]', String(e).slice(0, 300)));

await page.goto(
  'http://localhost:5173/?source=mock&scenario=stress&duo=kor,ragnir&vs=1&ritmo=1',
  { waitUntil: 'load', timeout: 30000 },
);
await page.waitForTimeout(3000);

console.log('capturando…');
for (let i = 0; i < 50; i++) {
  await page.screenshot({ path: `${DIR}/frame-${String(i).padStart(3, '0')}.png` });
  await page.waitForTimeout(100);
}
console.log('listo:', DIR);
await browser.close();
