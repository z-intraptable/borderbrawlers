/* Smoke test del generador. No forma parte del bundle. */
import { createMockFeed } from '../src/mock/mockFeed';
import type { MockScenario } from '../src/mock/mockFeed';
import { isAggTrade, isDepthSnapshot } from '../src/types/binance';
import type { AggTrade, DepthSnapshot, FeedMessage } from '../src/types/binance';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) {
    failures++;
    console.log(`  FAIL  ${name} ${detail}`);
  } else {
    console.log(`  ok    ${name} ${detail}`);
  }
}

const NUM_RE = /^-?\d+\.\d+$/;

function collect(scenario: MockScenario, ticks: number, seed = 42) {
  const depths: DepthSnapshot[] = [];
  const trades: AggTrade[] = [];
  const streams: string[] = [];
  const feed = createMockFeed((m: FeedMessage) => {
    streams.push(m.stream);
    if (isAggTrade(m.data)) trades.push(m.data);
    else if (isDepthSnapshot(m.data)) depths.push(m.data);
    else throw new Error('payload no clasificado');
  }, { scenario, seed });
  feed.step(ticks);
  return { depths, trades, streams, feed };
}

console.log('\n== formato de cable ==');
{
  const { depths, trades, streams } = collect('normal', 600);

  check('depth: 1 snapshot por tick', depths.length === 600, `(${depths.length})`);
  check('nombres de stream correctos',
    streams.every(s => s === 'btcusdt@depth20@100ms' || s === 'btcusdt@aggTrade'));

  let levelsOk = true, orderOk = true, stringsOk = true, crossOk = true;
  for (const d of depths) {
    if (d.bids.length !== 20 || d.asks.length !== 20) levelsOk = false;
    for (let i = 1; i < 20; i++) {
      if (parseFloat(d.bids[i][0]) >= parseFloat(d.bids[i - 1][0])) orderOk = false;
      if (parseFloat(d.asks[i][0]) <= parseFloat(d.asks[i - 1][0])) orderOk = false;
    }
    if (parseFloat(d.asks[0][0]) <= parseFloat(d.bids[0][0])) crossOk = false;
    for (const [p, q] of [...d.bids, ...d.asks]) {
      if (typeof p !== 'string' || typeof q !== 'string') stringsOk = false;
      if (!NUM_RE.test(p) || !NUM_RE.test(q)) stringsOk = false;
      if (parseFloat(q) <= 0) stringsOk = false;
    }
  }
  check('depth: 20 niveles por lado', levelsOk);
  check('depth: bids mayor→menor, asks menor→mayor', orderOk);
  check('depth: libro no cruzado (bestAsk > bestBid)', crossOk);
  check('depth: precio y cantidad son strings numéricos', stringsOk);
  check('depth: lastUpdateId monótono',
    depths.every((d, i) => i === 0 || d.lastUpdateId > depths[i - 1].lastUpdateId));
  check('depth: sin campos e/E/s',
    depths.every(d => !('e' in d) && !('E' in d) && !('s' in d)));

  const t0 = trades[0];
  check('aggTrade: campos exactos',
    JSON.stringify(Object.keys(t0)) === JSON.stringify(['e','E','s','a','p','q','f','l','T','m','M']),
    JSON.stringify(Object.keys(t0)));
  check('aggTrade: e === "aggTrade"', trades.every(t => t.e === 'aggTrade'));
  check('aggTrade: s en MAYÚSCULAS', trades.every(t => t.s === 'BTCUSDT'));
  check('aggTrade: p y q son strings', trades.every(t => typeof t.p === 'string' && typeof t.q === 'string'));
  check('aggTrade: m es boolean', trades.every(t => typeof t.m === 'boolean'));
  check('aggTrade: a monótono creciente',
    trades.every((t, i) => i === 0 || t.a > trades[i - 1].a));
  check('aggTrade: f <= l', trades.every(t => t.f <= t.l));
}

console.log('\n== determinismo ==');
{
  const a = collect('volatile', 200, 7);
  const b = collect('volatile', 200, 7);
  const c = collect('volatile', 200, 8);
  check('misma semilla → mismos depths',
    JSON.stringify(a.depths) === JSON.stringify(b.depths));
  check('misma semilla → mismos trades',
    JSON.stringify(a.trades.map(t => [t.p, t.q, t.m])) ===
    JSON.stringify(b.trades.map(t => [t.p, t.q, t.m])));
  check('semilla distinta → salida distinta',
    JSON.stringify(a.depths) !== JSON.stringify(c.depths));
}

console.log('\n== régimen y cadencia ==');
{
  const seconds = 200 * 0.1;
  for (const s of ['calm', 'normal', 'volatile', 'stress'] as MockScenario[]) {
    const { trades, depths, feed } = collect(s, 200);
    const rate = trades.length / seconds;
    const qtys = trades.map(t => parseFloat(t.q)).sort((x, y) => x - y);
    const median = qtys[Math.floor(qtys.length / 2)];
    const max = qtys[qtys.length - 1];
    const buys = trades.filter(t => !t.m).length;
    console.log(
      `  ${s.padEnd(9)} ${rate.toFixed(1).padStart(6)} trades/s | ` +
      `mediana ${median.toFixed(4)} | max ${max.toFixed(3)} (${(max / median).toFixed(0)}x) | ` +
      `buy ${((buys / trades.length) * 100).toFixed(0)}% | ` +
      `mid ${feed.getMid().toFixed(2)} | depths ${depths.length}`,
    );
    check(`${s}: hay ballenas (max > 8x mediana)`, max / median > 8);
    check(`${s}: ambos lados presentes`, buys > 0 && buys < trades.length);
    check(`${s}: mid finito y positivo`, Number.isFinite(feed.getMid()) && feed.getMid() > 0);
  }
}

console.log('\n== escalado de escenario ==');
{
  const rate = (s: MockScenario) => collect(s, 400).trades.length;
  const [calm, normal, volatile, stress] = [rate('calm'), rate('normal'), rate('volatile'), rate('stress')];
  check('calm < normal < volatile < stress',
    calm < normal && normal < volatile && volatile < stress,
    `${calm} < ${normal} < ${volatile} < ${stress}`);
  check('stress satura la cola de 256 en <1s', stress / 40 > 256, `${(stress / 40).toFixed(0)} trades/s`);
}

console.log('\n== camino con timers ==');
{
  const seen: FeedMessage[] = [];
  const feed = createMockFeed(m => seen.push(m), { scenario: 'calm', seed: 1 });
  check('no corre antes de start()', !feed.isRunning());
  feed.start();
  check('isRunning() tras start()', feed.isRunning());
  setTimeout(() => {
    feed.stop();
    const depths = seen.filter(m => isDepthSnapshot(m.data)).length;
    check('~10 depth/s con timers', depths >= 7 && depths <= 13, `(${depths} en 1s)`);
    check('stop() detiene', !feed.isRunning());
    const before = seen.length;
    setTimeout(() => {
      check('no emite tras stop()', seen.length === before);
      console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
      process.exit(failures === 0 ? 0 : 1);
    }, 300);
  }, 1000);
}
