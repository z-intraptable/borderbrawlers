import { BinanceFeedClient } from './net/feedCore';
import { BINANCE_DATA_HOST, combinedStreamUrl } from './types/binance';
import type { FeedSource } from './types/binance';
import { createMockFeed } from './mock/mockFeed';
import type { MockFeedHandle, MockScenario } from './mock/mockFeed';
import { createMatch, fijarDuo } from './game/match';
import { GREEN_ROSTER, RED_ROSTER } from './game/roster';
import { startGame } from './render/game';
import { mountHud } from './hud/hud';

/**
 * Punto de entrada. Sin framework: crea el cliente del feed, la simulación y la
 * capa de Pixi, y los conecta.
 *
 * Parámetros por query string:
 *   ?source=mock          mock | binance-direct | vps-replay | vps-relay
 *   ?scenario=stress      calm | normal | volatile | stress
 *   ?symbol=ethusdt
 *   ?vps=ws://host:8080
 *   ?stage=lich           fondo pintado; sin esto, el fondo plano de siempre
 *   ?modo=melee           los seis a la vez; sin esto, el torneo 1v1
 *
 * Sin `source` va contra Binance en vivo, que es el punto del proyecto. Los
 * valores se validan contra la lista permitida en vez de castearse: un
 * `?source=binancedirect` casteado a ciegas termina abriendo un WebSocket a la
 * URL literal "undefined".
 */

const SOURCES: readonly FeedSource[] = ['mock', 'binance-direct', 'vps-replay', 'vps-relay'];
const SCENARIOS: readonly MockScenario[] = ['calm', 'normal', 'volatile', 'stress'];

function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  const found = allowed.find((value) => value === raw);
  if (found === undefined && raw !== null) {
    console.warn(`BorderBrawlers: valor "${raw}" ignorado; se usa "${fallback}"`);
  }
  return found ?? fallback;
}

function resolveUrl(source: FeedSource, symbol: string, vps: string): string {
  const base = vps.replace(/\/$/, '');
  switch (source) {
    case 'binance-direct': return combinedStreamUrl(BINANCE_DATA_HOST, symbol);
    case 'vps-relay': return `${base}/stream/${symbol.toLowerCase()}`;
    case 'vps-replay': return `${base}/replay/${symbol.toLowerCase()}`;
    case 'mock': return '';
  }
}

const params = new URLSearchParams(window.location.search);
const source = pick(params.get('source'), SOURCES, 'binance-direct');
const scenario = pick(params.get('scenario'), SCENARIOS, 'normal');
const symbol = params.get('symbol') ?? 'btcusdt';
const vps = params.get('vps') ?? '';
// El escenario no se valida contra una lista: los fondos son archivos que se
// agregan sueltos, y `loadStage` ya devuelve null si el nombre no existe. Lo
// único que hace falta es que no se pueda escapar de la carpeta.
const stageParam = params.get('stage');
const stage = stageParam !== null && /^[a-z0-9-]+$/i.test(stageParam) ? stageParam : null;
// Cuántos peleadores por bando. `?vs=1` es el mano a mano para mirar el motor
// de pelea sin seis cuerpos encima; sin el parámetro es la pelea de siempre.
const vsParam = Number(params.get('vs'));
const lanes = Number.isFinite(vsParam) && vsParam > 0 ? vsParam : 3;
// A qué velocidad corre la pelea. Sin el parámetro va la de siempre, que desde
// el 18/08 es la mitad del reloj de pared: a velocidad real no se llegaba a ver
// quién le pegaba a quién.
const ritmoParam = Number(params.get('ritmo'));
const ritmo = Number.isFinite(ritmoParam) && ritmoParam > 0 && ritmoParam <= 4
  ? ritmoParam
  : undefined;

const host = document.getElementById('root');
if (host === null) throw new Error('#root no existe');
host.style.cssText = 'position:relative;width:100%;height:100%;background:#0B0F19;overflow:hidden';

const client = new BinanceFeedClient({
  url: resolveUrl(source, symbol, vps),
  onStatus: (status) => hud.setStatus(status),
});

/**
 * El torneo es el modo por defecto.
 *
 * Cada bando manda uno, el que gana se queda, y el que se queda sin sus tres
 * pierde el match. `?modo=melee` devuelve la pelea de seis a la vez, que es como
 * estuvo hasta ahora y sigue siendo útil para mirar el motor con todo lleno.
 */
