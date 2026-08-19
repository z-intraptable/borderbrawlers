import type { FeedStats, TradeRingBuffer } from '../net/feedCore';
import type { MatchState, Skyline } from './fighters';
import {
  COST_MELEE,
  COST_SKILL,
  COST_SUPER,
  HIT_COOLDOWN,
  SLOT_ACTIVE,
  SLOT_FREE,
  SUPER_DAMAGE,
  SUPER_RADIUS,
  TEAM_GREEN,
  TEAM_RED,
  addCharge,
  bookShare,
  chargeFromTrade,
  createMatchState,
  createSkyline,
  growthScale,
  hasGroundAhead,
  hitDamage,
  isKO,
  knockback,
  momentumBoost,
  pickTarget,
  separation,
  shouldBrakeAtLedge,
  skillDamage,
  skillForce,
  stunFor,
  skillRadius,
  superForce,
  ULTRA_HOLD,
  ultraGain,
  ultraStage,
  teamMomentum,
  wantsJump,
  weightFor,
} from './fighters';
import type { MoveResult } from './physics';
import { createMoveResult, step as physicsStep } from './physics';

/**
 * La pelea entera, sin una sola línea de dibujo.
 *
 * Este módulo no sabe que existe Pixi. Mantiene el estado de los seis
 * peleadores en arrays tipados y lo avanza con un paso de tiempo fijo; la capa
 * de render lo lee y lo dibuja. Es la separación que faltaba en la versión de
 * three.js, donde el pool mezclaba decisiones de juego con llamadas de física y
 * no se podía probar nada sin un browser.
 *
 * **En la pelea no queda ninguna decisión al azar.** Había un mulberry32 con
 * semilla fija acá, y su único consumidor era el reloj que sacaba una especial
 * cada 8 a 12 segundos. Al pasar los golpes a la barra de fuerza —que cargan las
 * órdenes— ese reloj sobró, y con él la última fuente de azar: hoy todo lo que
 * pasa en pantalla se puede seguir hasta un trade o una cifra del libro. El
 * replay determinista del VPS, que era la razón de tener el PRNG, sale ahora de
 * que no hay nada que sembrar.
 */

export const FIGHTERS_PER_TEAM = 3;
export const CAPACITY = FIGHTERS_PER_TEAM * 2;
export const STOCKS = 3;
/**
 * Cuánto dura la ceremonia del final, en segundos.
 *
 * No es un número de gusto: es lo que tarda en leerse el título, mirar a los
 * tres bailando y entender quién ganó. Menos que esto y el match siguiente
 * arranca antes de que uno se entere de que terminó el anterior.
 */
export const CEREMONIA = 7;

/* --- geometría del escenario ---------------------------------------- */

export const STAGE_HALF_WIDTH = 9;
/**
 * La losa del centro, que es donde se pelea.
 *
 * Subió de 2,4 a 3,2 —de 4,8 a 6,4 unidades de ancho— porque ahí arriba hay
 * SEIS cuerpos de 0,6 cada uno. Con 4,8 los seis ocupaban tres cuartos de la
 * losa y peleaban hombro con hombro contra el borde; ahora entran con lugar
 * para moverse, que es de lo que se trata.
 */
export const CENTER_HALF_WIDTH = 3.2;
/**
 * Cuántas losas por costado. **Bajó de 4 a 2, y son más anchas.**
 *
 * Con cuatro, cada una medía 0,98 unidades —1,6 cuerpos— y no era una
 * plataforma: era una repisa donde no entra una pelea. La referencia declarada
 * del proyecto tiene una losa grande y dos o tres flotando, no ocho repisas.
 *
 * Se pierde resolución del libro: cada losa lateral ahora resume diez niveles
 * en vez de cinco. Es un cambio real y va a favor: lo que el escenario tiene
 * que decir es "de este lado hay más liquidez que del otro", y eso se lee igual
 * con dos columnas por lado y con cuatro. Lo que no se leía era una pelea
 * repartida, porque no había dónde repartirla.
 */
export const PLATFORMS_PER_SIDE = 2;
export const PLATFORM_COUNT = PLATFORMS_PER_SIDE * 2 + 1;

/**
 * Dónde empieza la primera losa lateral. Corrido a la par del centro, que se
 * ensanchó: si no, la del costado se le montaba encima y desaparecía el pozo.
 */
const SIDE_INNER = 4.05;
const SIDE_SLOT = (STAGE_HALF_WIDTH - SIDE_INNER) / PLATFORMS_PER_SIDE;
/** El hueco entre losas es deliberado: sin pozos no hay nada que saltar. */
const SIDE_HALF_WIDTH = SIDE_SLOT / 2 - 0.25;

export const PLATFORM_MIN_Y = 0.6;
/**
 * Lo más alto que sube una losa lateral. **Era 6,5 y estaba fuera de alcance.**
 *
 * Ésta es la razón de fondo de que la pelea se juntara siempre en el centro, y
 * no era la IA. Con `JUMP_SPEED` en 11 y `GRAVITY` en −34, un salto sube
 * `11² / (2·34) = 1,78` unidades, y el segundo salto, tirado desde el vértice
 * del primero, suma otras 1,78: el techo real de un peleador son **3,56
 * unidades**. Una losa a 6,5 está tres unidades por encima de eso, o sea que
 * era **físicamente inalcanzable**: los ocho costados desaparecían del juego en
 * cuanto el libro los levantaba y quedaban los seis apretados en la losa del
 * medio, que es exactamente lo que se veía.
 *
 * 3,1 deja un margen sobre el techo teórico —hay que llegar con algo de
 * velocidad horizontal y aterrizar, no rozar el borde con la cabeza—, y como
 * las laterales arrancan en 0,6 el salto entre dos vecinas nunca pasa de 2,5.
 *
 * Lo verifica `scripts/smokeFighters.ts`, para que no vuelva a irse de rango
 * el día que alguien toque la gravedad o el salto.
 */
export const PLATFORM_MAX_Y = 3.1;
/** Tope de velocidad de una plataforma. Ver `SNAP_UP` en physics.ts. */
const PLATFORM_MAX_SPEED = 2.2;
const PLATFORM_LAMBDA = 2.5;

export function platformCenterX(index: number): number {
  if (index === 0) return 0;
  const side = index <= PLATFORMS_PER_SIDE ? -1 : 1;
  const slot = (index - 1) % PLATFORMS_PER_SIDE;
  return side * (SIDE_INNER + SIDE_SLOT * slot + SIDE_SLOT / 2);
}

export function platformHalfWidth(index: number): number {
  return index === 0 ? CENTER_HALF_WIDTH : SIDE_HALF_WIDTH;
}

/* --- personaje ------------------------------------------------------ */

export const FIGHTER_HALF_WIDTH = 0.3;
export const FIGHTER_HALF_HEIGHT = 0.52;

const RUN_SPEED = 3.6;
const JUMP_SPEED = 11;
const MAX_JUMPS = 2;
const AIR_CONTROL = 0.12;
const LOOKAHEAD = 0.7;
/** Cuánto queda sin control tras recibir un lanzamiento. */
export const HITSTUN = 0.34;
/**
 * El cuerpo a cuerpo aturde mucho menos: si aturdiera como una especial, dos
 * peleadores en contacto se paralizarían mutuamente y no pasaría nada más.
 */
const MELEE_STUN = 0.12;
/**
 * Separación del cuerpo a cuerpo, en unidades por segundo POR SEGUNDO.
 *
 * Es una aceleración y no un impulso, y el cambio importa. Como impulso
 * periódico —que es lo que era— empujaba de golpe cada tantos cuadros; mientras
 * la velocidad del piso se reasignaba entera cada paso eso se disimulaba, pero
 * ahora la velocidad se acelera hacia su objetivo y un impulso se queda pegado.
 * Dos cuerpos en contacto quedaban temblando al ritmo del empujón. Una fuerza
 * continua hace el mismo trabajo —no dejar que se solapen— y no tiembla.
 */
const MELEE_NUDGE = 7;
/**
 * Cada cuánto puede tirar una especial UN peleador.
 *
 * No existía, y su ausencia rompía el diseño que el propio código declara dos
 * bloques más abajo: *"la especial gasta la barra ENTERA… el que aguanta pega
 * más fuerte"*. Sin reloj nadie aguantaba nunca. La condición de disparo es
 * `energy >= COST_SKILL`, o sea 0,45, así que la barra se descargaba **exacta**
 * en 0,45 apenas la cruzaba: todas las especiales salían idénticas, la más
 * floja posible, y salían todo el tiempo. Ése era el goteo que se veía en
 * pantalla como ruido, y de paso dejaba al cuerpo a cuerpo sin barra —el puño
 * cuesta 0,12 y la especial se llevaba todo antes.
 *
 * Con dos segundos y medio de por medio la barra llega arriba, la especial pega
 * como corresponde, y entre una y otra lo que se ve es la pelea.
 */
