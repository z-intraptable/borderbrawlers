import { useEffect, useRef, useState } from 'react';
import { useBinanceFeed } from '../net/useBinanceFeed';
import type { FeedSource } from '../types/binance';
import type { MockScenario } from '../mock/mockFeed';

/**
 * Banco de pruebas de los módulos 1, 2 y 8, sin three ni Rapier.
 * Drena la cola con rAF igual que hará `useFrame`, así que sirve para ver que
 * el camino de datos funciona antes de que exista la escena.
 * No forma parte del entregable final.
 */

const SOURCES: FeedSource[] = ['mock', 'binance-direct', 'vps-replay', 'vps-relay'];
const SCENARIOS: MockScenario[] = ['calm', 'normal', 'volatile', 'stress'];

const COLORS = {
  buy: '#00FF66',
  sell: '#FF0055',
  gold: '#FFD700',
  dim: '#5b6472',
} as const;

interface Drained {
  buys: number;
  sells: number;
  whales: number;
  lastPrice: number;
  lastSide: 'buy' | 'sell';
}

export function FeedProbe(): React.JSX.Element {
  const [source, setSource] = useState<FeedSource>('mock');
  const [scenario, setScenario] = useState<MockScenario>('normal');
  const [vpsUrl, setVpsUrl] = useState<string>('ws://localhost:8080');

  const feed = useBinanceFeed({
    symbol: 'btcusdt',
    source,
    vpsUrl,
    mock: { scenario },
  });

  // El drenaje vive en rAF y escribe en un ref: ni un setState por tick.
  const drained = useRef<Drained>({ buys: 0, sells: 0, whales: 0, lastPrice: 0, lastSide: 'buy' });
  const [, forceTick] = useState(0);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (now: number): void => {
      raf = requestAnimationFrame(loop);
      const d = drained.current;
      for (;;) {
        const t = feed.trades.pop();
        if (t === null) break;
        if (t.side === 'buy') d.buys++; else d.sells++;
        if (t.whale) d.whales++;
        d.lastPrice = t.price;
        d.lastSide = t.side;
      }
      // El HUD se refresca a 5 Hz, no por tick de mercado.
      if (now - last > 200) { last = now; forceTick(v => v + 1); }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [feed.trades]);

  const d = drained.current;
  const s = feed.stats;
  const book = feed.book;

  return (
    <div style={{ padding: 20, display: 'grid', gap: 16, maxWidth: 720 }}>
      <h1 style={{ margin: 0, fontSize: 20, letterSpacing: 2 }}>
        <span style={{ color: COLORS.buy }}>BORDER</span>
        <span style={{ color: COLORS.sell }}>BRAWLERS</span>
        <span style={{ color: COLORS.dim, fontSize: 12, marginLeft: 12 }}>feed probe</span>
      </h1>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {SOURCES.map(x => (
          <button key={x} onClick={() => setSource(x)}
            style={btn(x === source)}>{x}</button>
        ))}
        {source === 'mock' && SCENARIOS.map(x => (
          <button key={x} onClick={() => setScenario(x)}
            style={btn(x === scenario, COLORS.gold)}>{x}</button>
        ))}
        {source.startsWith('vps') && (
          <input value={vpsUrl} onChange={e => setVpsUrl(e.target.value)}
            style={{ background: '#131926', color: '#e6edf3', border: '1px solid #263041',
                     borderRadius: 6, padding: '6px 10px', fontFamily: 'inherit', minWidth: 240 }} />
        )}
      </div>

      <Row label="estado" value={feed.status} color={feed.status === 'live' ? COLORS.buy : COLORS.gold} />
      <Row label="pestaña oculta" value={String(feed.isHidden)} />
      <Row label="mid" value={s.mid.toFixed(2)} />
      <Row label="spread" value={s.spread.toFixed(2)} />
      <Row label="snapshots" value={String(s.snapshots)} />
      <Row label="trades" value={String(s.trades)} />
      <Row label="mediana tamaño" value={s.tradeMedian.toFixed(5)} />
      <Row label="mediana cantidad libro" value={s.bookQtyMedian.toFixed(5)} />
      <Row label="ballenas" value={String(s.whales)} color={COLORS.gold} />
      <Row label="descartados por cola llena" value={String(s.droppedTrades)}
        color={s.droppedTrades > 0 ? COLORS.sell : undefined} />
      <Row label="en cola ahora" value={`${feed.trades.count} / 256`} />
      <Row label="drenados buy / sell" value={`${d.buys} / ${d.sells}`} />
      <Row label="último" value={`${d.lastPrice.toFixed(2)} ${d.lastSide}`}
        color={d.lastSide === 'buy' ? COLORS.buy : COLORS.sell} />

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Side title="BIDS" color={COLORS.buy}
          prices={book.bidPrices} qtys={book.bidQtys} count={book.bidCount} />
        <Side title="ASKS" color={COLORS.sell}
          prices={book.askPrices} qtys={book.askQtys} count={book.askCount} />
      </div>
    </div>
  );
}

function btn(active: boolean, accent = '#00FF66'): React.CSSProperties {
  return {
    background: active ? accent : '#131926',
    color: active ? '#0B0F19' : '#8b95a5',
    border: '1px solid #263041',
    borderRadius: 6,
    padding: '6px 12px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 12,
  };
}

function Row(props: { label: string; value: string; color?: string }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13,
                  borderBottom: '1px solid #1b2230', paddingBottom: 4 }}>
      <span style={{ color: COLORS.dim }}>{props.label}</span>
      <span style={{ color: props.color ?? '#e6edf3' }}>{props.value}</span>
    </div>
  );
}

function Side(props: {
  title: string; color: string;
  prices: Float64Array; qtys: Float64Array; count: number;
}): React.JSX.Element {
  const rows = [];
  for (let i = 0; i < Math.min(props.count, 8); i++) {
    rows.push(
      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <span style={{ color: props.color }}>{props.prices[i].toFixed(2)}</span>
        <span style={{ color: COLORS.dim }}>{props.qtys[i].toFixed(4)}</span>
      </div>,
    );
  }
  return (
    <div>
      <div style={{ color: props.color, fontSize: 11, letterSpacing: 2, marginBottom: 6 }}>
        {props.title}
      </div>
      {rows}
    </div>
  );
}
