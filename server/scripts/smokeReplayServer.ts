/*
 * Prueba de punta a punta del servidor de replay.
 *
 * El cliente de este test no es un doble: es el `BinanceFeedClient` real, el
 * mismo que corre en el browser, con un `socketFactory` de Node en lugar del
 * `WebSocket` del DOM. Si el libro se llena y los trades salen bien sin tocar
 * una línea del cliente, entonces el replay es indistinguible del vivo, que es
 * la única propiedad que le pedimos.
 *
 * Los datos salen del generador sintético, así que no hay red en ningún lado.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { BinanceFeedClient } from '../../src/net/feedCore';
import type { SocketFactory } from '../../src/net/feedCore';
import type { FeedMessage } from '../../src/types/binance';
import { createMockFeed } from '../../src/mock/mockFeed';
import { encodeFrame, fileNameFor } from '../src/recording';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; console.log(`  FAIL  ${name} ${detail}`); }
  else console.log(`  ok    ${name} ${detail}`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Corre el cliente contra una URL de replay y devuelve lo que llegó en la
 * PRIMERA pasada.
 *
 * El corte es necesario: con `loop=0` el servidor cierra al terminar la
 * ventana, y el cliente hace lo que tiene que hacer —reconectar con backoff— y
 * arranca la grabación de nuevo. Eso está bien en producción y arruina
 * cualquier medición que cuente frames, así que se para en cuanto el estado
 * deja de ser `live`.
 */
async function playOnce(url: string, timeoutMs: number): Promise<{ frames: string[]; client: BinanceFeedClient }> {
  const frames: string[] = [];
  let done = (): void => {};
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const client = new BinanceFeedClient({
    url,
    socketFactory: nodeSocketFactory,
    onRaw: (raw) => frames.push(raw),
    onStatus: (status) => { if (status === 'reconnecting' || status === 'error') done(); },
  });
  client.start();
  await Promise.race([finished, sleep(timeoutMs)]);
  client.stop();
  return { frames, client };
}

/** El mismo contrato que `browserSocketFactory`, sobre el `ws` de Node. */
const nodeSocketFactory: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.on('open', () => handlers.onOpen());
  ws.on('message', (data: Buffer) => handlers.onMessage(data.toString('utf8')));
  ws.on('close', () => handlers.onClose());
  ws.on('error', () => handlers.onError());
  return { close: () => { ws.removeAllListeners(); ws.close(); } };
};

const PORT = 8791;
const WINDOW_S = 4;
const SPEED = 8;

const dir = await mkdtemp(join(tmpdir(), 'bb-replay-'));
let server: ChildProcess | null = null;

