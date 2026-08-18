/**
 * Reglas de la pelea. Sin three, sin rapier, sin React, sin DOM.
 *
 * Todo lo que decide *qué* hace un personaje vive acá y se testea con asserts;
 * `FighterPool` sólo traduce esas decisiones a llamadas de física. La razón es
 * práctica: el comportamiento de un peleador es la parte que más se va a
 * retocar a ojo, y retocar a ojo sin una red de seguridad es cómo se rompe el
 * caso raro —el que está al borde de la plataforma, el que tiene 300% de daño—
 * sin que nadie se entere hasta verlo en video.
 */

export const TEAM_GREEN = 0;
export const TEAM_RED = 1;

/** Verde = compradores agresores, rojo = vendedores. Regla del agresor. */
export type Team = typeof TEAM_GREEN | typeof TEAM_RED;

export const SLOT_FREE = 0;
export const SLOT_ACTIVE = 1;
export const SLOT_RETIRING = 2;

/* ------------------------------------------------------------------ */
/* Skyline                                                             */
/* ------------------------------------------------------------------ */

/**
 * El escenario visto por la IA: una lista de plataformas con su rango de x y la
 * altura de su tapa.
 *
 * Los personajes preguntan "¿hay piso acá?" varias veces por frame. Hacerlo con
 * un raycast contra el mundo de física costaría una consulta por pregunta y
 * ademas asignaría; acá es un índice y una comparación, porque las alturas ya
 * están calculadas para dibujar. Es el mismo truco que `stageFocus`: un objeto
 * mutable creado una vez, escrito por el escenario y leído por el pool.
 *
 * Los rangos de x son FIJOS. Sólo se mueve `topY`. Una plataforma que además se
 * corriera de costado haría imposible calcular un salto, y se vería como un
 * temblor en vez de como un escenario.
 */
export interface Skyline {
  count: number;
  minX: Float64Array;
  maxX: Float64Array;
  topY: Float64Array;
}

export function createSkyline(count: number): Skyline {
  return {
    count,
    minX: new Float64Array(count),
    maxX: new Float64Array(count),
    topY: new Float64Array(count),
  };
}

/** Índice de la plataforma que cubre `x`, o -1 si ahí no hay nada. */
export function platformIndexAt(sky: Skyline, x: number): number {
  for (let i = 0; i < sky.count; i++) {
    if (x >= sky.minX[i] && x <= sky.maxX[i]) return i;
  }
  return -1;
}

/** Altura del piso bajo `x`. `-Infinity` es el vacío: ahí se cae. */
export function groundYAt(sky: Skyline, x: number): number {
  const i = platformIndexAt(sky, x);
  return i < 0 ? -Infinity : sky.topY[i];
}

/**
 * ¿Está parado? Tolerancia arriba porque el personaje descansa sobre su radio,
 * y velocidad vertical chica para no confundir "tocando el piso" con "pasando
 * a toda velocidad por la altura del piso".
 */
export function isGrounded(
  sky: Skyline,
  x: number,
  y: number,
  vy: number,
  feetOffset: number,
  tolerance = 0.18,
): boolean {
  const ground = groundYAt(sky, x);
  if (ground === -Infinity) return false;
  const feet = y - feetOffset;
  return feet <= ground + tolerance && feet >= ground - tolerance * 3 && Math.abs(vy) < 1.6;
}

/**
 * ¿Hay piso adelante? Sirve para dos cosas opuestas: saltar el pozo cuando el
 * objetivo está del otro lado, y frenar antes de caerse solo cuando no lo está.
 */
export function hasGroundAhead(
  sky: Skyline,
  x: number,
  dir: number,
  lookahead: number,
): boolean {
  return groundYAt(sky, x + dir * lookahead) !== -Infinity;
}

/* ------------------------------------------------------------------ */
/* Decisiones                                                          */
/* ------------------------------------------------------------------ */

/**
 * Enemigo más cercano, o -1 si el equipo rival no tiene a nadie.
 *
 * La distancia vertical se PENALIZA, no se descuenta: subir tres plataformas
 * cuesta varios saltos, así que un rival que está a 6 unidades de altura es peor
 * objetivo que uno a 4 caminando, aunque en línea recta esté más cerca. Con el
 * factor al revés los peleadores se obsesionan con el de arriba y se pasan la
 * pelea saltando contra una pared.
 */