const SKILL_COOLDOWN = 2.5;
const CONTACT = 0.85;
/**
 * Distancia de guardia. Apenas menor que `CONTACT` para que el cuerpo a cuerpo
 * siga saltando: si fuera mayor se quedarían mirándose sin llegar a pegarse.
 */
const ENGAGE_RANGE = 0.78;
/**
 * A qué distancia se vuelve a SALIR de combate.
 *
 * Que entrar y salir tengan umbrales distintos —histéresis— no es un lujo: con
 * un umbral solo, un peleador parado justo en 0,78 alterna entre "cerrar
 * distancia" y "pelear acá" en cuadros consecutivos, y son dos velocidades
 * distintas. El resultado era un peleador vibrando en el lugar, y como el
 * dibujo se espejea según el signo de la velocidad, además parpadeaba mirando
 * a un lado y al otro. Es el ruido que se veía en los movimientos.
 */
const DISENGAGE_RANGE = 1.35;
/**
 * Cuánto puede cambiar la velocidad horizontal por segundo.
 *
 * Antes en el piso no había aceleración: `vx` se reasignaba entera al valor
 * deseado, así que un cambio de objetivo daba vuelta al peleador en UN cuadro.
 * Acotarla a 34 u/s² le da 0,21 s para pasar de correr a un lado a correr al
 * otro: se sigue sintiendo un juego de peleas y ya no es un parpadeo.
 */
const GROUND_ACCEL = 34;
/**
 * Velocidad mínima para darse vuelta, y cuánto tiene que pasar entre una vuelta
 * y la siguiente. El que está peleando ni siquiera mira su velocidad: mira a su
 * rival, que es lo que hace un peleador.
 */
const TURN_SPEED = 1.2;
const TURN_COOLDOWN = 0.4;
/**
 * Cuánto tiene que estar corrido el rival para que valga la pena darse vuelta.
 *
 * Sin esto, dos peleadores forcejeando alrededor del mismo punto se cruzan de
 * lado constantemente —`dx` cambia de signo— y los dos se espejan cada vez. Con
 * un tercio de cuerpo de zona muerta, cruzarse deja de contar como estar del
 * otro lado.
 */
const FACE_DEADZONE = 0.32;
/**
 * Cuánto más cerca tiene que estar otro rival para robarle el objetivo al que
 * ya se venía persiguiendo. 0,75 es "un cuarto más cerca".
 *
 * `pickTarget` elegía de cero en cada paso, y con dos rivales a distancia
 * parecida la elección alternaba entre uno y otro sesenta veces por segundo. Si
 * estaban a los costados, el peleador se daba vuelta con cada cambio: es la
 * mitad de las vueltas que se veían. Un objetivo se suelta cuando se cae del
 * escenario o cuando otro está bastante más cerca, no cuando empata.
 */
const TARGET_SWITCH = 0.75;
/** Cuánto manda la separación cuando ya no hay que cerrar distancia. */
const SPACING_GAIN = 0.55;
/** Polvo mínimo de un aterrizaje, y a qué velocidad de caída se satura. */
const LANDING_SOFT = 0.35;
const LANDING_FULL = 18;
const SPAWN_Y = 8;
const SPAWN_X = 5.5;
const MAX_SPAWNS_PER_STEP = 4;
/**
 * Techo de trades leídos por paso. Es más alto que el de altas porque cargar es
 * mucho más barato que dar de alta, y porque un trade que no carga a nadie es un
 * dato del libro que se perdió. A 60 Hz son 1440 por segundo, muy por encima de
 * cualquier ráfaga real.
 */
const MAX_TRADES_PER_STEP = 24;

const BLAST = { minX: -15, maxX: 15, minY: -11, maxY: 26 };

/* ------------------------------------------------------------------ */
/* Poderes a distancia                                                 */
/* ------------------------------------------------------------------ */

/**
 * La especial deja de ser un estallido alrededor del que la tira y pasa a ser
 * un poder que SALE DISPARADO, viaja y estalla contra el rival.
 *
 * El motivo es de pelea, no de efectos: con la especial pegada al cuerpo el
 * único modo de usarla era estar encima del otro, así que los seis se pasaban
 * el match persiguiéndose y saltando y todo terminaba en contacto. Un poder que
 * cruza el escenario le da a la pelea la distancia que le faltaba — que es lo
 * que hacen Street Fighter, Mortal Kombat y las bolas de ki de Dragon Ball.
 *
 * Es un pool y no una lista: los poderes en vuelo son pocos y de vida corta, y
 * el camino de datos de mercado no puede asignar memoria por cuadro.
 */
export interface Poderes {
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  /** Segundos que le quedan de vuelo. Cero o menos es una ranura libre. */
  vida: Float32Array;
  /** De qué bando es, para no pegarle al que lo tiró ni a sus compañeros. */
  team: Uint8Array;
  /** Quién lo tiró. Sirve para el peso del empujón y para el rastro. */
  duenio: Int8Array;
  /** La barra que se gastó: escala daño, empuje y tamaño. */
  fuerza: Float32Array;
  /** Radio del estallido, en unidades de mundo. */
  radio: Float32Array;
  /** Cuál de las dos especiales del personaje es. Lo usa el dibujo. */
  tipo: Uint8Array;
}

/** Cuántos poderes pueden estar viajando a la vez. */
export const PODERES = 12;

/**
 * A qué velocidad viaja, en unidades por segundo.
 *
 * El escenario mide 30 de lado a lado, así que a 16 el poder lo cruza en menos
 * de dos segundos: se ve viajar —que es todo el punto— y sigue siendo esquivable
 * saltando, que es lo que lo vuelve una jugada y no un impuesto.
 */
const PODER_VELOCIDAD = 16;
/** Cuánto vive si no le pega a nadie. Alcanza para cruzar el escenario. */
export const PODER_VIDA = 2;
/** Desde qué distancia se anima a tirar. */
const ALCANCE = 22;
/**
 * A qué altura del cuerpo apunta.
 *
 * Al centro del rival y no a sus pies: `m.y` es el centro del cuerpo, y un poder
 * que sale de la altura del pecho y llega a la altura del pecho es el que se lee
 * como un disparo horizontal.
 */
const BOCA = 0.55;
/**
 * Cuánto puede corregir el rumbo el poder en vuelo, en radianes por segundo.
 *
 * Sale del *Homing Super Dash* de Dragon Ball FighterZ: la dirección deseada se
 * recalcula cada cuadro contra la posición del rival, pero el giro está
 * limitado, así que el proyectil CURVA en vez de doblar en ángulo recto.
 *
 * 2,2 rad/s a 16 unidades por segundo dan un radio de giro de 7,3 unidades —casi
 * medio escenario—, y eso es lo que lo mantiene esquivable: persigue lo
 * suficiente para no ser un tiro al aire cuando el rival camina, y no tanto como
 * para ser inevitable. Un poder que no falla nunca deja de ser una jugada.
 */
const GIRO_PODER = 2.2;

function createPoderes(): Poderes {
  return {
    x: new Float64Array(PODERES),
    y: new Float64Array(PODERES),
    vx: new Float64Array(PODERES),
    vy: new Float64Array(PODERES),
    vida: new Float32Array(PODERES),
    team: new Uint8Array(PODERES),
    duenio: new Int8Array(PODERES).fill(-1),
    fuerza: new Float32Array(PODERES),
    radio: new Float32Array(PODERES),
    tipo: new Uint8Array(PODERES),
  };
}

/** La primera ranura libre del pool, o -1 si están todas ocupadas. */
function poderLibre(p: Poderes): number {
  for (let k = 0; k < PODERES; k++) if (p.vida[k] <= 0) return k;
  return -1;
}



/* --- eventos para la capa de render ---------------------------------- */

export const EVENT_HIT = 0;
export const EVENT_KO = 1;
export const EVENT_SUPER = 2;
export const EVENT_LAND = 3;
export const EVENT_GROW = 4;
export const EVENT_SKILL = 5;
export const EVENT_MELEE = 6;
/**
 * Un poder estalló. `magnitude` es la fuerza con la que salió y `x`/`y` el
 * punto del impacto, que NO es donde está el que lo tiró.
 */
export const EVENT_ESTALLIDO = 7;
/**
 * Alguien saltó. `magnitude` es 0 si despegó del piso y 1 si fue salto de aire.
 *
 * Faltaba: el aterrizaje tenía su polvo desde el principio y el despegue no
 * tenía nada, así que la mitad de arriba del salto salía de la nada.
 */
export const EVENT_SALTO = 8;

/**
 * Cola de eventos del paso. La capa de render la drena y la vacía: es cómo la
 * simulación pide chispas y sacudones sin conocer al que los dibuja.
 */
