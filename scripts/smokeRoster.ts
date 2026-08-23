/*
 * Smoke test de la plantilla fija.
 *
 * Lo que se prueba es que NO hay relevos: pelean siempre los mismos seis y el
 * que se cae del escenario reaparece él mismo en su slot. Es una propiedad
 * fácil de romper sin que se note —un personaje que cambia al reaparecer se ve
 * como una pelea normal si uno no está mirando ese detalle— y romperla además
 * saca en pantalla a un personaje sin arte cortado, que la escena dibuja
 * vectorial y desentona con los demás.
 *
 * Sin red y sin Pixi: se le empujan trades a mano a la simulación.
 */
import { TradeRingBuffer } from '../src/net/feedCore';
import type { FeedStats } from '../src/net/feedCore';
import { CAPACITY, FIGHTERS_PER_TEAM, createMatch, stepMatch } from '../src/game/match';
import { SLOT_ACTIVE, TEAM_GREEN } from '../src/game/fighters';
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
  check('cada bando tiene exactamente los slots que pelea',
    GREEN_ROSTER.length === FIGHTERS_PER_TEAM
    && RED_ROSTER.length === FIGHTERS_PER_TEAM,
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

console.log('\n== reaparición al caerse ==');
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
  // Desde el pivot de 2026-08-23 (ver CLAUDE.md) `relevar` ya no espera un
  // trade para reponerlo: vuelve a entrar en el mismo paso.
  m.x[0] = -200;
  stepMatch(m, trades, stats, 1 / 60);
  check('el que se cae vuelve a entrar en el mismo paso', m.slot[0] === SLOT_ACTIVE);
  check('y con el mismo personaje que se cayó', m.character[0] === first[0],
    `${characterFor(TEAM_GREEN, first[0]).label} → ${characterFor(TEAM_GREEN, m.character[0]).label}`);

  const green = new Set<number>();
  for (let i = 0; i < FIGHTERS_PER_TEAM; i++) green.add(m.character[i]);
  check('sigue sin haber dos iguales en el escenario',
    green.size === FIGHTERS_PER_TEAM, `${[...green]}`);
}

console.log('\n== la plantilla no rota ==');
{
  const m = createMatch();
  const trades = new TradeRingBuffer(64);

  // Se tira al del slot 0 una y otra vez. Con relevos, en unas cuantas vueltas
  // habrían pasado varios personajes por ese slot; sin relevos tiene que volver
  // siempre el mismo, y ésta es la prueba que se pone roja si alguien le
  // devuelve el reparto por ronda a `activate` sin querer.
  const seen = new Set<number>();
  for (let round = 0; round < GREEN_ROSTER.length * 3; round++) {
    for (let n = 0; n < CAPACITY; n++) trades.push(n, 'buy', 100, 1, false, n);
    for (let n = 0; n < 8; n++) stepMatch(m, trades, stats, 1 / 60);
    if (m.slot[0] === SLOT_ACTIVE) {
      seen.add(m.character[0]);
      m.x[0] = -200;
      stepMatch(m, trades, stats, 1 / 60);
    }
  }
  check('por el slot 0 pasa siempre el mismo personaje',
    seen.size === 1, `${seen.size} distinto(s): ${[...seen]}`);

  // Y la plantilla tiene que dar justo para la pelea, sin suplentes: si alguien
  // suma un séptimo personaje, esto avisa que hay que decidir qué hacer con él.
  check('la plantilla es exactamente la pelea',
    GREEN_ROSTER.length === FIGHTERS_PER_TEAM
    && RED_ROSTER.length === FIGHTERS_PER_TEAM,
    `${GREEN_ROSTER.length} verdes, ${RED_ROSTER.length} rojos`);
}

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
