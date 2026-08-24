import { Application, Assets, Container, Graphics, Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters/advanced-bloom';
import { ShockwaveFilter } from 'pixi-filters/shockwave';
import type { Match } from '../game/match';
import {
  EVENT_ENTRA,
  EVENT_ESCUDO,
  EVENT_ESQUIVAR,
  EVENT_ESTALLIDO,
  EVENT_HIT,
  EVENT_KO,
  EVENT_LAND,
  EVENT_MELEE,
  EVENT_SALTO,
  EVENT_SKILL,
  EVENT_SUPER,
  FIGHTER_HALF_HEIGHT,
  HITSTUN,
  PODERES,
  PODER_VIDA,
  PLATFORM_COUNT,
  STAGE_HALF_WIDTH,
  platformCenterX,
  platformHalfWidth,
  stepMatch,
} from '../game/match';
import { COST_SUPER, SLOT_ACTIVE, TEAM_GREEN } from '../game/fighters';
import type { BinanceFeedClient } from '../net/feedCore';
import { createFighterView } from '../art/fighter';
import type { FighterView } from '../art/fighter';
import {
  ACTION_HIT,
  ACTION_TIME,
  ACT_KICK,
  ACT_NONE,
  ACT_PUNCH,
  ACT_SKILL,
  ACT_SUPER,
} from '../art/fighter';
import { lookFor } from '../art/looks';
import { loadArt, unloadArt } from '../art/loadArt';
import type { FighterArt } from '../art/loadArt';
import { loadSheets, unloadSheets } from '../art/loadSheets';
import type { FighterSheets } from '../art/loadSheets';
import { UMBRAL_GIRO_FRENTE, createSpriteFighterView } from '../art/spriteFighter';
import { ROSTER, characterFor } from '../game/roster';
import { detectLowQuality } from '../quality';
import {
  burst, createFx, drawFx, dust, flash, impact, slash,
  trail, updateFx, wave,
} from './fx';
import { createBackdrop } from './backdrop';
import { createEnergyField } from './energyField';
import { createStarfield } from './starfield';
import { createStage, loadPlatforms, loadStage, stageNames, stageTint } from './stage';
import type { StagePlatforms } from './stage';
import { loadVfxTexturas } from './loadVfx';
import { createVfxSprites } from './vfxSprites';

/**
 * La capa que dibuja. Lee el estado de la simulación y lo pinta; no decide nada.
 *
 * En Pixi el eje Y crece hacia ABAJO y en el mundo del juego crece hacia
 * arriba, así que todo lo que se coloca lleva la Y negada. Se hace acá y en un
 * solo lugar: mezclar los dos criterios es la forma más rápida de terminar con
 * un escenario dado vuelta y no entender por qué.
 *
 * Orden de las capas, de atrás hacia adelante:
 *
 *   backdrop  hogueras y cielo, en coordenadas de PANTALLA
 *   world     escenario, peleadores y polvo, en coordenadas de MUNDO
 *   glow      chispas, anillos y auras — la única capa con Bloom
 *
 * El Bloom va sobre `glow` y no sobre la escena entera a propósito. Aplicado a
 * todo, lava los contornos negros, que son la mitad de este estilo; aplicado
 * sólo a lo que tiene que brillar, el resto queda limpio y además cuesta una
 * pasada sobre una capa casi vacía en vez de sobre la pantalla completa.
 */

const GREEN = 0x00ff66;
const RED = 0xff0055;
/**
 * Grosor DIBUJADO de las losas: la central y las ocho laterales.
 *
 * Es sólo visual. La física trata las plataformas como una línea —`topY`, de
 * una vía— y no mira el espesor, así que esto se puede mover libremente para
 * que el dibujo cierre.
 *
 * Las laterales bajaron de 0,55 a 0,25 al mirar capturas de Brawlhalla, que es
 * la referencia visual del proyecto: ahí las plataformas flotantes son TABLONES
 * finos, no bloques. Con 0,55 la losa lateral daba una proporción de 1,4 —casi
 * cuadrada—, que no se lee como plataforma de un juego de peleas. Con 0,25 da
 * 2,5, que además es la proporción con la que salió el arte y evita estirarlo.
 */
const PLATFORM_THICK_CENTER = 0.9;
const PLATFORM_THICK_SIDE = 0.25;

const PLATFORM_TOP = 0xe8f1ff;
const PLATFORM_FACE = 0x5a6d92;
const PLATFORM_SHADE = 0x2b3552;

/** Paso fijo de simulación. La física no depende de los fps del monitor. */
const FIXED_DT = 1 / 60;

/**
 * A qué velocidad corre la pelea respecto del reloj de pared. En 0,5 va a la
 * mitad.
 *
 * **No se toca `FIXED_DT`.** El paso de simulación sigue siendo 1/60: todas las
 * constantes de física —gravedad, impulsos, umbrales de knockback— están
 * calibradas contra ese paso, y agrandarlo las invalida a todas de una. Lo que
 * se escala es cuánto tiempo ENTRA al acumulador, así que la pelea da la mitad
 * de pasos por segundo y se ve a la mitad de velocidad con la misma física.
 *
 * El reloj de dibujo se escala igual, para que la respiración del quieto y las
 * chispas no vayan al doble que los cuerpos. La cámara NO: sigue amortiguando
 * en tiempo real, porque una cámara a media velocidad se siente pesada aunque
 * lo que persigue vaya lento.
 *
 * **Por qué 0,72 y no 0,5 ni 1.** A velocidad entera no se llegaba a ver quién
 * pegaba a quién. A la mitad sí se ve, pero el super pasa a durar un segundo y
 * medio y la pelea se arrastra. 0,72 es el punto donde una acción de tres
 * dibujos —0,45 s de habilidad— dura 0,63 s: alcanza para leer los tres cuadros
 * y no alcanza para aburrir. Se prueba otro con `?ritmo=`.
 */
const RITMO = 0.72;
/** Tope de pasos por frame: tras un hipo, se pierde tiempo antes que congelar. */
const MAX_STEPS = 5;

/* --- hitstop --------------------------------------------------------- */

/**
 * Congelar la simulación unas decenas de milisegundos en el impacto es el
 * recurso más barato que existe para que un golpe se sienta: el ojo lee la
 * pausa como peso. Los efectos NO se congelan — siguen corriendo — así que la
 * pantalla no parece trabada, sólo el intercambio.
 *
 * Con Rapier esto era imposible sin romper un invariante: `paused` de
 * `<Physics>` era estado de React y tocarlo por cada golpe metía un setter en el
 * camino de datos. Con el bucle de paso fijo propio es una resta.
 */
const HITSTOP_SKILL = 0.06;
const HITSTOP_SUPER = 0.1;
const HITSTOP_KO = 0.12;
/** Techo: encadenar golpes no puede dejar la pelea detenida. */
const HITSTOP_MAX = 0.14;

/* --- cámara --------------------------------------------------------- */

/**
 * Cuánto mundo entra en la pantalla, de ancho, en unidades.
 *
 * Estos dos números son lo que decide **el tamaño aparente del personaje**, que
 * es la diferencia más grande contra Brawlhalla (ver
 * docs/REFERENCIA-BRAWLHALLA.md). Ahí el personaje ocupa cerca del 19% del alto
 * del cuadro; acá ocupaba el 5,5%.
 *
 * No es que el personaje sea chico respecto del escenario —la losa central mide
 * 4,6 alturas de personaje contra las ~5,6 de la referencia, que está bien— sino
 * que la cámara mostraba 28 unidades de ancho para un ring cuyo elemento
 * principal mide 4,8. El zoom estaba encuadrando el mapa, no la pelea.
 *
 * Con el mínimo en 5,5 el alto visible es 6,2 y el peleador —1,04 de alto— entra
 * al 17%. El mínimo se alcanza sólo cuando los seis están a menos de 5 unidades
 * entre sí, que con el margen de +3 de `moveCamera` es "están peleando juntos".
 *
 * El máximo baja de 14 a 10 por lo mismo: 14 dejaba 5 unidades de aire muerto de
 * cada lado del ring. Con 10 el ancho visible es 20 contra las 18 del escenario,
 * así que el borde —que es donde se pierde la pelea— se sigue viendo entero.
 */
const MIN_HALF_WIDTH = 8;
/**
 * Cuánto se puede ver a lo ALTO, en unidades de mundo (medio alto).
 *
 * El encuadre se calcula a lo ancho, y eso alcanza mientras la pantalla sea
 * apaisada. En una pantalla angosta y alta —un teléfono en vertical— el alto
 * visible sale del ancho por el aspecto: con medio ancho en 10 y un aspecto de
 * 1,78 se ven **treinta y cinco unidades de alto**, y un peleador, que mide
 * 1,04, queda ocupando el 3% de la pantalla. Brawlhalla, que es la referencia
 * declarada del proyecto, los muestra cerca del 8%.
 *
 * Acotando el alto visible, en una pantalla angosta la cámara se ACERCA en vez
 * de alejarse, y lo que se recorta son los costados. Se pierde ver el escenario
 * entero, sí; se gana ver quién está peleando, que es lo que se vino a mirar.
 *
 * En 16:9 no cambia nada: el tope por alto da 13,3 de medio ancho, más que
 * `MAX_HALF_WIDTH`, así que no llega a morder nunca.
 */
const MAX_HALF_HEIGHT = 8.6;
const MAX_HALF_WIDTH = STAGE_HALF_WIDTH + 1;
/**
 * Bajó de 3,2 a 1,4. Reportado con video real: con las especiales ahora
 * exigiendo casi cuerpo a cuerpo (ver ALCANCE en match.ts), la pelea entera
 * pasa pegada y moviéndose rápido, y a 3,2 la cámara perseguía cada
 * corrección de posición -- el resultado se leía como que "pierde el foco
 * de la pelea", no como una cámara que sigue la acción. Más lenta, la
 * cámara se comporta más como fija: sigue el CENTRO de la pelea sin
 * reaccionar a cada paso.
 */
const CAMERA_LAMBDA = 1.4;
/**
 * El acercamiento de los momentos clave.
 *
 * El plano abierto es para LEER la pelea: dónde está cada uno, dónde está el
 * borde del escenario, quién va ganando. Pero un plano abierto todo el tiempo no
 * tiene golpes, tiene puntitos moviéndose. Así que la cámara vive lejos y ENTRA
 * cuando pasa algo —un KO, un super— y se vuelve sola.
 *
 * El acercamiento se aplica DESPUÉS del clamp a `MIN_HALF_WIDTH`, y eso es a
 * propósito: el mínimo es lo más cerca que la cámara se pone sola, no lo más
 * cerca que puede estar. Un primer plano que respeta el mínimo no es un primer
 * plano.
 *
 * 1,9 por segundo de caída son unos 0,8 s de vuelta, que es más o menos lo que
 * dura el hitstop de un KO más el tiempo de leer qué pasó.
 */
/**
 * Bajó de 0,3 a 0,16 y después a 0,1. El primer recorte fue para el teléfono
 * vertical, que ya no es el objetivo (el juego se usa en horizontal). En
 * horizontal el problema era otro: aun sin el apriete de `MAX_HALF_HEIGHT`,
 * el acercamiento de un KO o un super seguía sintiéndose demasiado pegado al
 * personaje — golpes y poderes "se acercan demasiado", que es distinto de
 * "tapan al personaje" (ya resuelto aparte, en el tamaño de los VFX).
 */
/**
 * Bajó de 0,1 a 0,04, y `ZOOM_LAMBDA`/`ZOOM_DECAE` bajaron con él. Con
 * las especiales ahora saliendo dentro del forcejeo (ver ALCANCE en
 * match.ts) el punch-in de super/estallido pasó de disparar unas pocas
 * veces por partido a disparar todo el tiempo -- el resultado era una
 * cámara respirando (entra-sale-entra-sale) en vez de un acercamiento
 * puntual. Pedido explícito: "mínimo acercamiento lento cinematográfico".
 * 0,04 es un empujón apenas perceptible, no un primer plano.
 */
const ZOOM_CLAVE = 0.04;
const ZOOM_DECAE = 0.7;
/**
 * A qué velocidad `zoom` alcanza a `zoomTarget`. Separado de `CAMERA_LAMBDA`
 * porque el acercamiento de momento clave tiene que sentirse más decidido que
 * el paneo de encuadre normal — más lento que un salto instantáneo, más
 * rápido que seguir la pelea.
 *
 * Bajó de 9 a 2,5: a 9 el acercamiento entraba en ~0,1s, un salto duro. A
 * 2,5 entra en más de un segundo -- "lento cinematográfico" en vez de un tic.
 */
const ZOOM_LAMBDA = 2.5;
/**
 * Hasta dónde puede subir y bajar la mirada de la cámara, como fracción del alto
 * visible. Con 0,55 el piso del escenario queda a poco más de tres cuartos de
 * pantalla: abajo del centro, arriba del marcador.
 */
const CAMERA_Y_HIGH = 0.55;
const CAMERA_Y_LOW = 0.28;
const PAN_LIMIT_X = STAGE_HALF_WIDTH * 0.3;
/**
 * Cuánto se corre la cámara por unidad de `shake`.
 *
 * Bajó de 0,35 a 0,22. Con 0,35 un temblor de 1 movía el encuadre ±0,35
 * unidades sesenta veces por segundo, que a la escala actual —la cámara se
 * acercó bastante— son casi veinte píxeles de vibración: el escenario dejaba
 * de leerse. Un golpe se siente igual con la mitad.
 */
const SHAKE_GAIN = 0.22;

/**
 * A partir de esta rapidez, el peleador deja estela.
 *
 * Subió de 7 a 12. A 7 la dejaba casi siempre —un salto normal ya pasa de 7— y
 * la estela dejaba de decir "éste va volando" para ser un adorno permanente. A
 * 12 sale sólo cuando lo mandaron a volar de verdad, que es cuando un rastro
 * significa algo.
 */
const TRAIL_SPEED = 12;
/**
 * A qué distancia del centro del cuerpo cae el impacto de un puño o una patada.
 *
 * El personaje mide 0,6 de ancho, así que el golpe conecta apenas afuera de su
 * silueta: puesto en el centro, el destello le queda pintado encima del pecho y
 * parece que se golpeó a sí mismo.
 */
const PUNO_ALCANCE = 0.52;
/** Duración de la onda de choque del super, en segundos. */
const SHOCKWAVE_TIME = 0.85;

/**
 * El plano cerrado del super.
 *
 * El super era un fogonazo con temblor y nada más: la cámara seguía encuadrando
 * a los dos bandos como en cualquier otro momento, así que el momento más caro
 * de la pelea —sale una vez cada medio minuto largo— se veía igual que un puño.
 * Acá la cámara CORTA: se olvida del encuadre de grupo, se va encima del que lo
 * tira, y vuelve.
 *
 * Las barras de arriba y abajo entran de golpe y salen deslizando. De golpe
 * porque un corte de cámara es un corte, no un fundido; deslizando porque la
 * vuelta a la pelea sí tiene que sentirse como que se abre el cuadro.
 */
/**
 * Subió de 0,9 a 1,3: capturas reales mostraron el burst de textura recién
 * llegando a su tamaño pleno cuando la cámara ya estaba volviendo al plano
 * general — el plano cerrado no alcanzaba a mostrar el efecto que existe
 * para mostrar. Atado a las duraciones de `vfxSprites.burst` de más abajo:
 * si una sube, la otra tiene que acompañar.
 */
const CINE_TIEMPO = 1.3;
/** Qué fracción del alto de pantalla se come cada barra. */
const CINE_BARRA = 0.11;

/* --- el fotograma de impacto ----------------------------------------- */

/**
 * Cuánto dura el fogonazo que tapa la pantalla entera en un impacto grande.
 *
 * Es el *impact frame* de la animación japonesa: uno o dos cuadros en los que
 * la imagen se va entera a un color plano. Sirve porque el ojo no alcanza a
 * leerlos —a 60 Hz son 70 ms— pero sí registra el corte, y el golpe que viene
 * después se siente más fuerte de lo que la animación en sí muestra. Es el
 * truco más barato que existe en peso y el que más cambia cómo pega.
 *
 * El número está atado a cuadros y no al gusto: 0,07 s son cuatro cuadros a 60
 * Hz y dos a 30 Hz. Más corto que eso y en una pantalla lenta no aparece nunca.
 */
const DESTELLO_TIEMPO = 0.07;
/** El KO se lleva casi el doble: es lo último que pasa y conviene que tape. */
const DESTELLO_KO = 0.12;
/** A cuánto llega el fogonazo. En 1 taparía; en 0,82 se ve el mundo detrás. */
const DESTELLO_ALFA = 0.82;

interface Camera {
  x: number;
  y: number;
  halfWidth: number;
  /** Cuánto del acercamiento de momento clave queda puesto, de 0 a 1. Sigue a `zoomTarget` con lambda propia. */
  zoom: number;
  /**
   * A dónde apunta el acercamiento. Los golpes escriben ACÁ con `Math.max`, nunca
   * en `zoom` directo — si un golpe entrando a mitad de una racha pisara `zoom` de
   * una, el encuadre pegaría un salto en vez de acelerar la llegada. Con el target
   * separado, la cámara siempre LLEGA en curva, aunque el destino cambie de golpe.
   */
  zoomTarget: number;
  /** Segundos que le quedan al plano cerrado del super. Cero es pelea normal. */
  cine: number;
  /** A quién encuadra ese plano. */
  cineX: number;
  cineY: number;
}

export interface GameHandle {
  app: Application;
  destroy(): void;
}

/**
 * Espera una carga, pero no para siempre.
 *
 * Todo lo que el juego carga es OPCIONAL: sin fondo hay color plano, sin losas
 * hay barras de color, sin arte hay muñeco vectorial, sin hoja hay muñeco
 * articulado. Ninguna de esas ausencias es un error… **siempre que la carga
 * TERMINE**. Una que no vuelve nunca sí es fatal, porque `startGame` no llega a
 * enganchar su tick: queda el HUD vivo sobre una pantalla negra y el medidor de
 * frame en `0.0 ms`. Es lo que se vio en la página publicada.
 *
 * Y pasa de verdad: el cargador de Pixi decodifica imágenes en un worker, y un
 * pedido abortado —por caché envenenada, por red que se corta a mitad— deja la
 * promesa colgada sin rechazar. Contra eso no alcanza con un `catch`.
 *
 * El límite es generoso a propósito: veinticinco segundos. No está para exigir
 * velocidad —seis hojas de sprites son once megas, y por una conexión de
 * teléfono eso tarda— sino para que una carga que no vuelve NUNCA no se lleve
 * puesta la pelea. Lo que llegue más tarde llega tarde y no se usa.
 */
function sinColgarse<T>(carga: Promise<T>, queEs: string): Promise<T | null> {
  return Promise.race([
    carga.catch(() => null),
    new Promise<null>((listo) => setTimeout(() => {
      console.warn(`BorderBrawlers: ${queEs} tardó demasiado; se sigue sin eso.`);
      listo(null);
    }, 25000)),
  ]);
}

/** Si ya se inicializó el cargador. Vite recarga el módulo, no la página. */
let cargadorListo = false;

/**
 * Enciende el cargador de Pixi **sin detección de formatos**.
 *
 * Pixi lo arranca solo la primera vez que se le pide un archivo, y antes de
 * bajar nada prueba si el navegador entiende webp y avif decodificando dos
 * imágenes de muestra. Acá esa prueba no sirve para nada —el arte es PNG y JPG,
 * no hay variantes que elegir— y sí puede colgarse: la decodificación va a un
 * worker, y con la GPU emulada por software o la máquina ocupada esa promesa a
 * veces no vuelve. Colgada la detección, **todo** `Assets.load` queda esperando
 * y ni siquiera sale el pedido a la red: sin fondo, sin losas, sin personajes,
 * y el juego sin enganchar su tick. Eso era la pantalla negra con el HUD vivo.
 */
async function arrancarCargador(): Promise<void> {
  if (cargadorListo) return;
  cargadorListo = true;
  await Assets.init({ skipDetections: true });
}

export async function startGame(
  host: HTMLElement,
  match: Match,
  client: BinanceFeedClient,
  onFrame: (ms: number) => void,
  stageName: string | null = null,
  ritmo: number = RITMO,
): Promise<GameHandle> {
  const app = new Application();
  await app.init({
    background: 0x0b0f19,
    resizeTo: host,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  });
  await arrancarCargador();
  host.appendChild(app.canvas);

  /**
   * `resizeTo` de Pixi mide el elemento **al arrancar** y después sólo vuelve a
   * medir cuando la VENTANA dispara `resize`. Adentro de un iframe eso no pasa
   * nunca: el iframe crece cuando su página se acomoda, la ventana no cambia de
   * tamaño, y el renderer se queda con la medida que tenía el host antes de que
   * hubiera canvas adentro. Se ve como el juego dibujado en un rincón —o como
   * una pantalla negra, si el host todavía medía cero—, con el HUD, que es DOM,
   * perfectamente ubicado. Fue exactamente lo que se vio en la página publicada.
   *
   * Un `ResizeObserver` sobre el host avisa de cualquier cambio de caja, el
   * primer layout incluido, que es justo lo que falta.
   */
  function encuadrar(): void {
    // Se mide la CAJA, no `clientWidth`. `getBoundingClientRect` da fracciones,
    // que es lo que hay cuando el viewport de un teléfono no cae en un número
    // entero de píxeles CSS; `clientWidth` las redondea y la diferencia se
    // acumula en una franja muerta al costado.
    const caja = host.getBoundingClientRect();
    const ancho = Math.round(caja.width);
    const alto = Math.round(caja.height);
    if (ancho <= 0 || alto <= 0) return;
    // Las dos medidas están en píxeles CSS —ver `pantalla`—, así que se comparan
    // derecho. Dividiendo por `resolution`, como estaba, la comparación nunca
    // daba igual en una pantalla retina y la salida temprana no servía de nada.
    if (app.renderer.width === ancho && app.renderer.height === alto) return;
    app.renderer.resize(ancho, alto);
  }

  const observador = new ResizeObserver(encuadrar);
  observador.observe(host);
  encuadrar();

  /**
   * Tres avisos más, porque en un teléfono el `ResizeObserver` no alcanza.
   *
   * El caso que se vio en la página publicada: el juego dibujado en una franja
   * arriba y media pantalla muerta abajo. Pasa cuando la caja del host cambia
   * SIN que el observador lo note o antes de que haya nada que observar —el
   * navegador esconde su barra al primer desplazamiento, se gira el teléfono, o
   * la página se restaura del caché de atrás—.
   *
   * - `visualViewport` es lo único que sigue a la barra del navegador
   *   apareciendo y desapareciendo; ni `resize` de la ventana ni el observador
   *   se enteran de eso en iOS.
   * - `orientationchange` llega ANTES de que el navegador acomode la caja, así
   *   que hay que volver a medir un poco después, no en el momento.
   * - `pageshow` cubre volver con el botón de atrás desde el caché.
   *
   * Son todos listeners pasivos y `encuadrar` sale enseguida si nada cambió, o
   * sea que el costo de tenerlos de más es cero. El costo de que falte uno es
   * la mitad de la pantalla.
   */
  const revisar = (): void => {
    encuadrar();
    for (const espera of [50, 250, 600]) window.setTimeout(encuadrar, espera);
  };
  window.addEventListener('resize', revisar, { passive: true });
  window.addEventListener('orientationchange', revisar, { passive: true });
  window.addEventListener('pageshow', revisar, { passive: true });
  window.visualViewport?.addEventListener('resize', revisar, { passive: true });
  window.visualViewport?.addEventListener('scroll', encuadrar, { passive: true });
  revisar();

  const starfield = createStarfield();
  app.stage.addChild(starfield.view);
  const backdrop = createBackdrop();
  // Dos pasadas de shader (ruido + rayos) sobre la pantalla ENTERA, todos los
  // cuadros: en gama media/baja se suma al costo de Bloom y hace caer el
  // framerate, que es lo que se ve como "todo se mueve raro" —no es un solo
  // movimiento roto, es que el juego entero deja de mantener el ritmo. Mismo
  // gate que Bloom en vez de uno propio: son los mismos dispositivos.
  const energyField = detectLowQuality() ? null : createEnergyField();
  if (energyField !== null) backdrop.view.addChildAt(energyField.view, 0);
  // El fondo pintado va debajo de los cristales de volumen, que son el dato.
  //
  // Con `?stage=` se fija uno y no se mueve: es el modo de mirar un escenario.
  // Sin él se cargan todos los que haya y **se cambia de escenario cada vez que
  // alguien tira un super**. El super ya es el momento más ruidoso de la pelea
  // —onda de choque, hitstop, media docena volando—, así que el corte se
  // esconde ahí adentro en vez de parecer un parpadeo del fondo.
  const rotation = stageName === null ? await stageNames() : [stageName];

  // Las cargas arrancan JUNTAS y se esperan donde hacen falta. En fila
  // —fondo, después losas, después arte, después hojas— cada una paga de nuevo
  // el arranque del cargador de Pixi, que en una máquina ocupada es lo que más
  // tarda de todo: medido, el primer archivo tardó once segundos y los
  // siguientes uno o dos. Cuatro veces once segundos es una pantalla negra que
  // parece un cuelgue.
  const armatures = [...new Set(ROSTER.map((character) => character.armature))];
  const pedidos = {
    fondos: sinColgarse(Promise.all(rotation.map(loadStage)), 'el fondo del escenario'),
    losas: rotation.length === 0
      ? Promise.resolve(null)
      : sinColgarse(loadPlatforms(rotation[0]), 'las losas'),
    hojas: sinColgarse(Promise.all(armatures.map((name) => loadSheets(name))), 'las hojas de sprites'),
    vfx: sinColgarse(loadVfxTexturas(), 'las texturas de efectos'),
  };

  const stageTextures = (await pedidos.fondos ?? [])
    .filter((texture): texture is Texture => texture !== null);
  let stageIndex = 0;
  const stage = stageTextures.length === 0 ? null : createStage(stageTextures[0]);
  if (stage !== null) backdrop.view.addChildAt(stage.sprite, 0);
  app.stage.addChild(backdrop.view);

  /** Contenedor del mundo: acá vive la cámara, como escala y posición. */
  const world = new Container();
  app.stage.addChild(world);

  /**
   * Las losas: dibujadas si el escenario las trae, y las tres bandas de color
   * de siempre si no. Se resuelve una vez acá y no cada frame — igual que el
   * arte de los personajes, la ausencia no es un error.
   *
   * Se carga la dotación del escenario que ARRANCA. Los escenarios rotan con el
   * super, pero las losas no rotan con ellos: cambiarlas en el mismo frame que
   * el fondo pediría tener las nueve texturas de los cinco escenarios cargadas
   * de entrada, y la mayoría de los escenarios todavía no tiene losas propias.
   * Con `?stage=` —que es el modo de mirar un escenario— coincide siempre.
   */
  const platformArt = await pedidos.losas;
  const platforms = new Graphics();
  const platformSprites = platformArt === null ? null : buildStageSprites(platformArt);
  if (platformSprites === null) {
    world.addChild(platforms);
  } else {
    for (const sprite of platformSprites) world.addChild(sprite);
  }

  /** Polvo y sombras: no brillan, van con el resto del mundo. */
  const plainFx = new Graphics();
  world.addChild(plainFx);

  // Las hojas de sprites son el dibujo bueno: el que la tenga se anima cuadro
  // por cuadro. Se piden para TODA la plantilla y no sólo para los que
  // arrancan, porque al caerse uno entra otro en el mismo frame y ahí no hay
  // tiempo de ir a buscar una imagen.
  const sheeted = await pedidos.hojas ?? armatures.map(() => null);
  const sheetsByArmature = new Map<string, FighterSheets | null>(
    armatures.map((name, i) => [name, sheeted[i]]),
  );

  /**
   * **El arte cortado se pide SÓLO para el que se quedó sin hoja.**
   *
   * Es el respaldo: el muñeco de piezas articuladas que se usa cuando la hoja de
   * sprites no está. Se pedía siempre, en paralelo con las hojas, y eso son
   * **8 MB por visita bajados y tirados** — seis torsos, seis cabezas y cuatro
   * miembros por personaje que no se dibujan nunca porque los seis tienen hoja.
   * Sobre un total de 26,6 MB por visita era casi un tercio.
   *
   * Va después y no en paralelo a propósito: hasta no saber qué hoja falló no se
   * sabe qué respaldo hace falta. La latencia extra la paga únicamente el caso
   * degradado, que ya es el caso en el que algo salió mal.
   */
  const faltan = armatures.filter((_, i) => sheeted[i] === null);
  const respaldo = faltan.length === 0
    ? []
    : await sinColgarse(Promise.all(faltan.map((name) => loadArt(name))), 'el arte cortado')
      ?? faltan.map(() => null);
  const artByArmature = new Map<string, FighterArt | null>(
    armatures.map((name) => [name, null]),
  );
  faltan.forEach((name, i) => artByArmature.set(name, respaldo[i] ?? null));

  /**
   * Un cuerpo articulado por personaje, no por slot.
   *
   * El slot no cambia de bando pero **sí de personaje**: el que se cae del
   * escenario no vuelve y entra otro de la plantilla. Construir el cuerpo en
   * ese momento costaría una decena de `Graphics` y de `Sprite` en el frame más
   * cargado que hay; construidos todos de entrada, el relevo es cambiar de
   * `visible`. Son diecinueve cuerpos quietos y ocultos: no cuestan un draw
   * call porque Pixi no dibuja lo invisible.
   *
   * Que sea por personaje y no por slot es lo que permite que la caché exista:
   * `pickCharacter` no repite personaje entre slots activos del mismo bando, así
   * que un cuerpo nunca hace falta en dos lugares a la vez.
   */
  const viewByArmature = new Map<string, FighterView>();
  for (const character of ROSTER) {
    const sheets = sheetsByArmature.get(character.armature) ?? null;
    const view = sheets !== null
      ? createSpriteFighterView(sheets)
      : createFighterView(
        lookFor(character.armature),
        character.team === TEAM_GREEN ? GREEN : RED,
        artByArmature.get(character.armature) ?? null,
      );
    view.visible = false;
    world.addChild(view);
    viewByArmature.set(character.armature, view);
  }

  /**
   * Las barras de fuerza, las seis en UN solo `Graphics` que se redibuja entero
   * cada frame.
   *
   * Seis objetos separados serían seis draw calls contra el techo de 16 del
   * proyecto, y no compran nada: las barras cambian todas juntas, todos los
   * frames. Va después de los peleadores para que ninguna quede tapada.
   */
  // La barra de energía de cada peleador ya NO se dibuja. La energía sigue
  // gobernando todo —quién puede pegar, cuándo sale una especial, a quién le
  // toca el ultra—, pero seis barritas siguiendo a seis cuerpos que saltan eran
  // seis cosas más moviéndose en una pantalla que ya tiene nueve losas subiendo
  // y bajando. Lo que la barra decía se lee igual en el HUD, que está quieto.
  //
  // `drawBars` queda escrita a propósito: volver a mostrarlas es una línea, y
  // borrarla obligaría a reescribir el encuadre y el marco dorado del elegido.
  void drawBars;

  /** El cuerpo que le toca a cada slot ahora mismo. */
  const views: FighterView[] = [];
  /** Qué personaje está mostrando cada slot, para notar el relevo. */
  const shown = new Uint8Array(match.slot.length);
  for (let i = 0; i < match.slot.length; i++) {
    const character = characterFor(match.team[i], match.character[i]);
    shown[i] = match.character[i];
    const view = viewByArmature.get(character.armature);
    if (view === undefined) throw new Error(`sin cuerpo para ${character.armature}`);
    views.push(view);
  }

  /** Reengancha el cuerpo del slot cuando la simulación le cambió el personaje. */
  function relieve(m: Match): void {
    for (let i = 0; i < m.slot.length; i++) {
      if (m.character[i] === shown[i]) continue;
      views[i].visible = false;
      shown[i] = m.character[i];
      const armature = characterFor(m.team[i], m.character[i]).armature;
      const view = viewByArmature.get(armature);
      if (view === undefined) continue;
      views[i] = view;
    }
  }

  /**
   * Qué acción está reproduciendo cada peleador y hace cuánto. Vive en la capa
   * de render y no en la simulación: es estado de presentación, y meterlo en
   * `Match` obligaría a la simulación a saber cuánto dura una animación.
   */
  const action = new Uint8Array(match.slot.length);
  const actionAge = new Float32Array(match.slot.length);
  /**
   * El golpe de la habilidad y del super, esperando su cuadro.
   *
   * La simulación avisa que el personaje tiró la especial en el instante en que
   * la decide, pero el DIBUJO tarda: primero carga. Así que el evento no dispara
   * el efecto, lo agenda, y lo cobra `drawFighters` cuando la animación llega a
   * `ACTION_HIT`. Guardar el equipo y la magnitud acá es más barato que ir a
   * buscarlos después, porque para entonces la cola de eventos ya se vació.
   */
  const golpeKind = new Uint8Array(match.slot.length);
  const golpeMagnitud = new Float32Array(match.slot.length);
  const golpeEquipo = new Uint8Array(match.slot.length);

  /**
   * Lo que hace que el movimiento se vea blando, y que es de dibujo y no de
   * simulación: la simulación puede cambiar de golpe, el dibujo no.
   *
   * `giro` arranca en 1 y no en 0 porque un peleador con el dibujo a escala
   * cero es un peleador invisible.
   */
  const suave: Suavizado = {
    giro: new Float32Array(match.slot.length).fill(1),
    golpePiso: new Float32Array(match.slot.length),
    volaba: new Uint8Array(match.slot.length),
    vyPrevia: new Float32Array(match.slot.length),
  };

  /**
   * La capa que brilla. Es hija de `world` para heredar la cámara, y lleva el
   * Bloom puesto encima.
   */
  const glowFx = new Graphics();
  const glowLayer = new Container();
  glowLayer.addChild(glowFx);
  // El Bloom es el filtro más caro del render: recompone la capa entera por
  // cuadro. `detectLowQuality()` existía para saltearlo en gama media/baja
  // pero nadie la llamaba — quedó como código muerto del pivot a Pixi y el
  // Bloom corría siempre, sin importar el hardware.
  if (!detectLowQuality()) {
    glowLayer.filters = [new AdvancedBloomFilter({
      threshold: 0.35,
      bloomScale: 1.25,
      brightness: 1.05,
      blur: 5,
      quality: 4,
    })];
  }
  world.addChild(glowLayer);

  /**
   * Los contornos de los efectos. Encima de la capa que brilla y **sin filtro**.
   *
   * Es lo que da el borde del color del bando alrededor del núcleo blanco. Tiene
   * que ir en su propia capa porque el Bloom se come cualquier línea que pase
   * por él: metido adentro de `glowLayer` el contorno volvería a ser una mancha,
   * y detrás quedaría tapado por su propio relleno.
   */
  const inkFx = new Graphics();
  world.addChild(inkFx);

  /**
   * Los poderes en vuelo se dibujan aparte de `fx`.
   *
   * `fx` es un sistema de partículas: cada chispa nace, envejece y muere sola.
   * Un poder no es eso — es un objeto de la SIMULACIÓN que está en un lugar
   * concreto del mundo y tiene que dibujarse donde está, cuadro a cuadro, hasta
   * que estalle. Meterlo en el pool de partículas obligaría a sincronizar dos
   * verdades sobre la misma cosa.
   */
  const poderGlow = new Graphics();
  glowLayer.addChild(poderGlow);
  const poderInk = new Graphics();
  world.addChild(poderInk);

  /**
   * Las ráfagas con textura: especial, super, estallido, KO. Van en su propia
   * pareja de capas, glow con Bloom e ink sin filtro, igual que todo lo
   * demás — la textura no cambia esa regla, sólo lo que hay adentro del
   * contorno.
   */
  const vfxGlowLayer = new Container();
  glowLayer.addChild(vfxGlowLayer);
  const vfxInkLayer = new Container();
  world.addChild(vfxInkLayer);
  const vfxTexturas = await pedidos.vfx ?? {};
  const vfxSprites = createVfxSprites(vfxGlowLayer, vfxInkLayer, vfxTexturas);

  /**
   * Los cuerpos vuelven a subirse por encima de TODAS las capas de efectos.
   *
   * Se agregaron a `world` antes de que existiera ninguna capa de brillo/tinta
   * (líneas arriba), así que quedaban siempre tapados por lo último que se
   * dibujara — y una ráfaga de especial/super/estallido mide 2-3 veces el
   * ancho del personaje, así que lo tapaba entero durante todo el burst.
   * `addChild` sobre un hijo que ya está en el contenedor no lo duplica: lo
   * mueve al tope. Sí cambia el KO, que antes quedaba tapado a propósito por
   * su propio fogonazo; ahora se ve al personaje bajo el destello, que es
   * preferible a que cualquier poder lo vuelva invisible.
   */
  for (const view of viewByArmature.values()) world.addChild(view);

  const shockwave = new ShockwaveFilter({
    amplitude: 22,
    wavelength: 140,
    speed: 900,
    brightness: 1,
    radius: 620,
  });
  let shockwaveTime = -1;
  let shockwaveX = 0;
  let shockwaveY = 0;

  const camera: Camera = { x: 0, y: 2.5, halfWidth: MAX_HALF_WIDTH, zoom: 0, zoomTarget: 0,
    cine: 0,
    cineX: 0,
    cineY: 0,
  };
  /**
   * Las barras del plano cerrado.
   *
   * Van en `app.stage` y no en `world` a propósito: `applyCamera` mueve, escala
   * y sacude el mundo entero, y unas barras que se mueven con la cámara no son
   * barras de cine, son dos rectángulos flotando en el escenario.
   */
  const cineBarras = new Graphics();
  app.stage.addChild(cineBarras);

  /**
   * El fotograma de impacto. Va DESPUÉS de las barras de cine en el orden de
   * dibujo porque tiene que taparlo todo, barras incluidas: si las barras
   * quedaran encima, el cuadro tapado sería el del medio y no la pantalla, y
   * entonces no es un fotograma de impacto, es un fogonazo con marco.
   */
  const destelloG = new Graphics();
  app.stage.addChild(destelloG);
  let destello = 0;
  let destelloTotal = DESTELLO_TIEMPO;
  let destelloColor = 0xffffff;

  /** Pide un fotograma de impacto. Gana el más largo si ya había uno. */
  function destellar(dura: number, color: number): void {
    if (dura <= destello) return;
    destello = dura;
    destelloTotal = dura;
    destelloColor = color;
  }

  const fx = createFx();

  let accumulator = 0;
  let hitstop = 0;
  let elapsed = 0;

  /**
   * Interpolación de render: sin esto, `drawFighters` pinta siempre la
   * posición del ÚLTIMO paso de física ya terminado, y como la simulación
   * corre a pasos fijos de 1/60 s (más lento todavía escalada por `ritmo`)
   * mientras la pantalla puede refrescar a otro ritmo, el cuerpo salta de
   * posición en vez de deslizarse. La técnica es la de siempre en paso fijo
   * — Glenn Fiedler, "Fix Your Timestep!" — guardar dónde estaba el
   * peleador ANTES del último paso y mezclarlo con dónde quedó DESPUÉS,
   * según cuánto del siguiente paso ya pasó (`accumulator / FIXED_DT`).
   *
   * `match.x`/`match.y` siguen siendo la verdad de la simulación — golpes,
   * hitboxes y `cobrarGolpe` la usan tal cual — esto es sólo lo que se
   * DIBUJA.
   */
  const prevX = new Float64Array(match.slot.length);
  const prevY = new Float64Array(match.slot.length);
  const renderX = new Float64Array(match.slot.length);
  const renderY = new Float64Array(match.slot.length);
  prevX.set(match.x);
  prevY.set(match.y);

  /**
   * Lo mismo, para los poderes en vuelo. Viajan rápido —es la mecánica: salen
   * disparados y recién estallan al llegar— así que sin esto el salto entre
   * pasos de física se nota TODAVÍA más que en el cuerpo, que se mueve más
   * despacio.
   */
  const prevPX = new Float64Array(PODERES);
  const prevPY = new Float64Array(PODERES);
  const renderPX = new Float64Array(PODERES);
  const renderPY = new Float64Array(PODERES);
  prevPX.set(match.poderes.x);
  prevPY.set(match.poderes.y);

  const tick = (): void => {
    const started = performance.now();
    const frameMs = app.ticker.deltaMS;
    /** Tiempo real, para la cámara y el hitstop. */
    const dt = Math.min(frameMs / 1000, 0.1);
    /** Tiempo de la pelea: el mismo, a la velocidad de `RITMO`. */
    const dtPelea = dt * ritmo;
    elapsed += dtPelea;

    if (hitstop > 0) {
      // Durante el hitstop no se acumula tiempo de simulación. No se descarta:
      // simplemente no entra, así que al soltar la pausa la pelea sigue donde
      // estaba en vez de dar un salto para recuperar el atraso.
      hitstop -= dt;
    } else {
      accumulator += Math.min(frameMs, 250) / 1000 * ritmo;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
        // Dónde estaba ANTES de este paso: es el extremo de abajo de la
        // interpolación de más adelante.
        prevX.set(match.x);
        prevY.set(match.y);
        prevPX.set(match.poderes.x);
        prevPY.set(match.poderes.y);
        stepMatch(match, client.trades, client.stats, FIXED_DT);
        accumulator -= FIXED_DT;
        steps++;
        hitstop = Math.max(hitstop, drainEvents(match, fx));
        if (hitstop > 0) break;
      }
      if (steps >= MAX_STEPS) accumulator = 0;
    }

    if (hitstop > HITSTOP_MAX) hitstop = HITSTOP_MAX;

    // La fracción del PRÓXIMO paso que ya transcurrió. En 0 se dibuja
    // exactamente el último paso terminado (`prev === match.x`, mezcla da lo
    // mismo); en 1 estaría en el paso siguiente, que es lo que evita el tope
    // del bucle de arriba.
    const alpha = Math.min(1, accumulator / FIXED_DT);
    for (let i = 0; i < renderX.length; i++) {
      renderX[i] = prevX[i] + (match.x[i] - prevX[i]) * alpha;
      renderY[i] = prevY[i] + (match.y[i] - prevY[i]) * alpha;
    }
    for (let k = 0; k < PODERES; k++) {
      renderPX[k] = prevPX[k] + (match.poderes.x[k] - prevPX[k]) * alpha;
      renderPY[k] = prevPY[k] + (match.poderes.y[k] - prevPY[k]) * alpha;
    }

    // Estelas: sólo el que va rápido de verdad, y siempre — también durante el
    // hitstop, porque congelar los efectos delataría la pausa.
    emitTrails(match, fx);
    updateFx(fx, dtPelea);
    vfxSprites.update(dtPelea);

    // Antes de dibujar: si la simulación cambió de personaje algún slot, hay
    // que enganchar el cuerpo nuevo. Se hace acá y no adentro de `drainEvents`
    // porque el relevo no es un evento sino un estado — un slot que se llenó
    // durante el hitstop tiene que aparecer con el peleador que le tocó igual.
    relieve(match);

    // Un slot que se cayó del escenario no puede dejar un golpe agendado. El
    // golpe se cobra cuando la ANIMACIÓN llega a su cuadro de impacto, y a un
    // peleador que desaparece a mitad de super no le llega nunca: el apunte
    // quedaba ahí, el slot se volvía a llenar, y el primer puño del que entraba
    // cruzaba el umbral y cobraba el super del muerto —fogonazo, hitstop y
    // cambio de escenario incluidos—. `drawFighters` ya borra la acción de un
    // slot inactivo por la misma razón; esto es la otra mitad.
    for (let i = 0; i < golpeKind.length; i++) {
      if (match.slot[i] !== SLOT_ACTIVE) golpeKind[i] = 0;
    }

    if (platformSprites === null) drawStage(platforms, match);
    else placeStage(platformSprites, match);
    updateCamera(camera, match, dt, app.renderer.height / app.renderer.width);
    applyCamera(world, app, camera, match.shake);
    drawFighters(views, match, renderX, renderY, action, actionAge, suave, dtPelea, elapsed, cobrarGolpe);
    dibujarPoderes(poderGlow, poderInk, match, renderPX, renderPY, elapsed);
    dibujarCine(cineBarras, app, camera.cine);
    // Con el reloj de PANTALLA, no con el de la pelea: el fogonazo entra justo
    // cuando empieza el hitstop, y si se apagara con el reloj congelado se
    // quedaría clavado en pantalla todo lo que dure la congelada.
    destello = Math.max(0, destello - dt);
    dibujarDestello(destelloG, app, destello, destelloTotal, destelloColor);
    drawFx(fx, plainFx, glowFx, inkFx);

    /* --- fondo ------------------------------------------------------- */
    const { ancho: width, alto: height } = pantalla(app);
    const buy = client.stats.buyVolume;
    const sell = client.stats.sellVolume;
    const total = buy + sell;
    const greenShare = total > 0 ? buy / total : 0.5;
    const intensity = Math.min(1, Math.log1p(total) / 12);
    backdrop.update(greenShare, intensity, width, height, elapsed);
    if (energyField !== null) {
      energyField.resize(width, height);
      energyField.update(dt, greenShare);
    }
    starfield.resize(width, height);
    starfield.update(dt, elapsed);
    const sky = backdrop.skyColor(greenShare);
    app.renderer.background.color = sky;
    stage?.update(width, height, stageTint(sky));

    /* --- onda de choque ---------------------------------------------- */
    if (shockwaveTime >= 0) {
      shockwaveTime += dt;
      if (shockwaveTime > SHOCKWAVE_TIME) {
        shockwaveTime = -1;
        // Sacar el filtro y no sólo apagarlo: un filtro presente cuesta una
        // pasada de render-to-texture aunque su efecto sea nulo.
        world.filters = [];
      } else {
        shockwave.time = shockwaveTime;
        const scale = width / (camera.halfWidth * 2);
        shockwave.uniforms.uCenter.x = width / 2 + (shockwaveX - camera.x) * scale;
        shockwave.uniforms.uCenter.y = height / 2 + (camera.y - shockwaveY) * scale;
      }
    }

    onFrame(performance.now() - started);
  };

  /**
   * Agenda un golpe: arranca la animación ahora y deja anotado el impacto para
   * cobrarlo en el cuadro en que conecta.
   *
   * **Un golpe chico no pisa a uno grande.** Las cinco acciones están numeradas
   * de menor a mayor —puño, patada, especial, super— y un golpe sólo interrumpe
   * a otro de igual o menor rango. Sin esta guarda, un peleador que estaba
   * soltando el super y entraba en contacto cuerpo a cuerpo a mitad de la
   * animación quedaba tirando un puño, y el impacto del super, que ya estaba
   * anotado, no se cobraba nunca: el ultra desaparecía sin explotar. La
   * simulación igual reparte el daño —eso lo hizo `stepMatch` en su momento—,
   * así que era un super invisible, de los peores de encontrar.
   */
  function agendar(slot: number, kind: number, magnitude: number, team: number): void {
    if (slot < 0 || slot >= action.length) return;
    if (golpeKind[slot] !== 0 && kind < golpeKind[slot]) return;
    startAction(action, actionAge, slot, kind);
    golpeKind[slot] = kind;
    golpeMagnitud[slot] = magnitude;
    golpeEquipo[slot] = team;
  }

  /**
   * Cobra el golpe agendado de un slot: efectos, hitstop y cambio de escenario.
   *
   * Llega desde `drawFighters`, o sea DESPUÉS del bucle de simulación de este
   * frame. Escribir `hitstop` acá no descarta nada: el frame que viene lo lee al
   * empezar y congela desde ahí, que es justo cuando se ve el impacto.
   */
  function cobrarGolpe(slot: number, x: number, y: number): void {
    const kind = golpeKind[slot];
    if (kind === 0) return;
    golpeKind[slot] = 0;
    const teamColor = golpeEquipo[slot] === TEAM_GREEN ? GREEN : RED;
    // Hacia dónde mira el que pega. Es lo que orienta el tajo y manda las
    // chispas para adelante en vez de en círculo.
    const hacia = match.facing[slot] >= 0 ? 1 : -1;

    if (kind === ACT_PUNCH || kind === ACT_KICK) {
      // El puño y la patada NO llevan anillo. Un anillo es una onda que se
      // expande, y el cuerpo a cuerpo pasa tres veces por segundo: seis
      // peleadores dejaban dieciocho anillos por segundo creciendo encima del
      // escenario, y eso era la mitad del ruido. Lo que sí lleva es un impacto
      // corto y direccional, que dura 0,17 s y se apaga antes del siguiente.
      const alto = kind === ACT_PUNCH ? 0.16 : -0.1;
      impact(fx, x + hacia * PUNO_ALCANCE, y + alto,
        hacia > 0 ? 0 : Math.PI, kind === ACT_KICK ? 0.9 : 0.7, teamColor);
      // Y el barrido del miembro que pega: el *smear frame* de la animación
      // dibujada, que no dibuja el brazo sino el camino que hizo el brazo.
      // Acá el barrido no se puede pintar sobre el personaje —el brazo viene de
      // una hoja de sprites y no es una pieza que se pueda estirar—, así que se
      // dibuja al lado, en la capa de efectos, con el arco que describió.
      //
      // Dura 0,1 s, la mitad que el impacto, y es angosto. La razón de que el
      // cuerpo a cuerpo no llevara nada era el ruido de seis peleadores dando
      // dieciocho golpes por segundo; un arco que se apaga antes del golpe
      // siguiente no se acumula, que era el problema de verdad.
      slash(fx, x + hacia * PUNO_ALCANCE * 0.75, y + alto * 0.5,
        hacia > 0 ? 0 : Math.PI,
        kind === ACT_KICK ? 0.95 : 0.72, 0.1, teamColor);
      return;
    }

    if (kind === ACT_SKILL) {
      // La especial ya NO lleva bola de energía, rayos ni esquirlas grandes:
      // por más que se les bajó el tamaño dos veces, seguían tapando al
      // personaje (ver docs/pendiente-estilo-realista.md). Se deja lo mismo
      // que un golpe de cuerpo a cuerpo — un fogonazo corto y el tajo
      // direccional — así que el poder se ve pero no cubre a nadie.
      impact(fx, x, y, hacia > 0 ? 0 : Math.PI, 0.9, teamColor);
      // La textura de Kling (impacto/tajo), a un tamaño bien por debajo del
      // cuerpo (ver la cuenta de radio×~3,1 en pendiente-estilo-realista.md
      // — acá 0,5 con ESCALA 1,1-1,2 da ~0,55-0,6 unidades de mundo, la
      // mitad de FIGHTER_HALF_HEIGHT*2). Agregado encima del fogonazo, no en
      // vez de él: si la textura no cargó, el golpe se sigue viendo igual.
      vfxSprites.burst('impacto', x, y, 0.5, 0.3, teamColor);
      return;
    }

    // El super: mismo criterio que la especial. Antes tenía onda de choque,
    // esquirlas, anillo, fogonazo grande, tres texturas y un filtro de
    // distorsión de pantalla — todo centrado en el personaje, que es
    // justo lo que lo tapaba. Ahora sólo un fogonazo corto (el mismo que
    // marca cualquier golpe fuerte) y el hitstop/cámara que ya marcan que
    // pasó algo importante.
    flash(fx, x, y, 0.65, 0.18, teamColor);
    // Igual que la especial: la textura de Kling (onda) se agrega chica,
    // encima del fogonazo, sin volver a la bola/rayos/esquirlas grandes que
    // se sacaron el 20/08 por tapar al personaje.
    vfxSprites.burst('onda', x, y, 0.6, 0.35, teamColor);
    destellar(DESTELLO_KO, 0xffffff);
    hitstop = Math.max(hitstop, HITSTOP_SUPER);
    camera.cine = CINE_TIEMPO;
    camera.cineX = x;
    camera.cineY = y;
    // Y se cambia de escenario. Cambiar una textura no reconstruye nada —el
    // sprite es el mismo y el encaje se recalcula en el mismo frame, más
    // abajo—, así que el corte cae dentro del hitstop del super y no se ve un
    // salto de fondo suelto.
    if (stage !== null && stageTextures.length > 1) {
      stageIndex = (stageIndex + 1) % stageTextures.length;
      stage.show(stageTextures[stageIndex]);
    }
  }

  /** Drena la cola de eventos y devuelve cuánto hitstop pide este paso. */
  function drainEvents(m: Match, target: typeof fx): number {
    let stop = 0;
    for (let e = 0; e < m.events.count; e++) {
      const kind = m.events.kind[e];
      const x = m.events.x[e];
      const y = m.events.y[e];
      const magnitude = m.events.magnitude[e];
      const teamColor = m.events.team[e] === TEAM_GREEN ? GREEN : RED;

      switch (kind) {
        case EVENT_HIT: {
          const slot = m.events.slot[e];
          // Sólo los impactos fuertes —los de una especial o el super— frenan
          // el tiempo. El cuerpo a cuerpo pasa decenas de veces por segundo y
          // congelar en cada roce dejaría la pelea a media velocidad.
          if (magnitude >= 1.2) stop = Math.max(stop, HITSTOP_SKILL);
          // Con `slot` negativo el evento es del PAR que forcejea, y su golpe ya
          // lo dibuja `cobrarGolpe` cuando el puño llega. Dibujarlo otra vez acá
          // era pintar dos veces el mismo golpe, además de pintarlo antes de
          // tiempo: éste llega al empezar la animación y el otro al conectar.
          if (slot < 0) break;
          // El que la recibe: sale despedido, y la dirección del impacto es la
          // del envión que acaba de recibir. Es lo que hace que las chispas
          // acompañen al cuerpo en vez de contradecirlo.
          const dir = Math.atan2(m.vy[slot], m.vx[slot]);
          impact(target, x, y, dir, 0.7 + magnitude * 0.5, 0xfff0c0);
          break;
        }
        case EVENT_MELEE:
          // La magnitud es cuál de los dos golpes toca: se alternan. Se AGENDA,
          // igual que la especial y el super: la animación arranca ahora y el
          // impacto se cobra en el cuadro en que el puño llega. Antes las
          // chispas salían acá, o sea en el cuadro en que el brazo recién
          // empezaba a moverse, y por eso el golpe no se sentía conectar.
          agendar(m.events.slot[e], magnitude === 0 ? ACT_PUNCH : ACT_KICK,
            magnitude, m.events.team[e]);
          break;
        case EVENT_SKILL:
        case EVENT_SUPER:
          // Ni anillo ni chispas todavía: el personaje recién está cargando. Se
          // agenda y lo cobra `cobrarGolpe` en el cuadro en que suelta.
          agendar(m.events.slot[e], kind === EVENT_SUPER ? ACT_SUPER : ACT_SKILL,
            magnitude, m.events.team[e]);
          // El super sí; la habilidad no. Si entrara con las dos, la cámara
          // estaría entrando y saliendo todo el tiempo y el acercamiento
          // dejaría de significar "esto importa".
          if (kind === EVENT_SUPER) camera.zoomTarget = Math.max(camera.zoomTarget, 0.6);
          break;
        case EVENT_KO:
          // Sacado el anillo, las esquirlas y las texturas: por más que se
          // les bajó el tamaño dos veces, seguían tapando al personaje (ver
          // docs/pendiente-estilo-realista.md). Queda el mismo fogonazo corto
          // que marca cualquier golpe fuerte, más el tinte de pantalla que
          // dice de qué bando fue el KO.
          flash(target, x, y, 0.65, 0.18, teamColor);
          vfxSprites.burst('esquirlas', x, y, 0.5, 0.3, teamColor);
          destellar(DESTELLO_KO, teamColor);
          stop = Math.max(stop, HITSTOP_KO);
          // Sin acercamiento: un salto de plano en cada caída es la cámara
          // "cazando" la pelea en vez de quedarse fija mirándola. El
          // fogonazo y el hitstop ya marcan que pasó algo; no hace falta que
          // la cámara se mueva. (Escrito cuando el KO era el único gatillo
          // de `zoomTarget` con los poderes apagados; con especial y super
          // reactivados desde el pivot de 2026-08-23 —ver CLAUDE.md— vale la
          // pena revisar si el criterio sigue siendo el mismo.)
          break;
        case EVENT_ESTALLIDO: {
          // Mismo criterio: sin bola, rayos, esquirlas ni onda — sólo el
          // fogonazo, igual que un golpe cuerpo a cuerpo fuerte.
          const fuerza = Math.min(1, magnitude);
          flash(target, x, y, 0.55 + fuerza * 0.2, 0.16, 0xffffff);
          vfxSprites.burst('humo', x, y, 0.45 + fuerza * 0.15, 0.3, 0xffffff);
          destellar(DESTELLO_TIEMPO, 0xffffff);
          stop = Math.max(stop, HITSTOP_SKILL);
          // La cámara se acerca al impacto y no al que disparó: lo que hay que
          // mirar es dónde reventó.
          camera.zoomTarget = Math.max(camera.zoomTarget, 0.3 + fuerza * 0.2);
          break;
        }
        case EVENT_SALTO:
          if (magnitude === 0) {
            // Despegue: el polvo se queda en el piso, donde estaban los pies.
            dust(target, x, y - FIGHTER_HALF_HEIGHT, 0.7);
            wave(target, x, y - FIGHTER_HALF_HEIGHT, 0.75, 0.24, 0xd9cdb4);
          } else {
            // Salto de aire: no hay piso del que levantar polvo, así que lo que
            // se ve es el empujón contra el aire — un anillo bajo los pies, del
            // color del bando, que además muestra que gastó el salto extra.
            wave(target, x, y - FIGHTER_HALF_HEIGHT * 0.7, 0.95, 0.3, teamColor);
            burst(target, x, y - FIGHTER_HALF_HEIGHT * 0.7, 6, 4.5, 0.1, 0.34, teamColor);
          }
          break;
        case EVENT_LAND:
          dust(target, x, y - FIGHTER_HALF_HEIGHT, Math.min(1.4, magnitude));
          // Encima del polvo, el anillo del golpe contra la losa. El polvo dice
          // que cayó; el anillo dice CON CUÁNTA fuerza, y sin él un aterrizaje
          // de dos metros se ve igual que un saltito.
          if (magnitude > 0.9) {
            wave(target, x, y - FIGHTER_HALF_HEIGHT, 0.8 + magnitude * 0.7, 0.3, 0xd9cdb4);
          }
          break;
        case EVENT_ENTRA:
          // La entrada: un anillo del color del bando y una tolvanera bajo los
          // pies, en el mismo lugar en que va a caer. Es lo que hace que el
          // relevo se lea como que ALGUIEN ENTRÓ y no como que la escena se
          // corrigió sola después de estar vacía.
          wave(target, x, y - FIGHTER_HALF_HEIGHT, 1.1, 0.34, teamColor);
          burst(target, x, y - FIGHTER_HALF_HEIGHT * 0.6, 9, 6, 0.12, 0.4, teamColor);
          dust(target, x, y - FIGHTER_HALF_HEIGHT, 1.1);
          break;
        case EVENT_ESQUIVAR:
          // Un solo disparo por pulso (ver `lanzarEsquive` en match.ts). Una
          // estela corta del color del bando: dice "se fue de ahí", no "pasó
          // algo grande" -- por eso más chica y más rápida que el resto.
          wave(target, x, y, 0.55, 0.16, teamColor);
          vfxSprites.burst('esquive', x, y, 0.45, 0.22, teamColor);
          break;
        case EVENT_ESCUDO:
          // Igual criterio que el esquive: se lanza una sola vez por
          // ventana. El anillo se planta en vez de expandirse rápido -- lee
          // como "se puso firme", no como un golpe.
          wave(target, x, y, 0.7, 0.2, teamColor);
          vfxSprites.burst('escudo', x, y, 0.55, 0.28, teamColor);
          break;
        default:
          break;
      }
    }
    m.events.count = 0;
    return stop;
  }

  app.ticker.add(tick);

  return {
    app,
    destroy(): void {
      app.ticker.remove(tick);
      observador.disconnect();
      window.removeEventListener('resize', revisar);
      window.removeEventListener('orientationchange', revisar);
      window.removeEventListener('pageshow', revisar);
      window.visualViewport?.removeEventListener('resize', revisar);
      window.visualViewport?.removeEventListener('scroll', encuadrar);
      backdrop.destroy();
      // El caché de `Assets` sobrevive al `Application`: sin esto, cada recarga
      // en caliente de Vite deja otra copia de las hojas en memoria de GPU.
      for (const art of artByArmature.values()) {
        if (art !== null) void unloadArt(art);
      }
      for (const sheets of sheetsByArmature.values()) {
        if (sheets !== null) void unloadSheets(sheets);
      }
      // `destroy(true, …)` tira también el canvas y las texturas creadas por
      // los Graphics. Cuando entren los sprites del arte hay que sumar
      // `Assets.unload` de cada hoja: el caché de Assets sobrevive al
      // Application y es donde se acumula la memoria de GPU entre recargas.
      app.destroy(true, { children: true, texture: true });
    },
  };
}

