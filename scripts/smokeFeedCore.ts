/* Smoke test del núcleo del feed. Relojes y sockets falsos: sin red, sin esperas. */
import {
  ATTEMPT_LIMIT,
  ATTEMPT_WINDOW_MS,
  BACKOFF_CAP_MS,
  BinanceFeedClient,
  PROACTIVE_RECONNECT_MS,
  RollingMedian,
  TradeRingBuffer,
  WHALE_MULT,
  parseDepthInto,
  toFeedMessage,
} from '../src/net/feedCore';
import type { Clock, SocketFactory, SocketHandlers, TimerHandle } from '../src/net/feedCore';
import { createEmptyBook } from '../src/types/binance';
import type { AggTrade, ConnectionStatus, DepthSnapshot, FeedMessage } from '../src/types/binance';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; console.log(`  FAIL  ${name} ${detail}`); }
  else console.log(`  ok    ${name} ${detail}`);
}

/* ------------------------- dobles de prueba ------------------------- */

interface Timer { at: number; fn: () => void; id: number; cancelled: boolean }

class FakeClock implements Clock {
  private t = 1_700_000_000_000;
  private seq = 0;
  private timers: Timer[] = [];
  private rnd = 0.5;
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.seq;
    this.timers.push({ at: this.t + ms, fn, id, cancelled: false });
    return id as unknown as TimerHandle;
  }
  clearTimeout(handle: TimerHandle): void {
    const id = handle as unknown as number;
    const timer = this.timers.find(x => x.id === id);
    if (timer) timer.cancelled = true;
  }
  random(): number { return this.rnd; }
  setRandom(v: number): void { this.rnd = v; }
  /** Avanza el tiempo virtual disparando los timers en orden. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.timers
        .filter(x => !x.cancelled && x.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter(x => x !== due);
      this.t = due.at;
      due.fn();
    }
    this.t = target;
  }
  pending(): number { return this.timers.filter(x => !x.cancelled).length; }
}

class FakeSocket {
  closed = false;
  constructor(readonly url: string, readonly handlers: SocketHandlers) {}
  close(): void { this.closed = true; }
}

function makeSocketFactory(clock?: FakeClock): {
  factory: SocketFactory;
  sockets: FakeSocket[];
  createdAt: number[];
} {
  const sockets: FakeSocket[] = [];
  const createdAt: number[] = [];
  const factory: SocketFactory = (url, handlers) => {
    const s = new FakeSocket(url, handlers);
    sockets.push(s);
    createdAt.push(clock ? clock.now() : 0);
    return s;
  };
  return { factory, sockets, createdAt };
}

function depth(mid: number, id: number, levels = 20): DepthSnapshot {
  const bids: [string, string][] = [];
  const asks: [string, string][] = [];
  for (let i = 0; i < levels; i++) {
    bids.push([(mid - 1 - i).toFixed(2), (1 + i * 0.1).toFixed(5)]);
    asks.push([(mid + 1 + i).toFixed(2), (1 + i * 0.1).toFixed(5)]);
  }
  return { lastUpdateId: id, bids, asks };
}

function trade(q: number, m: boolean, a = 1, p = 100): AggTrade {
  return { e: 'aggTrade', E: 0, s: 'BTCUSDT', a, p: p.toFixed(2), q: q.toFixed(5), f: a, l: a, T: 0, m, M: true };
}

const wrapDepth = (d: DepthSnapshot): FeedMessage => ({ stream: 'btcusdt@depth20@100ms', data: d });
const wrapTrade = (t: AggTrade): FeedMessage => ({ stream: 'btcusdt@aggTrade', data: t });

/* ------------------------- RollingMedian ------------------------- */

console.log('\n== RollingMedian ==');
{
  const rm = new RollingMedian(200);
  const naive: number[] = [];
  let match = true;
  for (let i = 0; i < 1000; i++) {
    const v = Math.sin(i * 12.9898) * 1000 + 1000;
    rm.push(v);
    naive.push(v);
    if (naive.length > 200) naive.shift();
    const sorted = [...naive].sort((a, b) => a - b);
    const h = sorted.length >> 1;
    const expected = sorted.length % 2 === 1 ? sorted[h] : (sorted[h - 1] + sorted[h]) / 2;
    if (Math.abs(rm.median() - expected) > 1e-9) match = false;
  }
  check('coincide con implementación naive en 1000 pushes', match);
  check('warmup: no está lista antes de 20 muestras', !new RollingMedian(200).ready);
  const rm2 = new RollingMedian(200);
  for (let i = 0; i < 20; i++) rm2.push(1);
  check('warmup: lista a las 20 muestras', rm2.ready);
  const rm3 = new RollingMedian(4);
  [10, 20, 30, 40, 50, 60].forEach(v => rm3.push(v));
  check('ventana desliza (cap 4 → mediana de 30..60 = 45)', rm3.median() === 45, `${rm3.median()}`);
}

