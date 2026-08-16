/* Smoke test de las reglas de la pelea. Lógica pura: sin three, sin física. */
import {
  BASE_KNOCKBACK,
  JUMP_COOLDOWN,
  MAX_KNOCKBACK,
  SLOT_ACTIVE,
  SLOT_FREE,
  TEAM_GREEN,
  TEAM_RED,
  WEIGHT_MAX,
  createSkyline,
  groundYAt,
  hasGroundAhead,
  hitDamage,
  isGrounded,
  isKO,
  knockback,
  momentumBoost,
  nearestEnemy,
  platformIndexAt,
  separation,
  shouldBrakeAtLedge,
  teamMomentum,
  TEAMMATE_SPACING,
  weightFor,
  wantsJump,
  GROWTH_COOLDOWN,
  GROWTH_MAX_STAGE,
  SUPER_RADIUS,
  bookShare,
  growthScale,
  shouldGrow,
  superForce,
} from '../src/game/fighters';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; console.log(`  FAIL  ${name} ${detail}`); }
  else console.log(`  ok    ${name} ${detail}`);
}

/**
 * Escenario de prueba: tres plataformas con un pozo entre la segunda y la
 * tercera, que es donde viven todos los casos interesantes.
 *
 *   [-4,-2] alto 1      [-1,1] alto 0      POZO      [3,5] alto 2
 */
const sky = createSkyline(3);
sky.minX[0] = -4; sky.maxX[0] = -2; sky.topY[0] = 1;
sky.minX[1] = -1; sky.maxX[1] = 1;  sky.topY[1] = 0;
sky.minX[2] = 3;  sky.maxX[2] = 5;  sky.topY[2] = 2;

console.log('\n== el escenario visto por la IA ==');
{
  check('encuentra la plataforma bajo los pies', platformIndexAt(sky, -3) === 0);
  check('el borde cuenta como plataforma', platformIndexAt(sky, 1) === 1);
  check('entre plataformas no hay nada', platformIndexAt(sky, 2) === -1);
  check('fuera del escenario tampoco', platformIndexAt(sky, 99) === -1);
  check('la altura del piso es la de su plataforma', groundYAt(sky, 4) === 2, String(groundYAt(sky, 4)));
  check('sobre el pozo el piso es -Infinity', groundYAt(sky, 2) === -Infinity);
}

console.log('\n== estar parado ==');
{
  const FEET = 0.3;
  check('parado sobre la plataforma', isGrounded(sky, 0, 0 + FEET, 0, FEET));
  check('no lo está si va cayendo rápido', !isGrounded(sky, 0, 0 + FEET, -5, FEET));
  check('no lo está si está muy arriba', !isGrounded(sky, 0, 3, 0, FEET));
  check('no lo está sobre el pozo', !isGrounded(sky, 2, 0.3, 0, FEET));
  // Justo después de aterrizar los pies quedan un pelo por debajo del tope.
  check('tolera hundirse un poco al aterrizar', isGrounded(sky, 0, FEET - 0.1, -0.4, FEET));
}

console.log('\n== hay piso adelante ==');
{
  check('caminando hacia el centro sí hay', hasGroundAhead(sky, 0.5, 1, 0.4));
  check('caminando hacia el pozo no hay', !hasGroundAhead(sky, 1, 1, 0.8));
  check('mirando para el otro lado sí hay', hasGroundAhead(sky, 1, -1, 0.8));
}

console.log('\n== elegir a quién pegarle ==');
{
  const capacity = 5;
  const state = new Uint8Array([SLOT_ACTIVE, SLOT_ACTIVE, SLOT_ACTIVE, SLOT_ACTIVE, SLOT_FREE]);
  const teams = new Uint8Array([TEAM_GREEN, TEAM_RED, TEAM_RED, TEAM_GREEN, TEAM_RED]);
  const xs = new Float64Array([0, 8, 3, 1, 0.1]);
  const ys = new Float64Array([0, 0, 0, 0, 0]);

  check('elige al rival más cercano', nearestEnemy(capacity, state, teams, xs, ys, 0) === 2);
  check('ignora a los de su propio equipo', nearestEnemy(capacity, state, teams, xs, ys, 0) !== 3);
  check('ignora los slots libres, aunque estén pegados',
    nearestEnemy(capacity, state, teams, xs, ys, 0) !== 4);

  // El de arriba está más cerca en línea recta pero cuesta más llegar.
  const ys2 = new Float64Array([0, 0.5, 6, 0, 0]);
  const xs2 = new Float64Array([0, 4, 1, 0, 0]);
  check('prefiere al que está al lado antes que al que está por encima',
    nearestEnemy(capacity, state, teams, xs2, ys2, 0) === 1);

  const soloGreen = new Uint8Array([TEAM_GREEN, TEAM_GREEN, TEAM_GREEN, TEAM_GREEN, TEAM_GREEN]);
  check('sin rivales devuelve -1', nearestEnemy(capacity, state, soloGreen, xs, ys, 0) === -1);
}