/* ------------------------------------------------------------------ */

/**
 * Un tramo de estela por cuadro en el que sale volando, DETRÁS del cuerpo.
 *
 * El desplazamiento hacia atrás es lo que hace que sea una estela y no un aura:
 * emitida en el centro, la partícula queda encima del dibujo y lo tapa. Medio
 * cuerpo atrás, queda donde el peleador ya no está, que es de donde viene.
 */
function emitTrails(match: Match, target: ReturnType<typeof createFx>): void {
  for (let i = 0; i < match.slot.length; i++) {
    if (match.slot[i] !== SLOT_ACTIVE) continue;
    const vx = match.vx[i];
    const vy = match.vy[i];
    const speed = Math.hypot(vx, vy);
    if (speed < TRAIL_SPEED) continue;
    const color = match.team[i] === TEAM_GREEN ? GREEN : RED;
    const atras = (FIGHTER_HALF_HEIGHT * match.scale[i]) / speed;
    trail(target,
      match.x[i] - vx * atras, match.y[i] - vy * atras,
      vx, vy, 0.16 * match.scale[i], color);
  }
}

/**
 * Coloca las nueve losas dibujadas.
 *
 * Es el mismo dato que `drawStage` —x fijo, `topY` variable— pero escrito en
 * `position` y `height` de un sprite en vez de en un `Graphics`. Se puede porque
 * las nueve plataformas **no cambian de tamaño nunca**: sólo se mueven en Y. Si
 * se redimensionaran habría que estirar la imagen cada frame, y ahí un sprite
 * dejaría de ser más barato que las bandas.
 *
 * Los sprites se crean una vez al arrancar y de ahí en más esto sólo escribe
 * números: cero asignaciones por frame, como el resto del camino de dibujo.
 */
