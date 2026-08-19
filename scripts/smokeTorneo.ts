/*
 * Smoke test del torneo 1v1.
 *
 * Lo que se prueba es la regla del modo: cada bando manda UNO, el que gana se
 * queda, el que cae no vuelve y entra el siguiente de su plantilla, y el bando
 * que se queda sin los tres pierde el match. Después viene la ceremonia —los
 * tres del ganador en el escenario, el perdedor fuera— y el reinicio.
 *
 * Es lógica pura y va sin red ni Pixi: se le empujan trades a mano y se tira a
 * los peleadores del escenario a mano, que es exactamente lo que les hace un
 * super.
 */
import { TradeRingBuffer } from '../src/net/feedCore';
import type { FeedStats } from '../src/net/feedCore';
import { CAPACITY, CEREMONIA, FIGHTERS_PER_TEAM, createMatch, stepMatch } from '../src/game/match';
import { SLOT_ACTIVE, SLOT_FREE, TEAM_GREEN, TEAM_RED } from '../src/game/fighters';

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

const activos = (m: ReturnType<typeof createMatch>, desde: number): number => {
  let n = 0;
  for (let i = desde; i < desde + FIGHTERS_PER_TEAM; i++) if (m.slot[i] === SLOT_ACTIVE) n++;
  return n;
};

console.log('\n== el torneo manda de a uno ==');
const m = createMatch(FIGHTERS_PER_TEAM, true);
const trades = new TradeRingBuffer(64);

/** Empuja órdenes de los dos lados y deja correr unos cuadros. */
const alimentar = (): void => {
  for (let n = 0; n < CAPACITY; n++) {
    trades.push(n, n % 2 === 0 ? 'buy' : 'sell', 100, 1, false, n);
  }
  for (let n = 0; n < 8; n++) stepMatch(m, trades, stats, 1 / 60);
};

check('el carril es uno por bando aunque se pidan tres', m.lanes === 1, `${m.lanes}`);

alimentar();
check('sale uno de cada lado y nada más',
  activos(m, 0) === 1 && activos(m, FIGHTERS_PER_TEAM) === 1,
  `${activos(m, 0)} verde, ${activos(m, FIGHTERS_PER_TEAM)} rojo`);
check('y arranca el primero de la plantilla', m.character[0] === 0, `${m.character[0]}`);

console.log('\n== el que cae no vuelve: entra el siguiente ==');
for (let k = 0; k < FIGHTERS_PER_TEAM; k++) {
  m.x[0] = -200;
  stepMatch(m, trades, stats, 1 / 60);
  check(`cae el verde ${k + 1}`, m.caidos[TEAM_GREEN] === k + 1, `${m.caidos[TEAM_GREEN]}`);
  check(`el slot queda libre`, m.slot[0] === SLOT_FREE);
  if (k < FIGHTERS_PER_TEAM - 1) {
    alimentar();
    check('entra el siguiente de la plantilla',
      m.slot[0] === SLOT_ACTIVE && m.character[0] === k + 1, `personaje ${m.character[0]}`);
  }
}

console.log('\n== el bando sin plantilla pierde el match ==');
check('gana el que quedó con gente', m.ganador === TEAM_RED, `${m.ganador}`);
check('y el marcador lo publica', m.state.ganador === TEAM_RED, `${m.state.ganador}`);
check('al perdedor no le quedan peleadores', m.state.plantel[TEAM_GREEN] === 0,
  `${m.state.plantel[TEAM_GREEN]}`);

console.log('\n== la ceremonia ==');
stepMatch(m, trades, stats, 1 / 60);
check('los TRES del ganador salen al escenario',
  activos(m, FIGHTERS_PER_TEAM) === FIGHTERS_PER_TEAM, `${activos(m, FIGHTERS_PER_TEAM)}`);
check('y son los tres personajes distintos',
  new Set([m.character[3], m.character[4], m.character[5]]).size === FIGHTERS_PER_TEAM);
check('el perdedor no está en pantalla', activos(m, 0) === 0, `${activos(m, 0)}`);
check('quietos y en el piso',
  m.vx[3] === 0 && m.vy[3] === 0 && m.grounded[3] === 1);

// Los trades siguen llegando durante la ceremonia. Sin la guarda de `freeSlot`,
// el bando que ya perdió sacaría un cuarto peleador en mitad del baile.
alimentar();
check('no entra nadie más con el match terminado',
  activos(m, 0) === 0 && m.caidos[TEAM_GREEN] === FIGHTERS_PER_TEAM, `${activos(m, 0)}`);

console.log('\n== y vuelve a empezar ==');
// Hasta que se reinicie y ni un paso más: pasada la ceremonia se vuelve a
// pelear, y si se lo deja correr los peleadores empiezan a caerse otra vez y lo
// que se estaría midiendo es el match siguiente, no el reinicio.
let pasos = 0;
while (m.ganador >= 0 && pasos < 400) {
  stepMatch(m, trades, stats, 1 / 30);
  pasos++;
}
check('el match se reinicia solo', m.ganador === -1, `en ${(pasos / 30).toFixed(1)} s`);
check('y no antes de que se vea la ceremonia', pasos / 30 >= CEREMONIA - 0.5,
  `${(pasos / 30).toFixed(1)} s`);
check('con las dos plantillas enteras',
  m.caidos[TEAM_GREEN] === 0 && m.caidos[TEAM_RED] === 0);
check('y el marcador en cero', m.state.kos[TEAM_GREEN] === 0 && m.state.kos[TEAM_RED] === 0);

console.log('\n== la melé sigue siendo la de antes ==');
{
  const melee = createMatch(FIGHTERS_PER_TEAM, false);
  const t2 = new TradeRingBuffer(64);
  for (let n = 0; n < CAPACITY; n++) t2.push(n, n % 2 === 0 ? 'buy' : 'sell', 100, 1, false, n);
  for (let n = 0; n < 8; n++) stepMatch(melee, t2, stats, 1 / 60);
  check('los seis en el escenario',
    activos(melee, 0) === FIGHTERS_PER_TEAM
    && activos(melee, FIGHTERS_PER_TEAM) === FIGHTERS_PER_TEAM);
  melee.x[0] = -200;
  stepMatch(melee, t2, stats, 1 / 60);
  check('caerse no elimina a nadie del torneo', melee.ganador === -1 && melee.caidos[0] === 0);
}

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
