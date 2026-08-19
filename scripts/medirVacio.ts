/**
 * ¿Cuánto tiempo pasa el escenario con menos peleadores de los que debería?
 *
 * La medición anterior salteaba los cuadros de la ceremonia y contaba por
 * bando. Ésta no saltea nada y cuenta también la PANTALLA VACÍA, que es lo que
 * el operador ve: no importa de qué bando falta, importa que no hay nadie.
 *
 *     npx tsx scripts/medirVacio.ts
 */
import { TradeRingBuffer } from '../src/net/feedCore';
import type { FeedStats } from '../src/net/feedCore';
import { FIGHTERS_PER_TEAM, createMatch, stepMatch } from '../src/game/match';
import { SLOT_ACTIVE } from '../src/game/fighters';

const stats: FeedStats = {
  mid: 100, spread: 0.01, tradeMedian: 1, bookQtyMedian: 1,
  buyVolume: 1, sellVolume: 1, bidVolume: 1, askVolume: 1,
  snapshots: 0, trades: 0, whales: 0, droppedTrades: 0, reconnects: 0,
};

const activos = (m: ReturnType<typeof createMatch>, desde: number): number => {
  let n = 0;
  for (let i = desde; i < desde + FIGHTERS_PER_TEAM; i++) if (m.slot[i] === SLOT_ACTIVE) n++;
  return n;
};

const MINUTOS = 10;
const PASOS = Math.round(MINUTOS * 60 * 60);

// Cuatro formas de mercado: los dos lados parejos, uno solo, y seco.
const mercados: Array<[string, (paso: number) => 'buy' | 'sell' | null]> = [
  ['parejo', (p) => (p % 6 === 0 ? (p % 12 === 0 ? 'buy' : 'sell') : null)],
  ['sólo compras', (p) => (p % 6 === 0 ? 'buy' : null)],
  ['sólo ventas', (p) => (p % 6 === 0 ? 'sell' : null)],
  ['seco', (p) => (p % 600 === 0 ? 'buy' : null)],
];

for (const [nombre, lado] of mercados) {
  const m = createMatch(3, true);
  const cola = new TradeRingBuffer(64);
  let vacia = 0;        // segundos con CERO peleadores en pantalla
  let peorVacia = 0;
  let corridaVacia = 0;
  let solitario = 0;    // segundos con un bando presente y el otro no
  let peorSolo = 0;
  let corridaSolo = 0;
  let ceremonias = 0;
  let antesGanador = -1;

  for (let paso = 0; paso < PASOS; paso++) {
    const cual = lado(paso);
    if (cual !== null) cola.push(paso, cual, 100, 1 + (paso % 5), false, paso);
    stepMatch(m, cola, stats, 1 / 60);
    if (m.ganador >= 0 && antesGanador < 0) ceremonias++;
    antesGanador = m.ganador;

    const verde = activos(m, 0);
    const rojo = activos(m, FIGHTERS_PER_TEAM);
    if (verde + rojo === 0) {
      vacia += 1 / 60; corridaVacia += 1 / 60;
      peorVacia = Math.max(peorVacia, corridaVacia);
    } else corridaVacia = 0;
    // Sólo cuenta como "falta la mitad" fuera de la ceremonia: durante el
    // festejo el perdedor NO tiene que estar, es el diseño.
    if (m.ganador < 0 && (verde === 0) !== (rojo === 0)) {
      solitario += 1 / 60; corridaSolo += 1 / 60;
      peorSolo = Math.max(peorSolo, corridaSolo);
    } else corridaSolo = 0;
  }

  const total = PASOS / 60;
  console.log(
    nombre.padEnd(13),
    'vacía', `${vacia.toFixed(1)}s`.padStart(7), `(${(vacia / total * 100).toFixed(1)}%, peor ${peorVacia.toFixed(2)}s)`,
    '| media pelea', `${solitario.toFixed(1)}s`.padStart(7), `(${(solitario / total * 100).toFixed(1)}%, peor ${peorSolo.toFixed(2)}s)`,
    '|', ceremonias, 'matches',
  );
}
