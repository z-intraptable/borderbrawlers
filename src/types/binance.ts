/**
 * Contrato de datos de BorderBrawlers.
 *
 * Bloque 1 — tipos de cable (wire): las formas EXACTAS que emite Binance.
 * Bloque 2 — tipos normalizados: lo que consume la escena, ya en números.
 *
 * Los tipos de cable no se tocan ni se "mejoran": son el contrato del exchange.
 * El relay del VPS opera en modo passthrough, así que estas mismas formas valen
 * para las tres fuentes ('mock' | 'binance-direct' | 'vps-relay').
 */

/* ------------------------------------------------------------------ */
/* 1. Wire types                                                       */
/* ------------------------------------------------------------------ */

/** Envoltorio de `/stream?streams=...`. TODOS los mensajes vienen envueltos. */
export interface CombinedMessage<T> {
  stream: string;
  data: T;
}

/**
 * `<symbol>@depth20@100ms` — Partial Book Depth.
 * Snapshot idempotente del top 20 por lado. Reemplaza el estado anterior por
 * completo: no es un delta, no hay bootstrap REST ni gaps de secuencia.
 * No tiene campos `e`, `E` ni `s`.
 */
export interface DepthSnapshot {
  lastUpdateId: number;
  /** [precio, cantidad] — AMBOS son strings JSON, siempre. Bids: mayor→menor. */
  bids: [string, string][];
  /** [precio, cantidad] — AMBOS son strings JSON, siempre. Asks: menor→mayor. */
  asks: [string, string][];
}

/** `<symbol>@aggTrade` — Aggregate Trade. Sin cadencia fija; llega en ráfagas. */
export interface AggTrade {
  e: 'aggTrade';
  /** event time (ms) */
  E: number;
  /** símbolo, MAYÚSCULAS */
  s: string;
  /** aggregate trade id */
  a: number;
  /** precio (STRING) */
  p: string;
  /** cantidad (STRING) */
  q: string;
  /** first trade id */
  f: number;
  /** last trade id */
  l: number;
  /** trade time (ms) */
  T: number;
  /** ¿el comprador es el market maker? Define el agresor. */
  m: boolean;
  /** IGNORAR — Binance lo documenta literalmente como "Ignore". */
  M: boolean;
}

export type StreamPayload = DepthSnapshot | AggTrade;

/** Unión discriminada de todo lo que puede salir del socket. */
export type FeedMessage =
  | CombinedMessage<DepthSnapshot>
  | CombinedMessage<AggTrade>;

/**
 * Discrimina por la forma del payload, no por el nombre del stream: el nombre
 * es un string libre y el relay podría reescribirlo, la forma no.
 */
export function isAggTrade(data: StreamPayload): data is AggTrade {
  return (data as AggTrade).e === 'aggTrade';
}

export function isDepthSnapshot(data: StreamPayload): data is DepthSnapshot {
  return (data as DepthSnapshot).lastUpdateId !== undefined;
}

/* ------------------------------------------------------------------ */
/* 2. Tipos normalizados                                               */
/* ------------------------------------------------------------------ */

export type Side = 'buy' | 'sell';

/**
 * Trade ya parseado. `side` sale de la regla del agresor: `trade.m ? 'sell' : 'buy'`.
 * `whale` se calcula en el cliente contra la mediana móvil, nunca contra un
 * umbral fijo.
 */
export interface ProcessedTrade {
  id: number;
  side: Side;
  price: number;
  size: number;
  whale: boolean;
  /** trade time (ms), tal cual viene en `T`. */
  t: number;
}

/**
 * Libro normalizado. Arrays tipados preasignados de largo `BOOK_LEVELS`:
 * se sobrescriben in-place en cada snapshot, nunca se reasignan.
 */
export interface ProcessedBook {
  lastUpdateId: number;
  mid: number;
  bidPrices: Float64Array;
  bidQtys: Float64Array;
  askPrices: Float64Array;
  askQtys: Float64Array;
  /** Niveles efectivamente llenos en este snapshot (≤ BOOK_LEVELS). */
  bidCount: number;
  askCount: number;
}

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'error';

/**
 * Fuente del feed. Las cuatro emiten `FeedMessage` con las mismas formas de
 * cable, así que el parseo del cliente es idéntico en todos los casos y se
 * cambia de fuente sin tocar una línea de la escena.
 *
 *  - 'mock'           generador sintético local, sin red.
 *  - 'binance-direct' camino en vivo por defecto: browser → Binance, 1 hop.
 *  - 'vps-replay'     reemisión determinista de stream grabado, para perfilar.
 *  - 'vps-relay'      passthrough en vivo. Sólo si Binance bloquea el directo.
 */
export type FeedSource =
  | 'mock'
  | 'binance-direct'
  | 'vps-replay'
  | 'vps-relay';

/* ------------------------------------------------------------------ */
/* 3. Constantes y helpers de stream                                   */
/* ------------------------------------------------------------------ */

export const BOOK_LEVELS = 20;
export const DEPTH_INTERVAL_MS = 100;
export const TRADE_QUEUE_CAP = 256;

export const BINANCE_DATA_HOST = 'wss://data-stream.binance.vision:443';

export function depthStreamName(symbol: string): string {
  return `${symbol.toLowerCase()}@depth${BOOK_LEVELS}@${DEPTH_INTERVAL_MS}ms`;
}

export function aggTradeStreamName(symbol: string): string {
  return `${symbol.toLowerCase()}@aggTrade`;
}

/** URL combinada. `symbol` SIEMPRE en minúsculas en los nombres de stream. */
export function combinedStreamUrl(host: string, symbol: string): string {
  return (
    `${host}/stream?streams=` +
    `${depthStreamName(symbol)}/${aggTradeStreamName(symbol)}`
  );
}

export function createEmptyBook(levels: number = BOOK_LEVELS): ProcessedBook {
  return {
    lastUpdateId: 0,
    mid: 0,
    bidPrices: new Float64Array(levels),
    bidQtys: new Float64Array(levels),
    askPrices: new Float64Array(levels),
    askQtys: new Float64Array(levels),
    bidCount: 0,
    askCount: 0,
  };
}
