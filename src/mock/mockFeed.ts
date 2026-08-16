import type {
  AggTrade,
  CombinedMessage,
  DepthSnapshot,
  FeedMessage,
} from '../types/binance';
import {
  BOOK_LEVELS,
  DEPTH_INTERVAL_MS,
  aggTradeStreamName,
  depthStreamName,
} from '../types/binance';

/**
 * Generador local que emite exactamente las mismas formas de cable que Binance,
 * a la misma cadencia. Es intercambiable con el feed real y con el replay del
 * VPS: el consumidor no puede distinguirlos.
 *
 * Todo el azar sale de un PRNG sembrado, así que una semilla dada produce
 * siempre la misma sesión. Eso es lo que permite perfilar un caso extremo
 * (pool agotado, ráfaga sostenida) y repetirlo idéntico.
 */

export type MockScenario = 'calm' | 'normal' | 'volatile' | 'stress';

export interface MockFeedOptions {
  symbol: string;
  seed: number;
  startPrice: number;
  /** Paso mínimo de precio. BTCUSDT usa 0.01. */
  tickSize: number;
  /** Decimales al serializar precio. Debe ser coherente con tickSize. */
  pricePrecision: number;
  /** Decimales al serializar cantidad. */
  qtyPrecision: number;
  levels: number;
  depthIntervalMs: number;
  scenario: MockScenario;
}

export interface MockFeedHandle {
  start(): void;
  stop(): void;
  setScenario(scenario: MockScenario): void;
  /** Avanza `ticks` intervalos de profundidad sin usar timers. Para tests. */
  step(ticks: number): void;
  isRunning(): boolean;
  getMid(): number;
  getScenario(): MockScenario;
}

export type MockMessageHandler = (message: FeedMessage) => void;

interface ScenarioProfile {
  /** Desvío del retorno log por tick de profundidad. */
  sigma: number;
  /** Trades por segundo en régimen base. */
  tradeRate: number;
  /** Probabilidad por tick de abrir una ráfaga de volatilidad. */
  burstChance: number;
  burstRateMult: number;
  burstSigmaMult: number;
  /** Duración de la ráfaga en ticks: [mín, máx]. */
  burstTicks: readonly [number, number];
  /** Probabilidad de que un trade sea ballena. */
  whaleChance: number;
  /** Multiplicador de tamaño de la ballena: [mín, máx]. */
  whaleMult: readonly [number, number];
  /** Cantidad mediana por trade, en unidades base. */
  medianTradeQty: number;
  /** Cantidad mediana por nivel del libro. */
  medianLevelQty: number;
  /** Probabilidad de que un nivel sea un muro de liquidez. */
  wallChance: number;
  wallMult: number;
  /** Spread base, en ticks. */
  spreadTicks: number;
}

const PROFILES: Readonly<Record<MockScenario, ScenarioProfile>> = {
  calm: {
    sigma: 0.00004,
    tradeRate: 3,
    burstChance: 0.002,
    burstRateMult: 4,
    burstSigmaMult: 3,
    burstTicks: [10, 40],
    whaleChance: 0.008,
    whaleMult: [8, 15],
    medianTradeQty: 0.02,
    medianLevelQty: 1.2,
    wallChance: 0.04,
    wallMult: 12,
    spreadTicks: 1,
  },
  normal: {
    sigma: 0.00012,
    tradeRate: 20,
    burstChance: 0.01,
    burstRateMult: 6,
    burstSigmaMult: 4,
    burstTicks: [20, 80],
    whaleChance: 0.01,
    whaleMult: [8, 25],
    medianTradeQty: 0.035,
    medianLevelQty: 2.0,
    wallChance: 0.06,
    wallMult: 15,
    spreadTicks: 1,
  },
  volatile: {
    sigma: 0.0004,
    tradeRate: 50,
    burstChance: 0.004,
    burstRateMult: 5,
    burstSigmaMult: 5,
    burstTicks: [30, 120],
    whaleChance: 0.02,
    whaleMult: [10, 35],
    medianTradeQty: 0.06,
    medianLevelQty: 1.4,
    wallChance: 0.05,
    wallMult: 20,
    spreadTicks: 3,
  },
  /**
   * No pretende ser realista: satura la cola de trades y el pool de personajes
   * para verificar contrapresión, reciclado del más viejo y clamp de impulso.
   */
  stress: {
    sigma: 0.0009,
    tradeRate: 400,
    burstChance: 0.15,
    burstRateMult: 4,
    burstSigmaMult: 3,
    burstTicks: [40, 200],
    whaleChance: 0.06,
    whaleMult: [15, 60],
    medianTradeQty: 0.1,
    medianLevelQty: 1.0,
    wallChance: 0.05,
    wallMult: 25,
    spreadTicks: 6,
  },
};

export const DEFAULT_MOCK_OPTIONS: MockFeedOptions = {
  symbol: 'btcusdt',
  seed: 0x5eed_1234,
  startPrice: 64_000,
  tickSize: 0.01,
  pricePrecision: 2,
  qtyPrecision: 5,
  levels: BOOK_LEVELS,
  depthIntervalMs: DEPTH_INTERVAL_MS,
  scenario: 'normal',
};