export interface EventQueue {
  count: number;
  kind: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  magnitude: Float32Array;
  team: Uint8Array;
  /**
   * A qué peleador le pasó, o -1 si el evento no es de nadie en particular.
   *
   * Sin esto la capa de render sabe que alguien tiró una patada y dónde, pero no
   * a quién animar. Es el dato que convierte la cola en el disparador de las
   * animaciones y no sólo de las chispas.
   */
  slot: Int8Array;
}

const EVENT_CAP = 64;

function createEventQueue(): EventQueue {
  return {
    count: 0,
    kind: new Uint8Array(EVENT_CAP),
    x: new Float32Array(EVENT_CAP),
    y: new Float32Array(EVENT_CAP),
    magnitude: new Float32Array(EVENT_CAP),
    team: new Uint8Array(EVENT_CAP),
    slot: new Int8Array(EVENT_CAP),
  };
}

function emit(
  q: EventQueue, kind: number, x: number, y: number,
  magnitude: number, team: number, slot: number,
): void {
  if (q.count >= EVENT_CAP) return;
  const i = q.count++;
  q.kind[i] = kind;
  q.x[i] = x;
  q.y[i] = y;
  q.magnitude[i] = magnitude;
  q.team[i] = team;
  q.slot[i] = slot;
}

/* --- estado ---------------------------------------------------------- */

export interface Match {
  skyline: Skyline;
  state: MatchState;
  events: EventQueue;

  /** Altura objetivo y actual de cada plataforma. */
  targetY: Float64Array;

  slot: Uint8Array;
  team: Uint8Array;
  /**
   * Índice del personaje de la plantilla que le tocó a este slot. Lo fija
   * `createMatch` una sola vez y no cambia más: sin relevos, el que se cae del
   * escenario reaparece él mismo acá.
   *
   * Sigue siendo un array por slot y no una constante a propósito, para que
   * volver a agrandar la plantilla sea sumar entradas en `roster.ts` y devolverle
   * a `activate` el reparto por ronda, sin tocar el resto de la simulación.
   */
  character: Uint8Array;
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  facing: Int8Array;
  grounded: Uint8Array;
  damage: Float32Array;
  weight: Float32Array;
  stocks: Uint8Array;
  jumps: Uint8Array;
  lastJump: Float32Array;
  /**
   * Cuándo recibió el último GOLPE de verdad. Gobierna la cadencia del cuerpo a
   * cuerpo: mientras no pase `HIT_COOLDOWN` nadie le vuelve a pegar.
   *
   * No lo escribe el forcejeo. Antes sí, y era un error de lógica con
   * consecuencia visible: dos peleadores sin barra se tocaban, el forcejeo
   * ponía el reloj en cero, y cuando al cuarto de segundo les llegaba la carga
   * del libro **el golpe no salía** porque el reloj del forcejeo todavía corría.
   * O sea: el que no podía pegar le bloqueaba el golpe al que sí podía. El
   * forcejeo ya no tiene reloj —es una fuerza continua— y éste sólo se toca
   * cuando alguien pegó de verdad.
   */
  lastHit: Float32Array;
  /** A quién viene persiguiendo, o -1. Ver `TARGET_SWITCH`. */
  target: Int8Array;
  /** 1 si ya está a distancia de pelea. Ver `DISENGAGE_RANGE`. */
  engaged: Uint8Array;
  /** Cuándo se dio vuelta por última vez. Ver `TURN_COOLDOWN`. */
  lastTurn: Float32Array;
  /** Cuándo tiró su última especial. Ver `SKILL_COOLDOWN`. */
  lastSkillAt: Float32Array;
  hitstun: Float32Array;
  whale: Uint8Array;
  stage: Uint8Array;
  scale: Float32Array;
  claims: Uint8Array;
  /**
   * La barra de fuerza, de 0 a 1. La cargan las órdenes agresoras del bando y la
   * gastan TODOS los golpes: puño, patada, especial y super.
   *
   * Reemplazó a `nextSkill`, que era el reloj que sacaba una especial cada 8 a
   * 12 segundos sin mirar el mercado. Ver el bloque "La barra de fuerza" en
   * `fighters.ts` para por qué, y para qué se pierde a cambio.
   */
  energy: Float32Array;
  /** Cuál usó la última vez: se alternan. */
  lastSkill: Uint8Array;
  /** Golpe o patada: también se alternan, contacto a contacto. */
  lastBlow: Uint8Array;

  /**
   * A quién le toca cobrar el próximo trade de cada bando.
   *
   * El reparto es por turno y no en partes iguales a propósito: cargando a los
   * tres a la vez las tres barras se llenan juntas y descargan juntas, que se ve
   * como un pulso y no como una pelea. Por turno se escalonan solas, y además
   * cada orden que entra va visiblemente a UN peleador.
   */
  chargeCursor: Int8Array;

  /**
   * La barra de ultra de cada equipo, de 0 a 1. La cargan las mismas órdenes que
   * las personales, moduladas por la cuota del libro. Al llenarse le da el super
   * al peleador al que le toca, y el turno pasa al siguiente.
   */
  ultra: Float32Array;
  /** A qué carril del bando le toca el próximo ultra: 0, 1, 2 y vuelve. */
  ultraTurn: Uint8Array;

  /** Quién está creciendo por equipo, -1 si nadie. */
  growing: Int8Array;
  /**
   * Cuántos carriles de los tres usa cada bando. Es lo único que separa un 3v3
   * de un 1v1: los slots de los carriles de más quedan libres para siempre, y
   * todos los recorridos que ya saltean los slots vacíos —el turno del ultra,
   * el cobro de energía, la búsqueda de objetivo— los ignoran sin cambiar nada.
   *
   * Existe para poder mirar el motor de pelea con dos peleadores en pantalla en
   * vez de seis, que es donde se ve si un golpe pega, si el knockback empuja lo
   * que tiene que empujar y si la cámara sigue a quien corresponde.
   */
  lanes: number;
  /**
   * El torneo: cada bando manda UN peleador a la vez y el que gana se queda.
   *
   * Es un modo y no una variante del 3v3 porque cambia quién puede entrar, no
   * cuántos. En melé los seis están en el escenario y el que se cae vuelve; acá
   * hay un solo carril por bando, el que se cae **no vuelve**, y entra el
   * siguiente de su plantilla. El bando que se queda sin los tres pierde el
   * match.
   */
  torneo: boolean;
  /** Cuántos perdió cada bando. Sólo en torneo. */
  caidos: Uint8Array;
  /**
   * Cuándo puede entrar el próximo de cada plantilla. Sólo en torneo.
   *
   * El relevo NO espera a que llegue un trade de su bando. Esperaba, y ése era
   * el defecto que se veía como *"desaparecen uno o dos personajes"*: el alta
   * la disparaba la cola de trades, así que un tramo de mercado comprador
   * dejaba al bando vendedor sin NADIE en el escenario. Con tres carriles por
   * lado se disimulaba —faltaba uno de seis—; en 1v1 el que falta es la mitad
   * de la pelea y queda un peleador solo dando vueltas.
   */
  relevoEn: Float32Array;
  /** Quién ganó el match: -1 mientras se pelea. */
  ganador: number;
  /** En qué momento del reloj se terminó, para cronometrar la ceremonia. */
  ganoEn: number;
  clock: number;
  /** Los poderes que están viajando por el escenario. */
  poderes: Poderes;
  /** Sacudón de cámara, decae solo. */
  shake: number;
}

