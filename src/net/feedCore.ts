import type {
  AggTrade,
  ConnectionStatus,
  DepthSnapshot,
  FeedMessage,
  ProcessedBook,
  ProcessedTrade,
  Side,
  StreamPayload,
} from '../types/binance';
import {
  BOOK_LEVELS,
  TRADE_QUEUE_CAP,
  createEmptyBook,
  isAggTrade,
  isDepthSnapshot,
} from '../types/binance';

/**
 * Núcleo del feed: sin React, sin three, sin dependencias del DOM.
 * El constructor de WebSocket y el reloj se inyectan, así que el backoff,
 * el límite de intentos y la reconexión de 24 h son testeables con relojes
 * falsos en vez de esperar un día.
 */

/* ------------------------------------------------------------------ */
/* Constantes operativas                                               */
/* ------------------------------------------------------------------ */

/** Ventana de la mediana móvil de tamaños de trade. */
export const TRADE_MEDIAN_WINDOW = 200;
/** Ventana de la mediana móvil de cantidades del libro, en snapshots. */
export const BOOK_MEDIAN_WINDOW = 200;
/** Muestras mínimas antes de clasificar ballenas. Evita falsos al arrancar. */
export const MEDIAN_WARMUP = 20;
/** whale = size > mediana * WHALE_MULT. Nunca un umbral fijo. */
export const WHALE_MULT = 8;

/** Decaimiento por trade del flujo agresor. Vida media ~700 trades. */
export const FLOW_DECAY = 0.999;
/** Suavizado de la liquidez del libro, por snapshot. */
export const BOOK_VOLUME_ALPHA = 0.12;

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
/** Binance: 300 intentos de conexión por IP cada 5 minutos. */
export const ATTEMPT_LIMIT = 300;
export const ATTEMPT_WINDOW_MS = 5 * 60_000;
/** Binance corta a las 24 h exactas. Nos adelantamos ~10 minutos. */
export const PROACTIVE_RECONNECT_MS = 23 * 3_600_000 + 50 * 60_000;
export const PROACTIVE_JITTER_MS = 5 * 60_000;
/** Si la reconexión proactiva falla, se reintenta sin tocar el socket vivo. */
export const PROACTIVE_RETRY_MS = 60_000;

/* ------------------------------------------------------------------ */
/* Mediana móvil sin allocations                                       */
/* ------------------------------------------------------------------ */

/**
 * Mantiene una ventana circular y, en paralelo, la misma ventana ordenada.
 * Cada push mueve como mucho `capacity` floats dentro de un Float64Array ya
 * reservado: cero basura para el GC en el camino de datos de mercado.
 */