/** mulberry32: 32 bits de estado, sin dependencias, reproducible. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b_79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function createMockFeed(
  onMessage: MockMessageHandler,
  overrides: Partial<MockFeedOptions> = {},
): MockFeedHandle {
  const opts: MockFeedOptions = { ...DEFAULT_MOCK_OPTIONS, ...overrides };
  const symbolLower = opts.symbol.toLowerCase();
  const symbolUpper = opts.symbol.toUpperCase();
  const depthStream = depthStreamName(symbolLower);
  const tradeStream = aggTradeStreamName(symbolLower);
  const tickSeconds = opts.depthIntervalMs / 1000;

  const rng = makeRng(opts.seed);

  let scenario: MockScenario = opts.scenario;
  let profile: ScenarioProfile = PROFILES[scenario];

  let mid = opts.startPrice;
  let lastUpdateId = 1;
  let aggId = 1;
  let firstTradeId = 1;
  let burstTicksLeft = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  /** Box-Muller. Se descarta la segunda normal: no vale la pena cachearla acá. */
  function gauss(): number {
    let u = rng();
    if (u < 1e-12) u = 1e-12;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  }

  function uniform(min: number, max: number): number {
    return min + rng() * (max - min);
  }

  /** Poisson por el método de Knuth. `lambda` acá siempre es chico (< 60). */
  function poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    if (lambda > 60) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * gauss()));
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= rng();
    } while (p > limit);
    return k - 1;
  }

  function roundToTick(price: number): number {
    return Math.round(price / opts.tickSize) * opts.tickSize;
  }

  function fmtPrice(price: number): string {
    return price.toFixed(opts.pricePrecision);
  }

  function fmtQty(qty: number): string {
    const min = Math.pow(10, -opts.qtyPrecision);
    return Math.max(qty, min).toFixed(opts.qtyPrecision);
  }

  /** Log-normal centrada en la mediana: cola larga sin valores negativos. */
  function levelQty(): number {
    const q = profile.medianLevelQty * Math.exp(0.7 * gauss());
    return rng() < profile.wallChance ? q * profile.wallMult : q;
  }

  function buildDepth(): DepthSnapshot {
    const half = Math.max(opts.tickSize, profile.spreadTicks * opts.tickSize) / 2;
    const bestBid = roundToTick(mid - half);
    const bestAsk = roundToTick(Math.max(mid + half, bestBid + opts.tickSize));

    const bids: [string, string][] = new Array<[string, string]>(opts.levels);
    const asks: [string, string][] = new Array<[string, string]>(opts.levels);

    // Los huecos entre niveles crecen al alejarse del mid, como en un libro real.
    let bidPrice = bestBid;
    let askPrice = bestAsk;
    for (let i = 0; i < opts.levels; i++) {
      bids[i] = [fmtPrice(bidPrice), fmtQty(levelQty())];
      asks[i] = [fmtPrice(askPrice), fmtQty(levelQty())];
      const gap = opts.tickSize * (1 + Math.floor(i / 4) + Math.floor(rng() * 2));
      bidPrice = roundToTick(bidPrice - gap);
      askPrice = roundToTick(askPrice + gap);
    }

    return { lastUpdateId: lastUpdateId++, bids, asks };
  }

  function buildTrade(now: number, drift: number): AggTrade {
    let qty = profile.medianTradeQty * Math.exp(0.9 * gauss());
    if (rng() < profile.whaleChance) {
      qty *= uniform(profile.whaleMult[0], profile.whaleMult[1]);
    }

    // El agresor se inclina hacia donde se movió el precio en este tick: un
    // `m` independiente del drift produciría un libro que sube sin compradores.
    const buyBias = 0.5 + Math.max(-0.35, Math.min(0.35, drift * 1200));
    const isBuyAggressor = rng() < buyBias;

    const price = roundToTick(
      mid + (isBuyAggressor ? 1 : -1) * opts.tickSize * (1 + Math.floor(rng() * 3)),
    );

    const fills = 1 + Math.floor(rng() * 4);
    const f = firstTradeId;
    firstTradeId += fills;

    return {
      e: 'aggTrade',
      E: now,
      s: symbolUpper,
      a: aggId++,
      p: fmtPrice(price),
      q: fmtQty(qty),
      f,
      l: f + fills - 1,
      T: now,
      // m === true  → el comprador era maker → el agresor fue vendedor.
      m: !isBuyAggressor,
      M: true,
    };
  }

  function emitTick(now: number): void {
    if (burstTicksLeft > 0) {
      burstTicksLeft--;
    } else if (rng() < profile.burstChance) {
      burstTicksLeft = Math.round(
        uniform(profile.burstTicks[0], profile.burstTicks[1]),
      );
    }
    const inBurst = burstTicksLeft > 0;

    const sigma = profile.sigma * (inBurst ? profile.burstSigmaMult : 1);
    const rate = profile.tradeRate * (inBurst ? profile.burstRateMult : 1);

    const drift = sigma * gauss();
    mid = Math.max(opts.tickSize, mid * (1 + drift));

    const count = poisson(rate * tickSeconds);
    for (let i = 0; i < count; i++) {
      const t = now + Math.floor(rng() * opts.depthIntervalMs);
      const message: CombinedMessage<AggTrade> = {
        stream: tradeStream,
        data: buildTrade(t, drift),
      };
      onMessage(message);
    }

    const depth: CombinedMessage<DepthSnapshot> = {
      stream: depthStream,
      data: buildDepth(),
    };
    onMessage(depth);
  }

  return {
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => emitTick(Date.now()), opts.depthIntervalMs);
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    setScenario(next: MockScenario): void {
      scenario = next;
      profile = PROFILES[next];
      burstTicksLeft = 0;
    },
    step(ticks: number): void {
      const base = Date.now();
      for (let i = 0; i < ticks; i++) {
        emitTick(base + i * opts.depthIntervalMs);
      }
    },
    isRunning(): boolean {
      return timer !== null;
    },
    getMid(): number {
      return mid;
    },
    getScenario(): MockScenario {
      return scenario;
    },
  };
}
