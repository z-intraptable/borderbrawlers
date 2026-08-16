import { useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import type { FeedSource } from './types/binance';
import type { MockScenario } from './mock/mockFeed';
import { useBinanceFeed } from './net/useBinanceFeed';
import { BorderBrawlersScene } from './scene/BorderBrawlersScene';
import { detectLowQuality } from './quality';

/**
 * Módulo 7 — punto de entrada público.
 *
 * Todo el estado de React que hay en el proyecto está acá o en el hook del
 * feed, y todo es de baja frecuencia: fuente, símbolo, calidad, estado de
 * conexión. Nada de esto cambia por tick de mercado.
 */

const BULL = '#00FF66';
const BEAR = '#FF0055';
const GOLD = '#FFD700';
const VOID_DARK = '#0B0F19';
const DIM = '#6b7585';

export interface BorderBrawlersProps {
  symbol?: string;
  source?: FeedSource;
  vpsUrl?: string;
  scenario?: MockScenario;
  /** Forzar calidad. Sin esto se decide con `detectLowQuality()` al montar. */
  lowQuality?: boolean;
  showPerf?: boolean;
  showHud?: boolean;
}

export function BorderBrawlers(props: BorderBrawlersProps): React.JSX.Element {
  const {
    symbol = 'btcusdt',
    source = 'binance-direct',
    vpsUrl,
    scenario = 'normal',
    showPerf = true,
    showHud = true,
  } = props;

  const detected = useMemo(() => props.lowQuality ?? detectLowQuality(), [props.lowQuality]);
  const [lowQuality, setLowQuality] = useState(detected);

  const feed = useBinanceFeed({
    symbol,
    source,
    vpsUrl,
    mock: { scenario },
  });

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: VOID_DARK }}>
      <Canvas
        // Remontar con la calidad como key es deliberado: alternar el tipo de
        // material en caliente fuerza compilar un WebGLProgram nuevo y congela.
        key={lowQuality ? 'low' : 'high'}
        orthographic
        camera={{ position: [0, 3, 30], zoom: 60, near: 0.1, far: 200 }}
        dpr={lowQuality ? 1 : [1, 2]}
        gl={{
          antialias: !lowQuality,
          powerPreference: 'high-performance',
          stencil: false,
          depth: true,
        }}
      >
        <BorderBrawlersScene
          book={feed.book}
          stats={feed.stats}
          trades={feed.trades}
          isHidden={feed.isHidden}
          lowQuality={lowQuality}
          showPerf={showPerf}
        />
      </Canvas>

      {showHud && (
        <Hud
          symbol={symbol}
          source={feed.source}
          status={feed.status}
          mid={feed.stats.mid}
          trades={feed.stats.trades}
          whales={feed.stats.whales}
          lowQuality={lowQuality}
          onToggleQuality={() => setLowQuality((v) => !v)}
        />
      )}
    </div>
  );
}

interface HudProps {
  symbol: string;
  source: string;
  status: string;
  mid: number;
  trades: number;
  whales: number;
  lowQuality: boolean;
  onToggleQuality: () => void;
}

function Hud(p: HudProps): React.JSX.Element {
  const statusColor = p.status === 'live' ? BULL : p.status === 'error' ? BEAR : GOLD;
  return (
    <div
      style={{
        position: 'absolute',
        top: 12,
        left: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '8px 12px',
        borderRadius: 8,
        background: 'rgba(11,15,25,.75)',
        border: '1px solid #263041',
        font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#e6edf3',
        userSelect: 'none',
      }}
    >
      <strong style={{ letterSpacing: 2 }}>
        <span style={{ color: BULL }}>BORDER</span>
        <span style={{ color: BEAR }}>BRAWLERS</span>
      </strong>
      <span style={{ color: DIM }}>{p.symbol.toUpperCase()}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>
        {p.mid > 0 ? p.mid.toFixed(2) : '—'}
      </span>
      <span style={{ color: statusColor }}>● {p.status}</span>
      <span style={{ color: DIM }}>{p.source}</span>
      <span style={{ color: DIM }}>{p.trades} trades</span>
      <span style={{ color: GOLD }}>{p.whales} 🐋</span>
      <button
        onClick={p.onToggleQuality}
        style={{
          background: p.lowQuality ? GOLD : '#131926',
          color: p.lowQuality ? VOID_DARK : DIM,
          border: '1px solid #263041',
          borderRadius: 6,
          padding: '4px 10px',
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        {p.lowQuality ? 'calidad baja' : 'calidad alta'}
      </button>
    </div>
  );
}