export function createMatch(
  lanes: number = FIGHTERS_PER_TEAM,
  torneo: boolean = false,
): Match {
  // En torneo el carril es uno y no se discute: el 1v1 ES la regla del modo.
  if (torneo) lanes = 1;
  const m: Match = {
    skyline: createSkyline(PLATFORM_COUNT),
    state: createMatchState(),
    events: createEventQueue(),
    targetY: new Float64Array(PLATFORM_COUNT).fill(PLATFORM_MIN_Y),
    slot: new Uint8Array(CAPACITY),
    team: new Uint8Array(CAPACITY),
    character: new Uint8Array(CAPACITY),
    x: new Float64Array(CAPACITY),
    y: new Float64Array(CAPACITY),
    vx: new Float64Array(CAPACITY),
    vy: new Float64Array(CAPACITY),
    facing: new Int8Array(CAPACITY).fill(1),
    grounded: new Uint8Array(CAPACITY),
    damage: new Float32Array(CAPACITY),
    weight: new Float32Array(CAPACITY),
    stocks: new Uint8Array(CAPACITY),
    jumps: new Uint8Array(CAPACITY),
    lastJump: new Float32Array(CAPACITY),
    lastHit: new Float32Array(CAPACITY),
    target: new Int8Array(CAPACITY).fill(-1),
    engaged: new Uint8Array(CAPACITY),
    lastTurn: new Float32Array(CAPACITY),
    lastSkillAt: new Float32Array(CAPACITY),
    hitstun: new Float32Array(CAPACITY),
    whale: new Uint8Array(CAPACITY),
    stage: new Uint8Array(CAPACITY),
    scale: new Float32Array(CAPACITY).fill(1),
    claims: new Uint8Array(CAPACITY),
    energy: new Float32Array(CAPACITY),
    lastSkill: new Uint8Array(CAPACITY),
    lastBlow: new Uint8Array(CAPACITY),
    chargeCursor: new Int8Array(2),
    ultra: new Float32Array(2),
    ultraTurn: new Uint8Array(2),
    growing: Int8Array.from([-1, -1]),
    lanes: Math.min(FIGHTERS_PER_TEAM, Math.max(1, Math.round(lanes))),
    torneo,
    caidos: new Uint8Array(2),
    relevoEn: new Float32Array(2),
    ganador: -1,
    ganoEn: 0,
    clock: 0,
    poderes: createPoderes(),
    shake: 0,
  };

  // Ni el bando ni el personaje de un slot cambian nunca: se resuelven una sola
  // vez acá y valen para toda la sesión. Pelean siempre los mismos seis, y el
  // que se cae del escenario reaparece él mismo en su slot.
  for (let i = 0; i < CAPACITY; i++) {
    m.team[i] = i < FIGHTERS_PER_TEAM ? TEAM_GREEN : TEAM_RED;
    m.character[i] = i % FIGHTERS_PER_TEAM;
  }

  // Los rangos en x de las plataformas son fijos: sólo se mueve la altura.
  for (let i = 0; i < PLATFORM_COUNT; i++) {
    const cx = platformCenterX(i);
    const half = platformHalfWidth(i);
    m.skyline.minX[i] = cx - half;
    m.skyline.maxX[i] = cx + half;
    m.skyline.topY[i] = i === 0 ? 0 : PLATFORM_MIN_Y;
  }
  m.targetY[0] = 0;
  return m;
}

const move: MoveResult = createMoveResult();

export function updateStageFromBook(
  m: Match,
  bidQtys: Float64Array,
  bidCount: number,
  askQtys: Float64Array,
  askCount: number,
  qtyMedian: number,
): void {
  const reference = qtyMedian > 0 ? qtyMedian : 1;
  for (let i = 1; i < PLATFORM_COUNT; i++) m.targetY[i] = PLATFORM_MIN_Y;

  // Los 20 niveles de cada lado se reparten entre sus 4 plataformas.
  const perPlatform = Math.ceil(bidCount / PLATFORMS_PER_SIDE) || 1;
  for (let level = 0; level < bidCount; level++) {
    const slot = Math.min(PLATFORMS_PER_SIDE - 1, Math.floor(level / perPlatform));
    const height = Math.log1p(bidQtys[level] / reference) * 2.2;
    const index = 1 + slot;
    if (height > m.targetY[index]) m.targetY[index] = height;
  }
  const perAsk = Math.ceil(askCount / PLATFORMS_PER_SIDE) || 1;
  for (let level = 0; level < askCount; level++) {
    const slot = Math.min(PLATFORMS_PER_SIDE - 1, Math.floor(level / perAsk));
    const height = Math.log1p(askQtys[level] / reference) * 2.2;
    const index = 1 + PLATFORMS_PER_SIDE + slot;
    if (height > m.targetY[index]) m.targetY[index] = height;
  }

  for (let i = 1; i < PLATFORM_COUNT; i++) {
    if (m.targetY[i] < PLATFORM_MIN_Y) m.targetY[i] = PLATFORM_MIN_Y;
    if (m.targetY[i] > PLATFORM_MAX_Y) m.targetY[i] = PLATFORM_MAX_Y;
  }
}

function damp(current: number, goal: number, lambda: number, dt: number): number {
  return goal + (current - goal) * Math.exp(-lambda * dt);
}

