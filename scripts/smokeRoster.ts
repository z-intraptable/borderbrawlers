/*
 * Smoke test del relevo de plantilla.
 *
 * Lo que se prueba es la regla nueva: el que se cae del escenario NO vuelve —
 * el slot se llena con el que sigue en la plantilla. Es una propiedad fácil de
 * romper sin que se note, porque un personaje repetido o uno que vuelve
 * enseguida se ve como una pelea normal si uno no está mirando ese detalle.
 *
 * Sin red y sin Pixi: se le empujan trades a mano a la simulación.
 */
import { TradeRingBuffer } from '../src/net/feedCore';
import type { FeedStats } from '../src/net/feedCore';
import { CAPACITY, FIGHTERS_PER_TEAM, createMatch, stepMatch } from '../src/game/match';
import { SLOT_ACTIVE, SLOT_FREE, TEAM_GREEN } from '../src/game/fighters';
import { GREEN_ROSTER, RED_ROSTER, ROSTER, characterFor, requiredAnimations } from '../src/game/roster';

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

console.log('\n== la plantilla ==');
{
  check('hay más personajes que slots en cada bando',
    GREEN_ROSTER.length > FIGHTERS_PER_TEAM && RED_ROSTER.length > FIGHTERS_PER_TEAM,
    `${GREEN_ROSTER.length} verdes, ${RED_ROSTER.length} rojos`);

  const armatures = new Set(ROSTER.map((c) => c.armature));
  check('ninguna armadura repetida', armatures.size === ROSTER.length, `${armatures.size}`);

  // El nombre de la armadura es también el nombre de la carpeta del arte, y va
  // a una URL: un espacio o un acento ahí es un 404 en el medio de la pelea.
  const clean = ROSTER.every((c) => /^[A-Za-z0-9]+$/.test(c.armature));
  check('las armaduras son nombres de carpeta válidos', clean);

  const nine = ROSTER.every((c) => new Set(requiredAnimations(c)).size === 9);
  check('cada personaje declara nueve animaciones distintas', nine);
}

console.log('\n== relevo al caerse ==');
{
  const m = createMatch();
  const trades = new TradeRingBuffer(64);

  /** Llena todos los slots libres y devuelve qué personaje quedó en cada uno. */
  const fill = (): void => {
    for (let n = 0; n < CAPACITY; n++) {
      trades.push(n, n % 2 === 0 ? 'buy' : 'sell', 100, 1, false, n);
    }
    for (let n = 0; n < 8; n++) stepMatch(m, trades, stats, 1 / 60);
  };

  fill();
  const active = Array.from(m.slot).filter((s) => s === SLOT_ACTIVE).length;
  check('arranca con los seis en el escenario', active === CAPACITY, `${active}`);

  const first = Array.from(m.character);
  const greenFirst = new Set(first.slice(0, FIGHTERS_PER_TEAM));
  check('los tres verdes son personajes distintos',
    greenFirst.size === FIGHTERS_PER_TEAM, `${[...greenFirst]}`);

  // Se lo tira del escenario a mano: es exactamente lo que hace un super.
  m.x[0] = -200;
  stepMatch(m, trades, stats, 1 / 60);
  check('el que se pasó del borde deja el slot libre', m.slot[0] === SLOT_FREE);

  fill();
  check('el slot se vuelve a llenar', m.slot[0] === SLOT_ACTIVE);
  check('y no con el mismo que se cayó', m.character[0] !== first[0],
    `${characterFor(TEAM_GREEN, first[0]).label} → ${characterFor(TEAM_GREEN, m.character[0]).label}`);

  const green = new Set<number>();
  for (let i = 0; i < FIGHTERS_PER_TEAM; i++) green.add(m.character[i]);
  check('sigue sin haber dos iguales en el escenario',
    green.size === FIGHTERS_PER_TEAM, `${[...green]}`);
}

console.log('\n== la ronda recorre la plantilla entera ==');
{
  const m = createMatch();
  const trades = new TradeRingBuffer(64);
  const seen = new Set<number>();

  // Se tira al del slot 0 una y otra vez: si la ronda avanza, en unas cuantas
  // vueltas tienen que haber pasado todos los verdes por ese slot.
  for (let round = 0; round < GREEN_ROSTER.length * 3; round++) {
    for (let n = 0; n < CAPACITY; n++) trades.push(n, 'buy', 100, 1, false, n);
    for (let n = 0; n < 8; n++) stepMatch(m, trades, stats, 1 / 60);
    if (m.slot[0] === SLOT_ACTIVE) {
      seen.add(m.character[0]);
      m.x[0] = -200;
      stepMatch(m, trades, stats, 1 / 60);
    }
  }
  // Todos menos dos: los otros dos slots verdes nunca se caen en esta prueba,
  // así que esos dos personajes están ocupados de punta a punta y no pueden
  // aparecer en el slot 0. Que sean exactamente dos es la prueba de que no hay
  // repetidos — si los hubiera, el número daría más alto.
  const reachable = GREEN_ROSTER.length - (FIGHTERS_PER_TEAM - 1);
  check('la ronda recorre toda la plantilla disponible',
    seen.size === reachable, `${seen.size} de ${reachable}`);
}

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
