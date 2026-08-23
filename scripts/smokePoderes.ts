/*
 * Smoke test de los poderes a distancia.
 *
 * Reactivados con el pivot de 2026-08-23 (ver CLAUDE.md): la barra que carga
 * el mercado ya no tiene otra cosa que gastar, así que especial y super
 * vuelven a ser el camino normal, no un flag apagado. La regla del sistema
 * sigue siendo la misma: la especial no estalla encima del que la tira, sale
 * disparada, viaja, y recién estalla al llegar. Lo que se prueba es eso — que
 * sale, que se mueve, que le pega al rival lejano y no al compañero, y que no
 * se queda ninguna ranura del pool trabada.
 */
import { TradeRingBuffer } from '../src/net/feedCore';
import type { FeedStats } from '../src/net/feedCore';
import {
  CAPACITY, EVENT_ESTALLIDO, EVENT_SKILL, FIGHTERS_PER_TEAM, PODERES,
  createMatch, stepMatch,
} from '../src/game/match';
import { SLOT_ACTIVE, SLOT_RETIRING, TEAM_GREEN, TEAM_RED } from '../src/game/fighters';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; console.log(`  FAIL  ${name} ${detail}`); }
  else console.log(`  ok    ${name} ${detail}`);
}

const stats: FeedStats = {
  mid: 100, spread: 0.01, tradeMedian: 1, bookQtyMedian: 1,
  buyVolume: 1, sellVolume: 1, bidVolume: 1, askVolume: 1,
  snapshots: 0, trades: 0, whales: 0, droppedTrades: 0, reconnects: 0,
};

const enVuelo = (m: ReturnType<typeof createMatch>): number => {
  let n = 0;
  for (let k = 0; k < PODERES; k++) if (m.poderes.vida[k] > 0) n++;
  return n;
};

console.log('\n== el poder sale, viaja y estalla ==');
const m = createMatch(FIGHTERS_PER_TEAM, false);
const trades = new TradeRingBuffer(256);
for (let n = 0; n < CAPACITY; n++) {
  trades.push(n, n % 2 === 0 ? 'buy' : 'sell', 100, 3, false, n);
}
for (let n = 0; n < 12; n++) stepMatch(m, trades, stats, 1 / 60);

let disparos = 0;
let estallidos = 0;
let maxDistancia = 0;
let masEnVuelo = 0;
/** Dónde estaba el que disparó, para medir cuán lejos estalló su poder. */
const desde = new Map<number, { x: number; y: number }>();

for (let paso = 0; paso < 3600; paso++) {
  // Órdenes de los dos lados, para que las barras se carguen y salgan poderes.
  if (paso % 4 === 0) {
    trades.push(paso, paso % 8 === 0 ? 'buy' : 'sell', 100, 2 + (paso % 4), false, paso);
  }
  stepMatch(m, trades, stats, 1 / 60);
  for (let e = 0; e < m.events.count; e++) {
    if (m.events.kind[e] === EVENT_SKILL) {
      disparos++;
      desde.set(m.events.slot[e], { x: m.events.x[e], y: m.events.y[e] });
    }
    if (m.events.kind[e] === EVENT_ESTALLIDO) {
      estallidos++;
      const o = desde.get(m.events.slot[e]);
      if (o) {
        maxDistancia = Math.max(maxDistancia,
          Math.hypot(m.events.x[e] - o.x, m.events.y[e] - o.y));
      }
    }
  }
  masEnVuelo = Math.max(masEnVuelo, enVuelo(m));
  // Los eventos los drena el render; acá se drenan a mano.
  m.events.count = 0;
}

check('salen poderes', disparos > 0, `${disparos} en 60 s`);
check('y estallan contra alguien', estallidos > 0, `${estallidos} impactos`);
// El punto de todo el cambio: que el poder haga camino. Media unidad sería un
// estallido pegado al cuerpo, o sea la especial vieja con otro nombre.
check('el estallido es LEJOS de quien disparó', maxDistancia > 3,
  `el más lejano viajó ${maxDistancia.toFixed(1)} unidades`);
check('el pool no se satura', masEnVuelo < PODERES,
  `nunca hubo más de ${masEnVuelo} de ${PODERES} en vuelo`);

console.log('\n== no le pega a los suyos ==');
{
  const solo = createMatch(FIGHTERS_PER_TEAM, false);
  const cola = new TradeRingBuffer(64);
  for (let n = 0; n < CAPACITY; n++) cola.push(n, 'buy', 100, 3, false, n);
  for (let n = 0; n < 12; n++) stepMatch(solo, cola, stats, 1 / 60);
  // Se saca del escenario a todo el bando rojo: no queda a quién apuntarle.
  // SLOT_RETIRING y no SLOT_FREE: desde el pivot de 2026-08-23 (ver
  // CLAUDE.md) `relevar` rellena cualquier slot libre en el mismo paso, sin
  // esperar nada del mercado -- con SLOT_FREE el bando rojo volvería a
  // entrar antes de que arranque la medición.
  for (let i = FIGHTERS_PER_TEAM; i < CAPACITY; i++) solo.slot[i] = SLOT_RETIRING;
  const dano = Array.from({ length: FIGHTERS_PER_TEAM }, (_, i) => solo.damage[i]);
  for (let paso = 0; paso < 600; paso++) {
    cola.push(paso, 'buy', 100, 4, false, paso);
    stepMatch(solo, cola, stats, 1 / 60);
    solo.events.count = 0;
  }
  const intacto = dano.every((d, i) => solo.damage[i] === d);
  check('sin rivales no se dispara y nadie se lastima solo', intacto,
    `${enVuelo(solo)} en vuelo`);
}

console.log('\n== el reinicio apaga los que quedaron volando ==');
{
  const t = createMatch(FIGHTERS_PER_TEAM, true);
  const cola = new TradeRingBuffer(64);
  for (let n = 0; n < CAPACITY; n++) cola.push(n, n % 2 === 0 ? 'buy' : 'sell', 100, 3, false, n);
  for (let n = 0; n < 120; n++) stepMatch(t, cola, stats, 1 / 60);
  t.poderes.vida[0] = 5;
  // Se tira a los tres verdes: el match termina y arranca la ceremonia.
  for (let k = 0; k < FIGHTERS_PER_TEAM * 2; k++) {
    for (let i = 0; i < FIGHTERS_PER_TEAM; i++) if (t.slot[i] === SLOT_ACTIVE) t.x[i] = -200;
    for (let n = 0; n < 60; n++) stepMatch(t, cola, stats, 1 / 60);
  }
  check('el match lo ganó el rojo', t.ganador === TEAM_RED || t.ganador === -1,
    `${t.ganador}`);
  for (let n = 0; n < 600; n++) stepMatch(t, cola, stats, 1 / 60);
  check('y no quedó ningún poder del match anterior', t.poderes.vida[0] <= 0
    || t.ganador >= 0, `${enVuelo(t)} en vuelo`);
}

void TEAM_GREEN;
console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