/** Avanza un paso fijo de la simulación. */
export function stepMatch(
  m: Match,
  trades: TradeRingBuffer,
  stats: FeedStats,
  dt: number,
): void {
  m.clock += dt;
  const now = m.clock;
  m.events.count = 0;
  m.shake *= 0.9;
  if (m.shake < 0.001) m.shake = 0;

  /* --- plataformas ------------------------------------------------- */
  for (let i = 1; i < PLATFORM_COUNT; i++) {
    const next = damp(m.skyline.topY[i], m.targetY[i], PLATFORM_LAMBDA, dt);
    const limit = PLATFORM_MAX_SPEED * dt;
    const delta = Math.max(-limit, Math.min(limit, next - m.skyline.topY[i]));
    m.skyline.topY[i] += delta;
  }

  // Terminado el match no se pelea más: se festeja. Va después de las
  // plataformas para que el escenario siga respirando con el libro —congelarlo
  // entero hace que la ceremonia parezca que el juego se colgó— y antes de todo
  // lo demás, que es IA, golpes y altas.
  if (m.ganador >= 0) {
    if (m.clock - m.ganoEn >= CEREMONIA) reiniciar(m);
    else ceremonia(m);
    summarize(m);
    return;
  }

  const greenBoost = momentumBoost(teamMomentum(stats.buyVolume, stats.sellVolume, TEAM_GREEN));
  const redBoost = momentumBoost(teamMomentum(stats.buyVolume, stats.sellVolume, TEAM_RED));

  /* --- decidir y mover ---------------------------------------------- */
  m.claims.fill(0);
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;

    const inHitstun = now - m.hitstun[i] < HITSTUN;
    if (!inHitstun) {
      const previo = m.target[i];
      const sigueVivo = previo >= 0 && m.slot[previo] === SLOT_ACTIVE
        && m.team[previo] !== m.team[i];
      let target = pickTarget(CAPACITY, m.slot, m.team, m.x, m.y, m.claims, i);
      if (sigueVivo && target !== previo) {
        const dPrevio = Math.hypot(m.x[previo] - m.x[i], m.y[previo] - m.y[i]);
        const dNuevo = target >= 0
          ? Math.hypot(m.x[target] - m.x[i], m.y[target] - m.y[i])
          : Infinity;
        if (dNuevo > dPrevio * TARGET_SWITCH) target = previo;
      }
      m.target[i] = target;
      if (target >= 0) m.claims[target]++;
      const dx = target >= 0 ? m.x[target] - m.x[i] : -m.x[i];
      const dy = target >= 0 ? m.y[target] - m.y[i] : 0;
      const dir = dx >= 0 ? 1 : -1;
      const grounded = m.grounded[i] === 1;

      const groundAhead = hasGroundAhead(m.skyline, m.x[i], dir, LOOKAHEAD);
      const brake = shouldBrakeAtLedge(groundAhead, dx, dir);
      const spread = separation(CAPACITY, m.slot, m.team, m.x, m.y, i);
      const boost = m.team[i] === TEAM_GREEN ? greenBoost : redBoost;

      // Distancia de combate: adentro del alcance del golpe se deja de cerrar y
      // se pelea ahí. Sin esto cada uno camina HACIA ADENTRO del rival, el
      // cuerpo a cuerpo los separa 1,6 u/s y ellos vuelven a entrar a 3,6 — el
      // resultado era los seis apilados en el mismo punto del escenario. Con
      // una distancia de guardia, el que ya llegó cede el paso al compañero y
      // la pelea se reparte a lo ancho.
      // Con histéresis: se entra a combate a `ENGAGE_RANGE` y no se sale hasta
      // `DISENGAGE_RANGE`. Con un umbral solo esto es un control de todo o nada
      // y el peleador oscila alrededor de la frontera.
      const rango = m.engaged[i] === 1 ? DISENGAGE_RANGE : ENGAGE_RANGE;
      // **Con el poder cargado y el rival a tiro, no va a buscarlo.** Se planta
      // y lo castiga de lejos.
      //
      // Es el cambio de flujo que pedía el 1v1: con la especial pegada al cuerpo
      // el único plan posible era correr hacia el otro, así que los dos se
      // pasaban el match encimados y saltando. Ahora el que tiene barra elige
      // distancia, tira, se queda en cero, y recién entonces vuelve a entrar. Ese
      // ida y vuelta es la pelea; el forcejeo permanente no lo era.
      //
      // No se traba: la especial gasta la barra ENTERA y tiene enfriamiento, así
      // que `aTiro` se apaga solo apenas dispara. Y si los dos se plantan a la
      // vez, el primero que se queda sin barra vuelve a avanzar.
      const aTiro = target >= 0 && m.energy[i] >= COST_SKILL
        && Math.abs(dx) <= ALCANCE * 0.8;
      const closing = Math.abs(dx) > rango && !aTiro;
      m.engaged[i] = closing ? 0 : 1;
      const desired = brake ? 0
        : closing ? (dir + spread * 0.5) * RUN_SPEED * boost
          : spread * RUN_SPEED * SPACING_GAIN;

      if (grounded) {
        // Acelera hacia lo que quiere, no salta a ello. Ver `GROUND_ACCEL`.
        const limite = GROUND_ACCEL * dt;
        m.vx[i] += Math.max(-limite, Math.min(limite, desired - m.vx[i]));
      } else {
        m.vx[i] += (desired - m.vx[i]) * AIR_CONTROL;
      }

      // **A quién mira.** El que está peleando mira a su rival y punto: en el
      // forcejeo la velocidad cambia de signo constantemente y el dibujo se
      // espejea con ella, así que atarle la mirada a `vx` lo dejaba parpadeando.
      // El que está yendo hacia algún lado sí mira hacia donde va, pero con una
      // zona muerta y un tiempo mínimo entre vueltas.
      const mira = m.engaged[i] === 1 && target >= 0
        ? (Math.abs(dx) > FACE_DEADZONE ? dir : m.facing[i])
        : Math.abs(m.vx[i]) > TURN_SPEED ? (m.vx[i] >= 0 ? 1 : -1)
          : m.facing[i];
      if (mira !== m.facing[i] && now - m.lastTurn[i] >= TURN_COOLDOWN) {
        m.facing[i] = mira;
        m.lastTurn[i] = now;
      }

      // El que está por tirar tampoco salta: el poder viaja recto y en el aire
      // no se puede corregir la puntería. Además es la otra mitad de lo que se
      // veía como *"se la pasan saltando"* — la mitad de los saltos eran para
      // alcanzar en altura a alguien al que ahora le puede disparar.
      const jump = !aTiro
        && wantsJump({ grounded, dy, dx, groundAhead, sinceJump: now - m.lastJump[i] });
      // Recuperación: cayéndose por debajo del escenario gasta el salto extra.
      // Sin esto el primer empujón es siempre KO y no hay pelea.
      const recover = !grounded && m.vy[i] < 0 && m.y[i] < 0 && m.jumps[i] > 0
        && now - m.lastJump[i] > 0.25;
      if ((jump || recover) && m.jumps[i] > 0) {
        m.vy[i] = JUMP_SPEED;
        m.jumps[i]--;
        m.lastJump[i] = now;
        // La magnitud dice si fue el salto DESDE EL PISO o el de aire: el
        // primero levanta polvo y el segundo no tiene de dónde levantarlo, así
        // que el dibujo tiene que poder distinguirlos.
        emit(m.events, EVENT_SALTO, m.x[i], m.y[i], grounded ? 0 : 1, m.team[i], i);
        m.grounded[i] = 0;
      }
    }

    // La velocidad de caída ANTES de resolver el contacto: después del paso ya
    // es cero y no queda forma de saber si el aterrizaje fue un saltito o una
    // caída desde arriba de todo. Es lo que gradúa el polvo.
    const fallSpeed = m.vy[i] < 0 ? -m.vy[i] : 0;

    physicsStep(
      m.skyline, m.x[i], m.y[i], m.vx[i], m.vy[i],
      FIGHTER_HALF_WIDTH * m.scale[i], FIGHTER_HALF_HEIGHT * m.scale[i],
      m.grounded[i] === 1, dt, move,
    );
    m.x[i] = move.x;
    m.y[i] = move.y;
    m.vx[i] = move.vx;
    m.vy[i] = move.vy;
    m.grounded[i] = move.grounded ? 1 : 0;
    if (move.grounded) m.jumps[i] = MAX_JUMPS;
    if (move.landed) {
      emit(m.events, EVENT_LAND, m.x[i], m.y[i],
        LANDING_SOFT + fallSpeed / LANDING_FULL, m.team[i], i);
    }
  }

  /* --- especiales: se pagan con la barra ------------------------------- */
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    if (m.energy[i] < COST_SKILL) continue;
    if (now - m.hitstun[i] < HITSTUN) continue;
    if (now - m.lastSkillAt[i] < SKILL_COOLDOWN) continue;
    // El elegido para el ultra se PLANTA cuando la barra del equipo pasa de
    // `ULTRA_HOLD`: deja de gastar y junta para el super. Sin esto la especial
    // le baja la barra a cero y cuando le toca el ultra no puede pagarlo.
    //
    // Se planta recién ahí y no desde el principio del ciclo a propósito: entre
    // ultra y ultra pasa medio minuto largo, y un peleador que se lo pasa entero
    // sin atacar es un peleador de menos en la pelea. El momento en que se
    // planta es además el momento en que se lo ve crecer, así que se lee.
    if (m.growing[m.team[i]] === i && m.ultra[m.team[i]] >= ULTRA_HOLD) continue;

    // La especial gasta la barra ENTERA, no su precio. Es lo que hace que
    // esperar valga la pena: dos especiales al mínimo hacen menos que una con la
    // barra llena, así que el que aguanta pega más fuerte. Gastando sólo el
    // precio, la barra se drenaría de a 0,45 y todas las especiales saldrían
    // iguales — que es el goteo que este sistema vino a sacar.
    const spent = m.energy[i];

    // A quién apuntarle: el rival más cercano que esté dentro del ALCANCE del
    // poder. Antes la condición era tenerlo dentro del radio del estallido —o
    // sea, encima— y eso obligaba a que toda la pelea terminara en contacto.
    // Ahora se tira de lejos, que es lo que le faltaba.
    //
    // Sigue sin descargarse al vacío: sin nadie a la vista el poder no sale y
    // la barra se guarda. Un poder tirado a un rincón vacío es ruido.
    let objetivo = -1;
    let cerca = Infinity;
    for (let j = 0; j < CAPACITY; j++) {
      if (j === i || m.slot[j] !== SLOT_ACTIVE || m.team[j] === m.team[i]) continue;
      const d = Math.hypot(m.x[j] - m.x[i], m.y[j] - m.y[i]);
      if (d > ALCANCE || d >= cerca) continue;
      cerca = d;
      objetivo = j;
    }
    if (objetivo < 0) continue;

    const k = poderLibre(m.poderes);
    if (k < 0) continue;

    m.energy[i] = 0;
    m.lastSkillAt[i] = now;
    m.lastSkill[i] = m.lastSkill[i] === 0 ? 1 : 0;

    const dx = m.x[objetivo] - m.x[i];
    const dy = m.y[objetivo] - m.y[i];
    const largo = Math.hypot(dx, dy) || 1;
    // Se da vuelta para tirar. Un poder que sale de la espalda del personaje se
    // lee como un error de dibujo, no como un ataque.
    m.facing[i] = dx >= 0 ? 1 : -1;

    const poder = m.poderes;
    poder.x[k] = m.x[i] + m.facing[i] * BOCA;
    poder.y[k] = m.y[i] + 0.12;
    poder.vx[k] = (dx / largo) * PODER_VELOCIDAD;
    poder.vy[k] = (dy / largo) * PODER_VELOCIDAD;
    poder.vida[k] = PODER_VIDA;
    poder.team[k] = m.team[i];
    poder.duenio[k] = i;
    poder.fuerza[k] = spent;
    // El mismo radio de antes, pero ahora medido en el punto de IMPACTO y no en
    // el del que tira: el poder revienta donde llega.
    poder.radio[k] = skillRadius(spent) * 0.42;
    poder.tipo[k] = m.lastSkill[i];

    emit(m.events, EVENT_SKILL, m.x[i], m.y[i], m.lastSkill[i], m.team[i], i);
    // El disparo sacude poco: lo que sacude es el impacto, y eso lo cobra
    // `moverPoderes`. Repartirlo así es lo que hace que se sienta el viaje.
    m.shake = Math.max(m.shake, 0.12 + spent * 0.15);
  }

  moverPoderes(m, dt, now);

  /* --- empujones ----------------------------------------------------- */
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    for (let j = i + 1; j < CAPACITY; j++) {
      if (m.slot[j] !== SLOT_ACTIVE || m.team[j] === m.team[i]) continue;
      const dx = m.x[j] - m.x[i];
      const dy = m.y[j] - m.y[i];
      const distance = Math.hypot(dx, dy);
      if (distance > CONTACT) continue;

      const nx = distance > 1e-6 ? dx / distance : 1;

      // El cuerpo a cuerpo NO lanza: acumula daño y separa apenas. Lanzar es
      // trabajo de las especiales y del super. Es la regla de Smash, y es lo
      // que hace que el daño acumulado signifique algo: sin ella, cada roce
      // manda a volar y no hay nada que construir.
      //
      // El FORCEJEO —separarse— es gratis y pasa todos los cuadros: dos cuerpos
      // no pueden ocupar el mismo lugar, y empujar no es pegar. Es además lo
      // único que queda pasando cuando el libro está muerto y nadie tiene con
      // qué golpear.
      const empuje = nx * MELEE_NUDGE * dt;
      m.vx[j] += empuje;
      m.vx[i] -= empuje;

      if (now - m.lastHit[i] < HIT_COOLDOWN || now - m.lastHit[j] < HIT_COOLDOWN) continue;

      // El GOLPE, en cambio, se paga, y cada uno por su cuenta. Antes el
      // contacto disparaba un intercambio automático: los dos se pegaban
      // siempre, hubiera pasado lo que hubiera pasado en el mercado. Ahora un
      // peleador cargado le pega a uno vacío y el vacío sólo se lo come, porque
      // el que no tiene órdenes atrás no tiene con qué pegar.
      const golpeaI = m.energy[i] >= COST_MELEE && !guardando(m, i);
      const golpeaJ = m.energy[j] >= COST_MELEE && !guardando(m, j);
      if (!golpeaI && !golpeaJ) continue;

      // Recién acá se gasta el turno: el reloj del cuerpo a cuerpo lo mueve un
      // golpe que existió, no un roce.
      m.lastHit[i] = now;
      m.lastHit[j] = now;

      // Cada uno tira su golpe, alternando puño y patada. El que recibe queda
      // en hurt, que lo resuelve la capa de render con el hitstun que ya existe.
      if (golpeaI) {
        m.energy[i] -= COST_MELEE;
        m.damage[j] += hitDamage(m.weight[i]);
        m.hitstun[j] = now - HITSTUN + MELEE_STUN;
        m.lastBlow[i] = m.lastBlow[i] === 0 ? 1 : 0;
        emit(m.events, EVENT_MELEE, m.x[i], m.y[i], m.lastBlow[i], m.team[i], i);
      }
      if (golpeaJ) {
        m.energy[j] -= COST_MELEE;
        m.damage[i] += hitDamage(m.weight[j]);
        m.hitstun[i] = now - HITSTUN + MELEE_STUN;
        m.lastBlow[j] = m.lastBlow[j] === 0 ? 1 : 0;
        emit(m.events, EVENT_MELEE, m.x[j], m.y[j], m.lastBlow[j], m.team[j], j);
      }

      // **El cuerpo a cuerpo ya no sacude la cámara.** Con la cadencia actual
      // entra un golpe cada 0,25 s por pareja y hay tres parejas: `shake` no
      // bajaba nunca de 0,45 y el escenario entero vibraba de forma permanente.
      // Eso no se lee como impacto, se lee como una imagen sucia — y encima
      // arruina el dibujo de los personajes, que es lo que hay que mirar.
      //
      // El temblor queda para lo que pasa cada tanto: una especial, el super,
      // un KO. Una ballena sí sacude, porque es el único cuerpo a cuerpo que
      // no es rutina.
      const heavy = (golpeaI && m.whale[i] === 1) || (golpeaJ && m.whale[j] === 1);
      if (heavy) m.shake = Math.max(m.shake, 0.7);
    }
  }

  /* --- KO ------------------------------------------------------------ */
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    if (!isKO(BLAST, m.x[i], m.y[i])) continue;
    emit(m.events, EVENT_KO,
      Math.max(-10, Math.min(10, m.x[i])),
      Math.max(-5, Math.min(12, m.y[i])), 1, m.team[i], i);
    m.state.kos[m.team[i] === TEAM_GREEN ? TEAM_RED : TEAM_GREEN]++;
    if (m.stocks[i] > 0) m.stocks[i]--;
    m.slot[i] = SLOT_FREE;
    m.shake = 1;
    if (m.torneo && m.ganador < 0) {
      // El que se cayó queda eliminado y entra el siguiente de su plantilla,
      // después de un respiro para que se vea el KO. Quién entra lo resuelve
      // `relevar`, que es lo único que da de alta en torneo.
      const suyo = m.team[i];
      if (m.caidos[suyo] < FIGHTERS_PER_TEAM) m.caidos[suyo]++;
      m.relevoEn[suyo] = m.clock + RELEVO;
      if (m.caidos[suyo] >= FIGHTERS_PER_TEAM) {
        m.ganador = suyo === TEAM_GREEN ? TEAM_RED : TEAM_GREEN;
        m.ganoEn = m.clock;
      }
    }
  }

  /* --- el ultra: la barra del equipo ---------------------------------- */
  for (let team = 0; team < 2; team++) {
    // A quién le toca. Si el elegido está caído le toca al siguiente vivo, pero
    // el turno NO se pierde: el ciclo es de tres y se respeta, que es lo que
    // hace que el ultra sea previsible en vez de una lotería.
    const from = team === TEAM_GREEN ? 0 : FIGHTERS_PER_TEAM;
    let chosen = -1;
    for (let n = 0; n < FIGHTERS_PER_TEAM; n++) {
      const i = from + (m.ultraTurn[team] + n) % FIGHTERS_PER_TEAM;
      if (m.slot[i] === SLOT_ACTIVE) { chosen = i; break; }
    }

    // El que dejó de ser el elegido vuelve a su tamaño. Sin esto un peleador que
    // se cae mientras crecía reaparece gigante para siempre.
    const antes = m.growing[team];
    if (antes >= 0 && antes !== chosen) {
      m.stage[antes] = 0;
      m.scale[antes] = 1;
    }
    m.growing[team] = chosen;
    if (chosen < 0) continue;

    // El gigantismo es el DIBUJO de la barra del equipo: el elegido crece a
    // medida que se carga, así se ve venir el ultra sin leer ningún número y se
    // sabe de antemano a quién le toca.
    const stage = ultraStage(m.ultra[team]);
    if (stage > m.stage[chosen]) {
      emit(m.events, EVENT_GROW, m.x[chosen], m.y[chosen], stage, team, chosen);
    }
    m.stage[chosen] = stage;
    m.scale[chosen] = growthScale(stage);

    if (m.ultra[team] < 1) continue;
    // La barra del equipo da el DERECHO a tirar el ultra; la personal lo paga.
    // Como el elegido dejó de gastar al llegar a `ULTRA_HOLD`, para cuando la de
    // equipo se llena la suya ya está arriba del mínimo casi siempre.
    if (m.energy[chosen] < COST_SUPER) continue;

    const spent = m.energy[chosen];
    m.energy[chosen] = 0;
    m.ultra[team] = 0;
    m.ultraTurn[team] = (m.ultraTurn[team] + 1) % FIGHTERS_PER_TEAM;
    unleash(m, chosen, now, spent);
    m.stage[chosen] = 0;
    m.scale[chosen] = 1;
  }
  for (let team = 0; team < 2; team++) {
    const chosen = m.growing[team];
    m.state.charge[team] = chosen >= 0 ? m.stage[chosen] : 0;
    m.state.ultra[team] = m.ultra[team];
    m.state.ultraTurn[team] = m.ultraTurn[team];
  }

  /* --- la cola de trades: carga las barras y da de alta ---------------- */
  const greenShare = bookShare(stats.bidVolume, stats.askVolume, TEAM_GREEN);
  const redShare = bookShare(stats.bidVolume, stats.askVolume, TEAM_RED);
  //
  // Antes este bucle sacaba como mucho cuatro trades por paso y tiraba el resto:
  // un trade que llegaba con los tres slots del bando ocupados no hacía
  // absolutamente nada. Ahora TODO trade carga la barra de alguien, y el alta es
  // lo secundario. Es lo que hace que el ritmo de golpes sea el del mercado: en
  // una ráfaga de compras las barras verdes se llenan aunque no entre nadie
  // nuevo, y el bando descarga.
  let spawned = 0;
  let drained = 0;
  while (drained < MAX_TRADES_PER_STEP) {
    // Con el cupo de altas ya lleno y algún slot todavía esperando, se corta.
    // Sacar un trade de la cola sólo para cargar se lo robaría al alta del paso
    // siguiente, y un slot vacío es un peleador que falta en pantalla. Sin esta
    // guarda, seis trades de arranque daban cuatro peleadores en vez de seis:
    // el primer paso se llevaba los seis de la cola y sólo podía dar de alta a
    // cuatro. Una vez que están los seis arriba no vuelve a activarse, que es el
    // caso normal.
    if (spawned >= MAX_SPAWNS_PER_STEP
      && (freeSlot(m, TEAM_GREEN) >= 0 || freeSlot(m, TEAM_RED) >= 0)) break;

    const trade = trades.pop();
    if (trade === null) break;
    drained++;
    const team = trade.side === 'buy' ? TEAM_GREEN : TEAM_RED;
    charge(m, team, chargeFromTrade(trade.size, stats.tradeMedian));
    m.ultra[team] = addCharge(
      m.ultra[team],
      ultraGain(trade.size, stats.tradeMedian, team === TEAM_GREEN ? greenShare : redShare),
    );

    if (spawned >= MAX_SPAWNS_PER_STEP) continue;
    const slot = freeSlot(m, team);
    if (slot < 0) continue;
    spawned++;
    activate(m, slot, team, trade.size, trade.whale, stats.tradeMedian, now);
  }
  if (trades.count > CAPACITY * 6) trades.clear();

  relevar(m, stats.tradeMedian, now);
  summarize(m);
}

