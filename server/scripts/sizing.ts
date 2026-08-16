/*
 * Cuánto ocupa grabar. Corre el generador sintético —que emite exactamente las
 * mismas formas de cable que Binance— por una hora simulada, lo codifica con el
 * formato real de grabación y lo comprime de verdad con el mismo gzip que usa
 * el grabador. No estima: mide.
 *
 * La única entrada discutible es el ritmo de trades del perfil; se informa para
 * que se pueda contrastar con el mercado real.
 */
import { createGzip } from 'node:zlib';
import { createMockFeed } from '../../src/mock/mockFeed';
import type { MockScenario } from '../../src/mock/mockFeed';
import { encodeFrame } from '../src/recording';
import type { FeedMessage } from '../../src/types/binance';

const HOURS_PER_YEAR = 24 * 365;
const TICKS_PER_HOUR = 36_000; // 100 ms por tick de profundidad

async function measure(scenario: MockScenario): Promise<void> {
  let trades = 0;
  let raw = 0;
  let gz = 0;
  let t = Date.parse('2026-08-16T14:00:00.000Z');

  // Por streaming y no acumulando: una hora de `stress` pasa el largo máximo de
  // string de V8, que es justamente el tipo de cosa que este script tiene que
  // poder medir sin caerse.
  const gzip = createGzip({ level: 6 });
  gzip.on('data', (chunk: Buffer) => { gz += chunk.length; });
  const done = new Promise<void>((resolve) => gzip.on('end', resolve));

  const feed = createMockFeed((message: FeedMessage) => {
    const rawMessage = JSON.stringify(message);
    if (rawMessage.includes('"e":"aggTrade"')) trades++;
    const line = encodeFrame(t, rawMessage);
    raw += Buffer.byteLength(line);
    gzip.write(line);
  }, { scenario, symbol: 'btcusdt' });

  // `step` avanza sin timers: una hora de mercado en unos segundos de CPU.
  for (let i = 0; i < TICKS_PER_HOUR; i++) {
    t += 100;
    feed.step(1);
  }
  gzip.end();
  gzip.resume();
  await done;

  console.log(
    `${scenario.padEnd(9)} ${(trades / 3600).toFixed(0).padStart(3)} trades/s  ` +
    `hora ${(raw / 1e6).toFixed(0).padStart(4)} MB → ${(gz / 1e6).toFixed(0).padStart(3)} MB gz ` +
    `(${(raw / gz).toFixed(1)}x)  ` +
    `día ${((raw * 24) / 1e9).toFixed(2)} GB → ${((gz * 24) / 1e9).toFixed(2)} GB  ` +
    `año ${((gz * HOURS_PER_YEAR) / 1e9).toFixed(0).padStart(3)} GB`,
  );
}

console.log('\nUna hora simulada por escenario, formato de grabación real, gzip nivel 6.\n');
console.log('escenario  ritmo         por hora                     por día                año');
for (const scenario of ['calm', 'normal', 'volatile', 'stress'] as const) await measure(scenario);
console.log();
