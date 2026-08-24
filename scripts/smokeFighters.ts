/* Smoke test de las reglas de la pelea. Lógica pura: sin three, sin física. */
import {
  COST_SKILL,
  COST_SUPER,
  SUPER_RADIUS,
  addCharge,
  chargeFromTrade,
  skillDamage,
  skillRadius,
  BASE_KNOCKBACK,
  JUMP_COOLDOWN,
  MAX_KNOCKBACK,
  SLOT_ACTIVE,
  SLOT_FREE,
  TEAM_GREEN,
  TEAM_RED,
  createSkyline,
  findLedge,
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
  shouldBrakeToTurn,
  teamMomentum,
  TEAMMATE_SPACING,
  wantsJump,
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

console.log('\n== agarre de borde (Fase 2, Brawlhalla/Smash) ==');
{
  const REACH = 0.45;
  const BAND = 0.25;
  // Plataforma 1: minX -1, maxX 1, topY 0.
  check('cayendo justo al lado del borde derecho, agarra', findLedge(sky, 1.1, 0, -1, REACH, BAND) === 1);
  check('cayendo justo al lado del borde izquierdo, agarra', findLedge(sky, -1.1, 0, -1, REACH, BAND) === 1);
  check('lejos del borde, no agarra nada', findLedge(sky, 0, 0, -1, REACH, BAND) === -1);
  check('subiendo (todavía en el salto) no agarra aunque esté cerca del borde',
    findLedge(sky, 1.1, 0, 1, REACH, BAND) === -1);
  check('muy por debajo del borde, ya pasó de largo, no agarra',
    findLedge(sky, 1.1, -5, -1, REACH, BAND) === -1);
  check('muy por arriba del borde, todavía no cayó lo suficiente, no agarra',
    findLedge(sky, 1.1, 2, -1, REACH, BAND) === -1);
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

console.log('\n== frenar antes de girar, no caminar para atrás ==');
{
  check('mirando para donde va, no frena', !shouldBrakeToTurn(3, 1, 1, 0.3));
  check('quieto y quiere girar, no hace falta frenar más', !shouldBrakeToTurn(0.1, 1, -1, 0.3));
  check('corriendo rápido para un lado y el objetivo cambió de lado: frena',
    shouldBrakeToTurn(3, 1, -1, 0.3));
  check('el signo de vx no importa, sólo si mira para donde va',
    shouldBrakeToTurn(-3, 1, -1, 0.3));
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
    hitDamage(2, false) > hitDamage(1, false) && hitDamage(1, false) > 0);
  check('la patada pega más fuerte que el puño',
    hitDamage(1, true) > hitDamage(1, false));
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

console.log('\n== el super ==');
{
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

console.log('\n== la barra de fuerza ==');
{
  // La carga se normaliza por la MEDIANA, no por un tamaño absoluto: la escena
  // tiene que leerse igual en BTC que en un par chico.
  const medio = chargeFromTrade(100, 100);
  check('un trade mediano carga lo mismo sea cual sea la escala',
    Math.abs(chargeFromTrade(0.004, 0.004) - medio) < 1e-9);
  check('el doble de la mediana carga el doble',
    Math.abs(chargeFromTrade(200, 100) - medio * 2) < 1e-9);
  check('hacen falta unos siete trades medianos para llenar una barra',
    medio > 0.12 && medio < 0.16, `${medio}`);

  // Sin techo, un solo trade monstruoso cargaría para diez descargas y la barra
  // dejaría de decir nada.
  const enorme = chargeFromTrade(100_000, 100);
  check('un trade gigante no carga más que el techo', enorme <= 1.01, `${enorme}`);
  check('una ballena llena casi una barra de un saque',
    enorme > 0.9, `${enorme}`);

  // Los primeros trades llegan sin mediana: suponer que son medianos es lo neutro.
  check('sin mediana todavía carga como si fuera mediano',
    chargeFromTrade(5, 0) === medio);
  check('mediana negativa tampoco rompe', chargeFromTrade(5, -1) === medio);

  check('la barra no pasa de llena', addCharge(0.9, 0.5) === 1);
  check('ni baja de cero', addCharge(0.1, -0.5) === 0);

  // Que el radio crezca con la carga es lo que hace que valga la pena esperar.
  check('la especial llega más lejos cuanto más cargada',
    skillRadius(1) > skillRadius(COST_SKILL), `${skillRadius(1)} > ${skillRadius(COST_SKILL)}`);
  check('y pega más', skillDamage(1) > skillDamage(COST_SKILL));
  check('dos especiales al mínimo hacen menos que una con la barra llena',
    skillDamage(COST_SKILL) * 2 < skillDamage(1) * 1.6,
    `${skillDamage(COST_SKILL) * 2} vs ${skillDamage(1)}`);
  check('una especial con la barra llena no llega al radio del super',
    skillRadius(1) < SUPER_RADIUS, `${skillRadius(1)} < ${SUPER_RADIUS}`);

  check('los precios van de barato a caro', COST_SKILL < COST_SUPER);
}

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