/**
 * Mueve los poderes en vuelo y cobra el impacto.
 *
 * El poder viaja RECTO y sin gravedad: es energía, no una piedra. Que no caiga
 * es además lo que lo hace esquivable de una sola manera —saltando o
 * agachándose de su línea—, y una regla que se entiende mirando es una regla
 * que sirve.
 *
 * El estallido sí es de área: al llegar revienta y se lleva a todo rival dentro
 * del radio. En 1v1 da lo mismo, pero en melé es lo que hace que un poder bien
 * puesto valga por dos.
 */
function moverPoderes(m: Match, dt: number, now: number): void {
  const p = m.poderes;
  for (let k = 0; k < PODERES; k++) {
    if (p.vida[k] <= 0) continue;
    p.vida[k] -= dt;

    // Persigue: busca al rival más cercano y corrige el rumbo hacia él, con el
    // giro acotado. La velocidad no cambia — sólo la dirección.
    let objetivo = -1;
    let cerca = Infinity;
    for (let j = 0; j < CAPACITY; j++) {
      if (m.slot[j] !== SLOT_ACTIVE || m.team[j] === p.team[k]) continue;
      const d = Math.hypot(m.x[j] - p.x[k], m.y[j] - p.y[k]);
      if (d < cerca) { cerca = d; objetivo = j; }
    }
    if (objetivo >= 0) {
      const rapidez = Math.hypot(p.vx[k], p.vy[k]) || PODER_VELOCIDAD;
      const quiere = Math.atan2(m.y[objetivo] - p.y[k], m.x[objetivo] - p.x[k]);
      const va = Math.atan2(p.vy[k], p.vx[k]);
      // La diferencia normalizada a [-pi, pi]: sin esto, un rival que quedó
      // apenas del otro lado del cero manda al poder a dar la vuelta larga.
      let giro = quiere - va;
      while (giro > Math.PI) giro -= Math.PI * 2;
      while (giro < -Math.PI) giro += Math.PI * 2;
      const tope = GIRO_PODER * dt;
      const nuevo = va + Math.max(-tope, Math.min(tope, giro));
      p.vx[k] = Math.cos(nuevo) * rapidez;
      p.vy[k] = Math.sin(nuevo) * rapidez;
    }

    p.x[k] += p.vx[k] * dt;
    p.y[k] += p.vy[k] * dt;

    // Se apagó en el aire o se fue del escenario: no estalla, se disuelve. Un
    // estallido en el borde de la pantalla es un fogonazo que nadie entiende.
    if (p.vida[k] <= 0 || isKO(BLAST, p.x[k], p.y[k])) {
      p.vida[k] = 0;
      continue;
    }

    let pego = false;
    for (let j = 0; j < CAPACITY; j++) {
      if (m.slot[j] !== SLOT_ACTIVE || m.team[j] === p.team[k]) continue;
      const dx = m.x[j] - p.x[k];
      const dy = m.y[j] - p.y[k];
      // Contra el CUERPO y no contra su centro: el peleador es una caja, y un
      // poder que le pasa rozando el pecho tiene que pegarle.
      if (Math.abs(dx) > FIGHTER_HALF_WIDTH + p.radio[k] * 0.5) continue;
      if (Math.abs(dy) > FIGHTER_HALF_HEIGHT + p.radio[k] * 0.5) continue;
      pego = true;
      break;
    }
    if (!pego) continue;

    const spent = p.fuerza[k];
    const radio = p.radio[k];
    const dueno = p.duenio[k];
    const pesoDelQueTira = dueno >= 0 ? m.weight[dueno] : 1;
    emit(m.events, EVENT_ESTALLIDO, p.x[k], p.y[k], spent, p.team[k], dueno);
    m.shake = Math.max(m.shake, 0.3 + spent * 0.55);
    p.vida[k] = 0;

    for (let j = 0; j < CAPACITY; j++) {
      if (m.slot[j] !== SLOT_ACTIVE || m.team[j] === p.team[k]) continue;
      const dx = m.x[j] - p.x[k];
      const dy = m.y[j] - p.y[k];
      const distance = Math.hypot(dx, dy);
      if (distance > radio) continue;
      // El empuje sale del CENTRO DEL ESTALLIDO, no del que tiró. Es la
      // diferencia que se ve: al que le pega de frente lo manda para atrás, y
      // al que lo agarra de costado lo despide para el lado.
      const nx = distance > 1e-6 ? dx / distance : 1;
      const ny = distance > 1e-6 ? dy / distance : 0;
      const falloff = 0.55 + 0.45 * (1 - distance / radio);
      const force = knockback(m.damage[j], m.weight[j], pesoDelQueTira)
        * falloff * skillForce(spent);
      m.vx[j] = nx * force * 1.15;
      m.vy[j] = ny * force * 0.3 + force * 0.5;
      m.grounded[j] = 0;
      m.damage[j] += skillDamage(spent);
      // El aturdimiento sale de la fuerza del empujón, no de una constante: es
      // lo que hace que el poder cargado se sienta distinto del que salió con la
      // barra a medias. Ver `stunFor`.
      m.hitstun[j] = now - HITSTUN + stunFor(force);
      m.lastHit[j] = now;
      emit(m.events, EVENT_HIT, m.x[j], m.y[j], 0.8 + spent * 0.9, m.team[j], j);
    }
  }
}

