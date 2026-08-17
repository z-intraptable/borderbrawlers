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
  planPrune,
} from './recording';
import type { RecordingFile } from './recording';
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

/**
 * Retención por defecto: 10 GB, o 30 días, lo que llegue primero.
 *
 * El límite real es el tamaño y está puesto a propósito: 10 GB a 0,36 GB/día
 * comprimidos son ~28 días, y ~23 si el mercado se pone volátil (0,44 GB/día).
 * O sea que la cinta se pisa sola cada tres o cuatro semanas y el disco del VPS
 * nunca pasa de 10 GB, sin que haya que intervenir.
 *
 * Los 30 días son el tope de edad nominal. Casi nunca va a morder —el tamaño
 * llega primero— pero deja el techo explícito para cuando el mercado esté tan
 * quieto que 10 GB alcancen para más de un mes.
 */
const DEFAULT_KEEP_DAYS = 30;
const DEFAULT_MAX_GB = 10;

interface Options {
  dir: string;
  symbols: string[];
  host: string;
  keepDays: number;
  maxBytes: number;
}

function parseOptions(argv: string[]): Options {
  return {
    dir: flag(argv, 'dir', 'recordings'),
    symbols: flag(argv, 'symbols', 'btcusdt').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    host: flag(argv, 'host', BINANCE_DATA_HOST),
    keepDays: numberFlag(argv, 'keep-days', DEFAULT_KEEP_DAYS),
    maxBytes: Math.round(numberFlag(argv, 'max-gb', DEFAULT_MAX_GB) * 1e9),
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

  /** El archivo que se está escribiendo ahora. Nunca se puede podar. */
  get activeFile(): string | null {
    return this.hour < 0 ? null : fileNameFor(this.symbol, this.hour, false);
  }

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
      // Podar acá y no sólo en el timer: el cambio de hora es el único momento
      // en que el disco pega un salto, y es también cuando el archivo recién
      // comprimido ya tiene su tamaño final.
      await this.onHourClosed?.();
    });
  }

  /** Lo setea `main` una vez armado el conjunto de writers. */
  onHourClosed: (() => Promise<void>) | null = null;

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

/**
 * Aplica la política de retención. El presupuesto es compartido entre símbolos
 * porque el disco es uno solo.
 */
async function enforceRetention(opts: Options, protect: ReadonlySet<string>): Promise<void> {
  if (opts.keepDays <= 0 && opts.maxBytes <= 0) return;

  const files: RecordingFile[] = [];
  for (const symbol of opts.symbols) files.push(...(await listRecordings(opts.dir, symbol)));

  const plan = planPrune(files, {
    nowMs: Date.now(),
    keepMs: opts.keepDays * 24 * HOUR_MS,
    maxBytes: opts.maxBytes,
    protect,
  });

  for (const file of plan.remove) {
    await rm(join(opts.dir, file.file), { force: true });
    console.log(`[record] podado ${file.file} (${(file.bytes / 1e6).toFixed(0)} MB)`);
  }
  if (plan.remove.length > 0) {
    console.log(`[record] en disco ${(plan.keptBytes / 1e9).toFixed(2)} GB de ${(opts.maxBytes / 1e9).toFixed(0)} GB`);
  }
  if (plan.overBudget) {
    console.warn(
      `[record] ATENCIÓN: ${(plan.keptBytes / 1e9).toFixed(2)} GB en disco y no queda nada podable. ` +
      'La hora en curso sola ya no entra en el tope: subí --max-gb o bajá --keep-days.',
    );
  }
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  await mkdir(opts.dir, { recursive: true });

  // Restos de un corte anterior: un .part nunca es dato bueno.
  for (const name of await readdir(opts.dir)) {
    if (name.endsWith('.part')) await rm(join(opts.dir, name), { force: true });
  }

  console.log(
    `[record] dir=${opts.dir} símbolos=${opts.symbols.join(',')} host=${opts.host} ` +
    `retención=${opts.keepDays}d/${(opts.maxBytes / 1e9).toFixed(0)}GB`,
  );

  const writers = new Map<string, SymbolWriter>();
  const clients: BinanceFeedClient[] = [];

  const activeFiles = (): Set<string> => {
    const set = new Set<string>();
    for (const writer of writers.values()) {
      const active = writer.activeFile;
      if (active !== null) set.add(active);
    }
    return set;
  };
  const retain = (): Promise<void> => enforceRetention(opts, activeFiles());

  // Al arrancar, antes de escribir un byte: si el proceso estuvo caído una
  // semana, lo que hay en disco ya está fuera de política.
  await retain();

  for (const symbol of opts.symbols) {
    const writer = new SymbolWriter(opts.dir, symbol);
    writers.set(symbol, writer);
    const client = new BinanceFeedClient({
      url: combinedStreamUrl(opts.host, symbol),
      ingest: false,
      onRaw: (raw) => writer.write(Date.now(), raw),
      onStatus: (status: ConnectionStatus) => console.log(`[record] ${symbol} ${status}`),
    });
    writer.onHourClosed = retain;
    clients.push(client);
    client.start();
  }

  const stats = setInterval(() => {
    for (const [symbol, writer] of writers) {
      const mb = writer.bytes / 1_048_576;
      console.log(`[record] ${symbol} ${writer.frames} frames ${mb.toFixed(1)} MB`);
    }
    void retain();
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
