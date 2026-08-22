/*
 * Smoke test de las cadenas de combo del cuerpo a cuerpo.
 *
 * Reemplazaron la alternancia pura de `lastBlow` (`nextBlow`, en match.ts). Lo
 * que se prueba: que el golpe que sale sigue una de las cadenas declaradas en
 * `COMBO_CHAINS` y no cualquier orden, que el último golpe de cada cadena pega
 * con `COMBO_FINISHER_MULT` de más, y que un silencio más largo que
 * `COMBO_WINDOW` corta la cadena en vez de seguirla donde quedó.
 */
import { TradeRingBuffer } from '../src/net/feedCore';
import type { FeedStats } from '../src/net/feedCore';
import {
  CAPACITY, EVENT_MELEE, FIGHTERS_PER_TEAM,
  createMatch, stepMatch,
} from '../src/game/match';
import {
  COMBO_CHAINS, COMBO_FINISHER_MULT, COMBO_WINDOW, SLOT_ACTIVE, TEAM_GREEN, TEAM_RED, hitDamage,
} from '../src/game/fighters';

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

console.log('\n== el golpe que sale sigue una cadena declarada ==');
{
  const m = createMatch(FIGHTERS_PER_TEAM, false);
  const trades = new TradeRingBuffer(256);
  for (let n = 0; n < CAPACITY; n++) trades.push(n, n % 2 === 0 ? 'buy' : 'sell', 100, 3, false, n);
  for (let n = 0; n < 12; n++) stepMatch(m, trades, stats, 1 / 60);

  // Por cada golpe que conecta, se lee el estado de combo del que pegó DESPUÉS
  // del paso —`comboStep` ya avanzó dentro de `nextBlow`, así que el paso que
  // ACABA de salir es el anterior al que quedó guardado— y se compara contra
  // lo que `COMBO_CHAINS` dice que tenía que salir en esa posición exacta. No
  // hace falta reconstruir dónde empieza y termina cada cadena desde afuera:
  // el propio estado ya lo dice.
  let golpes = 0;
  let noCoincide = 0;
  for (let paso = 0; paso < 3600; paso++) {
    // Órdenes constantes de los dos lados: la barra nunca se vacía.
    trades.push(paso, paso % 2 === 0 ? 'buy' : 'sell', 100, 3, false, paso);
    stepMatch(m, trades, stats, 1 / 60);
    for (let e = 0; e < m.events.count; e++) {
      if (m.events.kind[e] !== EVENT_MELEE) continue;
      golpes++;
      const slot = m.events.slot[e];
      const chain = COMBO_CHAINS[m.comboChain[slot]];
      const consumedStep = (m.comboStep[slot] - 1 + chain.length) % chain.length;
      if (chain[consumedStep] !== m.events.magnitude[e]) noCoincide++;
    }
    m.events.count = 0;
  }

  check('hubo suficientes golpes para juzgar', golpes > 60, `${golpes} golpes en 60 s`);
  check('todo golpe coincide con el paso de su cadena declarada', noCoincide === 0,
    `${golpes - noCoincide}/${golpes} coinciden con COMBO_CHAINS`);
}