/**
 * En torneo, mantiene UN peleador por bando en el escenario.
 *
 * La pelea de torneo no puede depender del mercado para existir: el mercado
 * decide con qué fuerza pegan y cuándo cargan el ultra, pero un 1v1 con un solo
 * peleador no es una pelea. En melé sigue mandando el trade —ahí el alta ES la
 * visualización del flujo—, y por eso esto arranca con un `return`.
 *
 * Entra con el peso de un trade mediano a propósito: en un torneo la plantilla
 * está fijada de antemano y el tercero no puede salir enano porque justo venían
 * órdenes chicas.
 */
function relevar(m: Match, median: number, now: number): void {
  if (!m.torneo || m.ganador >= 0) return;
  for (let team = 0; team < 2; team++) {
    if (m.clock < m.relevoEn[team]) continue;
    const slot = freeSlot(m, team);
    if (slot < 0) continue;
    activate(m, slot, team, median > 0 ? median : 1, false, median, now);
  }
}

/**
 * Le pasa la carga de un trade a UN peleador del bando, por turno.
 *
 * Salta a los slots vacíos —un caído no cobra— y avanza el cursor sólo cuando
 * encontró a quién cobrarle, así con dos peleadores vivos se turnan entre esos
 * dos y no se pierde una de cada tres órdenes.
 */
function charge(m: Match, team: number, amount: number): void {
  const from = team === TEAM_GREEN ? 0 : FIGHTERS_PER_TEAM;
  for (let n = 0; n < FIGHTERS_PER_TEAM; n++) {
    const lane = (m.chargeCursor[team] + n) % FIGHTERS_PER_TEAM;
    const i = from + lane;
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    m.energy[i] = addCharge(m.energy[i], amount);
    m.chargeCursor[team] = (lane + 1) % FIGHTERS_PER_TEAM;
    return;
  }
}

/**
 * ¿Está guardando para el ultra? El elegido, con la barra del equipo pasada de
 * `ULTRA_HOLD`, no gasta ni en puños: se planta y espera el remate.
 */
function guardando(m: Match, i: number): boolean {
  const team = m.team[i];
  return m.growing[team] === i && m.ultra[team] >= ULTRA_HOLD;
}

/**
 * Cuánto tarda en entrar el siguiente de la plantilla, en segundos.
 *
 * No es cero: el KO tiene que poder verse. Con el relevo instantáneo el que se
 * cae y el que entra se pisan en el mismo cuadro y no se entiende que hubo un
 * cambio de peleador, que es justamente lo que el modo tiene para contar.
 */
const RELEVO = 0.8;

function freeSlot(m: Match, team: number): number {
  const from = team === TEAM_GREEN ? 0 : FIGHTERS_PER_TEAM;
  // Con el match terminado no entra nadie más: los trades siguen llegando
  // durante la ceremonia y sin esto el bando perdedor sacaría un cuarto
  // peleador de la nada en mitad del baile.
  if (m.ganador >= 0) return -1;
  if (m.torneo && m.caidos[team] >= FIGHTERS_PER_TEAM) return -1;
  // La pausa del relevo también vale para la cola de trades: sin esto una venta
  // que llega justo después del KO mete al siguiente en el mismo cuadro y el
  // cambio de peleador no se ve.
  if (m.torneo && m.clock < m.relevoEn[team]) return -1;
  // Hasta `m.lanes` y no hasta los tres: es acá, y sólo acá, donde se decide
  // cuántos peleadores llega a tener un bando.
  for (let i = from; i < from + m.lanes; i++) if (m.slot[i] === SLOT_FREE) return i;
  return -1;
}


