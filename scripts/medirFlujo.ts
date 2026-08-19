/* Cuánto de la pelea es aire y cuánto es distancia. Sirve para comparar. */
import { TradeRingBuffer } from '../src/net/feedCore';
import type { FeedStats } from '../src/net/feedCore';
import { CAPACITY, FIGHTERS_PER_TEAM, createMatch, stepMatch } from '../src/game/match';
import { SLOT_ACTIVE } from '../src/game/fighters';

const stats: FeedStats = {
  mid: 100, spread: 0.01, tradeMedian: 1, bookQtyMedian: 1,
  buyVolume: 1, sellVolume: 1, bidVolume: 1, askVolume: 1,
  snapshots: 0, trades: 0, whales: 0, droppedTrades: 0, reconnects: 0,
};
const m = createMatch(FIGHTERS_PER_TEAM, true);
const trades = new TradeRingBuffer(256);
for (let n = 0; n < CAPACITY; n++) trades.push(n, n % 2 === 0 ? 'buy' : 'sell', 100, 3, false, n);

let enAire = 0;
let muestras = 0;
const distancias: number[] = [];
for (let paso = 0; paso < 7200; paso++) {
  if (paso % 4 === 0) {
    trades.push(paso, paso % 2 === 0 ? 'buy' : 'sell', 100, 2 + (paso % 4), false, paso);
  }
  stepMatch(m, trades, stats, 1 / 60);
  m.events.count = 0;
  if (m.ganador >= 0) continue;
  let a = -1; let b = -1;
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    if (i < FIGHTERS_PER_TEAM) a = i; else b = i;
  }
  for (const i of [a, b]) {
    if (i < 0) continue;
    muestras++;
    if (m.grounded[i] !== 1) enAire++;
  }
  if (a >= 0 && b >= 0) distancias.push(Math.abs(m.x[a] - m.x[b]));
}
distancias.sort((p, q) => p - q);
const mediana = distancias.length ? distancias[distancias.length >> 1] : 0;
const lejos = distancias.filter((d) => d > 4).length / (distancias.length || 1);
console.log(`en el aire:            ${(enAire / muestras * 100).toFixed(1)}% del tiempo`);
console.log(`distancia mediana:     ${mediana.toFixed(2)} unidades`);
console.log(`a más de 4 unidades:   ${(lejos * 100).toFixed(1)}% del tiempo`);
