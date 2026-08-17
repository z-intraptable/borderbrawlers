import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';

/**
 * Formato de grabación y lectura de ventanas.
 *
 * Módulo puro salvo por el acceso a disco: no abre sockets, no depende del
 * servidor, y es lo único de `server/` que se testea con asserts.
 *
 * ---
 *
 * Una línea por frame, NDJSON:
 *
 *     {"t":1755357600123,"d":{"stream":"btcusdt@aggTrade","data":{...}}}
 *
 * `t` es el instante en que el frame ENTRÓ, en ms epoch. `d` es el texto que
 * mandó Binance, byte por byte, sin reparsear. Esa es la parte que importa: el
 * replay tiene que ser indistinguible del vivo, y cualquier round-trip por
 * `JSON.parse` + `JSON.stringify` normaliza cosas (orden de claves, exponentes,
 * `1.0` → `1`) que en el vivo llegan como llegan. Guardar el crudo también hace
 * que grabar cueste una concatenación de strings y nada más.
 *
 * Un archivo por hora UTC y por símbolo: `btcusdt-2026-08-16T14.ndjson`, y
 * `.ndjson.gz` una vez cerrado. La hora es la unidad de rotación porque es la
 * granularidad más fina en la que sigue valiendo la pena comprimir, y porque
 * elegir "el minuto de las 14:32" no debería obligar a descomprimir un día.
 */

export const HOUR_MS = 3_600_000;

/** Sufijos, en el orden en que se prefieren al buscar una hora en disco. */
export const PLAIN_SUFFIX = '.ndjson';
export const GZIP_SUFFIX = '.ndjson.gz';

export interface RecordedFrame {
  /** ms epoch en que llegó el frame. */
  t: number;
  /** El texto original de Binance, sin tocar. */
  payload: string;
  /**
   * `true` si es un aggTrade. Se calcula UNA vez, al cargar, porque el
   * servidor lo necesita por frame bajo contrapresión y ahí no hay tiempo de
   * parsear: un snapshot de profundidad es idempotente y se puede descartar sin
   * consecuencias, un trade no.
   */
  trade: boolean;
}

/* ------------------------------------------------------------------ */
/* Codificación                                                        */
/* ------------------------------------------------------------------ */

/** Arma la línea sin reparsear el payload: es una concatenación y nada más. */
export function encodeFrame(t: number, payload: string): string {
  return `{"t":${t},"d":${payload}}\n`;
}

/**
 * Deshace `encodeFrame` sin `JSON.parse`. El prefijo es de largo conocido
 * (`{"t":` son 5 caracteres) y el timestamp son dígitos, así que la primera
 * coma después del índice 5 es el separador. Sobre 60 s de mercado son ~2000
 * líneas; con `JSON.parse` sería trabajo tirado, porque lo que queremos de
 * vuelta es justamente el texto sin interpretar.
 *
 * Devuelve `null` para líneas vacías o que no tengan la forma esperada, en vez
 * de tirar: una grabación cortada a la mitad por un apagón termina en una línea
 * trunca, y eso no puede voltear el servidor.
 */
export function decodeFrame(line: string): RecordedFrame | null {
  if (line.length < 12 || !line.startsWith('{"t":')) return null;
  const comma = line.indexOf(',', 5);
  if (comma < 0) return null;
  const t = Number(line.slice(5, comma));
  if (!Number.isFinite(t)) return null;
  if (line.slice(comma, comma + 5) !== ',"d":') return null;
  if (line.charCodeAt(line.length - 1) !== 125 /* } */) return null;
  const payload = line.slice(comma + 5, -1);
  if (payload.length === 0) return null;
  return { t, payload, trade: payload.includes('"e":"aggTrade"') };
}

/* ------------------------------------------------------------------ */
/* Nombres de archivo                                                  */
/* ------------------------------------------------------------------ */