function activate(
  m: Match, slot: number, team: number,
  size: number, whale: boolean, median: number, now: number,
): void {
  // En melé `m.character[slot]` no se toca: lo fijó `createMatch` y reactivar un
  // slot es devolverle al MISMO peleador que se cayó, porque no hay relevos.
  //
  // En torneo sí cambia, y es el corazón del modo: el carril es uno solo por
  // bando, así que quién entra por él es quién sigue en la plantilla. Por eso
  // `character` siguió siendo un array por slot y no una constante.
  if (m.torneo) m.character[slot] = m.caidos[team] % FIGHTERS_PER_TEAM;
  const weight = weightFor(size, median, whale);
  m.weight[slot] = weight;
  m.damage[slot] = 0;
  m.stocks[slot] = STOCKS;
  m.jumps[slot] = MAX_JUMPS;
  m.lastJump[slot] = now;
  m.lastHit[slot] = now;
  m.hitstun[slot] = -10;
  m.whale[slot] = whale ? 1 : 0;
  m.stage[slot] = 0;
  m.scale[slot] = 1;
  m.lastSkill[slot] = 1;
  // La barra arranca vacía: un peleador que acaba de entrar todavía no tiene
  // órdenes atrás. Las primeras que lleguen de su lado se la cargan.
  m.energy[slot] = 0;

  // Repartidos por carril: los tres apareciendo en el mismo punto caen uno
  // encima del otro y arrancan la pelea amontonados.
  const lane = slot % FIGHTERS_PER_TEAM;
  m.x[slot] = (team === TEAM_GREEN ? -1 : 1) * (SPAWN_X - lane * 1.7);
  m.y[slot] = SPAWN_Y + lane * 0.8;
  m.vx[slot] = 0;
  m.vy[slot] = 0;
  m.facing[slot] = team === TEAM_GREEN ? 1 : -1;
  m.grounded[slot] = 0;
  m.slot[slot] = SLOT_ACTIVE;
}

/**
 * El super del gigantismo. No usa el knockback normal a propósito: tiene que
 * sacar del escenario aunque el rival esté con 0% de daño, o el gigantismo es
 * sólo un personaje más grande.
 */
function unleash(m: Match, self: number, now: number, spent: number): void {
  // Lo que se gastó gradúa el remate: al mínimo pega poco más que el super de
  // antes, con la barra llena pega un tercio más.
  const power = 0.6 + spent * 0.7;
  emit(m.events, EVENT_SUPER, m.x[self], m.y[self], SUPER_RADIUS, m.team[self], self);
  m.shake = 1;
  for (let i = 0; i < CAPACITY; i++) {
    if (i === self || m.slot[i] !== SLOT_ACTIVE || m.team[i] === m.team[self]) continue;
    const dx = m.x[i] - m.x[self];
    const dy = m.y[i] - m.y[self];
    const distance = Math.hypot(dx, dy);
    if (distance > SUPER_RADIUS) continue;
    const force = superForce(distance) * power;
    const nx = distance > 1e-6 ? dx / distance : 1;
    const ny = distance > 1e-6 ? dy / distance : 0;
    m.vx[i] = nx * force * 1.3;
    m.vy[i] = ny * force * 0.4 + force * 0.55;
    m.grounded[i] = 0;
    m.damage[i] += SUPER_DAMAGE * power;
    m.hitstun[i] = now - HITSTUN + stunFor(force);
    m.lastHit[i] = now;
    emit(m.events, EVENT_HIT, m.x[i], m.y[i], 1.4, m.team[i], i);
  }
}

/**
 * El final del match: los tres del bando ganador parados en el centro.
 *
 * Se hace desde la simulación y no sólo desde el dibujo porque los cuerpos ya
 * existen por slot y `relieve` ya sabe cambiarlos cuando cambia el personaje.
 * Activar los tres slots del ganador es todo lo que hace falta para que los tres
 * aparezcan; el baile lo compone la capa de render, que es la que ya mueve
 * escala y rotación.
 */
function ceremonia(m: Match): void {
  const gana = m.ganador === TEAM_GREEN ? 0 : FIGHTERS_PER_TEAM;
  const pierde = m.ganador === TEAM_GREEN ? FIGHTERS_PER_TEAM : 0;
  const piso = m.skyline.topY[0] + FIGHTER_HALF_HEIGHT;
  for (let n = 0; n < FIGHTERS_PER_TEAM; n++) {
    const i = gana + n;
    m.character[i] = n;
    m.slot[i] = SLOT_ACTIVE;
    m.x[i] = (n - 1) * 1.7;
    m.y[i] = piso;
    m.vx[i] = 0;
    m.vy[i] = 0;
    m.grounded[i] = 1;
    m.damage[i] = 0;
    m.scale[i] = 1;
    m.stage[i] = 0;
    m.whale[i] = 0;
    m.hitstun[i] = -10;
    // Mirándose entre ellos y no los tres al mismo lado: tres muñecos de perfil
    // en fila parecen una cola, no un festejo.
    m.facing[i] = n === FIGHTERS_PER_TEAM - 1 ? -1 : 1;
    m.slot[pierde + n] = SLOT_FREE;
  }
}

/**
 * Fija qué personaje pelea por cada bando y no lo suelta.
 *
 * Es el modo de trabajo: con seis peleadores rotando, probar un cambio en UNO
 * es esperar a que le toque. Acá salen siempre los dos elegidos, y como va sobre
 * la melé de un carril el que se cae vuelve él mismo en vez de ser reemplazado.
 *
 * El índice es dentro de la plantilla de SU bando, que es lo que guarda
 * `m.character`. Ver `characterFor` en roster.ts.
 */
export function fijarDuo(m: Match, verde: number, rojo: number): void {
  m.character[0] = verde % FIGHTERS_PER_TEAM;
  m.character[FIGHTERS_PER_TEAM] = rojo % FIGHTERS_PER_TEAM;
}

/** Vuelve a empezar. */
function reiniciar(m: Match): void {
  for (let i = 0; i < CAPACITY; i++) {
    m.slot[i] = SLOT_FREE;
    m.damage[i] = 0;
    m.stocks[i] = STOCKS;
    m.stage[i] = 0;
    m.scale[i] = 1;
    m.whale[i] = 0;
    m.energy[i] = 0;
    m.character[i] = i % FIGHTERS_PER_TEAM;
  }
  // Los poderes que estaban viajando se apagan: si no, el primer cuadro del
  // match nuevo trae una bola de energía cruzando de un match que ya terminó.
  m.poderes.vida.fill(0);
  m.caidos[0] = 0;
  m.caidos[1] = 0;
  m.relevoEn[0] = 0;
  m.relevoEn[1] = 0;
  m.ganador = -1;
  m.state.kos[0] = 0;
  m.state.kos[1] = 0;
  m.ultra[0] = 0;
  m.ultra[1] = 0;
  m.ultraTurn[0] = 0;
  m.ultraTurn[1] = 0;
  m.growing[0] = -1;
  m.growing[1] = -1;
}

function summarize(m: Match): void {
  // Acá y no en `stepMatch`: el KO que termina el match se cobra al final del
  // paso, así que escribirlo arriba lo publicaba un cuadro tarde y el título
  // salía después del golpe que lo causó.
  m.state.ganador = m.ganador;
  m.state.torneo = m.torneo;
  for (let team = 0; team < 2; team++) {
    const from = team === TEAM_GREEN ? 0 : FIGHTERS_PER_TEAM;
    let damage = 0;
    let alive = 0;
    let stocks = 0;
    for (let i = from; i < from + FIGHTERS_PER_TEAM; i++) {
      stocks += m.stocks[i];
      if (m.slot[i] !== SLOT_ACTIVE) continue;
      damage += m.damage[i];
      alive++;
    }
    m.state.damage[team] = alive > 0 ? damage / alive : 0;
    m.state.alive[team] = alive;
    m.state.stocks[team] = stocks;
    // Cuántos le quedan al bando. En torneo son los que todavía no cayeron; en
    // melé, los que están en el escenario. Es lo que dibujan los puntitos del
    // marcador, y en torneo `alive` no sirve: siempre vale 1 o 0.
    m.state.plantel[team] = m.torneo
      ? FIGHTERS_PER_TEAM - Math.min(FIGHTERS_PER_TEAM, m.caidos[team])
      : alive;
  }
}
