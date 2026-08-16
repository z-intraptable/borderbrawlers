import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BorderBrawlers } from './BorderBrawlers';
import { FeedProbe } from './dev/FeedProbe';
import type { FeedSource } from './types/binance';
import type { MockScenario } from './mock/mockFeed';

const container = document.getElementById('root');
if (container === null) throw new Error('#root no existe');

/**
 * Parámetros por query string, para poder cambiar de fuente sin recompilar:
 *   ?probe            banco de pruebas del feed, sin escena 3D
 *   ?source=mock      mock | binance-direct | vps-replay | vps-relay
 *   ?scenario=stress  calm | normal | volatile | stress
 *   ?symbol=ethusdt
 *   ?vps=wss://host
 *   ?low              fuerza calidad baja
 */
const params = new URLSearchParams(window.location.search);
const source = (params.get('source') ?? 'binance-direct') as FeedSource;
const scenario = (params.get('scenario') ?? 'normal') as MockScenario;
const symbol = params.get('symbol') ?? 'btcusdt';
const vpsUrl = params.get('vps') ?? undefined;
const lowQuality = params.has('low') ? true : undefined;

createRoot(container).render(
  <StrictMode>
    {params.has('probe') ? (
      <FeedProbe />
    ) : (
      <BorderBrawlers
        symbol={symbol}
        source={source}
        scenario={scenario}
        vpsUrl={vpsUrl}
        lowQuality={lowQuality}
      />
    )}
  </StrictMode>,
);