/* ------------------------- TradeRingBuffer ------------------------- */

console.log('\n== TradeRingBuffer ==');
{
  const rb = new TradeRingBuffer(4);
  for (let i = 1; i <= 6; i++) rb.push(i, 'buy', 100, 1, false, 0);
  check('capacidad fija respetada', rb.count === 4, `${rb.count}`);
  check('cuenta descartes', rb.droppedCount === 2, `${rb.droppedCount}`);
  const ids = [rb.pop()?.id, rb.pop()?.id, rb.pop()?.id, rb.pop()?.id];
  check('descarta el más viejo (quedan 3..6)', JSON.stringify(ids) === '[3,4,5,6]', JSON.stringify(ids));
  check('vacío devuelve null', rb.pop() === null);
  rb.push(9, 'sell', 1, 1, true, 0);
  rb.clear();
  check('clear() vacía', rb.count === 0 && rb.pop() === null);
}

/* ------------------------- parseo ------------------------- */

console.log('\n== parseo ==');
{
  const book = createEmptyBook(20);
  parseDepthInto(depth(1000, 7), book);
  check('mid = (bestBid + bestAsk) / 2', book.mid === 1000, `${book.mid}`);
  check('lastUpdateId propagado', book.lastUpdateId === 7);
  check('bids descendentes en Float64Array', book.bidPrices[0] > book.bidPrices[1]);
  check('asks ascendentes en Float64Array', book.askPrices[0] < book.askPrices[1]);

  const short = createEmptyBook(20);
  parseDepthInto(depth(1000, 8, 5), short);
  check('snapshot corto: cuenta correcta', short.bidCount === 5 && short.askCount === 5);
  check('snapshot corto: cola en cero', short.bidPrices[5] === 0 && short.bidQtys[19] === 0);

  check('toFeedMessage rechaza JSON inválido', toFeedMessage('{no json') === null);
  check('toFeedMessage rechaza objeto sin stream', toFeedMessage('{"data":{}}') === null);
  check('toFeedMessage rechaza payload desconocido',
    toFeedMessage('{"stream":"x","data":{"foo":1}}') === null);
  check('toFeedMessage acepta aggTrade',
    toFeedMessage(JSON.stringify(wrapTrade(trade(1, true)))) !== null);
  check('toFeedMessage acepta depth',
    toFeedMessage(JSON.stringify(wrapDepth(depth(100, 1)))) !== null);
}

/* ------------------------- regla del agresor y ballenas ------------------------- */

console.log('\n== agresor y ballenas ==');
{
  const clock = new FakeClock();
  const { factory } = makeSocketFactory();
  const c = new BinanceFeedClient({ url: 'ws://x', clock, socketFactory: factory });

  c.handleFeedMessage(wrapTrade(trade(1, true, 1)));
  c.handleFeedMessage(wrapTrade(trade(1, false, 2)));
  const first = c.trades.pop();
  const second = c.trades.pop();
  check('m === true  → sell (agresor vendedor)', first?.side === 'sell', `${first?.side}`);
  check('m === false → buy  (agresor comprador)', second?.side === 'buy', `${second?.side}`);

  const c2 = new BinanceFeedClient({ url: 'ws://x', clock, socketFactory: factory });
  for (let i = 0; i < 19; i++) c2.handleFeedMessage(wrapTrade(trade(1, false, i + 1)));
  c2.handleFeedMessage(wrapTrade(trade(1000, false, 100)));
  let sawWhaleBeforeWarmup = false;
  for (;;) { const t = c2.trades.pop(); if (!t) break; if (t.whale) sawWhaleBeforeWarmup = true; }
  check('sin warmup no clasifica ballenas', !sawWhaleBeforeWarmup);

  const c3 = new BinanceFeedClient({ url: 'ws://x', clock, socketFactory: factory });
  for (let i = 0; i < 100; i++) c3.handleFeedMessage(wrapTrade(trade(1, false, i + 1)));
  while (c3.trades.pop() !== null) { /* drenar */ }
  c3.handleFeedMessage(wrapTrade(trade(WHALE_MULT + 0.5, false, 500)));
  c3.handleFeedMessage(wrapTrade(trade(WHALE_MULT - 0.5, false, 501)));
  const big = c3.trades.pop();
  const small = c3.trades.pop();
  check(`size > mediana * ${WHALE_MULT} → ballena`, big?.whale === true);
  check(`size < mediana * ${WHALE_MULT} → no ballena`, small?.whale === false);
  check('mediana móvil expuesta en stats', c3.stats.tradeMedian === 1, `${c3.stats.tradeMedian}`);

  const c4 = new BinanceFeedClient({ url: 'ws://x', clock, socketFactory: factory });
  for (let i = 0; i < 30; i++) c4.handleFeedMessage(wrapDepth(depth(1000 + i, i + 1)));
  check('mediana de cantidades del libro > 0', c4.stats.bookQtyMedian > 0, `${c4.stats.bookQtyMedian}`);
  check('spread expuesto', c4.stats.spread === 2, `${c4.stats.spread}`);
  check('contador de snapshots', c4.stats.snapshots === 30);
}