try {
  /* --- grabación sintética: WINDOW_S segundos de mercado --- */
  const t0 = Date.parse('2026-08-16T14:00:00.000Z');
  const lines: string[] = [];
  const recorded: string[] = [];
  let t = t0;
  const feed = createMockFeed((message: FeedMessage) => {
    const raw = JSON.stringify(message);
    lines.push(encodeFrame(t, raw));
    recorded.push(raw);
  }, { scenario: 'normal', symbol: 'btcusdt', seed: 7 });
  // El timestamp se avanza DESPUÉS de emitir: la ventana es [from, to), así que
  // arrancar en t0+100 dejaría el último tick justo sobre el borde y afuera.
  for (let i = 0; i < WINDOW_S * 10; i++) { feed.step(1); t += 100; }
  await writeFile(join(dir, fileNameFor('btcusdt', t0)), lines.join(''));
  console.log(`\ngrabación sintética: ${recorded.length} frames en ${WINDOW_S} s\n`);

  /* --- servidor real, proceso aparte --- */
  const entry = fileURLToPath(new URL('../src/replay.ts', import.meta.url));
  server = spawn(
    process.execPath,
    ['--import', 'tsx', entry, '--dir', dir, '--port', String(PORT), '--host', '127.0.0.1'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let serverLog = '';
  server.stdout?.on('data', (d: Buffer) => { serverLog += d.toString(); });
  server.stderr?.on('data', (d: Buffer) => { serverLog += d.toString(); });

  for (let i = 0; i < 80 && !serverLog.includes('escuchando'); i++) await sleep(100);
  check('el servidor levanta', serverLog.includes('escuchando'), serverLog.slice(0, 140));

  console.log('\n== HTTP ==');
  {
    const health = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json() as Promise<{ ok: boolean }>);
    check('/health responde ok', health.ok === true);
    const listing = await fetch(`http://127.0.0.1:${PORT}/recordings/btcusdt`)
      .then((r) => r.json() as Promise<{ hours: unknown[] }>);
    check('/recordings lista la hora grabada', listing.hours.length === 1, String(listing.hours.length));
    const missing = await fetch(`http://127.0.0.1:${PORT}/nada`);
    check('una ruta desconocida da 404', missing.status === 404, String(missing.status));
  }

  console.log('\n== el cliente real contra el replay ==');
  {
    const at = new Date(t0).toISOString();
    const { frames: received, client } = await playOnce(
      `ws://127.0.0.1:${PORT}/replay/btcusdt?at=${at}&window=${WINDOW_S}&speed=${SPEED}&loop=0`,
      (WINDOW_S / SPEED) * 1000 + 4000,
    );

    check('llegó la grabación entera', received.length === recorded.length,
      `${received.length}/${recorded.length}`);
    check('byte por byte y en el mismo orden que se grabó',
      received.join(' ') === recorded.join(' '));

    // Lo que importa de verdad: el cliente lo entendió sin saber que era replay.
    check('el libro se llenó', client.book.bidCount === 20 && client.book.askCount === 20,
      `${client.book.bidCount}/${client.book.askCount}`);
    check('el mid es un precio razonable', client.stats.mid > 1000, client.stats.mid.toFixed(2));
    check('el spread es positivo', client.stats.spread > 0, client.stats.spread.toFixed(2));
    check('contó todos los snapshots', client.stats.snapshots === WINDOW_S * 10, String(client.stats.snapshots));
    check('contó trades', client.stats.trades > 0, String(client.stats.trades));
    check('la mediana de tamaños quedó armada', client.stats.tradeMedian > 0);
  }

  console.log('\n== el mismo minuto, dos veces ==');
  {
    // Sin esto el replay no sirve para lo que fue hecho: perfilar es comparar
    // dos corridas, y dos corridas sólo son comparables si son la misma.
    const url = `ws://127.0.0.1:${PORT}/replay/btcusdt?at=${new Date(t0).toISOString()}&window=${WINDOW_S}&speed=${SPEED}&loop=0`;
    const a = (await playOnce(url, (WINDOW_S / SPEED) * 1000 + 4000)).frames;
    const b = (await playOnce(url, (WINDOW_S / SPEED) * 1000 + 4000)).frames;
    check('dos corridas dan exactamente la misma secuencia',
      a.length > 0 && a.join(' ') === b.join(' '), `${a.length} vs ${b.length} frames`);
  }

  console.log('\n== loop, ventana vacía y rutas malas ==');
  {
    const got: string[] = [];
    const client = new BinanceFeedClient({
      url: `ws://127.0.0.1:${PORT}/replay/btcusdt?at=${new Date(t0).toISOString()}&window=1&speed=${SPEED}&loop=1`,
      socketFactory: nodeSocketFactory,
      onRaw: (raw) => got.push(raw),
    });
    client.start();
    await sleep(1600);
    client.stop();
    check('con loop=1 la ventana se repite', got.length > 0, `${got.length} frames de una ventana de 1 s`);

    const closed = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/replay/btcusdt?at=2020-01-01T00:00:00Z&window=60`);
      ws.on('close', (code: number) => resolve(code));
      ws.on('error', () => resolve(-1));
    });
    check('una ventana sin grabación cierra con error, no cuelga', closed === 1011, String(closed));

    const badPath = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/otra/cosa`);
      ws.on('open', () => resolve(false));
      ws.on('error', () => resolve(true));
    });
    check('una ruta que no es /replay/<symbol> se rechaza en el upgrade', badPath);
  }
} finally {
  server?.kill('SIGTERM');
  await sleep(300);
  server?.kill('SIGKILL');
  await rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
