import type { FeedStats, TradeRingBuffer } from '../net/feedCore';
import type { MatchState, Skyline } from './fighters';
import { characterFor } from './roster';
import {
  ACCION_ACERCAR,
  ACCION_ESPECIAL,
  ACCION_RETIRAR,
  ACCION_SUPER,
  COMBO_CHAINS,
  COMBO_FINISHER_MULT,
  COMBO_WINDOW,
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
  chargeFromTrade,
  createMatchState,
  createSkyline,
  hasGroundAhead,
  hitDamage,
  isKO,
  knockback,
  momentumBoost,
  pickTarget,
  planear,
  separation,
  shouldBrakeAtLedge,
  shouldBrakeToTurn,
  skillDamage,
  skillForce,
  stunFor,
  skillRadius,
  superForce,
  teamMomentum,
  wantsJump,
} from './fighters';
import type { PlanContext } from './fighters';
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
/**
 * Enfriamiento del super, aparte de lo que tarda en recargarse la barra.
 *
 * Sin esto, con el mercado a mil la barra vuelve a llenarse casi al toque de
 * descargarla y el super gana SIEMPRE por sobre la especial (ver el
 * comentario de `superEnfriando` en `fighters.ts`) — medido con un mercado
 * agitado sintético: 0 especiales en 20 partidos enteros, todo remate. Más
 * largo que `SKILL_COOLDOWN` a propósito: el super es la excepción, no la
 * rutina.
 */
const SUPER_COOLDOWN = 6;
/**
 * Cada cuánto se vuelve a evaluar el plan (`planear` en fighters.ts), en
 * segundos de simulación. Evaluarlo cada cuadro sería carísimo para seis
 * unidades a 60 fps y además se vería nervioso -- un peleador cambiando de
 * plan constantemente no se lee como una decisión, se lee como un tic.
 */
const REPLAN_INTERVAL = 0.4;
const CONTACT = 0.85;
/**
 * Distancia de guardia. Apenas menor que `CONTACT` para que el cuerpo a cuerpo
 * siga saltando: si fuera mayor se quedarían mirándose sin llegar a pegarse.
 */
const ENGAGE_RANGE = 0.7;
/**
 * A qué distancia se vuelve a SALIR de combate.
 *
 * Que entrar y salir tengan umbrales distintos —histéresis— no es un lujo: con
 * un umbral solo, un peleador parado justo en el borde alterna entre "cerrar
 * distancia" y "pelear acá" en cuadros consecutivos, y son dos velocidades
 * distintas. El resultado era un peleador vibrando en el lugar, y como el
 * dibujo se espejea según el signo de la velocidad, además parpadeaba mirando
 * a un lado y al otro. Es el ruido que se veía en los movimientos.
 *
 * **Bajó de 1,35 a 0,95.** Con 1,35 "enganchado" significaba cualquier cosa
 * entre 0,85 (`CONTACT`) y 1,35: medio cuerpo de aire donde el peleador ya
 * dejó de cerrar —`closing` se apaga acá— pero todavía no llegó a golpear. Sin
 * un compañero cerca que lo empuje (`spread` en `separation`, que es lo único
 * que lo mueve una vez enganchado) esa franja no tiene NINGUNA fuerza que lo
 * saque: se queda plantado a centímetros de pegar y no pega nunca. En 3v3 casi
 * no se notaba —siempre hay un tercero empujando— pero el torneo 1v1, que es
 * el modo por defecto, se queda con exactamente dos peleadores en la mitad
 * del match: confirmado con un 1 contra 1 aislado que se trababa así a los 9
 * golpes y no volvía a conectar en 150 s simulados. Con 0,95 la franja mide
 * un décimo de unidad en vez de medio cuerpo, y "enganchado" es casi
 * literalmente "a distancia de golpe".
 */
const DISENGAGE_RANGE = 0.95;
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
 * Cuánto tiene que pasar entre una vuelta y la siguiente. El que está
 * peleando ni siquiera mira su velocidad: mira a su rival, que es lo que hace
 * un peleador.
 */