function placeStage(sprites: readonly Sprite[], match: Match): void {
  for (let i = 0; i < sprites.length; i++) {
    sprites[i].y = -match.skyline.topY[i];
  }
}

/**
 * Prepara las nueve losas a partir de las dos imágenes del escenario: una
 * central y ocho laterales, que es toda la variedad que hay porque las ocho
 * laterales miden exactamente lo mismo.
 *
 * El ancho y el grosor se escriben una sola vez acá. La imagen se estira a la
 * medida de la losa, y por eso el arte se pide con la proporción que el juego
 * necesita —4,6 la central y 1,41 las laterales—; con otra proporción el dibujo
 * entra igual pero deformado.
 */
function buildStageSprites(art: StagePlatforms): Sprite[] {
  const sprites: Sprite[] = [];
  for (let i = 0; i < PLATFORM_COUNT; i++) {
    const sprite = new Sprite(i === 0 ? art.centro : art.lado);
    // Anclado arriba y al medio: `topY` es justamente la cara de arriba, que es
    // lo que la física usa como piso.
    sprite.anchor.set(0.5, 0);
    sprite.x = platformCenterX(i);
    sprite.width = platformHalfWidth(i) * 2;
    sprite.height = (i === 0 ? PLATFORM_THICK_CENTER : PLATFORM_THICK_SIDE) + 0.14;
    sprites.push(sprite);
  }
  return sprites;
}