const VERTICAL_COST = 1.8;

export function nearestEnemy(
  capacity: number,
  slotState: Uint8Array,
  teams: Uint8Array,
  xs: Float64Array,
  ys: Float64Array,
  self: number,
): number {
  const myTeam = teams[self];
  const x = xs[self];
  const y = ys[self];
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < capacity; i++) {
    if (i === self || slotState[i] !== SLOT_ACTIVE || teams[i] === myTeam) continue;
    const dx = xs[i] - x;
    const dy = (ys[i] - y) * VERTICAL_COST;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Como `nearestEnemy`, pero penalizando a los rivales que ya tienen encima a un
 * compañero.
 *
 * Sin esto los tres del equipo eligen siempre al mismo —el más cercano al
 * centro— y la pelea entera se apelmaza en un punto mientras las plataformas
 * laterales quedan vacías. Con la penalización se reparten solos, sin necesidad
 * de un asignador global ni de roles.
 */
export function pickTarget(
  capacity: number,
  slotState: Uint8Array,
  teams: Uint8Array,
  xs: Float64Array,
  ys: Float64Array,
  claims: Uint8Array,
  self: number,
): number {
  const myTeam = teams[self];
  const x = xs[self];
  const y = ys[self];
  let best = -1;
  let bestScore = Infinity;
  for (let i = 0; i < capacity; i++) {
    if (i === self || slotState[i] !== SLOT_ACTIVE || teams[i] === myTeam) continue;
    const dx = xs[i] - x;
    const dy = (ys[i] - y) * VERTICAL_COST;
    const score = (dx * dx + dy * dy) * (1 + claims[i] * CLAIM_PENALTY);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Cuánto encarece cada compañero que ya eligió a ese rival. */
const CLAIM_PENALTY = 2.5;

/**
 * Separación entre compañeros: cuánto conviene correrse al costado, de -1 a 1.
 *
 * Es steering, no física: empujar con impulsos a los del propio equipo se ve
 * como un choque y arruina el knockback del rival. Acá sólo se le suma una
 * intención de correrse al costado.
 *
 * **Es continua, no ±1.** La versión anterior devolvía tres valores, y sumada a
 * una persecución que vale ±1 nunca podía ganarle: lo más que hacía era reducir
 * a la mitad la velocidad de acercamiento. El resultado era que los seis
 * peleadores terminaban apilados en el mismo punto de la plataforma central. Con
 * la urgencia proporcional a lo encimados que están, el que tiene a alguien
 * pegado se corre de verdad y el que está a distancia cómoda no se mueve.
 */
export const TEAMMATE_SPACING = 1.6;

export function separation(
  capacity: number,
  slotState: Uint8Array,
  teams: Uint8Array,
  xs: Float64Array,
  ys: Float64Array,
  self: number,
): number {
  const myTeam = teams[self];
  let push = 0;
  for (let i = 0; i < capacity; i++) {
    if (i === self || slotState[i] !== SLOT_ACTIVE || teams[i] !== myTeam) continue;
    const dx = xs[self] - xs[i];
    const gap = Math.abs(dx);
    if (gap > TEAMMATE_SPACING) continue;
    if (Math.abs(ys[self] - ys[i]) > TEAMMATE_SPACING * 2) continue;
    // Superpuestos exactos: el signo de dx no dice nada y los dos empujarían
    // para el mismo lado, así que no se separarían nunca. El índice de slot
    // desempata, que es arbitrario pero consistente.
    const dir = gap < 1e-6 ? (self > i ? 1 : -1) : (dx >= 0 ? 1 : -1);
    push += dir * (1 - gap / TEAMMATE_SPACING);
  }
  return push > 1 ? 1 : push < -1 ? -1 : push;
}

export interface JumpContext {
  grounded: boolean;
  /** Altura del objetivo menos la propia. Positivo = está arriba. */
  dy: number;
  /** Distancia horizontal con signo hacia el objetivo. */
  dx: number;
  /** ¿Hay piso en la dirección en la que camina? */
  groundAhead: boolean;
  /** Segundos desde el último salto. Evita el martilleo. */
  sinceJump: number;
}

export const JUMP_COOLDOWN = 0.45;
/** A partir de acá el objetivo cuenta como "arriba" y hay que subir. */
export const JUMP_HEIGHT_THRESHOLD = 0.6;

/**
 * Tres motivos para saltar, en orden de frecuencia real: el objetivo está más
 * arriba, hay un pozo en el camino, o está lo bastante cerca como para caerle
 * encima. El cooldown es lo que separa "peleador" de "resorte".
 */
export function wantsJump(ctx: JumpContext): boolean {
  if (!ctx.grounded) return false;
  if (ctx.sinceJump < JUMP_COOLDOWN) return false;
  if (ctx.dy > JUMP_HEIGHT_THRESHOLD) return true;
  if (!ctx.groundAhead && Math.abs(ctx.dx) > 0.4) return true;
  return false;
}

/**
 * ¿Frena para no caerse? Sólo si el objetivo NO está del otro lado del pozo:
 * si está, se salta. Un peleador que nunca se tira al vacío nunca persigue a
 * nadie hasta el borde, y toda la pelea se queda en el centro.
 */
export function shouldBrakeAtLedge(groundAhead: boolean, dx: number, dir: number): boolean {
  if (groundAhead) return false;
  return Math.sign(dx) !== dir || Math.abs(dx) < 0.4;
}

/* ------------------------------------------------------------------ */
/* Golpes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Ojo con las unidades: esto ahora es VELOCIDAD en unidades por segundo, no un
 * impulso sobre una masa como cuando lo resolvía Rapier. Con los números viejos
 * un golpe al 200% daba 14 u/s por 1,4 de multiplicador horizontal, o sea 19
 * u/s sobre un escenario de 18 de ancho: cada roce cruzaba la pantalla entera y
 * los peleadores se pasaban la pelea en el aire.
 */
export const BASE_KNOCKBACK = 2.4;
export const DAMAGE_SCALE = 0.022;
export const MAX_KNOCKBACK = 9.5;
/** Daño que suma un empujón, escalado por el peso del que pega. */
export const HIT_DAMAGE = 6;
export const HIT_COOLDOWN = 0.35;

/**
 * La regla que hace que una pelea escale: el empujón crece con el daño que ya
 * acumuló el que lo recibe, y baja con su peso. Al principio nadie se mueve de
 * la plataforma y a los 200% cualquier roce es un KO. Sin esto la pelea es
 * plana: o todos salen volando al primer toque, o no sale nadie nunca.
 */
export function knockback(damage: number, weight: number, attackerWeight: number): number {
  const raw = (BASE_KNOCKBACK + damage * DAMAGE_SCALE * BASE_KNOCKBACK) * attackerWeight;
  return Math.min(MAX_KNOCKBACK, raw / Math.max(0.35, weight));
}

/** Daño de un empujón. Un peso pesado lastima más. */
export function hitDamage(attackerWeight: number): number {
  return HIT_DAMAGE * attackerWeight;
}

/* ------------------------------------------------------------------ */
/* Peso y equipo                                                       */
/* ------------------------------------------------------------------ */

export const WEIGHT_MIN = 0.7;
export const WEIGHT_MAX = 2.4;

/**
 * El tamaño del trade define el peso, contra la mediana móvil y nunca contra un
 * umbral fijo — el mismo criterio que las ballenas. Logarítmico porque los
 * tamaños tienen cola larga: sin el log, un solo trade grande produce un
 * personaje absurdo y todos los demás quedan iguales entre sí.
 */
export function weightFor(size: number, median: number, whale: boolean): number {
  const reference = median > 0 ? median : size;
  const magnitude = Math.log1p(size / Math.max(reference, 1e-12));
  const base = WEIGHT_MIN + magnitude * 0.55;
  return Math.min(WEIGHT_MAX, whale ? base * 1.8 : base);
}

/**
 * Ímpetu del equipo: cuánto del volumen agresor reciente le pertenece. 0,5 es
 * empate. Se usa para acelerar al equipo que está ganando el flujo, que es la
 * forma de que la pelea cuente lo que pasa en el mercado en vez de ser ruido.
 */
export function teamMomentum(buyVolume: number, sellVolume: number, team: number): number {
  const total = buyVolume + sellVolume;
  if (total <= 0) return 0.5;
  const buyShare = buyVolume / total;
  return team === TEAM_GREEN ? buyShare : 1 - buyShare;
}

/** De ímpetu a multiplicador de empuje. Acotado: nunca deja a un equipo quieto. */
export function momentumBoost(momentum: number): number {
  return 0.75 + momentum * 0.7;
}

/* ------------------------------------------------------------------ */
/* Blast zones                                                         */
/* ------------------------------------------------------------------ */

export interface BlastZone {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function isKO(zone: BlastZone, x: number, y: number): boolean {
  return x < zone.minX || x > zone.maxX || y < zone.minY || y > zone.maxY;
}

/* ------------------------------------------------------------------ */
/* Gigantismo                                                          */
/* ------------------------------------------------------------------ */

/**
 * Cuando la liquidez de un lado del libro crece, ese equipo se envalentona: de
 * a UNO por vez, un peleador crece en tres pasos y al llegar arriba descarga un
 * super que despide a todo lo que tenga cerca, y vuelve a su tamaño.
 *
 * De a uno y no todos juntos es lo que lo hace legible: con los tres creciendo a
 * la vez no se entiende qué pasó, con uno solo se ve venir el golpe.
 */
export const GROWTH_MAX_STAGE = 3;
/** Cuota del libro a partir de la cual un equipo empieza a crecer. */
export const GROWTH_THRESHOLD = 0.56;
/** Segundos entre pasos. Es el tiempo que tarda en verse venir. */
export const GROWTH_COOLDOWN = 1.6;

/**
 * Escalas de la especificación del usuario: 1,15 / 1,30 / 1,50.
 *
 * Las que había —hasta 2,6×— estaban pensadas para cápsulas sin cara, donde el
 * único recurso para que se notara era el tamaño bruto. Con un personaje
 * dibujado, 2,6× es un monstruo que tapa el escenario y deja de leerse como el
 * mismo peleador. A 1,5× se nota perfecto y sigue siendo él.
 */
const GROWTH_SCALES = [1, 1.15, 1.3, 1.5] as const;

export function growthScale(stage: number): number {
  const clamped = stage < 0 ? 0 : stage > GROWTH_MAX_STAGE ? GROWTH_MAX_STAGE : stage;
  return GROWTH_SCALES[clamped];
}

/** Cuota de la liquidez del libro que le corresponde a un equipo. */
export function bookShare(bidVolume: number, askVolume: number, team: number): number {
  const total = bidVolume + askVolume;
  if (total <= 0) return 0.5;
  const bidShare = bidVolume / total;
  return team === TEAM_GREEN ? bidShare : 1 - bidShare;
}

export function shouldGrow(share: number, sinceLastStep: number): boolean {
  return share > GROWTH_THRESHOLD && sinceLastStep >= GROWTH_COOLDOWN;
}

/** Alcance y potencia del super que se descarga al completar el gigantismo. */
export const SUPER_RADIUS = 3.4;
export const SUPER_FORCE = 15;
export const SUPER_DAMAGE = 34;

/** Cae con la distancia, pero nunca a cero dentro del radio: es un super. */
export function superForce(distance: number): number {
  const t = Math.max(0, 1 - distance / SUPER_RADIUS);
  return SUPER_FORCE * (0.45 + 0.55 * t);
}

/* ------------------------------------------------------------------ */
/* La barra de fuerza                                                  */
/* ------------------------------------------------------------------ */

/**
 * Cada peleador tiene UNA barra. Las órdenes agresoras de su lado la cargan y
 * **todo lo que golpea la gasta**: el puño, la patada, la especial y el super.
 *
 * Antes los golpes no salían del mercado. El cuerpo a cuerpo pegaba en cada
 * contacto que pasara el cooldown y las especiales salían de un temporizador
 * aleatorio de 8 a 12 segundos —el código decía, textual, que "no dependen de
 * que el mercado haga nada"—. El resultado era un goteo constante de golpes
 * chicos: muchos, iguales entre sí, y ninguno significaba nada. Un espectador no
 * podía mirar la pelea y sacar UNA sola conclusión sobre el libro.
 *
 * Con la barra, un golpe que se ve **es** un trade que pasó. El ritmo de la
 * pelea es el ritmo del mercado: libro quieto, pelea de forcejeo; ráfaga de
 * compras, el verde descarga. Y como cada uno tira siempre lo más caro que puede
 * pagar, la potencia sube sola con el flujo en vez de estar pegada a una
 * constante.
 *
 * **El precio a pagar, y es real**: con el libro muerto no hay golpes. El
 * temporizador viejo existía justamente para que "siempre esté pasando algo
 * aunque el libro esté quieto". Eso se pierde a propósito — un visualizador que
 * inventa acción cuando no hay datos está mintiendo—, pero deja la pantalla
 * quieta en un mercado sin volumen. Lo que sostiene la escena en ese caso es el
 * forcejeo del cuerpo a cuerpo, que no cuesta energía y sólo separa.
 */

/** Puño o patada. Barato: es el relleno, no el evento. */
export const COST_MELEE = 0.12;
/** Especial. Sale cara para que se vea venir. */
export const COST_SKILL = 0.45;
/**
 * Super. No es un precio fijo sino un MÍNIMO: el super gasta la barra entera y
 * su potencia sale de cuánto había. Puesto como mínimo y no como barra llena
 * para que un mercado flojo no deje al gigante congelado esperando para siempre.
 */
export const COST_SUPER = 0.6;

/**
 * Cuánto carga un trade del tamaño de la mediana. Con 0,14 hacen falta unos
 * siete trades medianos para llenar una barra, que a razón de mercado normal
 * —repartiendo por turno entre los tres del bando— da una descarga cada ocho a
 * catorce segundos por peleador.
 */
const CHARGE_PER_MEDIAN = 0.14;
/**
 * Techo de lo que puede aportar UN trade, en múltiplos de la mediana.
 *
 * Está justo abajo del umbral de ballena —`size > mediana * 8`— para que una
 * ballena llene casi una barra de un saque y se vea el golpe salir de ella. Sin
 * techo, un solo trade monstruoso cargaría a un peleador para diez descargas y
 * la barra dejaría de decir nada.
 */
const CHARGE_CAP = 7;

/**
 * Lo que suma a la barra un trade agresor.
 *
 * Se normaliza por la mediana móvil —la misma que decide quién es ballena— y no
 * por un tamaño absoluto, porque un trade "grande" en BTC no se parece a uno
 * grande en un par chico, y la escena tiene que leerse igual en los dos.
 */
export function chargeFromTrade(size: number, median: number): number {
  // Sin mediana todavía —los primeros veinte trades— no hay con qué comparar, y
  // suponer que todos son medianos es la suposición neutra.
  if (!(median > 0)) return CHARGE_PER_MEDIAN;
  const ratio = Math.min(size / median, CHARGE_CAP);
  return ratio * CHARGE_PER_MEDIAN;
}

/** La barra no pasa de llena: una barra que se desborda deja de leerse. */
export function addCharge(energy: number, delta: number): number {
  const next = energy + delta;
  return next > 1 ? 1 : next < 0 ? 0 : next;
}

/**
 * Alcance de la especial según lo cargado que esté el que la tira.
 *
 * Que el radio crezca con la carga es lo que hace que valga la pena esperar: una
 * especial al mínimo apenas llega al que tiene enfrente, una con la barra llena
 * barre a los tres.
 */
export function skillRadius(energy: number): number {
  return 1.4 + clamp01(energy) * 1.9;
}

/** Daño de una especial según lo que se gastó en ella. */
export function skillDamage(spent: number): number {
  return 6 + clamp01(spent) * 22;
}

/**
 * Multiplicador de empujón de una especial. Al precio mínimo pega menos que el
 * knockback normal, con la barra llena pega la mitad más.
 */
export function skillForce(spent: number): number {
  return 0.5 + clamp01(spent);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/* ------------------------------------------------------------------ */
/* El ultra: la barra del equipo                                       */
/* ------------------------------------------------------------------ */

/**
 * Arriba de las tres barras personales hay UNA por equipo. La cargan las mismas
 * órdenes, y cuando se llena le da el **ultra** al peleador al que le toca: el
 * primero, después el segundo, después el tercero, y vuelve a empezar.
 *
 * Es lo que le da sentido al gigantismo. Antes crecer salía de la cuota de
 * liquidez del libro y el super se descargaba solo al tercer paso, así que el
 * espectador veía a alguien inflarse sin saber por qué ni a quién le iba a tocar
 * después. Ahora el ciclo es de tres y se anuncia: el elegido crece a medida que
 * la barra del equipo se llena —el gigantismo ES el dibujo de la barra— y el
 * turno pasa al siguiente en cuanto descarga.
 *
 * El libro no queda afuera: modula la velocidad de carga. El equipo que domina
 * la liquidez carga más rápido, así que `bidVolume` y `askVolume` siguen
 * decidiendo quién llega antes a su ultra.
 */

/**
 * Cuánto carga la barra de equipo un trade del tamaño de la mediana. Mucho menos
 * que la personal: hacen falta unos 55 trades para llenarla, que a ritmo de
 * mercado normal es un ultra por equipo cada medio minuto largo. Un super que
 * sale cada diez segundos deja de ser un super.
 */
const ULTRA_PER_MEDIAN = 0.018;

/**
 * A partir de acá el elegido deja de gastar en golpes y especiales: está
 * guardando para el ultra. Coincide con el paso 2 de gigantismo, así que el
 * momento en que se planta es el mismo en que se lo ve grande. Antes de eso
 * pelea normal, porque un peleador que se pasa media pelea sin atacar es un
 * peleador de menos.
 */
export const ULTRA_HOLD = 0.66;

/** Lo que suma a la barra de equipo un trade agresor, según la cuota del libro. */
export function ultraGain(size: number, median: number, share: number): number {
  const base = median > 0 ? Math.min(size / median, CHARGE_CAP) : 1;
  // El libro empuja, pero no decide. Con el libro entero en contra la carga va a
  // 0,7x y con todo a favor a 1,3x: el que pierde el libro tarda menos del doble
  // que el que lo domina, nunca más. Pasado ese punto el equipo que va perdiendo
  // no llega nunca a su ultra y la pelea deja de tener vuelta — que es
  // justamente lo que el ultra por turnos vino a garantizar.
  return base * ULTRA_PER_MEDIAN * (0.7 + clamp01(share) * 0.6);
}

/**
 * En qué paso de gigantismo va el elegido según la barra de su equipo.
 *
 * Discreto y no continuo: en pasos se lee como un aviso —"va por el segundo"— y
 * de corrido se ve como un zoom lento que nadie registra.
 */
export function ultraStage(ultra: number): number {
  if (ultra >= 0.99) return GROWTH_MAX_STAGE;
  if (ultra >= ULTRA_HOLD) return 2;
  if (ultra >= 0.33) return 1;
  return 0;
}

/* ------------------------------------------------------------------ */
/* Estado del combate para el HUD                                      */
/* ------------------------------------------------------------------ */

/**
 * Objeto mutable creado una vez, escrito por el pool y muestreado por el HUD a
 * baja frecuencia. Mismo patrón que `stageFocus`: el productor no sabe que
 * existe React.
 */
export interface MatchState {
  /** Daño promedio de los vivos, por equipo. */
  damage: Float32Array;
  stocks: Uint8Array;
  alive: Uint8Array;
  kos: Uint32Array;
  /** Etapa de gigantismo en curso por equipo. 0 = nadie creciendo. */
  charge: Uint8Array;
  /** La barra de ultra del equipo, de 0 a 1. */
  ultra: Float32Array;
  /** A qué carril del bando le toca el próximo ultra. */
  ultraTurn: Uint8Array;
}

export function createMatchState(): MatchState {
  return {
    damage: new Float32Array(2),
    stocks: new Uint8Array(2),
    alive: new Uint8Array(2),
    kos: new Uint32Array(2),
    charge: new Uint8Array(2),
    ultra: new Float32Array(2),
    ultraTurn: new Uint8Array(2),
  };
}