/* ------------------------- reconexión ------------------------- */

console.log('\n== backoff y límite de intentos ==');
{
  const clock = new FakeClock();
  clock.setRandom(1);
  const { factory, sockets } = makeSocketFactory();
  const seen: ConnectionStatus[] = [];
  const c = new BinanceFeedClient({
    url: 'ws://x', clock, socketFactory: factory, onStatus: s => seen.push(s),
  });

  c.start();
  check('abre un socket al arrancar', sockets.length === 1);
  sockets[0].handlers.onOpen();
  check('status live tras open', c.getStatus() === 'live');

  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    const before = sockets.length;
    sockets[sockets.length - 1].handlers.onClose();
    let waited = 0;
    while (sockets.length === before && waited < 120_000) { clock.advance(50); waited += 50; }
    delays.push(waited);
  }
  check('backoff crece', delays[0] < delays[1] && delays[1] < delays[2], JSON.stringify(delays.slice(0, 4)));
  check(`backoff topa en ${BACKOFF_CAP_MS} ms`, Math.max(...delays) <= BACKOFF_CAP_MS + 50,
    `max ${Math.max(...delays)}`);
  check('pasa por reconnecting', seen.includes('reconnecting'));

  // Jitter: con random distinto, el delay del mismo intento cambia.
  const mk = (rnd: number): number => {
    const ck = new FakeClock(); ck.setRandom(rnd);
    const f = makeSocketFactory();
    const cl = new BinanceFeedClient({ url: 'ws://x', clock: ck, socketFactory: f.factory });
    cl.start();
    f.sockets[0].handlers.onOpen();
    f.sockets[0].handlers.onClose();
    let waited = 0;
    while (f.sockets.length === 1 && waited < 120_000) { ck.advance(10); waited += 10; }
    return waited;
  };
  check('jitter altera el delay', mk(0) !== mk(1), `${mk(0)} vs ${mk(1)}`);
  check('equal jitter: nunca menos de la mitad de la base', mk(0) >= 500, `${mk(0)}`);
}

{
  // Cada open resetea el backoff, así que con random=0 el delay es siempre el
  // mínimo (500 ms): el peor caso realista para el limitador de intentos.
  const clock = new FakeClock();
  clock.setRandom(0);
  const { factory, sockets, createdAt } = makeSocketFactory(clock);
  const c = new BinanceFeedClient({ url: 'ws://x', clock, socketFactory: factory });
  c.start();

  let driven = 0;
  for (let i = 0; i < 4_000; i++) {
    while (driven < sockets.length) {
      const s = sockets[driven++];
      s.handlers.onOpen();
      s.handlers.onClose();
    }
    clock.advance(600);
  }

  let worstWindow = 0;
  for (let i = 0; i < createdAt.length; i++) {
    let n = 0;
    for (let j = i; j < createdAt.length && createdAt[j] - createdAt[i] < ATTEMPT_WINDOW_MS; j++) n++;
    if (n > worstWindow) worstWindow = n;
  }
  const spanMin = (createdAt[createdAt.length - 1] - createdAt[0]) / 60_000;
  check(`nunca supera ${ATTEMPT_LIMIT} intentos en ${ATTEMPT_WINDOW_MS / 60_000} min`,
    worstWindow <= ATTEMPT_LIMIT, `peor ventana: ${worstWindow} en ${spanMin.toFixed(0)} min`);
  check('el limitador se ejerció de verdad (no quedó holgado)',
    worstWindow > ATTEMPT_LIMIT * 0.9, `${worstWindow}/${ATTEMPT_LIMIT}`);
  check('sigue reconectando después de agotar la cuota',
    sockets.length > ATTEMPT_LIMIT, `${sockets.length} sockets en ${spanMin.toFixed(0)} min`);

  // Con backoff real (sin reset por open) el techo queda muy por debajo del límite.
  const ck2 = new FakeClock();
  ck2.setRandom(1);
  const f2 = makeSocketFactory(ck2);
  const c2 = new BinanceFeedClient({ url: 'ws://x', clock: ck2, socketFactory: f2.factory });
  c2.start();
  let driven2 = 0;
  for (let i = 0; i < 2_000; i++) {
    while (driven2 < f2.sockets.length) f2.sockets[driven2++].handlers.onClose();
    ck2.advance(500);
  }
  const perWindow = f2.createdAt.filter(t => t - f2.createdAt[0] < ATTEMPT_WINDOW_MS).length;
  check('con backoff sostenido el propio backoff ya acota a ~15 intentos / 5 min',
    perWindow < 20, `${perWindow} intentos`);
  check(`techo de ${BACKOFF_CAP_MS} ms respetado en régimen`,
    f2.createdAt[10] - f2.createdAt[9] <= BACKOFF_CAP_MS + 500,
    `${f2.createdAt[10] - f2.createdAt[9]} ms`);
}