/** '2026-08-16T14' — hora UTC. Ordena lexicográficamente igual que en el tiempo. */
export function hourKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

export function hourStartMs(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

export function fileNameFor(symbol: string, ms: number, gzip = false): string {
  return `${symbol.toLowerCase()}-${hourKey(ms)}${gzip ? GZIP_SUFFIX : PLAIN_SUFFIX}`;
}

export interface ParsedName {
  symbol: string;
  hourMs: number;
  gzip: boolean;
}

export function parseFileName(name: string): ParsedName | null {
  const gzip = name.endsWith(GZIP_SUFFIX);
  const base = gzip ? name.slice(0, -GZIP_SUFFIX.length) : name.endsWith(PLAIN_SUFFIX)
    ? name.slice(0, -PLAIN_SUFFIX.length)
    : null;
  if (base === null) return null;
  const cut = base.lastIndexOf('-', base.length - 12);
  if (cut <= 0) return null;
  const symbol = base.slice(0, cut);
  const key = base.slice(cut + 1);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(key)) return null;
  const hourMs = Date.parse(`${key}:00:00.000Z`);
  if (!Number.isFinite(hourMs)) return null;
  return { symbol, hourMs, gzip };
}

/** Horas UTC que tocan el intervalo [from, to], inclusive de los bordes. */
export function hoursCovering(fromMs: number, toMs: number): number[] {
  if (!(toMs >= fromMs)) return [];
  const out: number[] = [];
  for (let h = hourStartMs(fromMs); h <= toMs; h += HOUR_MS) out.push(h);
  return out;
}

/* ------------------------------------------------------------------ */
/* Inventario y lectura                                                */
/* ------------------------------------------------------------------ */

export interface RecordingFile extends ParsedName {
  file: string;
  bytes: number;
}

/** Todas las grabaciones de un símbolo que hay en `dir`, de más vieja a más nueva. */
export async function listRecordings(dir: string, symbol: string): Promise<RecordingFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const wanted = symbol.toLowerCase();
  const out: RecordingFile[] = [];
  for (const name of names) {
    const parsed = parseFileName(name);
    if (parsed === null || parsed.symbol !== wanted) continue;
    const info = await stat(join(dir, name));
    out.push({ ...parsed, file: name, bytes: info.size });
  }
  out.sort((a, b) => a.hourMs - b.hourMs);
  return out;
}

/** Abre una hora, prefiriendo el `.ndjson` si todavía no se comprimió. */
function openHour(dir: string, symbol: string, hourMs: number, files: Set<string>): NodeJS.ReadableStream | null {
  const plain = fileNameFor(symbol, hourMs, false);
  if (files.has(plain)) return createReadStream(join(dir, plain));
  const gz = fileNameFor(symbol, hourMs, true);
  if (files.has(gz)) return createReadStream(join(dir, gz)).pipe(createGunzip());
  return null;
}

export interface WindowResult {
  frames: RecordedFrame[];
  /** `true` si se llegó al tope de frames y la ventana quedó cortada. */
  truncated: boolean;
  /** Líneas ilegibles salteadas. Distinto de cero es una grabación dañada. */
  skipped: number;
}

/**
 * Carga [fromMs, toMs) entero en memoria.
 *
 * Cargar en vez de leer del disco mientras se emite es deliberado: una ventana
 * de 60 s son ~1 MB (el stream son ~16 KB/s), y tenerla toda en RAM es lo que
 * hace que el replay sea determinista de verdad — un hipo del disco no puede
 * correr un frame de lugar — y que repetir el bucle no cueste nada. `maxFrames`
 * es la red de contención para que un `?window=` grande no se coma el VPS.
 */
