/* Sonda: ¿el 1v1 realmente pelea? Corre el torneo con el feed simulado. */
import { createMockFeed } from '../src/mock/mockFeed';
import { BinanceFeedClient } from '../src/net/feedCore';
import { CAPACITY, FIGHTERS_PER_TEAM, createMatch, stepMatch } from '../src/game/match';
import { SLOT_ACTIVE, TEAM_GREEN } from '../src/game/fighters';

const cliente = new BinanceFeedClient({ url: '', onStatus: () => {} });
const mock = createMockFeed((m) => cliente.handleFeedMessage(m), { scenario: 'stress', symbol: 'btcusdt', seed: 7 });

const m = createMatch(FIGHTERS_PER_TEAM, true);
const dt = 1 / 60;
let cerca = Infinity;
let golpes = 0;
let ultimoDano = 0;

for (let paso = 0; paso < 60 * 120; paso++) {
  // `step(1)` avanza un intervalo de profundidad, que son 100 ms: uno cada seis
  // cuadros de 1/60.
  if (paso % 6 === 0) mock.step(1);
  stepMatch(m, cliente.trades, cliente.stats, dt);
  let a = -1; let b = -1;
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    if (m.team[i] === TEAM_GREEN) a = i; else b = i;
  }
  if (a >= 0 && b >= 0) cerca = Math.min(cerca, Math.abs(m.x[a] - m.x[b]));
  const total = (a >= 0 ? m.damage[a] : 0) + (b >= 0 ? m.damage[b] : 0);
  if (total > ultimoDano) { golpes++; ultimoDano = total; }
  if (paso % (60 * 20) === 0) {
    console.log(`${(paso / 60).toFixed(0).padStart(3)}s  activos ${a >= 0 ? 1 : 0}v${b >= 0 ? 1 : 0}`
      + `  daño ${m.state.damage[0].toFixed(0)}%/${m.state.damage[1].toFixed(0)}%`
      + `  caídos ${m.caidos[0]}/${m.caidos[1]}  KO ${m.state.kos[0]}/${m.state.kos[1]}`
      + `  dx ${a >= 0 && b >= 0 ? Math.abs(m.x[a] - m.x[b]).toFixed(2) : '—'}`
      + `  ultra ${m.ultra[0].toFixed(2)}/${m.ultra[1].toFixed(2)}`);
  }
}
console.log(`\nlo más cerca que llegaron: ${cerca.toFixed(2)} unidades`);
console.log(`veces que subió el daño: ${golpes}`);
console.log(`ganador: ${m.ganador}`);