function drawStage(g: Graphics, match: Match): void {
  g.clear();
  for (let i = 0; i < PLATFORM_COUNT; i++) {
    const cx = platformCenterX(i);
    const half = platformHalfWidth(i);
    const top = match.skyline.topY[i];
    const thickness = i === 0 ? PLATFORM_THICK_CENTER : PLATFORM_THICK_SIDE;

    // Tres bandas sólidas: filo claro, cara media y sombra dura. Sin degradés
    // ni ruido — la ficha de estilo es vector plano.
    g.rect(cx - half, -top, half * 2, 0.14).fill(PLATFORM_TOP);
    g.rect(cx - half, -top + 0.14, half * 2, thickness * 0.45).fill(PLATFORM_FACE);
    g.rect(cx - half, -top + 0.14 + thickness * 0.45, half * 2, thickness * 0.55)
      .fill(PLATFORM_SHADE);
    g.rect(cx - half, -top, half * 2, thickness + 0.14)
      .stroke({ width: 0.07, color: 0x05070d, alignment: 0 });
  }
}

/**
 * Estado de presentación que suaviza lo que la simulación decide de golpe.
 *
 * No vive en `Match` a propósito: son constantes de cómo SE VE el movimiento,
 * y la simulación no tiene por qué saber cuánto tarda un dibujo en darse
 * vuelta. Es el mismo criterio por el que `action` y `actionAge` están acá.
 */