console.log('\n== reconexión proactiva a 24 h (make-before-break) ==');
{
  const clock = new FakeClock();
  clock.setRandom(0.5);
  const { factory, sockets } = makeSocketFactory();
  const c = new BinanceFeedClient({ url: 'ws://x', clock, socketFactory: factory });
  c.start();
  sockets[0].handlers.onOpen();

  clock.advance(PROACTIVE_RECONNECT_MS - 60_000);
  check('no reconecta antes de tiempo', sockets.length === 1, `${sockets.length}`);

  clock.advance(120_000);
  check('abre socket nuevo cerca de las 23h50', sockets.length === 2, `${sockets.length}`);
  check('el socket viejo SIGUE ABIERTO mientras el nuevo negocia', !sockets[0].closed);
  check('status sigue live (sin hueco visible)', c.getStatus() === 'live');

  sockets[1].handlers.onOpen();
  check('recién ahí cierra el viejo', sockets[0].closed);
  check('el nuevo queda vivo', !sockets[1].closed);
  check('cuenta la reconexión', c.stats.reconnects === 1);

  clock.advance(PROACTIVE_RECONNECT_MS + 60_000);
  check('reprograma la siguiente a 24 h', sockets.length === 3, `${sockets.length}`);

  // Si el candidato falla, el vivo no se toca.
  const alive = sockets[1];
  sockets[2].handlers.onError();
  check('candidato fallido no derriba el socket vivo', !alive.closed);
  check('status sigue live tras fallar el candidato', c.getStatus() === 'live');
}

console.log('\n== stop() y limpieza ==');
{
  const clock = new FakeClock();
  const { factory, sockets } = makeSocketFactory();
  const c = new BinanceFeedClient({ url: 'ws://x', clock, socketFactory: factory });
  c.start();
  sockets[0].handlers.onOpen();
  c.stop();
  check('stop() cierra el socket', sockets[0].closed);
  clock.advance(PROACTIVE_RECONNECT_MS * 2);
  check('stop() no deja timers vivos', sockets.length === 1, `${sockets.length}`);
  sockets[0].handlers.onClose();
  clock.advance(60_000);
  check('un close tardío no reabre tras stop()', sockets.length === 1);
}

console.log('\n== presión de memoria en el camino de datos ==');
{
  const clock = new FakeClock();
  const { factory } = makeSocketFactory();
  const c = new BinanceFeedClient({ url: 'ws://x', clock, socketFactory: factory });
  const msg = wrapTrade(trade(1.5, false, 1));
  const snap = wrapDepth(depth(1000, 1));
  for (let i = 0; i < 20_000; i++) { c.handleFeedMessage(msg); if (i % 10 === 0) c.handleFeedMessage(snap); }
  while (c.trades.pop() !== null) { /* drenar */ }

  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) {
    console.log('  SKIP  correr con `node --expose-gc` para medir el heap de verdad');
  } else {
    gc(); gc();
    const before = process.memoryUsage().heapUsed;
    const N = 400_000;
    for (let i = 0; i < N; i++) {
      c.handleFeedMessage(msg);
      if (i % 10 === 0) c.handleFeedMessage(snap);
      if (i % 200 === 0) while (c.trades.pop() !== null) { /* drenar */ }
    }
    gc(); gc();
    const growth = process.memoryUsage().heapUsed - before;
    const perOp = growth / N;
    check('cero crecimiento retenido de heap en 400k trades + 40k snapshots',
      perOp < 1, `${(growth / 1024).toFixed(1)} KB → ${perOp.toFixed(3)} B/trade`);
  }
}

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