/**
 * `?duo=kor,ragnir` — uno por bando y siempre los mismos.
 *
 * Existe para trabajar: con seis rotando, probar un cambio en uno es esperar a
 * que le toque. Va sobre la melé de un carril y no sobre el torneo, así que el
 * que se cae vuelve él mismo y la pelea no se termina nunca.
 */
const duoParam = params.get('duo');
const duo = duoParam
  ? duoParam.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  : null;

const torneo = duo === null && params.get('modo') !== 'melee';
const match = createMatch(duo !== null ? 1 : lanes, torneo);
if (duo !== null) {
  // Se busca por el nombre del armature en minúscula: es el mismo que da nombre
  // a la carpeta de arte, así que `?duo=kor,ragnir` se lee igual que el disco.
  const cual = (lista: readonly { armature: string }[], nombre: string | undefined): number => {
    const i = lista.findIndex((c) => c.armature.toLowerCase() === nombre);
    return i >= 0 ? i : 0;
  };
  fijarDuo(match, cual(GREEN_ROSTER, duo[0]), cual(RED_ROSTER, duo[1]));
}
/** Lo escribe el bucle de render, lo muestrea el HUD. */
const perf = { frameMs: 0 };

const hud = mountHud(host, client.stats, match.state, symbol);

let mock: MockFeedHandle | null = null;
if (source === 'mock') {
  mock = createMockFeed((message) => client.handleFeedMessage(message), { scenario, symbol });
  mock.start();
  hud.setStatus('live');
} else {
  client.start();
}

// La cola acumulada mientras la pestaña estuvo oculta ya no representa nada:
// reproducirla sería una ráfaga de altas de trades viejos.
document.addEventListener('visibilitychange', () => client.clearTrades());

const game = await startGame(host, match, client, (ms) => { perf.frameMs = ms; }, stage, ritmo);

/**
 * `?medir` — la regla, para cuando el juego se ve corrido en un teléfono.
 *
 * El encuadre roto —el juego dibujado en una franja y media pantalla muerta— no
 * se reproduce en ningún navegador de escritorio ni en un headless: depende de
 * cómo el navegador del teléfono resuelve el alto de la página con sus barras
 * apareciendo y desapareciendo. Y en un teléfono no hay consola donde mirar.
 *
 * Así que los números se dibujan en pantalla. Una captura de esto dice en un
 * segundo si el problema es la caja de la página, la del canvas o ninguna de
 * las dos, que es lo que de otro modo se adivina.
 */
if (params.has('medir')) {
  const regla = document.createElement('pre');
  regla.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;margin:0;padding:6px 8px;'
    + 'font:12px ui-monospace,monospace;color:#0f6;background:rgba(0,0,0,.82);'
    + 'white-space:pre;pointer-events:none;line-height:1.35';
  document.body.appendChild(regla);
  const refrescar = (): void => {
    const lienzo = game.app.canvas;
    const caja = lienzo.getBoundingClientRect();
    const vv = window.visualViewport;
    regla.textContent = [
      `ventana   ${window.innerWidth} x ${window.innerHeight}`,
      `visual    ${vv ? `${Math.round(vv.width)} x ${Math.round(vv.height)}` : '(no hay)'}`,
      `root      ${host.clientWidth} x ${host.clientHeight}`,
      `canvas    ${Math.round(caja.width)} x ${Math.round(caja.height)} en ${Math.round(caja.x)},${Math.round(caja.y)}`,
      `buffer    ${lienzo.width} x ${lienzo.height}`,
      `renderer  ${game.app.renderer.width} x ${game.app.renderer.height} @${game.app.renderer.resolution}x`,
      `dpr       ${window.devicePixelRatio}`,
    ].join('\n');
  };
  refrescar();
  window.setInterval(refrescar, 500);
}

// Enganche de desarrollo: deja mirar el renderer desde afuera —tamaño,
// resolución, draw calls— sin tener que instrumentar el juego cada vez. Vite lo
// saca del build de producción junto con la rama muerta.
if (import.meta.env.DEV) {
  (window as unknown as { __APP__: unknown }).__APP__ = game.app;
}

// Vite reemplaza el módulo en caliente; sin esto quedan dos canvas y dos
// sockets vivos por cada guardado.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    game.destroy();
    hud.destroy();
    mock?.stop();
    client.stop();
  });
}
