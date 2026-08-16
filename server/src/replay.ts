import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { HOUR_MS, listRecordings, loadWindow } from './recording';
import type { RecordedFrame } from './recording';
import { flag, numberFlag } from './args';

/**
 * Servidor de replay.
 *
 * Reemite una grabación en el MISMO formato de cable que Binance, con los
 * mismos huecos entre frames. El cliente no puede distinguirlo del vivo: usa el
 * mismo `BinanceFeedClient`, el mismo parseo y el mismo `resolveFeedUrl`, que
 * ya arma `<vps>/replay/<symbol>`.
 *
 * Para qué existe: perfilar necesita repetir EL MISMO minuto una y otra vez
 * mientras mirás el profiler. Contra el mercado en vivo no hay dos corridas
 * comparables, así que cualquier medición de "mejoró o empeoró" es ruido.
 *
 *   ws://host/replay/btcusdt?at=2026-08-16T14:32:00Z&window=60&speed=1&loop=1
 *
 *   at      inicio de la ventana. ISO 8601 o ms epoch.
 *   window  segundos de grabación a reproducir.  default 60
 *   speed   multiplicador de velocidad.          default 1
 *   loop    repetir al terminar.                 default 1
 *   gap     pausa entre repeticiones, en ms.     default 0
 */

const DEFAULT_WINDOW_S = 60;
const MAX_WINDOW_S = 900;
const MIN_SPEED = 0.1;
const MAX_SPEED = 20;

/**
 * Tope de frames por ventana. 900 s al ritmo real son ~30k frames y ~15 MB de
 * texto; el tope está para que un `?window=` grande no se coma los 4 GB del VPS.
 */
const MAX_FRAMES = 200_000;

/**
 * Contrapresión. Pasado el umbral blando se saltean los snapshots de
 * profundidad, que son idempotentes por definición: perder uno no deja al
 * cliente en un estado inconsistente, el siguiente lo reemplaza entero. Los
 * trades no se saltean hasta el umbral duro, porque cada uno es un personaje
 * que sale al escenario y perderlos cambia lo que se ve.
 */
const BUFFER_SOFT = 1 << 20;
const BUFFER_HARD = 4 << 20;

interface Options {
  dir: string;
  port: number;
  host: string;
}

interface Session {
  frames: number;
  loops: number;
  droppedDepth: number;
  droppedTrades: number;
}

/* ------------------------------------------------------------------ */
/* Caché de ventanas                                                   */
/* ------------------------------------------------------------------ */

/**
 * Las mismas coordenadas piden el mismo array. Perfilar es abrir la misma
 * ventana veinte veces seguidas, y releer 15 MB de disco en cada F5 no aporta.
 */
const CACHE_MAX = 4;
const cache = new Map<string, RecordedFrame[]>();

