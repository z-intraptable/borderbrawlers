import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BorderBrawlers } from './BorderBrawlers';
import type { FeedSource } from './types/binance';
import type { MockScenario } from './mock/mockFeed';

const container = document.getElementById('root');
if (container === null) throw new Error('#root no existe');

/**
 * Parámetros por query string, para poder cambiar de fuente sin recompilar:
 *   ?source=mock          mock | binance-direct | vps-replay | vps-relay
 *   ?scenario=stress      calm | normal | volatile | stress
 *   ?symbol=ethusdt
 *   ?vps=wss://host
 *   ?low                  fuerza calidad baja
 *   ?quality=high|low     fuerza la calidad; sin esto decide detectLowQuality()
 *
 * Los valores se validan contra la lista permitida en vez de castearse: un
 * `?source=binancedirect` casteado a ciegas llega hasta `resolveFeedUrl` y sale
 * como `undefined`, que es un WebSocket a la URL literal "undefined".
 */
const SOURCES: readonly FeedSource[] = ['mock', 'binance-direct', 'vps-replay', 'vps-relay'];
const SCENARIOS: readonly MockScenario[] = ['calm', 'normal', 'volatile', 'stress'];

function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  const found = allowed.find((value) => value === raw);
  if (found === undefined && raw !== null) {
    console.warn(`BorderBrawlers: valor "${raw}" ignorado; se usa "${fallback}"`);
  }
  return found ?? fallback;
}

const params = new URLSearchParams(window.location.search);
const source = pick(params.get('source'), SOURCES, 'binance-direct');
const scenario = pick(params.get('scenario'), SCENARIOS, 'normal');
const symbol = params.get('symbol') ?? 'btcusdt';
const vpsUrl = params.get('vps') ?? undefined;

// `?quality=high` es lo único que permite medir la ruta con Bloom en una
// máquina que detectLowQuality() clasifica como lenta (headless, CI, notebook).
const quality = params.get('quality');
const lowQuality =
  params.has('low') || quality === 'low' ? true : quality === 'high' ? false : undefined;

createRoot(container).render(
  <StrictMode>
    <BorderBrawlers
      symbol={symbol}
      source={source}
      scenario={scenario}
      vpsUrl={vpsUrl}
      lowQuality={lowQuality}
    />
  </StrictMode>,
);