interface Suavizado {
  /** Hacia dónde mira el dibujo, de -1 a 1. Cruza el cero al darse vuelta. */
  giro: Float32Array;
  /** El aplastón que dejó el aterrizaje, apagándose solo. */
  golpePiso: Float32Array;
  /** Si venía por el aire, para pescar el instante en que toca el piso. */
  volaba: Uint8Array;
  /** La velocidad vertical del frame anterior: la de impacto. */
  vyPrevia: Float32Array;
}

/**
 * A qué velocidad se da vuelta el dibujo, en unidades de `facing` por segundo.
 *
 * `match.facing` salta de -1 a 1 en un frame y espejar el dibujo de golpe es
 * exactamente el tirón que se ve como movimiento duro. A 9 por segundo la
 * vuelta entera tarda 0,22 s: se lee como que el personaje gira, y sigue siendo
 * lo bastante rápido como para no mentir sobre hacia dónde está pegando.
 */
const GIRO_POR_SEGUNDO = 14;
/**
 * Lo más angosto que se deja ver el dibujo mientras se da vuelta.
 *
 * Un dibujo plano NO TIENE PERFIL: llevar su ancho a cero no lo muestra de
 * canto, lo borra. Como `giro` cruza el cero, había uno o dos cuadros en los
 * que el peleador medía cero píxeles de ancho y desaparecía — que es
 * exactamente el parpadeo que se ve al cambiar de lado.
 *
 * Entonces el ancho no baja de este piso y el SIGNO cruza de golpe: se angosta
 * hasta un tercio, espeja, y se vuelve a abrir. Eso sí se lee como que gira, y
 * es además lo que hace un juego de pelea de verdad, que espeja el sprite.
 */