async function windowFor(dir: string, symbol: string, from: number, to: number): Promise<RecordedFrame[]> {
  const key = `${symbol}|${from}|${to}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const result = await loadWindow(dir, symbol, from, to, MAX_FRAMES);
  if (result.skipped > 0) console.warn(`[replay] ${symbol} ${result.skipped} líneas ilegibles`);
  if (result.truncated) console.warn(`[replay] ${symbol} ventana cortada en ${MAX_FRAMES} frames`);
  cache.set(key, result.frames);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  return result.frames;
}

/* ------------------------------------------------------------------ */
/* Parámetros                                                          */
/* ------------------------------------------------------------------ */

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function parseInstant(raw: string | null): number | null {
  if (raw === null || raw === '') return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Sin `at`, la ventana es la última grabada. Es cómodo para mirar, pero se
 * mueve con el reloj: para una medición que se pueda repetir hay que pasar `at`.
 */
async function defaultStart(dir: string, symbol: string, windowMs: number): Promise<number> {
  const files = await listRecordings(dir, symbol);
  const last = files[files.length - 1];
  const end = last === undefined ? Date.now() : Math.min(last.hourMs + HOUR_MS, Date.now());
  return end - windowMs;
}

/* ------------------------------------------------------------------ */
/* Emisión                                                             */
/* ------------------------------------------------------------------ */

/**
 * Reloj de emisión sin deriva: cada frame se agenda contra `epoch`, el instante
 * de pared que corresponde al primer frame de la vuelta, y no contra "cuándo
 * salió el anterior". Encadenar `setTimeout` a partir del frame previo acumula
 * el error de cada timer y a los 60 s la grabación ya va corrida.
 */
function play(ws: WebSocket, frames: RecordedFrame[], speed: number, loop: boolean, gapMs: number, session: Session): () => void {
  const base = frames[0].t;
  const span = frames[frames.length - 1].t - base;
  let index = 0;
  let epoch = Date.now();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const send = (frame: RecordedFrame): void => {
    const buffered = ws.bufferedAmount;
    if (buffered > BUFFER_HARD || (buffered > BUFFER_SOFT && !frame.trade)) {
      if (frame.trade) session.droppedTrades++;
      else session.droppedDepth++;
      return;
    }
    ws.send(frame.payload);
    session.frames++;
  };

  const tick = (): void => {
    if (stopped) return;
    const now = Date.now();

    for (;;) {
      while (index < frames.length && epoch + (frames[index].t - base) / speed <= now) {
        send(frames[index]);
        index++;
      }
      if (index < frames.length) break;
      if (!loop) {
        ws.close(1000, 'fin de la grabación');
        return;
      }
      index = 0;
      session.loops++;
      epoch += (span + gapMs) / speed;
      // Si el proceso quedó suspendido (VPS con swap, laptop dormida) el epoch
      // puede quedar muy atrás y la vuelta siguiente saldría entera de golpe.
      // Se reancla al presente: se pierde la continuidad, no el ritmo.
      if (epoch < now - 1_000) epoch = now;
    }

    const due = epoch + (frames[index].t - base) / speed;
    timer = setTimeout(tick, Math.max(0, due - Date.now()));
  };

  tick();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}

/* ------------------------------------------------------------------ */
/* Servidor                                                            */
/* ------------------------------------------------------------------ */

async function handleConnection(ws: WebSocket, url: URL, symbol: string, dir: string): Promise<void> {
  const windowS = clamp(Number(url.searchParams.get('window') ?? DEFAULT_WINDOW_S) || DEFAULT_WINDOW_S, 1, MAX_WINDOW_S);
  const speed = clamp(Number(url.searchParams.get('speed') ?? 1) || 1, MIN_SPEED, MAX_SPEED);
  const loop = (url.searchParams.get('loop') ?? '1') !== '0';
  const gapMs = clamp(Number(url.searchParams.get('gap') ?? 0) || 0, 0, 10_000);
  const windowMs = windowS * 1000;

  const from = parseInstant(url.searchParams.get('at')) ?? (await defaultStart(dir, symbol, windowMs));
  const to = from + windowMs;

  const frames = await windowFor(dir, symbol, from, to);
  if (ws.readyState !== ws.OPEN) return;

  if (frames.length === 0) {
    console.warn(`[replay] ${symbol} sin datos en ${new Date(from).toISOString()} +${windowS}s`);
    ws.close(1011, 'no hay grabación para esa ventana');
    return;
  }

  const session: Session = { frames: 0, loops: 0, droppedDepth: 0, droppedTrades: 0 };
  console.log(
    `[replay] ${symbol} ${frames.length} frames desde ${new Date(from).toISOString()} ` +
    `+${windowS}s speed=${speed} loop=${loop ? 'sí' : 'no'}`,
  );

  const stop = play(ws, frames, speed, loop, gapMs, session);
  ws.on('close', () => {
    stop();
    console.log(
      `[replay] ${symbol} fin: ${session.frames} enviados, ${session.loops} vueltas` +
      (session.droppedDepth + session.droppedTrades > 0
        ? `, descartados ${session.droppedDepth} depth / ${session.droppedTrades} trades por contrapresión`
        : ''),
    );
  });
  ws.on('error', () => stop());
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const opts: Options = {
    dir: flag(argv, 'dir', 'recordings'),
    port: numberFlag(argv, 'port', 8080),
    host: flag(argv, 'host', '0.0.0.0'),
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      json(res, 200, { ok: true, dir: opts.dir, uptime: Math.round(process.uptime()) });
      return;
    }
    const listing = /^\/recordings\/([a-z0-9]+)$/i.exec(url.pathname);
    if (listing !== null) {
      void listRecordings(opts.dir, listing[1]).then((files) =>
        json(res, 200, {
          symbol: listing[1].toLowerCase(),
          hours: files.map((f) => ({
            from: new Date(f.hourMs).toISOString(),
            to: new Date(f.hourMs + HOUR_MS).toISOString(),
            bytes: f.bytes,
            comprimido: f.gzip,
          })),
        }),
      );
      return;
    }
    json(res, 404, { error: 'usá /health, /recordings/<symbol>, o ws://.../replay/<symbol>' });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/replay\/([a-z0-9]+)$/i.exec(url.pathname);
    if (match === null) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    const symbol = match[1].toLowerCase();
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, url, symbol, opts.dir).catch((error: unknown) => {
        console.error('[replay] error en la conexión:', error);
        ws.close(1011, 'error del servidor');
      });
    });
  });

  server.listen(opts.port, opts.host, () => {
    console.log(`[replay] escuchando en ${opts.host}:${opts.port}, dir=${opts.dir}`);
  });

  const shutdown = (): void => {
    server.close();
    for (const ws of wss.clients) ws.close(1001, 'servidor apagándose');
    setTimeout(() => process.exit(0), 200).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
