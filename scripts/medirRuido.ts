/**
 * Cuenta el ruido del movimiento, en vez de mirarlo.
 *
 *   npx tsx scripts/medirRuido.ts
 *
 * "Se ve mucho ruido en los movimientos" es una observación de ojo, y las
 * observaciones de ojo se discuten. Estas tres son números:
 *
 * - **vueltas**: cuántas veces por segundo un peleador se espeja. El dibujo se
 *   voltea con `facing`, así que dos vueltas en el mismo segundo ya se ven como
 *   un parpadeo.
 * - **cambios de signo de la velocidad**: cuántas veces frena y arranca para el
 *   otro lado. Es el temblor, aunque no llegue a darse vuelta el dibujo.
 * - **sacudón**: cuánto cambia la velocidad de un paso al siguiente, promedio.
 *   Un número alto es movimiento a los tirones aunque no oscile.
 *
 * Sin red, sin navegador y sin dibujar nada: trades a mano, como el resto de
 * los smoke tests.
 */
import { TradeRingBuffer } from '../src/net/feedCore';
import type { FeedStats } from '../src/net/feedCore';
import { CAPACITY, PLATFORM_COUNT, createMatch, stepMatch } from '../src/game/match';
import { SLOT_ACTIVE } from '../src/game/fighters';

const SEGUNDOS = 60;
const PASO = 1 / 60;

const stats: FeedStats = {
  mid: 100, spread: 0.01, tradeMedian: 1, bookQtyMedian: 1,
  buyVolume: 1, sellVolume: 1, bidVolume: 1, askVolume: 1,
  snapshots: 0, trades: 0, whales: 0, droppedTrades: 0, reconnects: 0,
};

const m = createMatch();
const trades = new TradeRingBuffer(64);

/**
 * **El libro plano es el caso que se ve mal.** Con la liquidez repartida pareja
 * las ocho plataformas de los costados se quedan abajo del todo y las seis
 * personas terminan encimadas en la del centro, que es exactamente lo que se ve
 * en el teléfono. Con un libro cualquiera se separan solas y no se mide nada.
 */
function libroPlano(): void {
  for (let i = 1; i < PLATFORM_COUNT; i++) {
    m.targetY[i] = -3;
    m.skyline.topY[i] = -3;
  }
}
libroPlano();
// Alta de los seis.
for (let n = 0; n < CAPACITY; n++) trades.push(n, n % 2 === 0 ? 'buy' : 'sell', 100, 1, false, n);
for (let n = 0; n < 8; n++) stepMatch(m, trades, stats, PASO);

const n = m.slot.length;
const facingAntes = Int8Array.from(m.facing);
const signoAntes = new Int8Array(n);
const vxAntes = Float64Array.from(m.vx);

let vueltas = 0;
let cambios = 0;
let sacudon = 0;
let muestras = 0;
let contactos = 0;
let id = 1000;

for (let paso = 0; paso < SEGUNDOS / PASO; paso++) {
  // Un goteo constante de órdenes: sin barra nadie pega y la medición sería de
  // una pelea que no pasa.
  if (paso % 6 === 0) {
    trades.push(id, id % 2 === 0 ? 'buy' : 'sell', 100, 1.4, false, id);
    id++;
  }
  libroPlano();
  stepMatch(m, trades, stats, PASO);
  for (let i = 0; i < n; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    if (m.facing[i] !== facingAntes[i]) vueltas++;
    facingAntes[i] = m.facing[i];

    const signo = m.vx[i] > 0.35 ? 1 : m.vx[i] < -0.35 ? -1 : 0;
    if (signo !== 0 && signoAntes[i] !== 0 && signo !== signoAntes[i]) cambios++;
    if (signo !== 0) signoAntes[i] = signo;

    for (let j = i + 1; j < n; j++) {
      if (m.slot[j] !== SLOT_ACTIVE || m.team[j] === m.team[i]) continue;
      if (Math.hypot(m.x[j] - m.x[i], m.y[j] - m.y[i]) <= 0.85) contactos++;
    }
    sacudon += Math.abs(m.vx[i] - vxAntes[i]);
    vxAntes[i] = m.vx[i];
    muestras++;
  }
}

// Ojo con esto: `muestras` ya son pasos × peleadores. Dividir por él Y por la
// frecuencia del paso escalaba el resultado sesenta veces para abajo y todo
// daba 0,00 — un medidor que siempre dice que está todo bien.
const vivos = muestras / (SEGUNDOS / PASO);
const porSegundo = (x: number): string => (x / SEGUNDOS / vivos).toFixed(2);
console.log(`\n${SEGUNDOS} s de pelea — por peleador y por segundo:`);
console.log(`  vueltas (se espeja el dibujo)   ${porSegundo(vueltas)}`);
console.log(`  cambios de signo de velocidad   ${porSegundo(cambios)}`);
console.log(`  sacudón medio por paso          ${(sacudon / muestras).toFixed(3)} u/s`);
console.log(`  pares en contacto por paso      ${(contactos / (muestras / n)).toFixed(2)}`);
