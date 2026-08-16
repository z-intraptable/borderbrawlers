import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, rm, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { BinanceFeedClient } from '../../src/net/feedCore';
import { BINANCE_DATA_HOST, combinedStreamUrl } from '../../src/types/binance';
import type { ConnectionStatus } from '../../src/types/binance';
import {
  GZIP_SUFFIX,
  HOUR_MS,
  PLAIN_SUFFIX,
  encodeFrame,
  fileNameFor,
  hourStartMs,
  listRecordings,
} from './recording';
import { flag, numberFlag } from './args';

/**
 * Grabador. Un proceso, un símbolo por conexión, escribe el crudo a disco.
 *
 * No reimplementa nada de la red: usa el mismo `BinanceFeedClient` que corre en
 * el browser, con `ingest: false` para que no parsee ni acumule medianas que
 * acá no le sirven a nadie. El backoff exponencial con jitter, el límite de 300
 * intentos por 5 minutos y la reconexión proactiva a las 24 h vienen de arriba
 * y están cubiertos por `npm test` en la raíz. Una segunda implementación de
 * eso mismo en el servidor sería la que se desincroniza y se descubre un martes
 * a las 3 de la mañana con un hueco de seis horas en la grabación.
 */

interface Options {
  dir: string;
  symbols: string[];
  host: string;
  keepDays: number;
}

function parseOptions(argv: string[]): Options {
  return {
    dir: flag(argv, 'dir', 'recordings'),
    symbols: flag(argv, 'symbols', 'btcusdt').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    host: flag(argv, 'host', BINANCE_DATA_HOST),
    keepDays: numberFlag(argv, 'keep-days', 0),
  };
}

/**
 * Un archivo abierto por símbolo, rotado al cambiar la hora UTC.
 *
 * La escritura va por el buffer del `WriteStream` y nunca espera al `drain`: un
 * grabador que aplica contrapresión hacia el socket termina perdiendo frames,
 * que es exactamente lo que no puede pasar. A 16 KB/s contra un disco de VPS el
 * buffer no crece; si creciera, se ve en el log de `stats`.
 */
class SymbolWriter {
  private stream: WriteStream | null = null;
  private hour = -1;
  private pending: Promise<void> = Promise.resolve();

  frames = 0;
  bytes = 0;

  constructor(private readonly dir: string, private readonly symbol: string) {}

  write(t: number, payload: string): void {
    const hour = hourStartMs(t);
    if (hour !== this.hour) this.rotate(hour);
    const line = encodeFrame(t, payload);
    this.frames++;
    this.bytes += line.length;
    this.stream?.write(line);
  }

  private rotate(hour: number): void {
    const previous = this.stream;
    const previousName = this.hour < 0 ? null : fileNameFor(this.symbol, this.hour, false);
    this.hour = hour;
    this.stream = createWriteStream(join(this.dir, fileNameFor(this.symbol, hour, false)), { flags: 'a' });

    if (previous === null || previousName === null) return;
    // Comprimir en cadena, nunca en paralelo: dos gzip simultáneos en 2 vCPU
    // compitiendo con el grabador es la única forma de que este proceso llegue
    // a perder un frame por CPU.
    this.pending = this.pending.then(async () => {
      await new Promise<void>((resolve) => previous.end(resolve));
      await compress(this.dir, previousName);
    });
  }

  async close(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    if (stream !== null) await new Promise<void>((resolve) => stream.end(resolve));
    await this.pending;
  }
}

/** gzip a `.ndjson.gz.part` y recién ahí el rename: un corte no deja un .gz trunco. */
async function compress(dir: string, name: string): Promise<void> {
  const source = join(dir, name);
  const target = join(dir, name.replace(PLAIN_SUFFIX, GZIP_SUFFIX));
  const partial = `${target}.part`;
  try {
    await pipeline(createReadStream(source), createGzip({ level: 6 }), createWriteStream(partial));
    await rename(partial, target);
    await rm(source);
    console.log(`[record] comprimido ${name}`);
  } catch (error) {
    console.error(`[record] falló comprimir ${name}:`, error);
    await rm(partial, { force: true });
  }
}

/** Borra grabaciones más viejas que `keepDays`. 0 = no borrar nunca. */
async function prune(dir: string, symbols: string[], keepDays: number): Promise<void> {
  if (keepDays <= 0) return;
  const cutoff = Date.now() - keepDays * 24 * HOUR_MS;
  for (const symbol of symbols) {
    for (const rec of await listRecordings(dir, symbol)) {
      if (rec.hourMs + HOUR_MS >= cutoff) continue;
      await rm(join(dir, rec.file), { force: true });
      console.log(`[record] podado ${rec.file}`);
    }
  }
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  await mkdir(opts.dir, { recursive: true });

  // Restos de un corte anterior: un .part nunca es dato bueno.
  for (const name of await readdir(opts.dir)) {
    if (name.endsWith('.part')) await rm(join(opts.dir, name), { force: true });
  }

  console.log(`[record] dir=${opts.dir} símbolos=${opts.symbols.join(',')} host=${opts.host}`);

  const writers = new Map<string, SymbolWriter>();
  const clients: BinanceFeedClient[] = [];

  for (const symbol of opts.symbols) {
    const writer = new SymbolWriter(opts.dir, symbol);
    writers.set(symbol, writer);
    const client = new BinanceFeedClient({
      url: combinedStreamUrl(opts.host, symbol),
      ingest: false,
      onRaw: (raw) => writer.write(Date.now(), raw),
      onStatus: (status: ConnectionStatus) => console.log(`[record] ${symbol} ${status}`),
    });
    clients.push(client);
    client.start();
  }

  const stats = setInterval(() => {
    for (const [symbol, writer] of writers) {
      const mb = writer.bytes / 1_048_576;
      console.log(`[record] ${symbol} ${writer.frames} frames ${mb.toFixed(1)} MB`);
    }
    void prune(opts.dir, opts.symbols, opts.keepDays);
  }, 10 * 60_000);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`[record] ${signal}, cerrando`);
    clearInterval(stats);
    for (const client of clients) client.stop();
    for (const writer of writers.values()) await writer.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();