export class RollingMedian {
  private readonly window: Float64Array;
  private readonly sorted: Float64Array;
  private readonly capacity: number;
  private head = 0;
  private size = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.window = new Float64Array(capacity);
    this.sorted = new Float64Array(capacity);
  }

  push(value: number): void {
    if (this.size === this.capacity) {
      this.removeSorted(this.window[this.head]);
    } else {
      this.size++;
    }
    this.window[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    this.insertSorted(value);
  }

  private insertSorted(value: number): void {
    const n = this.size - 1;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    for (let i = n; i > lo; i--) this.sorted[i] = this.sorted[i - 1];
    this.sorted[lo] = value;
  }

  private removeSorted(value: number): void {
    let lo = 0;
    let hi = this.size - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.size - 1; i++) this.sorted[i] = this.sorted[i + 1];
  }

  get count(): number {
    return this.size;
  }

  get ready(): boolean {
    return this.size >= MEDIAN_WARMUP;
  }

  median(): number {
    if (this.size === 0) return 0;
    const half = this.size >> 1;
    if ((this.size & 1) === 1) return this.sorted[half];
    return (this.sorted[half - 1] + this.sorted[half]) / 2;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Cola de trades                                                      */
/* ------------------------------------------------------------------ */

/**
 * Ring buffer de capacidad fija con política descartar-el-más-viejo.
 * Los `ProcessedTrade` están preasignados y se sobrescriben in-place: un trade
 * entrante no asigna memoria. Los objetos devueltos por `pop()` son slots del
 * pool y sólo son válidos hasta el próximo drenaje.
 */
export class TradeRingBuffer {
  private readonly slots: ProcessedTrade[];
  private readonly capacity: number;
  private head = 0;
  private tail = 0;
  private size = 0;
  private dropped = 0;

  constructor(capacity: number = TRADE_QUEUE_CAP) {
    this.capacity = capacity;
    this.slots = new Array<ProcessedTrade>(capacity);
    for (let i = 0; i < capacity; i++) {
      this.slots[i] = { id: 0, side: 'buy', price: 0, size: 0, whale: false, t: 0 };
    }
  }

  push(id: number, side: Side, price: number, size: number, whale: boolean, t: number): void {
    const slot = this.slots[this.head];
    slot.id = id;
    slot.side = side;
    slot.price = price;
    slot.size = size;
    slot.whale = whale;
    slot.t = t;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    } else {
      this.tail = (this.tail + 1) % this.capacity;
      this.dropped++;
    }
  }

  pop(): ProcessedTrade | null {
    if (this.size === 0) return null;
    const slot = this.slots[this.tail];
    this.tail = (this.tail + 1) % this.capacity;
    this.size--;
    return slot;
  }

  get count(): number {
    return this.size;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  clear(): void {
    this.head = 0;
    this.tail = 0;
    this.size = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Inyección de entorno                                                */
/* ------------------------------------------------------------------ */

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  random(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  random: () => Math.random(),
};

export interface SocketHandlers {
  onOpen(): void;
  onMessage(raw: string): void;
  onClose(): void;
  onError(): void;
}

export interface SocketLike {
  close(): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketLike;

/** Factory por defecto: `WebSocket` nativo del browser. */
export const browserSocketFactory: SocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') handlers.onMessage(event.data);
  };
  ws.onclose = () => handlers.onClose();
  ws.onerror = () => handlers.onError();
  return {
    close: () => {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    },
  };
};

/* ------------------------------------------------------------------ */
/* Parseo                                                              */
/* ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Valida la forma antes de tratarla como `FeedMessage`. Nunca usa `any`. */
export function toFeedMessage(raw: string): FeedMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { stream, data } = parsed;
  if (typeof stream !== 'string' || !isRecord(data)) return null;
  const payload = data as unknown as StreamPayload;
  if (isAggTrade(payload)) return { stream, data: payload };
  if (isDepthSnapshot(payload)) return { stream, data: payload };
  return null;
}

/**
 * Escribe el snapshot en los arrays tipados ya reservados de `book`.
 * `parseFloat` se llama una sola vez por número, acá. Nadie vuelve a tocar
 * los strings después de esta función.
 */
export function parseDepthInto(snapshot: DepthSnapshot, book: ProcessedBook): void {
  const levels = book.bidPrices.length;
  const bidCount = Math.min(snapshot.bids.length, levels);
  const askCount = Math.min(snapshot.asks.length, levels);

  for (let i = 0; i < bidCount; i++) {
    const level = snapshot.bids[i];
    book.bidPrices[i] = parseFloat(level[0]);
    book.bidQtys[i] = parseFloat(level[1]);
  }
  for (let i = 0; i < askCount; i++) {
    const level = snapshot.asks[i];
    book.askPrices[i] = parseFloat(level[0]);
    book.askQtys[i] = parseFloat(level[1]);
  }
  for (let i = bidCount; i < levels; i++) {
    book.bidPrices[i] = 0;
    book.bidQtys[i] = 0;
  }
  for (let i = askCount; i < levels; i++) {
    book.askPrices[i] = 0;
    book.askQtys[i] = 0;
  }

  book.bidCount = bidCount;
  book.askCount = askCount;
  book.lastUpdateId = snapshot.lastUpdateId;
  book.mid = bidCount > 0 && askCount > 0
    ? (book.bidPrices[0] + book.askPrices[0]) / 2
    : book.mid;
}

/* ------------------------------------------------------------------ */
/* Cliente                                                             */
/* ------------------------------------------------------------------ */

export interface FeedStats {
  mid: number;
  spread: number;
  /** Mediana móvil de tamaños de trade. Base del criterio de ballena. */
  tradeMedian: number;
  /** Mediana móvil de cantidades del libro. Ancla de la escala logarítmica. */
  bookQtyMedian: number;
  /**
   * Flujo agresor por lado, con decaimiento exponencial. Es "quién está
   * empujando ahora", no el total histórico: un acumulador sin decaimiento se
   * congela después de unos minutos y deja de decir nada. Con
   * `FLOW_DECAY` la vida media queda en ~700 trades, unos 20 s de mercado
   * normal.
   */
  buyVolume: number;
  sellVolume: number;
  /**
   * Liquidez en el libro por lado, suavizada. `bidVolume` es el músculo del
   * equipo verde y `askVolume` el del rojo: cuando uno crece, ese equipo entra
   * en gigantismo.
   */
  bidVolume: number;
  askVolume: number;
  snapshots: number;
  trades: number;
  whales: number;
  droppedTrades: number;
  reconnects: number;
  lastMessageAt: number;
}

export interface FeedClientOptions {
  url: string;
  levels?: number;
  queueCapacity?: number;
  clock?: Clock;
  socketFactory?: SocketFactory;
  onStatus?: (status: ConnectionStatus) => void;
  /**
   * Recibe cada frame TAL CUAL llegó del socket, antes de parsearlo. Existe
   * para el grabador del VPS: guardar el texto original es lo único que hace
   * que el replay sea idéntico al vivo, y así el grabador hereda el backoff,
   * el límite de 300 intentos y la reconexión de 24 h ya testeados en vez de
   * tener una segunda implementación que se desincroniza.
   *
   * En el browser nadie lo pasa y el camino de datos no cambia.
   */
  onRaw?: (raw: string) => void;
  /**
   * En false el cliente no parsea ni acumula nada: sólo mantiene la conexión y
   * entrega `onRaw`. El grabador no necesita el libro ni las medianas, y en el
   * VPS ese trabajo es puro desperdicio. Default true.
   */
  ingest?: boolean;
}

export class BinanceFeedClient {
  readonly book: ProcessedBook;
  readonly trades: TradeRingBuffer;
  readonly stats: FeedStats;

  private readonly url: string;
  private readonly clock: Clock;
  private readonly createSocket: SocketFactory;
  private readonly onStatus: (status: ConnectionStatus) => void;
  private readonly onRaw: ((raw: string) => void) | null;
  private readonly ingest: boolean;

  private readonly tradeMedian = new RollingMedian(TRADE_MEDIAN_WINDOW);
  private readonly bookMedian = new RollingMedian(BOOK_MEDIAN_WINDOW);
  /** Scratch para la mediana por snapshot. Preasignado, nunca reasignado. */
  private readonly qtyScratch: Float64Array;

  private socket: SocketLike | null = null;
  private pendingSocket: SocketLike | null = null;
  private retryTimer: TimerHandle | null = null;
  private proactiveTimer: TimerHandle | null = null;

  private readonly attemptTimes = new Float64Array(ATTEMPT_LIMIT);
  private attemptHead = 0;
  private attemptCount = 0;

  private backoffAttempt = 0;
  private status: ConnectionStatus = 'connecting';
  private stopped = true;

  constructor(options: FeedClientOptions) {
    const levels = options.levels ?? BOOK_LEVELS;
    this.url = options.url;
    this.clock = options.clock ?? systemClock;
    this.createSocket = options.socketFactory ?? browserSocketFactory;
    this.onStatus = options.onStatus ?? (() => {});
    this.onRaw = options.onRaw ?? null;
    this.ingest = options.ingest ?? true;
    this.book = createEmptyBook(levels);
    this.trades = new TradeRingBuffer(options.queueCapacity ?? TRADE_QUEUE_CAP);
    this.qtyScratch = new Float64Array(levels * 2);
    this.stats = {
      mid: 0, spread: 0, tradeMedian: 0, bookQtyMedian: 0,
      buyVolume: 0, sellVolume: 0, bidVolume: 0, askVolume: 0,
      snapshots: 0, trades: 0, whales: 0, droppedTrades: 0,
      reconnects: 0, lastMessageAt: 0,
    };
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.onStatus(next);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.setStatus('connecting');
    this.openPrimary();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer('retry');
    this.clearTimer('proactive');
    this.socket?.close();
    this.socket = null;
    this.pendingSocket?.close();
    this.pendingSocket = null;
  }

  /** Se llama al ocultarse la pestaña: la cola acumulada ya no representa nada. */
  clearTrades(): void {
    this.trades.clear();
  }

  /* ---------------- ciclo de vida de la conexión ---------------- */

  private clearTimer(which: 'retry' | 'proactive'): void {
    const handle = which === 'retry' ? this.retryTimer : this.proactiveTimer;
    if (handle !== null) this.clock.clearTimeout(handle);
    if (which === 'retry') this.retryTimer = null;
    else this.proactiveTimer = null;
  }

  /**
   * Devuelve 0 si se puede intentar ya, o los ms que faltan para que el intento
   * más viejo salga de la ventana de 5 minutos.
   */
  private throttleDelay(): number {
    if (this.attemptCount < ATTEMPT_LIMIT) return 0;
    const oldest = this.attemptTimes[this.attemptHead];
    const elapsed = this.clock.now() - oldest;
    return elapsed >= ATTEMPT_WINDOW_MS ? 0 : ATTEMPT_WINDOW_MS - elapsed;
  }

  private recordAttempt(): void {
    this.attemptTimes[this.attemptHead] = this.clock.now();
    this.attemptHead = (this.attemptHead + 1) % ATTEMPT_LIMIT;
    if (this.attemptCount < ATTEMPT_LIMIT) this.attemptCount++;
  }

  /** Equal jitter: mitad fija, mitad aleatoria. Evita reconexiones en manada. */
  private backoffDelay(): number {
    const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.backoffAttempt);
    return raw / 2 + this.clock.random() * (raw / 2);
  }

  private openPrimary(): void {
    if (this.stopped) return;
    const throttle = this.throttleDelay();
    if (throttle > 0) {
      this.setStatus('reconnecting');
      this.retryTimer = this.clock.setTimeout(() => this.openPrimary(), throttle);
      return;
    }
    this.recordAttempt();
    this.socket = this.createSocket(this.url, {
      onOpen: () => this.handlePrimaryOpen(),
      onMessage: (raw) => this.handleMessage(raw),
      onClose: () => this.handlePrimaryClose(),
      onError: () => this.handlePrimaryError(),
    });
  }

  private handlePrimaryOpen(): void {
    this.backoffAttempt = 0;
    this.setStatus('live');
    this.scheduleProactiveReconnect();
  }

  private handlePrimaryError(): void {
    if (this.status !== 'live') this.setStatus('error');
  }

  private handlePrimaryClose(): void {
    if (this.stopped) return;
    this.socket = null;
    this.clearTimer('proactive');
    this.setStatus('reconnecting');
    const delay = this.backoffDelay();
    this.backoffAttempt++;
    this.retryTimer = this.clock.setTimeout(() => this.openPrimary(), delay);
  }

  /**
   * Make-before-break: se abre el socket nuevo y recién cuando confirma `open`
   * se cierra el viejo, para no dejar un hueco visible en el escenario.
   */
  private scheduleProactiveReconnect(): void {
    this.clearTimer('proactive');
    const jitter = (this.clock.random() * 2 - 1) * PROACTIVE_JITTER_MS;
    this.proactiveTimer = this.clock.setTimeout(
      () => this.startProactiveReconnect(),
      PROACTIVE_RECONNECT_MS + jitter,
    );
  }

  private startProactiveReconnect(): void {
    if (this.stopped || this.pendingSocket !== null) return;
    if (this.throttleDelay() > 0) {
      this.proactiveTimer = this.clock.setTimeout(
        () => this.startProactiveReconnect(),
        PROACTIVE_RETRY_MS,
      );
      return;
    }
    this.recordAttempt();
    this.pendingSocket = this.createSocket(this.url, {
      onOpen: () => this.promotePending(),
      onMessage: (raw) => this.handleMessage(raw),
      onClose: () => this.abandonPending(),
      onError: () => this.abandonPending(),
    });
  }

  private promotePending(): void {
    const promoted = this.pendingSocket;
    if (promoted === null) return;
    this.pendingSocket = null;
    this.socket?.close();
    this.socket = promoted;
    this.stats.reconnects++;
    this.setStatus('live');
    this.scheduleProactiveReconnect();
  }

  private abandonPending(): void {
    if (this.pendingSocket === null) return;
    this.pendingSocket.close();
    this.pendingSocket = null;
    if (this.stopped) return;
    this.proactiveTimer = this.clock.setTimeout(
      () => this.startProactiveReconnect(),
      PROACTIVE_RETRY_MS,
    );
  }

  /* ---------------- camino de datos ---------------- */

  /** Punto de entrada único. El mock y el replay lo alimentan directo. */
  handleFeedMessage(message: FeedMessage): void {
    const payload: StreamPayload = message.data;
    if (isAggTrade(payload)) this.ingestTrade(payload);
    else if (isDepthSnapshot(payload)) this.ingestDepth(payload);
    this.stats.lastMessageAt = this.clock.now();
  }

  private handleMessage(raw: string): void {
    // El crudo primero y sin condiciones: si el parseo rechaza un frame, el
    // grabador igual lo tiene que haber guardado. Un frame que no entendemos es
    // exactamente el que después vas a querer poder reproducir.
    if (this.onRaw !== null) this.onRaw(raw);
    if (!this.ingest) {
      this.stats.lastMessageAt = this.clock.now();
      return;
    }
    const message = toFeedMessage(raw);
    if (message === null) return;
    this.handleFeedMessage(message);
  }

  private ingestTrade(trade: AggTrade): void {
    const size = parseFloat(trade.q);
    if (!Number.isFinite(size) || size <= 0) return;

    const median = this.tradeMedian.median();
    const whale = this.tradeMedian.ready && size > median * WHALE_MULT;

    // Regla del agresor. `m` = ¿el comprador es el maker? El taker es el agresor.
    const side: Side = trade.m ? 'sell' : 'buy';

    const before = this.trades.droppedCount;
    this.trades.push(trade.a, side, parseFloat(trade.p), size, whale, trade.T);
    if (this.trades.droppedCount !== before) this.stats.droppedTrades = this.trades.droppedCount;

    // Flujo agresor: decae siempre, suma sólo del lado que pegó.
    this.stats.buyVolume *= FLOW_DECAY;
    this.stats.sellVolume *= FLOW_DECAY;
    if (side === 'buy') this.stats.buyVolume += size;
    else this.stats.sellVolume += size;

    this.tradeMedian.push(size);
    this.stats.trades++;
    if (whale) this.stats.whales++;
    this.stats.tradeMedian = this.tradeMedian.median();
  }

  private ingestDepth(snapshot: DepthSnapshot): void {
    parseDepthInto(snapshot, this.book);

    let n = 0;
    let bidVolume = 0;
    let askVolume = 0;
    for (let i = 0; i < this.book.bidCount; i++) {
      bidVolume += this.book.bidQtys[i];
      this.qtyScratch[n++] = this.book.bidQtys[i];
    }
    for (let i = 0; i < this.book.askCount; i++) {
      askVolume += this.book.askQtys[i];
      this.qtyScratch[n++] = this.book.askQtys[i];
    }
    // Suavizado: el libro cambia entero diez veces por segundo y sin esto el
    // gigantismo se dispararía y cancelaría con cada snapshot.
    this.stats.bidVolume += (bidVolume - this.stats.bidVolume) * BOOK_VOLUME_ALPHA;
    this.stats.askVolume += (askVolume - this.stats.askVolume) * BOOK_VOLUME_ALPHA;
    if (n > 0) {
      // Insertion sort in-place sobre el scratch: n = 40, sin allocations.
      for (let i = 1; i < n; i++) {
        const v = this.qtyScratch[i];
        let j = i - 1;
        while (j >= 0 && this.qtyScratch[j] > v) {
          this.qtyScratch[j + 1] = this.qtyScratch[j];
          j--;
        }
        this.qtyScratch[j + 1] = v;
      }
      this.bookMedian.push(this.qtyScratch[n >> 1]);
      this.stats.bookQtyMedian = this.bookMedian.median();
    }

    this.stats.mid = this.book.mid;
    this.stats.spread = this.book.askCount > 0 && this.book.bidCount > 0
      ? this.book.askPrices[0] - this.book.bidPrices[0]
      : 0;
    this.stats.snapshots++;
  }
}