console.log('\n== cuándo saltar ==');
{
  const base = { grounded: true, dy: 0, dx: 2, groundAhead: true, sinceJump: 10 };
  check('en el aire no salta otra vez', !wantsJump({ ...base, grounded: false }));
  check('salta si el objetivo está arriba', wantsJump({ ...base, dy: 2 }));
  check('no salta por un desnivel mínimo', !wantsJump({ ...base, dy: 0.2 }));
  check('salta el pozo si el objetivo está del otro lado',
    wantsJump({ ...base, groundAhead: false }));
  check('no salta al vacío si el objetivo está encima suyo',
    !wantsJump({ ...base, groundAhead: false, dx: 0.1 }));
  check('el cooldown lo frena', !wantsJump({ ...base, dy: 2, sinceJump: JUMP_COOLDOWN - 0.01 }));
  check('y lo deja pasar cuando vence', wantsJump({ ...base, dy: 2, sinceJump: JUMP_COOLDOWN }));
  check('caminando en llano no salta porque sí', !wantsJump(base));
}

console.log('\n== frenar en el borde ==');
{
  check('con piso adelante no frena', !shouldBrakeAtLedge(true, 5, 1));
  check('frena si el rival está para el otro lado', shouldBrakeAtLedge(false, -5, 1));
  check('se tira al vacío si el rival está del otro lado', !shouldBrakeAtLedge(false, 5, 1));
  check('frena si el rival está encima suyo', shouldBrakeAtLedge(false, 0.1, 1));
}

console.log('\n== knockback estilo Smash ==');
{
  const light = knockback(0, 1, 1);
  const damaged = knockback(200, 1, 1);
  check('sin daño el empujón es el base', Math.abs(light - BASE_KNOCKBACK) < 1e-9, light.toFixed(2));
  check('con daño acumulado sale mucho más lejos', damaged > light * 2,
    `${light.toFixed(2)} → ${damaged.toFixed(2)}`);
  check('es monótono en el daño',
    knockback(50, 1, 1) < knockback(100, 1, 1) && knockback(100, 1, 1) < knockback(150, 1, 1));
  check('un pesado se mueve menos que un liviano', knockback(100, 2.4, 1) < knockback(100, 0.7, 1));
  check('y pega más fuerte', knockback(100, 1, 2.4) > knockback(100, 1, 0.7));
  check('nunca supera el tope', knockback(99_999, 0.1, 5) <= MAX_KNOCKBACK,
    knockback(99_999, 0.1, 5).toFixed(2));
  check('un peso cero no divide por cero', Number.isFinite(knockback(100, 0, 1)));
  check('el daño de un golpe escala con el peso del que pega',
    hitDamage(2) > hitDamage(1) && hitDamage(1) > 0);
}

console.log('\n== peso desde el tamaño del trade ==');
{
  const median = 0.5;
  check('un trade mediano pesa poco más que el mínimo', weightFor(median, median, false) < 1.2,
    weightFor(median, median, false).toFixed(2));
  check('más grande pesa más', weightFor(5, median, false) > weightFor(1, median, false));
  check('una ballena pesa más que el mismo trade sin serlo',
    weightFor(5, median, true) > weightFor(5, median, false));
  check('nunca pasa el tope', weightFor(1e9, median, true) <= WEIGHT_MAX);
  check('sin mediana todavía da algo razonable',
    Number.isFinite(weightFor(0.3, 0, false)) && weightFor(0.3, 0, false) > 0);
}

console.log('\n== ímpetu de equipo ==');
{
  check('sin volumen es empate', teamMomentum(0, 0, TEAM_GREEN) === 0.5);
  check('todo el flujo comprador es ímpetu verde', teamMomentum(100, 0, TEAM_GREEN) === 1);
  check('y cero para el rojo', teamMomentum(100, 0, TEAM_RED) === 0);
  check('los dos ímpetus suman 1',
    Math.abs(teamMomentum(30, 70, TEAM_GREEN) + teamMomentum(30, 70, TEAM_RED) - 1) < 1e-9);
  check('el equipo perdedor igual se mueve', momentumBoost(0) > 0.5, momentumBoost(0).toFixed(2));
  check('el ganador se mueve más', momentumBoost(1) > momentumBoost(0));
}

console.log('\n== KO ==');
{
  const zone = { minX: -14, maxX: 14, minY: -12, maxY: 20 };
  check('en el escenario no hay KO', !isKO(zone, 0, 0));
  check('caerse es KO', isKO(zone, 0, -13));
  check('salir por el costado es KO', isKO(zone, 15, 0));
  check('salir por arriba es KO', isKO(zone, 0, 21));
  check('el borde exacto todavía no es KO', !isKO(zone, 14, -12));
}