console.log('\n== el finisher pega más fuerte, el resto no ==');
{
  // 1 contra 1 de verdad —`lanes: 1`, no 3v3 con los otros cuatro apagados a
  // mano— porque `freeSlot` sólo mira hasta `m.lanes` (ver match.ts): apagar
  // slots con `m.slot[i] = 0` los deja libres para que el mismo feed de
  // trades los vuelva a dar de alta al paso siguiente, y esos extra
  // contaminan a quién le sube el daño. Con `lanes: 1` esos slots no existen.
  const m = createMatch(1, false);
  const trades = new TradeRingBuffer(64);
  trades.push(0, 'buy', 100, 3, false, 0);
  trades.push(1, 'sell', 100, 3, false, 1);
  for (let n = 0; n < 12; n++) stepMatch(m, trades, stats, 1 / 60);
  let atacante = -1;
  let victima = -1;
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    if (m.team[i] === TEAM_GREEN) atacante = i;
    if (m.team[i] === TEAM_RED) victima = i;
  }

  // Mucho más pasos que el bloque de arriba de sobra, no porque haga falta
  // tanto: el cuerpo a cuerpo empuja de verdad (`knockback`/`stunFor`, ver
  // `stepMatch`), así que la víctima termina cayendo del escenario y el
  // intercambio se corta solo —correcto: es la única forma que le queda al
  // juego de terminar un match con los poderes apagados. Lo que importa es
  // que entren unos pocos golpes antes de eso, no sostenerlo en el tiempo.
  // Comparar promedios de finisher contra no-finisher, agrupado por tipo de
  // golpe, se cae si la cadena activa es de las dos que NUNCA repiten tipo de
  // golpe entre pasos normales y el finisher ([0,0,1] y [1,1,0]: no hay con
  // qué comparar un puño finisher contra un puño normal si nunca hay uno). En
  // cambio la fórmula de producción (`hitDamage` + `COMBO_FINISHER_MULT`) se
  // puede predecir golpe por golpe sin importar qué cadena esté activa: el
  // peso del atacante no cambia en toda la pelea (no hay gigantismo con los
  // poderes apagados), así que alcanza con comparar cada golpe contra lo que
  // la fórmula dice que tenía que doler.
  const peso = m.weight[atacante];
  let golpes = 0;
  let fueraDeTolerancia = 0;
  for (let paso = 0; paso < 9000; paso++) {
    trades.push(paso, 'buy', 100, 3, false, paso);
    const danoAntes = m.damage[victima];
    stepMatch(m, trades, stats, 1 / 60);
    let golpeo = false;
    for (let e = 0; e < m.events.count; e++) {
      if (m.events.kind[e] === EVENT_MELEE && m.events.slot[e] === atacante) golpeo = true;
    }
    m.events.count = 0;
    if (!golpeo) continue;
    const chain = COMBO_CHAINS[m.comboChain[atacante]];
    // `comboStep` ya avanzó dentro de `nextBlow`: el paso que ACABA de salir
    // es el anterior al que quedó guardado.
    const consumedStep = (m.comboStep[atacante] - 1 + chain.length) % chain.length;
    const esFinisher = consumedStep === chain.length - 1;
    const blow = chain[consumedStep];
    const esperado = hitDamage(peso, blow === 1) * (esFinisher ? COMBO_FINISHER_MULT : 1);
    const dano = m.damage[victima] - danoAntes;
    golpes++;
    // 1% de margen por el paso a Float32 en el daño acumulado.
    if (Math.abs(dano - esperado) > Math.abs(esperado) * 0.01) fueraDeTolerancia++;
  }

  check('hubo golpes suficientes para juzgar', golpes >= 6, `${golpes} golpes`);
  check('cada golpe pega exactamente lo que predice hitDamage × el multiplicador del finisher',
    golpes > 0 && fueraDeTolerancia === 0, `${golpes - fueraDeTolerancia}/${golpes} dentro de tolerancia`);
}

console.log('\n== un silencio más largo que COMBO_WINDOW corta la cadena ==');
{
  // Mismo motivo que el bloque anterior: `lanes: 1` en vez de apagar slots.
  const m = createMatch(1, false);
  const trades = new TradeRingBuffer(64);
  trades.push(0, 'buy', 100, 3, false, 0);
  trades.push(1, 'sell', 100, 3, false, 1);
  for (let n = 0; n < 12; n++) stepMatch(m, trades, stats, 1 / 60);
  let atacante = -1;
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] === SLOT_ACTIVE && m.team[i] === TEAM_GREEN) atacante = i;
  }

  // Deja que pegue un par de veces para que `comboStep` no esté ya en 0.
  for (let paso = 0; paso < 30; paso++) {
    trades.push(paso, 'buy', 100, 3, false, paso);
    stepMatch(m, trades, stats, 1 / 60);
    m.events.count = 0;
  }
  const cadenaAntes = m.comboChain[atacante];
  const pasoAntesDelHueco = m.comboStep[atacante];

  // El hueco: en vez de alejarlo del escenario —a riesgo de que caiga fuera
  // de `BLAST` y lo den por KO, que invalidaría todo el test— se adelanta
  // directo el reloj de su último golpe conectado. Es EXACTAMENTE lo que mide
  // `sinceLast` en `nextBlow`, así que el efecto es el mismo que un silencio
  // real de sobra más largo que `COMBO_WINDOW` (0,75 s de simulación).
  m.lastHit[atacante] = m.clock - COMBO_WINDOW - 1;

  // Y vuelve a pegar: el primer golpe después del hueco tiene que arrancar
  // una cadena nueva —paso 0— y no seguir donde había quedado.
  let volvioAPegar = false;
  for (let paso = 0; paso < 60 && !volvioAPegar; paso++) {
    trades.push(1000 + paso, 'buy', 100, 3, false, 1000 + paso);
    stepMatch(m, trades, stats, 1 / 60);
    for (let e = 0; e < m.events.count; e++) {
      if (m.events.kind[e] === EVENT_MELEE && m.events.slot[e] === atacante) volvioAPegar = true;
    }
    m.events.count = 0;
  }

  check('el atacante volvió a conectar tras el hueco', volvioAPegar);
  check('la cadena arrancó de nuevo (rotó) y no siguió donde había quedado',
    m.comboChain[atacante] === (cadenaAntes + 1) % COMBO_CHAINS.length,
    `antes ${cadenaAntes} (paso ${pasoAntesDelHueco}), después ${m.comboChain[atacante]}`);
}

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