const TURN_COOLDOWN = 0.4;
/**
 * Por debajo de esta velocidad se considera "frenado" y puede dar la vuelta.
 * Ver `shouldBrakeToTurn`: sin este freno `vx` cruzaba al signo nuevo antes de
 * que `TURN_COOLDOWN` dejara girar el dibujo, y el peleador caminaba para
 * atrás. Chica a propósito: frenar y girar son dos pasos separados, no el
 * mismo umbral leído dos veces.
 */
const TURN_BRAKE_SPEED = 0.3;
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
/**
 * El goteo que mantiene enganchados a dos peleadores sin compañeros cerca.
 *
 * El forcejeo (`MELEE_NUDGE`, más abajo) empuja para AFUERA todo el tiempo que
 * dura el contacto, y no tiene freno propio: nada tira para adentro salvo
 * `spread`, que sale de `separation()` y mide distancia a los DEL PROPIO
 * equipo. Sin un compañero cerca —el 1v1 del torneo, que es el modo por
 * defecto, se queda con exactamente dos peleadores en la mitad de cada
 * match— `spread` da cero, y con `desired` en cero el forcejeo tiene vía
 * libre: empuja hasta juntito afuera de `CONTACT` y ahí se queda, sin nada
 * que lo vuelva a acercar. Confirmado con un 1 contra 1 aislado que se
 * trababa así a los pocos golpes y no volvía a conectar en 150 s simulados.
 *
 * Chico a propósito —una fracción de `RUN_SPEED`, no un cierre de distancia
 * de verdad— para no reabrir el vaivén que resuelve la histéresis de
 * `ENGAGE_RANGE`/`DISENGAGE_RANGE`: alcanza para ganarle al margen de
 * `MELEE_NUDGE`, no para correr hacia el rival.
 */
const HOLD_PULL = 0.08;
/** Polvo mínimo de un aterrizaje, y a qué velocidad de caída se satura. */
const LANDING_SOFT = 0.35;
const LANDING_FULL = 18;
const SPAWN_Y = 8;
const SPAWN_X = 5.5;
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
 * Alguien entra al escenario, propio o del torneo. `x`/`y` es dónde cae.
 *
 * Sin esto el peleador que releva aparecía de la nada: un cuadro no hay nadie
 * de ese bando, al siguiente hay un cuerpo entero parado. Servía para que el
 * hueco del relevo se leyera como "no hay nadie" y no como "algo se rompió",
 * pero la entrada en sí no tenía ningún efecto que la anunciara.
 */
