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

/**
 * Empuja órdenes de los dos lados y deja correr un segundo.
 *
 * Un segundo y no un puñado de cuadros: el relevo del torneo tiene una pausa a
 * propósito para que el KO se vea, así que con ocho cuadros el siguiente de la
 * plantilla todavía no salió y el test estaría midiendo la pausa, no el relevo.
 */
const alimentar = (cuadros = 60): void => {
  for (let n = 0; n < CAPACITY; n++) {
    trades.push(n, n % 2 === 0 ? 'buy' : 'sell', 100, 1, false, n);
  }
  for (let n = 0; n < cuadros; n++) stepMatch(m, trades, stats, 1 / 60);
};

check('el carril es uno por bando aunque se pidan tres', m.lanes === 1, `${m.lanes}`);

alimentar();
check('sale uno de cada lado y nada más',
  activos(m, 0) === 1 && activos(m, FIGHTERS_PER_TEAM) === 1,
  `${activos(m, 0)} verde, ${activos(m, FIGHTERS_PER_TEAM)} rojo`);
check('y arranca el primero de la plantilla', m.character[0] === 0, `${m.character[0]}`);

console.log('\n== el relevo no espera al mercado ==');
// El defecto que esto cubre: el alta la disparaba la cola de trades, así que un
// tramo de mercado de un solo lado dejaba al otro bando SIN NADIE en pantalla.
// Con tres carriles se disimulaba; en 1v1 el que falta es la mitad de la pelea.
{
  const solo = createMatch(FIGHTERS_PER_TEAM, true);
  const cola = new TradeRingBuffer(64);
  // Se mide POR BANDO y no "hay pelea": dos KO seguidos con medio segundo de
  // diferencia dejan el escenario vacío la suma de las dos pausas, y eso es
  // correcto. Lo que no puede pasar es que un bando con plantilla se quede
  // afuera más de lo que dura su propia pausa.
  const corrida = [0, 0];
  const peor = [0, 0];
  for (let paso = 0; paso < 3600; paso++) {
    if (paso % 6 === 0) cola.push(paso, 'buy', 100, 1 + (paso % 5), false, paso);
    stepMatch(solo, cola, stats, 1 / 60);
    if (solo.ganador >= 0) { corrida[0] = corrida[1] = 0; continue; }
    for (const team of [TEAM_GREEN, TEAM_RED]) {
      const desde = team === TEAM_GREEN ? 0 : FIGHTERS_PER_TEAM;
      const puede = solo.caidos[team] < FIGHTERS_PER_TEAM;
      corrida[team] = puede && activos(solo, desde) === 0 ? corrida[team] + 1 : 0;
      if (corrida[team] > peor[team]) peor[team] = corrida[team];
    }
  }
  // 0,8 s es la pausa que se le deja al KO; más que eso es gente que falta.
  check('con el mercado todo de un lado igual el otro bando sigue saliendo',
    peor[TEAM_RED] <= 60,
    `sin un solo trade rojo, el hueco más largo fue ${(peor[TEAM_RED] / 60).toFixed(2)} s`);
  check('y el bando que sí recibe órdenes tampoco falta',
    peor[TEAM_GREEN] <= 60, `${(peor[TEAM_GREEN] / 60).toFixed(2)} s`);
}

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
alimentar(8);
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