const GIRO_MINIMO = 0.34;
/**
 * Cuánto se estira a lo alto mientras se angosta.
 *
 * Un cuerpo que se comprime de un lado se abulta del otro: sin eso, angostarse
 * al 34% se lee como que el personaje se aplasta contra un vidrio, no como que
 * gira. Con la compensación el volumen se conserva a ojo y la vuelta se lee
 * como una vuelta. Es la mitad barata de lo que haría una animación de giro
 * dibujada, que es lo que no tenemos: el arte de los seis está dibujado de
 * perfil y de un solo lado, así que un giro de verdad habría que dibujarlo.
 */
const GIRO_ALTO = 0.16;
/** Cuánto aplasta el aterrizaje más fuerte, y en cuánto se apaga. */
const GOLPE_PISO = 0.16;
const GOLPE_PISO_DECAE = 5.5;

/** El ancho con signo que le toca al dibujo para un `giro` de -1 a 1. */
function anchoDelGiro(giro: number): number {
  return (giro < 0 ? -1 : 1) * (GIRO_MINIMO + (1 - GIRO_MINIMO) * Math.min(1, Math.abs(giro)));
}

function drawFighters(
  views: FighterView[], match: Match,
  renderX: Float64Array, renderY: Float64Array,
  action: Uint8Array, actionAge: Float32Array,
  suave: Suavizado,
  dt: number, elapsed: number,
  cobrarGolpe: (slot: number, x: number, y: number) => void,
): void {
  for (let i = 0; i < views.length; i++) {
    const view = views[i];
    if (match.slot[i] !== SLOT_ACTIVE) {
      // `views` está indexado por SLOT pero las instancias son por ARMADURA
      // (`viewByArmature`, más arriba): con seis peleadores nada más, dos
      // slots pueden apuntar al mismo `FighterView` si uno de ellos nunca se
      // activó. En torneo eso pasa siempre a partir del segundo relevo: el
      // slot 1 y el slot 2 arrancan mirando a Mako y Asuri por defecto y
      // JAMÁS se activan (en torneo sólo entra el slot 0 de cada bando), así
      // que cuando el slot 0 relevado pasa a ser Mako, este mismo bucle —en
      // la vuelta que le toca al slot 1, que sigue "inactivo" pero comparte
      // la vista de Mako— la volvía a ocultar en el mismo cuadro en que el
      // slot 0 la acababa de mostrar. Resultado: el segundo y tercer
      // peleador del plantel casi nunca se veían. Antes de apagar una vista,
      // hay que confirmar que ningún OTRO slot activo la esté usando ahora.
      let enUsoPorOtro = false;
      for (let j = 0; j < views.length; j++) {
        if (j !== i && match.slot[j] === SLOT_ACTIVE && views[j] === view) {
          enUsoPorOtro = true;
          break;
        }
      }
      if (!enUsoPorOtro) view.visible = false;
      // Un slot que vuelve a entrar no puede heredar la patada del anterior,
      // ni darse vuelta desde donde quedó el que se fue.
      action[i] = ACT_NONE;
      suave.giro[i] = match.facing[i];
      suave.golpePiso[i] = 0;
      continue;
    }
    view.visible = true;
    // La posición INTERPOLADA, no la del último paso de física a secas —
    // ver el comentario de `prevX`/`prevY` en `startGame`. `cobrarGolpe`,
    // más abajo, sigue usando `match.x`/`match.y`: el golpe tiene que salir
    // donde la simulación dice que conectó, no donde el dibujo lo suaviza.
    view.x = renderX[i];
    view.y = -renderY[i];

    // La acción corre con el reloj de pantalla, no con el de la simulación: es
    // una animación, y tiene que seguir avanzando durante el hitstop o el golpe
    // se vería congelado a mitad de camino.
    if (action[i] !== ACT_NONE) {
      const total = ACTION_TIME[action[i]];
      const antes = actionAge[i];
      actionAge[i] += dt;
      // El cruce y no el "ya pasó": si preguntara por mayor o igual, el golpe se
      // cobraría en todos los frames que quedan de la acción.
      const golpe = ACTION_HIT[action[i]] * total;
      if (antes < golpe && actionAge[i] >= golpe) {
        cobrarGolpe(i, match.x[i], match.y[i]);
      }
      if (actionAge[i] >= total) action[i] = ACT_NONE;
    }
    const duration = ACTION_TIME[action[i]];
    const progress = duration > 0 ? actionAge[i] / duration : 0;
    const hurt = match.clock - match.hitstun[i] < HITSTUN;

    // El giro se calcula ANTES de posar y no después: `pose()` necesita saber
    // qué tan adentro del giro está para elegir entre el cuadro de la acción y
    // el de frente, y calcularlo con el `giro` del frame pasado lo dejaría un
    // cuadro atrasado justo en el momento más visible.
    const paso = GIRO_POR_SEGUNDO * dt;
    suave.giro[i] += Math.max(-paso, Math.min(paso, match.facing[i] - suave.giro[i]));
    // `vuelta` vale 0 mirando de frente a su lado y 1 en el medio del giro.
    const vuelta = 1 - Math.min(1, Math.abs(suave.giro[i]));

    view.pose(
      match.vx[i], match.vy[i], match.grounded[i] === 1, hurt,
      action[i], progress, elapsed, vuelta,
    );

    // Al tocar el piso la simulación pone `vy` en cero en el mismo frame, así
    // que el aplastón de abajo se apagaría justo cuando tendría que verse. Este
    // se dispara con la velocidad con la que LLEGÓ —la del frame anterior— y se
    // apaga solo.
    const enPiso = match.grounded[i] === 1;
    if (enPiso && suave.volaba[i] === 1) {
      suave.golpePiso[i] = Math.min(1, Math.abs(suave.vyPrevia[i]) / 12);
    }
    suave.volaba[i] = enPiso ? 0 : 1;
    suave.vyPrevia[i] = match.vy[i];
    suave.golpePiso[i] = Math.max(0, suave.golpePiso[i] - dt * GOLPE_PISO_DECAE);

    // Squash & stretch: se estira al subir y se aplasta al caer. Es lo que
    // separa un muñeco que se traslada de uno que se mueve.
    const stretch = Math.max(-0.22, Math.min(0.18,
      match.vy[i] * 0.014 - suave.golpePiso[i] * GOLPE_PISO));
    const scale = match.scale[i];
    // Más allá de `UMBRAL_GIRO_FRENTE` el cuadro que se está mostrando ya es el
    // de frente —lo decide `pose()`— así que angostarlo además sería angostar
    // un dibujo que ya mira a cámara: se lee como que se aplasta contra un
    // vidrio. Se DESHACE el angostamiento a medida que entra a esa zona, con la
    // misma curva con la que entró, para que no haya un salto en el borde.
    const abre = Math.max(0, (vuelta - UMBRAL_GIRO_FRENTE) / (1 - UMBRAL_GIRO_FRENTE));
    const anchoBase = anchoDelGiro(suave.giro[i]);
    const ancho = anchoBase + (Math.sign(anchoBase) * 1 - anchoBase) * abre;
    view.scale.x = scale * ancho * (1 - stretch);
    view.scale.y = scale * (1 + stretch) * (1 + vuelta * GIRO_ALTO);
    // El contenedor está en el CENTRO del cuerpo, así que estirarlo o aplastarlo
    // le despega los pies del piso: un personaje que aterriza se hundía y uno
    // que salta se iba para arriba antes de despegar. Correr el centro medio
    // aplastón deja los pies clavados, que es de donde sale la sensación de
    // peso.
    // El estirón del giro también levanta el centro, así que los pies se
    // despegarían de la losa justo en el cuadro más visible de la vuelta.
    view.y = -match.y[i]
      - (stretch + vuelta * GIRO_ALTO) * FIGHTER_HALF_HEIGHT * scale;

    // El baile del final. Se compone acá y no sale de la hoja porque ninguno de
    // los seis tiene una animación de baile: lo que hay es una pose de pie. Con
    // un salto, una inclinación y un balanceo que se contrapesan alcanza, y es
    // la misma capa que ya hace el squash & stretch.
    //
    // Cada uno entra con su propio desfase. Tres muñecos saltando exactamente
    // juntos no se leen como que festejan, se leen como un error.
    if (match.state.ganador >= 0 && match.team[i] === match.state.ganador) {
      const fase = elapsed * 2.4 + i * 0.9;
      view.y -= Math.abs(Math.sin(fase)) * 0.36;
      view.rotation = Math.sin(fase * 0.5) * 0.18;
      const rebote = Math.cos(fase * 2) * 0.09;
      view.scale.x = scale * ancho * (1 - rebote);
      view.scale.y = scale * (1 + rebote);
    } else if (view.rotation !== 0) {
      view.rotation = 0;
    }
  }
}

