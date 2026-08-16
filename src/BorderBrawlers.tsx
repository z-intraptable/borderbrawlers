import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import type { FeedSource } from './types/binance';
import type { MockScenario } from './mock/mockFeed';
import type { FeedStats } from './net/feedCore';
import { useBinanceFeed } from './net/useBinanceFeed';
import { BorderBrawlersScene } from './scene/BorderBrawlersScene';
import { detectLowQuality } from './quality';
import type { MatchState } from './game/fighters';
import { GROWTH_MAX_STAGE, TEAM_GREEN, TEAM_RED, createMatchState } from './game/fighters';
import { FIGHTERS_PER_TEAM } from './scene/FighterPool';

/**
 * Módulo 7 — punto de entrada público.
 *
 * Todo el estado de React del proyecto está acá o en el hook del feed, y todo
 * es de baja frecuencia: fuente, símbolo, calidad, estado de conexión. Nada de
 * esto cambia por tick de mercado; el marcador se MUESTREA a 4 Hz.
 */

const BULL = '#00FF66';
const BEAR = '#FF0055';
const GOLD = '#FFD700';
const VOID_DARK = '#0B0F19';
const DIM = '#6b7585';

/**
 * Cada cuánto el HUD lee los objetos mutables. Nadie re-renderiza al llegar un
 * trade, así que sin este muestreo el marcador queda congelado en los valores
 * del montaje. 4 Hz alcanza para un texto que se lee con los ojos y no toca el
 * camino de datos de mercado.
 */
const HUD_REFRESH_MS = 250;

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

  const feed = useBinanceFeed({ symbol, source, vpsUrl, mock: { scenario } });
  /** Lo escribe el pool cada frame, lo muestrea el marcador. Nunca se reemplaza. */
  const match = useMemo(createMatchState, []);

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
          match={match}
          isHidden={feed.isHidden}
          lowQuality={lowQuality}
          showPerf={showPerf}
        />
      </Canvas>

      {showHud && (
        <>
          <TopBar
            symbol={symbol}
            source={feed.source}
            status={feed.status}
            stats={feed.stats}
            lowQuality={lowQuality}
            onToggleQuality={() => setLowQuality((v) => !v)}
          />
          <Scoreboard match={match} stats={feed.stats} />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Marcador                                                            */
/* ------------------------------------------------------------------ */

/**
 * El marcador de abajo, que es el elemento más reconocible de Smash. Cae justo
 * porque el porcentaje de daño mapea contra el flujo del mercado sin forzar
 * nada: el equipo que viene recibiendo es el que está perdiendo el flujo.
 */
function Scoreboard({ match, stats }: { match: MatchState; stats: FeedStats }): React.JSX.Element {
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 18,
        display: 'flex',
        justifyContent: 'center',
        gap: 18,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      <TeamPanel match={match} stats={stats} team={TEAM_GREEN} label="COMPRA" color={BULL} />
      <TeamPanel match={match} stats={stats} team={TEAM_RED} label="VENTA" color={BEAR} />
    </div>
  );
}

function TeamPanel(props: {
  match: MatchState;
  stats: FeedStats;
  team: number;
  label: string;
  color: string;
}): React.JSX.Element {
  const { match, team, label, color } = props;
  const damage = useSampled(match, (m) => Math.round(m.damage[team]));
  const alive = useSampled(match, (m) => m.alive[team]);
  const kos = useSampled(match, (m) => m.kos[team]);
  const charge = useSampled(match, (m) => m.charge[team]);

  return (
    <div
      style={{
        minWidth: 220,
        padding: '10px 16px 12px',
        borderRadius: 12,
        background: 'linear-gradient(180deg, rgba(11,15,25,.55), rgba(11,15,25,.88))',
        border: `2px solid ${color}`,
        boxShadow: `0 0 22px ${color}33`,
        font: '12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#e6edf3',
        textAlign: 'center',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ color, letterSpacing: 3 }}>{label}</strong>
        <span style={{ color: DIM }}>{kos} KO</span>
      </div>

      {/* El porcentaje, gordo y con sombra, como en Smash. */}
      <div
        style={{
          font: '700 40px/1 ui-monospace, SFMono-Regular, Menlo, monospace',
          color,
          textShadow: `0 2px 0 #05070d, 0 0 18px ${color}66`,
          fontVariantNumeric: 'tabular-nums',
          margin: '4px 0 6px',
        }}
      >
        {damage}<span style={{ fontSize: 22 }}>%</span>
      </div>

      <div style={{ display: 'flex', justifyContent: 'center', gap: 12, alignItems: 'center' }}>
        {/* Vidas: un punto por peleador en pie. */}
        <span style={{ display: 'flex', gap: 4 }}>
          {Array.from({ length: FIGHTERS_PER_TEAM }, (_, i) => (
            <span
              key={i}
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: i < alive ? color : '#263041',
                boxShadow: i < alive ? `0 0 8px ${color}` : 'none',
              }}
            />
          ))}
        </span>
        {/* Carga del gigantismo: tres pasos y el tercero descarga el super. */}
        <span style={{ display: 'flex', gap: 3 }} title="gigantismo">
          {Array.from({ length: GROWTH_MAX_STAGE }, (_, i) => (
            <span
              key={i}
              style={{
                width: 14,
                height: 5,
                borderRadius: 2,
                background: i < charge ? GOLD : '#263041',
                boxShadow: i < charge ? `0 0 8px ${GOLD}` : 'none',
              }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Barra de mercado                                                    */
/* ------------------------------------------------------------------ */

interface TopBarProps {
  symbol: string;
  source: string;
  status: string;
  stats: FeedStats;
  lowQuality: boolean;
  onToggleQuality: () => void;
}

function TopBar(p: TopBarProps): React.JSX.Element {
  const statusColor = p.status === 'live' ? BULL : p.status === 'error' ? BEAR : GOLD;
  const mid = useSampled(p.stats, (s) => s.mid);
  const trades = useSampled(p.stats, (s) => s.trades);
  const whales = useSampled(p.stats, (s) => s.whales);

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
        {mid > 0 ? mid.toFixed(2) : '—'}
      </span>
      <span style={{ color: statusColor }}>● {p.status}</span>
      <span style={{ color: DIM }}>{p.source}</span>
      <span style={{ color: DIM }}>{trades} trades</span>
      <span style={{ color: GOLD }}>{whales} 🐋</span>
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

/**
 * Muestrea un número de un objeto mutable a `HUD_REFRESH_MS` y sólo dispara un
 * re-render cuando ese número efectivamente cambió. Es lo contrario de
 * suscribirse: el productor no sabe que existe React.
 */
function useSampled<T>(source: T, read: (s: T) => number): number {
  const [value, setValue] = useState(() => read(source));
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    const id = setInterval(() => {
      const next = readRef.current(source);
      setValue((prev) => (prev === next ? prev : next));
    }, HUD_REFRESH_MS);
    return () => clearInterval(id);
  }, [source]);

  return value;
}
