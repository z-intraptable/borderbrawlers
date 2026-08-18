/**
 * Abre una página del juego en un navegador de verdad y saca una foto.
 *
 *     node scripts/mirar.mjs "http://127.0.0.1:8877/index.html?vs=1" foto.png
 *
 * Existe porque los defectos que importan no se ven en el typecheck ni en los
 * tests: el juego dibujado en un rincón, la pantalla negra con el HUD vivo, el
 * personaje que no aparece. Todos se ven en una foto y en la consola.
 *
 * Imprime lo que la página escribe en consola, los errores y los pedidos de red
 * que fallan, que es donde apareció el `GET` abortado que colgaba el cargador.
 */
import { chromium } from 'playwright';

const url = process.argv[2];
const salida = process.argv[3] ?? 'shots/mirar.png';
const espera = Number(process.argv[4] ?? 15000);

if (!url) throw new Error('falta la url');

const navegador = await chromium.launch({
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const pagina = await navegador.newPage({ viewport: { width: 1280, height: 720 } });

pagina.on('console', (m) => {
  if (m.type() === 'debug') return;
  console.log(`[${m.type()}]`, m.text().slice(0, 300));
});
pagina.on('pageerror', (e) => console.log('[error]', String(e).slice(0, 500)));
pagina.on('requestfailed', (r) => {
  const u = r.url();
  if (u.startsWith('data:')) return;
  console.log('[falló]', r.method(), u.slice(0, 110), r.failure()?.errorText);
});

await pagina.goto(url, { waitUntil: 'load', timeout: 60000 });
await pagina.waitForTimeout(espera);

const estado = await pagina.evaluate(() => {
  const lienzo = document.querySelector('canvas');
  const hud = document.body.innerText.replace(/\s+/g, ' ').slice(0, 160);
  return JSON.stringify({
    lienzo: lienzo === null ? null : [lienzo.width, lienzo.height],
    hud,
  });
});
console.log('[estado]', estado);

await pagina.screenshot({ path: salida, timeout: 60000 });
console.log('[foto]', salida);
await navegador.close();