/**
 * Dibuja los poderes que están viajando por el escenario.
 *
 * Se dibuja como un COMETA y no como una bola: una bola en vuelo no se lee, se
 * ve como una pelota flotando. Lo que dice "esto va a algún lado" es la cola,
 * que apunta hacia atrás en el sentido en el que viaja, y que además le dice al
 * que mira de dónde salió el disparo sin tener que haber estado mirando cuando
 * salió.
 *
 * Va todo por geometría y no por partículas a propósito: la cola tiene que
 * estar exactamente detrás de la cabeza en el cuadro en que se dibuja, y un
 * pool de partículas da un rastro que se queda atrás cuando el poder acelera o
 * cuando la pantalla va a 30 fps.
 *
 * Las tres capas son las mismas que usa el resto del juego: `glow` lleva Bloom
 * y es donde va la energía, `ink` queda afuera y es lo que le pone el contorno
 * negro que tienen los personajes y las llamas. Sin el contorno el poder se ve
 * como una luz de motor gráfico y no como algo dibujado.
 */
function dibujarPoderes(
  glow: Graphics, ink: Graphics, match: Match,
  renderPX: Float64Array, renderPY: Float64Array, elapsed: number,
): void {
  glow.clear();
  ink.clear();
  const p = match.poderes;
  for (let k = 0; k < PODERES; k++) {
    if (p.vida[k] <= 0) continue;
    // Posición interpolada, no la del último paso a secas — igual razón que
    // `renderX`/`renderY` de los peleadores, y acá pesa más: un poder viaja
    // rápido de punta a punta de la pantalla.
    const px = renderPX[k];
    const py = -renderPY[k];
    // En pantalla el eje Y va al revés que en el mundo, así que la cola se
    // orienta con la velocidad ya dada vuelta o apunta para el lado contrario.
    const ang = Math.atan2(-p.vy[k], p.vx[k]);
    const color = p.team[k] === TEAM_GREEN ? GREEN : RED;
    const fuerza = Math.min(1, p.fuerza[k]);
    const r = 0.26 + fuerza * 0.34;
    // Late. Una bola de energía de tamaño fijo se ve como un sprite pegado a la
    // pantalla; el latido es lo que la hace estar viva.
    const pulso = 1 + Math.sin(elapsed * 26 + k * 1.7) * 0.09;
    const cos = Math.cos(ang);
    const sen = Math.sin(ang);

    /* --- la cola: capas que se apagan hacia afuera -------------------- */
    // Nace recién cuando el poder ya salió: los primeros centímetros de vuelo
    // no pueden tener una estela de dos metros.
    const salida = Math.min(1, (PODER_VIDA - p.vida[k]) * 6);
    const largo = r * (5.5 + fuerza * 3.5) * salida;
    if (largo > 0.01) {
      const nx = -sen;
      const ny = cos;
      // Tres gotas metidas una adentro de la otra, cada una más corta, más
      // angosta y más opaca. Sumadas dan una CAÍDA: el borde de afuera queda
      // apenas insinuado y el centro casi sólido, que es como se ve una llama.
      //
      // Antes era una sola gota de alfa plana con un contorno negro encima, y
      // eso es exactamente lo que la hacía ver como un triángulo de papel:
      // una figura recortada tiene borde, una luz no.
      const capas: Array<[number, number, number]> = [
        [1, 1, 0.16],
        [0.62, 0.66, 0.28],
        [0.3, 0.4, 0.5],
      ];
      for (const [fl, fa, alfa] of capas) {
        const lg = largo * fl;
        const an = r * 0.92 * fa;
        const bocaX = px + cos * r * 0.35;
        const bocaY = py + sen * r * 0.35;
        glow.moveTo(bocaX + nx * an, bocaY + ny * an);
        glow.quadraticCurveTo(
          px - cos * lg * 0.45 + nx * an * 0.6,
          py - sen * lg * 0.45 + ny * an * 0.6,
          px - cos * lg, py - sen * lg,
        );
        glow.quadraticCurveTo(
          px - cos * lg * 0.45 - nx * an * 0.6,
          py - sen * lg * 0.45 - ny * an * 0.6,
          bocaX - nx * an, bocaY - ny * an,
        );
        glow.fill({ color, alpha: alfa });
      }
    }

    /* --- la cabeza ---------------------------------------------------- */
    const rr = r * pulso;
    // Aura, cuerpo del color del bando, y núcleo blanco. Los tres anillos son
    // lo mismo que hace `FX_ORB`: es lo que le da el borde duro de dibujo en
    // vez del degradé de una luz.
    // Seis anillos y no tres. Con tres el salto de alfa entre uno y otro se ve
    // como un escalón y la bola queda con aros concéntricos; con seis el ojo ya
    // no separa los bordes y lee un degradé. Es un degradé hecho a mano, que es
    // lo único que hay: `Graphics` no rellena con degradé radial.
    const anillos: Array<[number, number, number]> = [
      [1.9, 0.1, color],
      [1.5, 0.2, color],
      [1.2, 0.4, color],
      [1.0, 0.85, color],
      [0.66, 0.7, 0xffffff],
      [0.4, 0.98, 0xffffff],
    ];
    for (const [f, alfa, c] of anillos) {
      glow.circle(px, py, rr * f);
      glow.fill({ color: c, alpha: alfa });
    }

    // Adentro, una estrella de cuatro puntas girando. Es la "textura" del
    // poder: sin nada adentro el núcleo es un círculo blanco plano, y un
    // círculo blanco plano no se lee como energía comprimida.
    const giro = elapsed * 5.5 + k;
    for (let n = 0; n < 4; n++) {
      const a = giro + (n * Math.PI) / 2;
      const punta = rr * 0.86;
      const ancho = rr * 0.16;
      glow.moveTo(px + Math.cos(a) * punta, py + Math.sin(a) * punta);
      glow.lineTo(px + Math.cos(a + 1.57) * ancho, py + Math.sin(a + 1.57) * ancho);
      glow.lineTo(px + Math.cos(a - 1.57) * ancho, py + Math.sin(a - 1.57) * ancho);
    }
    glow.fill({ color: 0xffffff, alpha: 0.7 });

    // Sin contorno negro. El contorno le da borde de calcomanía a algo que
    // tiene que ser luz: en el juego se veía un decágono negro con relleno
    // adentro, porque el círculo de `Graphics` es un polígono y el trazo lo
    // delata. Lo que separa el poder del fondo es el Bloom, no una línea.
  }
}

