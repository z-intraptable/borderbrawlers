import { BinanceFeedClient } from './net/feedCore';
import { BINANCE_DATA_HOST, combinedStreamUrl } from './types/binance';
import type { FeedSource } from './types/binance';
import { createMockFeed } from './mock/mockFeed';
import type { MockFeedHandle, MockScenario } from './mock/mockFeed';
import { createMatch } from './game/match';
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

const host = document.getElementById('root');
if (host === null) throw new Error('#root no existe');
host.style.cssText = 'position:relative;width:100%;height:100%;background:#0B0F19;overflow:hidden';

const client = new BinanceFeedClient({
  url: resolveUrl(source, symbol, vps),
  onStatus: (status) => hud.setStatus(status),
});

const match = createMatch();
/** Lo escribe el bucle de render, lo muestrea el HUD. */
const perf = { frameMs: 0 };

const hud = mountHud(host, client.stats, match.state, symbol, source, perf);

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

const game = await startGame(host, match, client, (ms) => { perf.frameMs = ms; }, stage);

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
