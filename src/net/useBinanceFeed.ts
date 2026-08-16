import { useEffect, useMemo, useState } from 'react';
import type {
  ConnectionStatus,
  FeedSource,
  ProcessedBook,
  FeedMessage,
} from '../types/binance';
import { BINANCE_DATA_HOST, combinedStreamUrl } from '../types/binance';
import type { FeedStats, TradeRingBuffer } from './feedCore';
import { BinanceFeedClient } from './feedCore';
import type { MockFeedHandle, MockFeedOptions } from '../mock/mockFeed';
import { createMockFeed } from '../mock/mockFeed';

/**
 * Hook fino sobre `BinanceFeedClient`. Lo único que vive acá es lo que sólo
 * puede vivir en React: `useState` para el chrome de UI de baja frecuencia
 * (estado de conexión, visibilidad de la pestaña) y `useEffect` para el ciclo
 * de vida. Ni un solo setter de estado en el camino de datos de mercado.
 */

export interface UseBinanceFeedOptions {
  symbol?: string;
  source?: FeedSource;
  /** Origen del VPS, sin barra final. Ej: 'wss://bb.midominio.com'. */
  vpsUrl?: string;
  mock?: Partial<MockFeedOptions>;
}

export interface BinanceFeedApi {
  /** Baja frecuencia: seguro para renderizar en el HUD. */
  status: ConnectionStatus;
  /** Alimenta `<Physics paused={isHidden}>`. Cambia sólo con la pestaña. */
  isHidden: boolean;
  symbol: string;
  source: FeedSource;
  /** Mutables, escritos fuera de React. Se leen desde `useFrame`. */
  book: ProcessedBook;
  trades: TradeRingBuffer;
  stats: FeedStats;
}

export function resolveFeedUrl(
  source: FeedSource,
  symbol: string,
  vpsUrl?: string,
): string {
  switch (source) {
    case 'binance-direct':
      return combinedStreamUrl(BINANCE_DATA_HOST, symbol);
    case 'vps-relay':
      return `${(vpsUrl ?? '').replace(/\/$/, '')}/stream/${symbol.toLowerCase()}`;
    case 'vps-replay':
      return `${(vpsUrl ?? '').replace(/\/$/, '')}/replay/${symbol.toLowerCase()}`;
    case 'mock':
      return '';
  }
}

export function useBinanceFeed(options: UseBinanceFeedOptions = {}): BinanceFeedApi {
  const symbol = options.symbol ?? 'btcusdt';
  const source = options.source ?? 'binance-direct';
  const vpsUrl = options.vpsUrl;

  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [isHidden, setIsHidden] = useState<boolean>(false);

  const client = useMemo(
    () =>
      new BinanceFeedClient({
        url: resolveFeedUrl(source, symbol, vpsUrl),
        onStatus: setStatus,
      }),
    [source, symbol, vpsUrl],
  );

  const mockConfig = options.mock;

  useEffect(() => {
    let mock: MockFeedHandle | null = null;

    if (source === 'mock') {
      const forward = (message: FeedMessage): void => client.handleFeedMessage(message);
      mock = createMockFeed(forward, { ...mockConfig, symbol });
      mock.start();
      setStatus('live');
    } else {
      client.start();
    }

    const onVisibility = (): void => {
      const hidden = document.visibilityState === 'hidden';
      setIsHidden(hidden);
      // La cola acumulada mientras rAF estaba pausado ya no representa nada:
      // reproducirla sería una ráfaga de spawns de trades viejos.
      client.clearTrades();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      mock?.stop();
      client.stop();
      client.clearTrades();
    };
    // `mockConfig` se lee sólo al montar; cambiarlo en caliente no reinicia el feed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, source, symbol]);

  return {
    status,
    isHidden,
    symbol,
    source,
    book: client.book,
    trades: client.trades,
    stats: client.stats,
  };
}