console.log('\n== gigantismo ==');
{
  check('sin liquidez el libro está empatado', bookShare(0, 0, TEAM_GREEN) === 0.5);
  check('todo el libro del lado bid es cuota verde', bookShare(100, 0, TEAM_GREEN) === 1);
  check('y cero para el rojo', bookShare(100, 0, TEAM_RED) === 0);
  check('las dos cuotas suman 1',
    Math.abs(bookShare(30, 70, TEAM_GREEN) + bookShare(30, 70, TEAM_RED) - 1) < 1e-9);

  check('con el libro parejo nadie crece', !shouldGrow(0.5, 999));
  check('con ventaja clara sí crece', shouldGrow(0.7, GROWTH_COOLDOWN));
  check('pero no antes de que pase el cooldown', !shouldGrow(0.7, GROWTH_COOLDOWN - 0.01));

  check('la etapa 0 es el tamaño normal', growthScale(0) === 1);
  check('cada paso agranda', growthScale(1) < growthScale(2) && growthScale(2) < growthScale(3));
  check('tres pasos y nada más', growthScale(GROWTH_MAX_STAGE + 5) === growthScale(GROWTH_MAX_STAGE));
  check('una etapa negativa no rompe', growthScale(-1) === 1);

  check('el super pega más fuerte de cerca', superForce(0) > superForce(SUPER_RADIUS));
  check('y en el borde del radio todavía pega', superForce(SUPER_RADIUS) > 0);
}

console.log('\n== separación entre compañeros ==');
{
  // Seis slots: 0-2 verdes, 3-5 rojos. Sólo cuenta el propio equipo.
  const slots = new Uint8Array([SLOT_ACTIVE, SLOT_ACTIVE, SLOT_ACTIVE, SLOT_ACTIVE, SLOT_FREE, SLOT_FREE]);
  const teams = new Uint8Array([TEAM_GREEN, TEAM_GREEN, TEAM_GREEN, TEAM_RED, TEAM_RED, TEAM_RED]);
  const mk = (...values: number[]): Float64Array => Float64Array.from(values);

  const far = separation(6, slots, teams, mk(0, 9, -9, 0.1, 0, 0), mk(0, 0, 0, 0, 0, 0), 0);
  check('con los compañeros lejos no se corre', far === 0, `${far}`);

  const right = separation(6, slots, teams, mk(0, -0.4, -9, 0, 0, 0), mk(0, 0, 0, 0, 0, 0), 0);
  check('con un compañero a la izquierda se corre a la derecha', right > 0, `${right}`);

  const left = separation(6, slots, teams, mk(0, 0.4, -9, 0, 0, 0), mk(0, 0, 0, 0, 0, 0), 0);
  check('y al revés', left < 0, `${left}`);

  // Lo que la versión de ±1 no podía expresar y es todo el punto del cambio.
  const close = separation(6, slots, teams, mk(0, -0.2, -9, 0, 0, 0), mk(0, 0, 0, 0, 0, 0), 0);
  const loose = separation(6, slots, teams, mk(0, -1.4, -9, 0, 0, 0), mk(0, 0, 0, 0, 0, 0), 0);
  check('encimado empuja más que a distancia cómoda', close > loose, `${close} > ${loose}`);
  check('justo en el límite no empuja nada',
    separation(6, slots, teams, mk(0, -TEAMMATE_SPACING, -9, 0, 0, 0), mk(0, 0, 0, 0, 0, 0), 0) === 0);

  // Sin desempate los dos empujarían para el mismo lado y no se separarían.
  const xs = mk(0, 0, -9, 0, 0, 0);
  const ys = mk(0, 0, 0, 0, 0, 0);
  const a = separation(6, slots, teams, xs, ys, 0);
  const b = separation(6, slots, teams, xs, ys, 1);
  check('superpuestos exactos se separan en sentidos opuestos', a * b < 0, `${a} vs ${b}`);

  const rival = separation(6, slots, teams, mk(0, 9, -9, 0.1, 0, 0), mk(0, 0, 0, 0, 0, 0), 0);
  check('un rival encima no cuenta como compañero', rival === 0, `${rival}`);

  const above = separation(6, slots, teams, mk(0, 0.2, -9, 0, 0, 0), mk(0, 99, 0, 0, 0, 0), 0);
  check('un compañero muy por arriba tampoco', above === 0, `${above}`);

  // Dos compañeros encimados del mismo lado suman 1,8 sin acotar.
  const piled = separation(6, slots, teams, mk(0, -0.1, -0.2, 0, 0, 0), mk(0, 0, 0, 0, 0, 0), 0);
  check('varios encimados del mismo lado no pasan de 1', piled === 1, `${piled}`);
}

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