export const EVENT_ENTRA = 9;

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
  /** Cuándo tiró su último super. Ver `SUPER_COOLDOWN`. */
  lastSuperAt: Float32Array;
  /**
   * El plan vigente (`ACCION_*` en fighters.ts) y cuándo se decidió.
   * `REPLAN_INTERVAL` marca cada cuánto se vuelve a evaluar — no cada
   * cuadro, sería carísimo para seis unidades a 60 fps y además se vería
   * nervioso. Entre una replanificación y la siguiente, el bloque de
   * movimiento ejecuta el plan con las mismas primitivas de siempre.
   */
  plan: Uint8Array;
  lastPlan: Float32Array;
  hitstun: Float32Array;
  whale: Uint8Array;
  /**
   * Tamaño visual, 1 siempre. Quedó del gigantismo (ver el pivot de
   * 2026-08-23 en CLAUDE.md, que lo sacó); el array sobrevive porque el
   * render y `physicsStep` ya lo multiplican al tamaño del cuerpo, y tocar
   * esas dos lecturas no valía el riesgo por sacar un `* 1`.
   */
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
  /** Golpe o patada: sale de la cadena de combo activa. Ver `nextBlow`. */
  lastBlow: Uint8Array;
  /** En qué paso de `COMBO_CHAINS[comboChain[i]]` está. Ver `nextBlow`. */
  comboStep: Uint8Array;
  /** Qué cadena de `COMBO_CHAINS` le toca. Rota cada vez que arranca una nueva. */
  comboChain: Uint8Array;

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
    lastSuperAt: new Float32Array(CAPACITY),
    plan: new Uint8Array(CAPACITY).fill(ACCION_ACERCAR),
    lastPlan: new Float32Array(CAPACITY),
    hitstun: new Float32Array(CAPACITY),
    whale: new Uint8Array(CAPACITY),
    scale: new Float32Array(CAPACITY).fill(1),
    claims: new Uint8Array(CAPACITY),
    energy: new Float32Array(CAPACITY),
    lastSkill: new Uint8Array(CAPACITY),
    lastBlow: new Uint8Array(CAPACITY),
    comboStep: new Uint8Array(CAPACITY),
    // Arranca repartido y no todos en la cadena 0: si los seis empezaran
    // sincronizados, el primer intercambio de cada uno se ve idéntico.
    comboChain: Uint8Array.from({ length: CAPACITY }, (_, i) => i % COMBO_CHAINS.length),
    chargeCursor: new Int8Array(2),
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

      // **El plan.** Se re-evalúa cada `REPLAN_INTERVAL`, no cada cuadro (ver
      // su comentario) — entre una vuelta y la siguiente, el peleador sigue
      // ejecutando lo último que decidió. Sin rival no hay nada que planear:
      // se cae de vuelta en ACERCAR, que con `target < 0` ya vale "caminar
      // hacia el centro" más abajo, en `desired`.
      if (target >= 0 && now - m.lastPlan[i] >= REPLAN_INTERVAL) {
        const ctx: PlanContext = {
          distancia: Math.abs(dx),
          energia: m.energy[i],
          alcance: ALCANCE,
          cercaDelBorde: !hasGroundAhead(m.skyline, m.x[i], -dir, LOOKAHEAD),
          dañoPropio: m.damage[i],
          dañoRival: m.damage[target],
          superEnfriando: now - m.lastSuperAt[i] < SUPER_COOLDOWN,
        };
        const ctxRival: PlanContext = {
          distancia: ctx.distancia,
          energia: m.energy[target],
          alcance: ALCANCE,
          cercaDelBorde: !hasGroundAhead(m.skyline, m.x[target], dir, LOOKAHEAD),
          dañoPropio: m.damage[target],
          dañoRival: m.damage[i],
          superEnfriando: now - m.lastSuperAt[target] < SUPER_COOLDOWN,
        };
        m.plan[i] = planear(ctx, ctxRival);
        m.lastPlan[i] = now;
      } else if (target < 0) {
        m.plan[i] = ACCION_ACERCAR;
      }

      // Ejecutar el plan con energía DE AHORA, no la de cuando se planeó: si
      // ya se gastó la barra en este mismo paso (ver el bucle de especiales
      // más abajo, que corre después) o el enfriamiento no dejó, `aTiro`
      // tiene que apagarse aunque el plan siga diciendo ESPECIAL hasta la
      // próxima vuelta. Mismo criterio para el super.
      const aTiro = m.plan[i] === ACCION_ESPECIAL && target >= 0
        && m.energy[i] >= COST_SKILL && Math.abs(dx) <= ALCANCE * 0.8;
      const tirandoSuper = m.plan[i] === ACCION_SUPER && m.energy[i] >= COST_SUPER;
      // Con el super listo tampoco se acerca ni tira la especial: se planta
      // igual que `aTiro`, sólo que a esperar su propio turno de descargarlo
      // (ver el bloque del super, más abajo).
      const retirando = m.plan[i] === ACCION_RETIRAR;
      const moveDir = retirando ? -dir : dir;
      const closing = m.plan[i] === ACCION_ACERCAR && Math.abs(dx) > rango;
      m.engaged[i] = closing ? 0 : 1;
      // Frena antes de girar en vez de acelerar para el otro lado ya: sin esto
      // `vx` cruzaba al signo nuevo antes de que `TURN_COOLDOWN` dejara girar
      // el dibujo, y el que estaba yendo a algún lado se veía caminando para
      // atrás. Sólo aplica fuera del cuerpo a cuerpo -- ver el comentario de
      // `mira`, ahí la mirada ya no sigue a `vx`.
      const turning = m.engaged[i] !== 1
        && shouldBrakeToTurn(m.vx[i], m.facing[i], moveDir, TURN_BRAKE_SPEED);
      const desired = brake || turning ? 0
        : closing ? (moveDir + spread * 0.5) * RUN_SPEED * boost
          : (spread * SPACING_GAIN + moveDir * HOLD_PULL) * RUN_SPEED;

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
      // El que está yendo hacia algún lado mira hacia donde va, pero recién
      // cuando ya frenó (ver `turning` arriba) y con un tiempo mínimo entre
      // vueltas -- así el giro del dibujo nunca llega después que la velocidad.
      const mira = m.engaged[i] === 1 && target >= 0
        ? (Math.abs(dx) > FACE_DEADZONE ? dir : m.facing[i])
        : Math.abs(m.vx[i]) <= TURN_BRAKE_SPEED ? moveDir
          : m.facing[i];
      if (mira !== m.facing[i] && now - m.lastTurn[i] >= TURN_COOLDOWN) {
        m.facing[i] = mira;
        m.lastTurn[i] = now;
      }

      // El que está por tirar (especial o super) tampoco salta: el poder
      // viaja recto y en el aire no se puede corregir la puntería, y el
      // super pierde alcance si sale de un salto a medias.
      const jump = !aTiro && !tirandoSuper
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

  /* --- super: lo dispara el plan, no un umbral suelto ------------------- */
  // Ya no depende del gigantismo por turnos de equipo (sacado con el pivot
  // de 2026-08-23, ver CLAUDE.md). La primera versión de esto disparaba
  // apenas `energy >= COST_SUPER`, sin mirar nada más, y el resultado fue un
  // super cada vez que la barra cruzaba 0,6 -- bastaba UN trade grande --
  // sin dejar pasar nunca ni una especial ni un golpe. `planear` es lo que
  // arregla eso: sólo elige `ACCION_SUPER` cuando el puntaje le gana a
  // acercarse, sostener o tirar la especial, así que dispara cuando
  // conviene y no en cuanto es posible.
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    if (m.plan[i] !== ACCION_SUPER) continue;
    if (m.energy[i] < COST_SUPER) continue;
    if (now - m.hitstun[i] < HITSTUN) continue;
    if (now - m.lastSuperAt[i] < SUPER_COOLDOWN) continue;
    const spent = m.energy[i];
    m.energy[i] = 0;
    m.lastSuperAt[i] = now;
    unleash(m, i, now, spent);
  }

  /* --- especiales: las dispara el plan, se pagan con la barra ---------- */
  for (let i = 0; i < CAPACITY; i++) {
    if (m.slot[i] !== SLOT_ACTIVE) continue;
    if (m.plan[i] !== ACCION_ESPECIAL) continue;
    if (m.energy[i] < COST_SKILL) continue;
    if (now - m.hitstun[i] < HITSTUN) continue;
    if (now - m.lastSkillAt[i] < SKILL_COOLDOWN) continue;

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

      // El FORCEJEO —separarse— es gratis y pasa todos los cuadros, conecte o
      // no un golpe: dos cuerpos no pueden ocupar el mismo lugar, y empujar no
      // es pegar. Es además lo único que queda pasando cuando el libro está
      // muerto y nadie tiene con qué golpear. El lanzamiento de verdad, más
      // abajo (`golpeaI`/`golpeaJ`), sólo pasa si el golpe conecta.
      const empuje = nx * MELEE_NUDGE * dt;
      m.vx[j] += empuje;
      m.vx[i] -= empuje;

      if (now - m.lastHit[i] < HIT_COOLDOWN || now - m.lastHit[j] < HIT_COOLDOWN) continue;

      // El GOLPE, en cambio, es incondicional: el cuerpo a cuerpo ya no
      // depende de la barra de mercado (ver el pivot de 2026-08-23 en
      // CLAUDE.md) — sólo especiales y super la gastan. Los dos siempre
      // conectan si llegaron al cooldown.

      // Cuánto pasó desde el último golpe CONECTADO de cada uno, antes de pisar
      // `lastHit` — es lo que decide si la cadena de combo sigue o se cortó.
      // Ver `nextBlow`.
      const sinceI = now - m.lastHit[i];
      const sinceJ = now - m.lastHit[j];

      // Recién acá se gasta el turno: el reloj del cuerpo a cuerpo lo mueve un
      // golpe que existió, no un roce.
      m.lastHit[i] = now;
      m.lastHit[j] = now;

      // Cada uno tira su golpe, siguiendo su cadena de combo (`nextBlow`). El
      // empuje sale de la MISMA fórmula que especiales y super —`knockback` +
      // `stunFor`, la regla de Smash ya declarada en CLAUDE.md— y no de un
      // aturdimiento fijo como antes.
      //
      // El cuerpo a cuerpo no lanzaba a propósito: para eso estaban las
      // especiales y el super, y que el golpe chico no lance es lo que hace
      // que el daño acumulado signifique algo. La fórmula de `knockback` ya
      // está pensada para esto: al principio (`BASE_KNOCKBACK`) empuja poco,
      // y recién con daño acumulado empuja fuerte — el mismo "golpe chico no
      // lanza" de antes, pero ganado con números en vez de con un bando
      // aparte del sistema.
      {
        const { blow, esFinisher } = nextBlow(m, i, sinceI);
        m.lastBlow[i] = blow;
        const force = knockback(m.damage[j], m.weight[j], m.weight[i]);
        m.vx[j] = nx * force;
        m.vy[j] = force * 0.5;
        m.grounded[j] = 0;
        m.damage[j] += hitDamage(m.weight[i], blow === 1) * (esFinisher ? COMBO_FINISHER_MULT : 1);
        m.hitstun[j] = now - HITSTUN + stunFor(force);
        emit(m.events, EVENT_MELEE, m.x[i], m.y[i], m.lastBlow[i], m.team[i], i);
      }
      {
        const { blow, esFinisher } = nextBlow(m, j, sinceJ);
        m.lastBlow[j] = blow;
        const force = knockback(m.damage[i], m.weight[i], m.weight[j]);
        m.vx[i] = -nx * force;
        m.vy[i] = force * 0.5;
        m.grounded[i] = 0;
        m.damage[i] += hitDamage(m.weight[j], blow === 1) * (esFinisher ? COMBO_FINISHER_MULT : 1);
        m.hitstun[i] = now - HITSTUN + stunFor(force);
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
      const heavy = m.whale[i] === 1 || m.whale[j] === 1;
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

  /* --- la cola de trades: carga la barra personal ----------------------- */
  //
  // Desde el pivot de 2026-08-23 (ver CLAUDE.md) el mercado sólo carga la
  // barra que habilita especiales y super — ya no da de alta a nadie ni
  // decide el peso. Quién está en cancha lo resuelve `relevar`, más abajo,
  // sin mirar el feed en absoluto.
  let drained = 0;
  while (drained < MAX_TRADES_PER_STEP) {
    const trade = trades.pop();
    if (trade === null) break;
    drained++;
    const team = trade.side === 'buy' ? TEAM_GREEN : TEAM_RED;
    charge(m, team, chargeFromTrade(trade.size, stats.tradeMedian));
  }
  if (trades.count > CAPACITY * 6) trades.clear();

  relevar(m, now);
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
 * Mantiene la cancha llena, sin mirar el mercado para nada.
 *
 * Desde el pivot de 2026-08-23 (ver CLAUDE.md) la pelea no depende del mercado
 * para existir: quién está en cancha lo decide `freeSlot` —el torneo respeta
 * `relevoEn`/`caidos`, el melé simplemente llena los `lanes` que tenga— y acá
 * sólo se activa a quien corresponda apenas hay un slot libre. Antes esto
 * dependía de que llegara un trade puntual; con `activate` ya sin `size`,
 * `whale` ni `median` —el peso es fijo por personaje— no hace falta esperar
 * nada del feed.
 */
function relevar(m: Match, now: number): void {
  if (m.ganador >= 0) return;
  for (let team = 0; team < 2; team++) {
    const slot = freeSlot(m, team);
    if (slot < 0) continue;
    activate(m, slot, team, now);
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
 * Qué golpe sale y si es el finisher, según la cadena de combo de `i`.
 *
 * Si pasó más de `COMBO_WINDOW` desde el último golpe que conectó (`sinceLast`,
 * calculado ANTES de pisar `lastHit`), la cadena se cortó: arranca una nueva
 * —rotando cuál, para no repetir siempre la misma— desde el paso 0.
 */
function nextBlow(m: Match, i: number, sinceLast: number): { blow: number; esFinisher: boolean } {
  if (sinceLast > COMBO_WINDOW) {
    m.comboChain[i] = (m.comboChain[i] + 1) % COMBO_CHAINS.length;
    m.comboStep[i] = 0;
  }
  const chain = COMBO_CHAINS[m.comboChain[i]];
  const step = m.comboStep[i];
  m.comboStep[i] = (step + 1) % chain.length;
  return { blow: chain[step], esFinisher: step === chain.length - 1 };
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


function activate(m: Match, slot: number, team: number, now: number): void {
  // En melé `m.character[slot]` no se toca: lo fijó `createMatch` y reactivar un
  // slot es devolverle al MISMO peleador que se cayó, porque no hay relevos.
  //
  // En torneo sí cambia, y es el corazón del modo: el carril es uno solo por
  // bando, así que quién entra por él es quién sigue en la plantilla. Por eso
  // `character` siguió siendo un array por slot y no una constante.
  if (m.torneo) m.character[slot] = m.caidos[team] % FIGHTERS_PER_TEAM;
  // El peso es un stat fijo por personaje (ver `ROSTER[].weight`), no algo
  // que trae el trade que lo hizo entrar — desde el pivot de 2026-08-23 (ver
  // CLAUDE.md) el mercado ya no decide quién aparece ni cuánto pesa.
  m.weight[slot] = characterFor(team, m.character[slot]).weight;
  m.damage[slot] = 0;
  m.stocks[slot] = STOCKS;
  m.jumps[slot] = MAX_JUMPS;
  m.lastJump[slot] = now;
  m.lastHit[slot] = now;
  m.hitstun[slot] = -10;
  m.whale[slot] = 0;
  m.lastSkill[slot] = 1;
  // La barra arranca vacía: un peleador que acaba de entrar todavía no tiene
  // órdenes atrás. Las primeras que lleguen de su lado se la cargan.
  m.energy[slot] = 0;
  // Sin plan heredado del que ocupaba el slot antes: entra a acercarse, y
  // que decida de nuevo apenas tenga rival.
  m.plan[slot] = ACCION_ACERCAR;
  m.lastPlan[slot] = 0;

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
  emit(m.events, EVENT_ENTRA, m.x[slot], m.y[slot], 0, team, slot);
}

/**
 * El super. No usa el knockback normal a propósito: tiene que sacar del
 * escenario aunque el rival esté con 0% de daño, o no se distingue de un
 * empujón cualquiera. Lo dispara `planear` (Fase 2, ver CLAUDE.md) al elegir
 * `ACCION_SUPER`, no un umbral suelto -- ver el bloque "super" en `stepMatch`.
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