/**
 * Las dos barras negras del plano cerrado.
 *
 * Entran de golpe y salen deslizando: `min(1, p * 4)` está lleno mientras queda
 * más de un cuarto del plano y recién ahí baja. Un corte de cámara es un corte
 * —no un fundido— pero la vuelta a la pelea sí tiene que sentirse como que se
 * abre el cuadro.
 */
/**
 * El fotograma de impacto: la pantalla entera de un color por dos o tres
 * cuadros.
 *
 * Se apaga con una curva y no en línea recta —`p * p`— porque en línea recta el
 * fogonazo se ve como una transición de medio segundo mal hecha. Con el
 * cuadrado sale casi todo el brillo en el primer cuadro y lo que queda es una
 * cola corta, que es como se comporta la luz de verdad y como está dibujado en
 * los originales.
 */
function dibujarDestello(
  g: Graphics, app: Application, resta: number, total: number, color: number,
): void {
  g.clear();
  if (resta <= 0 || total <= 0) return;
  const p = resta / total;
  const { ancho, alto } = pantalla(app);
  g.rect(0, 0, ancho, alto);
  g.fill({ color, alpha: DESTELLO_ALFA * p * p });
}

function dibujarCine(g: Graphics, app: Application, resta: number): void {
  g.clear();
  if (resta <= 0) return;
  const { ancho, alto } = pantalla(app);
  const p = Math.min(1, resta / CINE_TIEMPO);
  const franja = alto * CINE_BARRA * Math.min(1, p * 4);
  if (franja < 0.5) return;
  g.rect(0, 0, ancho, franja);
  g.rect(0, alto - franja, ancho, franja);
  g.fill({ color: 0x05070d, alpha: 0.96 });
}

/** Arranca una acción, pisando la que hubiera. */
function startAction(
  action: Uint8Array, actionAge: Float32Array, slot: number, kind: number,
): void {
  if (slot < 0 || slot >= action.length) return;
  action[slot] = kind;
  actionAge[slot] = 0;
}

/**
 * `aspect` es alto/ancho de la ventana. Hace falta para acotar la altura de la
 * cámara EN PROPORCIÓN a lo que se ve, no con un número fijo.
 */
/* --- las barras de fuerza -------------------------------------------- */

/** Ancho y alto de una barra, en unidades de mundo. */
const BAR_WIDTH = 0.95;
const BAR_HEIGHT = 0.11;
/** Cuánto sube la barra por encima de la cabeza. */
const BAR_LIFT = 0.34;
const BAR_BACK = 0x11161f;
const BAR_GOLD = 0xffcc33;

/**
 * La barra de fuerza de cada peleador, arriba de la cabeza.
 *
 * Sin esto el sistema entero es invisible: se ve que alguien pega más fuerte que
 * otro y no hay forma de saber por qué. La barra es lo que convierte "pegó
 * fuerte" en "venía cargado", que es la lectura del libro que la pelea tiene que
 * entregar.
 *
 * Con la barra por encima de `COST_SUPER` se le pinta el marco en dorado: es
 * cómo se sabe que el super está a un cuadro de salir, antes de que salga.
 */
function drawBars(g: Graphics, match: Match): void {
  g.clear();
  for (let i = 0; i < match.slot.length; i++) {
    if (match.slot[i] !== SLOT_ACTIVE) continue;
    const scale = match.scale[i];
    const x = match.x[i] - BAR_WIDTH / 2;
    // `y` del mundo crece hacia arriba y el de la pantalla hacia abajo: la capa
    // del mundo ya está invertida, así que acá se resta para subir.
    const y = -(match.y[i] + FIGHTER_HALF_HEIGHT * scale + BAR_LIFT);
    const fill = match.energy[i];
    const cargado = fill >= COST_SUPER;

    g.rect(x, y, BAR_WIDTH, BAR_HEIGHT).fill({ color: BAR_BACK, alpha: 0.75 });
    if (fill > 0) {
      g.rect(x, y, BAR_WIDTH * fill, BAR_HEIGHT)
        .fill(match.team[i] === TEAM_GREEN ? GREEN : RED);
    }
    g.rect(x, y, BAR_WIDTH, BAR_HEIGHT).stroke({
      width: cargado ? 0.035 : 0.018,
      color: cargado ? BAR_GOLD : 0x000000,
      alpha: cargado ? 1 : 0.55,
    });
  }
}

function updateCamera(camera: Camera, match: Match, dt: number, aspect: number): void {
  // El plano cerrado que reemplazaba el encuadre de grupo por un primer
  // plano de quien tiró el super SE SACÓ. Reportado con video real: "el
  // zoom de cámara es el error, pierde el foco de la pelea" -- literal,
  // durante 1,3s la cámara dejaba de mostrar al rival por completo. Con las
  // especiales ahora saliendo dentro del forcejeo (ver ALCANCE en
  // match.ts), el super pasó de ser un momento raro a uno frecuente, así
  // que ese corte pasó de ocasional a constante. Pedido explícito: cámara
  // fija, con mínimo acercamiento lento -- eso lo sigue dando el punch-in
  // de `zoomTarget` más abajo (suavizado, ver `ZOOM_CLAVE`), no un corte de
  // plano. `camera.cine` sigue contando para las barras de letterbox
  // (`dibujarCine`) -- el look cinematográfico queda, sólo que sin mover la
  // cámara lejos de la pelea.
  camera.cine = Math.max(0, camera.cine - dt);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let i = 0; i < match.slot.length; i++) {
    if (match.slot[i] !== SLOT_ACTIVE) continue;
    count++;
    if (match.x[i] < minX) minX = match.x[i];
    if (match.x[i] > maxX) maxX = match.x[i];
    if (match.y[i] < minY) minY = match.y[i];
    if (match.y[i] > maxY) maxY = match.y[i];
  }

  let targetX = 0;
  let targetY = 2.5;
  let targetHalf = MAX_HALF_WIDTH;
  if (count > 0) {
    targetX = (minX + maxX) / 2;
    targetY = (minY + maxY) / 2;
    // El encuadre contiene a los peleadores Y al escenario: seguir sólo a los
    // personajes deja el ring fuera de cuadro justo cuando se juntan, que es
    // cuando más falta hace ver dónde está el borde.
    targetHalf = Math.max((maxX - minX) / 2 + 3, MIN_HALF_WIDTH);
  }

  targetX = Math.max(-PAN_LIMIT_X, Math.min(PAN_LIMIT_X, targetX));
  // El piso vive en y≈0 y el marcador ocupa la franja de abajo de la pantalla:
  // si la cámara mira muy alto, el escenario termina detrás del HUD.
  //
  // El límite es una FRACCIÓN del alto visible, no un número de unidades. Con el
  // tope fijo en 4,5 que había antes, al cerrar el zoom para agrandar a los
  // personajes las nueve losas se iban abajo de la pantalla: 4,5 era medio alto
  // visible con la cámara vieja y es un alto entero con la nueva. Atado al alto
  // visible, el piso queda a la misma altura de cuadro con cualquier zoom.
  const halfHeight = camera.halfWidth * aspect;
  targetY = Math.max(
    CAMERA_Y_LOW * halfHeight,
    Math.min(CAMERA_Y_HIGH * halfHeight, targetY * 0.7 + 1),
  );
  // El tope por alto manda incluso sobre `MIN_HALF_WIDTH`: si el mínimo pudiera
  // pisarlo, en vertical volveríamos a ver veinte unidades de alto y los
  // personajes seguirían siendo hormigas. Ver `MAX_HALF_HEIGHT`.
  const topeAlto = aspect > 0 ? MAX_HALF_HEIGHT / aspect : MAX_HALF_WIDTH;
  const techo = Math.min(MAX_HALF_WIDTH, topeAlto);
  const piso = Math.min(MIN_HALF_WIDTH, techo);
  targetHalf = Math.max(piso, Math.min(techo, targetHalf));
  // Y recién acá el primer plano, por encima del mínimo. El target decae en
  // línea recta —así se sentía antes—, pero lo que de verdad mueve la cámara
  // es `zoom`, que lo persigue en curva: eso saca el salto que había cuando un
  // golpe entraba a mitad de la vuelta de otro.
  camera.zoomTarget = Math.max(0, camera.zoomTarget - dt * ZOOM_DECAE);
  camera.zoom += (camera.zoomTarget - camera.zoom) * (1 - Math.exp(-ZOOM_LAMBDA * dt));
  targetHalf *= 1 - ZOOM_CLAVE * camera.zoom;

  const k = 1 - Math.exp(-CAMERA_LAMBDA * dt);
  camera.x += (targetX - camera.x) * k;
  camera.y += (targetY - camera.y) * k;
  camera.halfWidth += (targetHalf - camera.halfWidth) * k;
}

/**
 * El tamaño de la pantalla en píxeles CSS, que es en lo que piensa todo el
 * dibujo: la cámara, el encaje del escenario y las dos hogueras.
 *
 * **`renderer.width` NO son píxeles físicos.** En Pixi v8 es `screen.width`, o
 * sea que ya viene en píxeles CSS; los físicos están en `renderer.canvas.width`.
 * Cuatro lugares de este archivo lo dividían por `resolution` creyendo lo
 * contrario, y ese error es invisible en un monitor común —ahí `resolution` es 1
 * y dividir no hace nada— pero en cualquier pantalla retina o teléfono vale 2 y
 * **el mundo entero se dibujaba a la mitad, apretado contra el rincón de
 * arriba a la izquierda**, con el resto del lienzo pintado de fondo. Así se veía
 * en el teléfono, y por eso ninguna captura headless a dpr 1 lo mostraba.
 *
 * La regla de `?medir` fue la que lo cerró: `renderer 402 x 714 @2x` contra
 * `buffer 804 x 1428` dice exactamente cuál de los dos es cuál.
 */
function pantalla(app: Application): { ancho: number; alto: number } {
  return { ancho: app.renderer.width, alto: app.renderer.height };
}

function applyCamera(world: Container, app: Application, camera: Camera, shake: number): void {
  const { ancho: width, alto: height } = pantalla(app);
  const scale = width / (camera.halfWidth * 2);

  const jitterX = shake > 0 ? (Math.random() * 2 - 1) * shake * SHAKE_GAIN : 0;
  const jitterY = shake > 0 ? (Math.random() * 2 - 1) * shake * SHAKE_GAIN : 0;

  world.scale.set(scale);
  world.x = width / 2 - (camera.x + jitterX) * scale;
  world.y = height / 2 + (camera.y + jitterY) * scale;
}

export { FIGHTER_HALF_HEIGHT };