export async function loadWindow(
  dir: string,
  symbol: string,
  fromMs: number,
  toMs: number,
  maxFrames: number,
): Promise<WindowResult> {
  const present = new Set((await listRecordings(dir, symbol)).map((r) => r.file));
  const frames: RecordedFrame[] = [];
  let skipped = 0;
  let truncated = false;

  for (const hour of hoursCovering(fromMs, toMs)) {
    const stream = openHour(dir, symbol, hour, present);
    if (stream === null) continue;
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length === 0) continue;
      const frame = decodeFrame(line);
      if (frame === null) { skipped++; continue; }
      if (frame.t < fromMs) continue;
      if (frame.t >= toMs) break;
      if (frames.length >= maxFrames) { truncated = true; break; }
      frames.push(frame);
    }
    lines.close();
    stream.on?.('error', () => {});
    if (truncated) break;
  }

  // Las horas se leen en orden y dentro de cada archivo los frames ya están
  // ordenados por construcción, pero un solape entre archivos (una reconexión
  // justo en el cambio de hora) rompería el orden y con él la línea de tiempo.
  frames.sort((a, b) => a.t - b.t);
  return { frames, truncated, skipped };
}

/* ------------------------------------------------------------------ */
/* Retención                                                           */
/* ------------------------------------------------------------------ */

export interface RetentionPolicy {
  /** Instante de referencia, en ms epoch. */
  nowMs: number;
  /** Antigüedad máxima en ms. 0 = sin límite de edad. */
  keepMs: number;
  /** Tamaño máximo total en bytes. 0 = sin límite de tamaño. */
  maxBytes: number;
  /** Archivos que NO se pueden borrar: las horas que se están escribiendo. */
  protect: ReadonlySet<string>;
}

export interface PrunePlan {
  /** A borrar, de más viejo a más nuevo. */
  remove: RecordingFile[];
  /** Bytes que quedan después de borrar. */
  keptBytes: number;
  /**
   * `true` si se agotó lo que se podía borrar y el total sigue por encima del
   * tope. Pasa cuando la hora en curso sola ya no entra: no es una condición
   * que se pueda resolver borrando, hay que avisar.
   */
  overBudget: boolean;
}

/**
 * Qué borrar para respetar la política, sin tocar disco.
 *
 * Dos topes, y corta el que llegue primero: la edad limpia lo que ya no sirve
 * para perfilar, y el tamaño es la red de contención para que una racha de
 * volatilidad no llene el VPS igual. Siempre se borra lo más viejo primero, y
 * nunca la hora que se está escribiendo.
 *
 * El presupuesto es COMPARTIDO entre símbolos: el disco es uno solo, así que
 * grabar dos pares no puede duplicar el espacio ocupado en silencio.
 */
export function planPrune(files: readonly RecordingFile[], policy: RetentionPolicy): PrunePlan {
  // Orden determinista aun con dos símbolos en la misma hora.
  const sorted = [...files].sort((a, b) => a.hourMs - b.hourMs || a.file.localeCompare(b.file));
  const remove: RecordingFile[] = [];
  let total = sorted.reduce((sum, f) => sum + f.bytes, 0);

  const removable = (f: RecordingFile): boolean => !policy.protect.has(f.file);

  if (policy.keepMs > 0) {
    const cutoff = policy.nowMs - policy.keepMs;
    for (const f of sorted) {
      // Se compara contra el FIN de la hora: un archivo de las 14:00 con 7 días
      // de retención sigue conteniendo datos válidos hasta las 15:00.
      if (f.hourMs + HOUR_MS >= cutoff || !removable(f)) continue;
      remove.push(f);
      total -= f.bytes;
    }
  }

  if (policy.maxBytes > 0 && total > policy.maxBytes) {
    for (const f of sorted) {
      if (total <= policy.maxBytes) break;
      if (remove.includes(f) || !removable(f)) continue;
      remove.push(f);
      total -= f.bytes;
    }
  }

  remove.sort((a, b) => a.hourMs - b.hourMs || a.file.localeCompare(b.file));
  return {
    remove,
    keptBytes: total,
    overBudget: policy.maxBytes > 0 && total > policy.maxBytes,
  };
}
