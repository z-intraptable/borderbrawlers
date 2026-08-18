import { Application, Assets, Container, Graphics, Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters/advanced-bloom';
import { ShockwaveFilter } from 'pixi-filters/shockwave';
import type { Match } from '../game/match';
import {
  EVENT_GROW,
  EVENT_HIT,
  EVENT_KO,
  EVENT_LAND,
  EVENT_MELEE,
  EVENT_SKILL,
  EVENT_SUPER,
  FIGHTER_HALF_HEIGHT,
  HITSTUN,
  PLATFORM_COUNT,
  STAGE_HALF_WIDTH,
  platformCenterX,
  platformHalfWidth,
  stepMatch,
  updateStageFromBook,
} from '../game/match';
import { SLOT_ACTIVE, TEAM_GREEN } from '../game/fighters';
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
import { createSpriteFighterView } from '../art/spriteFighter';
import { ROSTER, characterFor } from '../game/roster';
import { burst, createFx, drawFx, dust, ring, trail, updateFx } from './fx';
import { createBackdrop } from './backdrop';
import { createStage, loadFlames, loadPlatforms, loadStage, stageNames, stageTint } from './stage';
import type { StagePlatforms } from './stage';

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
const GOLD = 0xffd700;
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
 */
const RITMO = 0.5;
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
const MIN_HALF_WIDTH = 5.5;
const MAX_HALF_WIDTH = STAGE_HALF_WIDTH + 1;
const CAMERA_LAMBDA = 3.2;
/**
 * Hasta dónde puede subir y bajar la mirada de la cámara, como fracción del alto
 * visible. Con 0,55 el piso del escenario queda a poco más de tres cuartos de
 * pantalla: abajo del centro, arriba del marcador.
 */
const CAMERA_Y_HIGH = 0.55;
const CAMERA_Y_LOW = 0.28;
const PAN_LIMIT_X = STAGE_HALF_WIDTH * 0.3;
const SHAKE_GAIN = 0.35;

/** A partir de esta rapidez, el peleador deja estela. */
const TRAIL_SPEED = 7;
/** Duración de la onda de choque del super, en segundos. */
const SHOCKWAVE_TIME = 0.85;

interface Camera {
  x: number;
  y: number;
  halfWidth: number;
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
    const ancho = host.clientWidth;
    const alto = host.clientHeight;
    if (ancho <= 0 || alto <= 0) return;
    // `renderer.width` viene en píxeles FÍSICOS y `clientWidth` en píxeles CSS:
    // en una pantalla retina son el doble. Comparar sin dividir por la
    // resolución da siempre distinto y se redimensiona en todos los cuadros.
    if (app.renderer.width / app.renderer.resolution === ancho
      && app.renderer.height / app.renderer.resolution === alto) return;
    app.renderer.resize(ancho, alto);
  }

  const observador = new ResizeObserver(encuadrar);
  observador.observe(host);
  encuadrar();

  const backdrop = createBackdrop();
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
    arte: sinColgarse(Promise.all(armatures.map((name) => loadArt(name))), 'el arte cortado'),
    hojas: sinColgarse(Promise.all(armatures.map((name) => loadSheets(name))), 'las hojas de sprites'),
    fuegos: sinColgarse(
      Promise.all([loadFlames('verde'), loadFlames('rojo')]), 'las hogueras'),
  };

  // Las hogueras entran cuando llegan y nadie las espera: hasta entonces el
  // fondo son los cristales de polígonos, que no necesitan cargar nada. Es la
  // única carga de la pantalla que puede llegar tarde sin que se note, así que
  // es la única que no bloquea el arranque.
  void pedidos.fuegos.then((par) => {
    if (par === null) return;
    const [verdes, rojos] = par;
    if (verdes !== null && rojos !== null) backdrop.useFlames(verdes, rojos);
  });

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

  // Se pide el arte de TODA la plantilla una sola vez, en paralelo, y no sólo
  // el de los seis que arrancan: al caerse uno entra otro en el mismo frame, y
  // ahí no hay tiempo de ir a buscar una imagen. El que no lo tenga dibujado
  // todavía devuelve null y sale vectorial, en la misma pelea.
  const loaded = await pedidos.arte ?? armatures.map(() => null);
  const artByArmature = new Map<string, FighterArt | null>(
    armatures.map((name, i) => [name, loaded[i]]),
  );

  // Y las hojas de sprites, con el mismo criterio: el que la tenga se dibuja
  // cuadro por cuadro, el que no sigue con el muñeco de piezas. Los dos en la
  // misma pelea.
  const sheeted = await pedidos.hojas ?? armatures.map(() => null);
  const sheetsByArmature = new Map<string, FighterSheets | null>(
    armatures.map((name, i) => [name, sheeted[i]]),
  );

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
  const bars = new Graphics();
  world.addChild(bars);

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
   * La capa que brilla. Es hija de `world` para heredar la cámara, y lleva el
   * Bloom puesto encima.
   */
  const glowFx = new Graphics();
  const glowLayer = new Container();
  glowLayer.addChild(glowFx);
  glowLayer.filters = [new AdvancedBloomFilter({
    threshold: 0.35,
    bloomScale: 1.25,
    brightness: 1.05,
    blur: 5,
    quality: 4,
  })];
  world.addChild(glowLayer);

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

  const camera: Camera = { x: 0, y: 2.5, halfWidth: MAX_HALF_WIDTH };
  const fx = createFx();

  let accumulator = 0;
  let lastBookId = -1;
  let hitstop = 0;
  let elapsed = 0;

  const tick = (): void => {
    const started = performance.now();
    const frameMs = app.ticker.deltaMS;
    /** Tiempo real, para la cámara y el hitstop. */
    const dt = Math.min(frameMs / 1000, 0.1);
    /** Tiempo de la pelea: el mismo, a la velocidad de `RITMO`. */
    const dtPelea = dt * ritmo;
    elapsed += dtPelea;

    // El escenario se recalcula sólo cuando llega un snapshot nuevo.
    if (client.book.lastUpdateId !== lastBookId && client.book.mid > 0) {
      lastBookId = client.book.lastUpdateId;
      updateStageFromBook(
        match,
        client.book.bidQtys, client.book.bidCount,
        client.book.askQtys, client.book.askCount,
        client.stats.bookQtyMedian,
      );
    }

    if (hitstop > 0) {
      // Durante el hitstop no se acumula tiempo de simulación. No se descarta:
      // simplemente no entra, así que al soltar la pausa la pelea sigue donde
      // estaba en vez de dar un salto para recuperar el atraso.
      hitstop -= dt;
    } else {
      accumulator += Math.min(frameMs, 250) / 1000 * ritmo;
      let steps = 0;
      while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
        stepMatch(match, client.trades, client.stats, FIXED_DT);
        accumulator -= FIXED_DT;
        steps++;
        hitstop = Math.max(hitstop, drainEvents(match, fx));
        if (hitstop > 0) break;
      }
      if (steps >= MAX_STEPS) accumulator = 0;
    }

    if (hitstop > HITSTOP_MAX) hitstop = HITSTOP_MAX;

    // Estelas: sólo el que va rápido de verdad, y siempre — también durante el
    // hitstop, porque congelar los efectos delataría la pausa.
    emitTrails(match, fx);
    updateFx(fx, dtPelea);

    // Antes de dibujar: si la simulación cambió de personaje algún slot, hay
    // que enganchar el cuerpo nuevo. Se hace acá y no adentro de `drainEvents`
    // porque el relevo no es un evento sino un estado — un slot que se llenó
    // durante el hitstop tiene que aparecer con el peleador que le tocó igual.
    relieve(match);

    if (platformSprites === null) drawStage(platforms, match);
    else placeStage(platformSprites, match);
    updateCamera(camera, match, dt, app.renderer.height / app.renderer.width);
    applyCamera(world, app, camera, match.shake);
    drawFighters(views, match, action, actionAge, dtPelea, elapsed, cobrarGolpe);
    drawBars(bars, match);
    drawFx(fx, plainFx, glowFx);

    /* --- fondo ------------------------------------------------------- */
    const width = app.renderer.width / app.renderer.resolution;
    const height = app.renderer.height / app.renderer.resolution;
    const buy = client.stats.buyVolume;
    const sell = client.stats.sellVolume;
    const total = buy + sell;
    const greenShare = total > 0 ? buy / total : 0.5;
    const intensity = Math.min(1, Math.log1p(total) / 12);
    backdrop.update(greenShare, intensity, width, height, elapsed);
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

  function agendar(slot: number, kind: number, magnitude: number, team: number): void {
    if (slot < 0 || slot >= action.length) return;
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
    const magnitude = golpeMagnitud[slot];
    const teamColor = golpeEquipo[slot] === TEAM_GREEN ? GREEN : RED;

    if (kind === ACT_SKILL) {
      ring(fx, x, y, 2.3, 0.42, teamColor);
      burst(fx, x, y, 8, 5, 0.1, 0.4, teamColor);
      return;
    }

    ring(fx, x, y, magnitude, 0.6, GOLD);
    ring(fx, x, y, magnitude * 0.6, 0.45, 0xffffff);
    burst(fx, x, y, 14, 11, 0.2, 0.7, GOLD);
    hitstop = Math.max(hitstop, HITSTOP_SUPER);
    shockwaveTime = 0;
    shockwaveX = x;
    shockwaveY = y;
    world.filters = [shockwave];
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
        case EVENT_HIT:
          burst(target, x, y, 6 + Math.round(magnitude * 5), 6 * magnitude, 0.12, 0.34, 0xfff0c0);
          // Sólo los impactos fuertes —los de una especial o el super— frenan
          // el tiempo. El cuerpo a cuerpo pasa decenas de veces por segundo y
          // congelar en cada roce dejaría la pelea a media velocidad.
          if (magnitude >= 1.2) stop = Math.max(stop, HITSTOP_SKILL);
          break;
        case EVENT_MELEE:
          // La magnitud es cuál de los dos golpes toca: se alternan.
          startAction(action, actionAge, m.events.slot[e],
            magnitude === 0 ? ACT_PUNCH : ACT_KICK);
          break;
        case EVENT_SKILL:
        case EVENT_SUPER:
          // Ni anillo ni chispas todavía: el personaje recién está cargando. Se
          // agenda y lo cobra `agendarGolpe` en el cuadro en que suelta.
          agendar(m.events.slot[e], kind === EVENT_SUPER ? ACT_SUPER : ACT_SKILL,
            magnitude, m.events.team[e]);
          break;
        case EVENT_KO:
          burst(target, x, y, 14, 9, 0.22, 0.8, 0xffffff);
          ring(target, x, y, 2.6, 0.55, teamColor);
          stop = Math.max(stop, HITSTOP_KO);
          break;
        case EVENT_LAND:
          dust(target, x, y - FIGHTER_HALF_HEIGHT, Math.min(1.4, magnitude));
          break;
        case EVENT_GROW:
          ring(target, x, y, 1.4 + magnitude * 0.5, 0.5, GOLD);
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

/** Un punto de estela por frame en el que sale volando. */
function emitTrails(match: Match, target: ReturnType<typeof createFx>): void {
  for (let i = 0; i < match.slot.length; i++) {
    if (match.slot[i] !== SLOT_ACTIVE) continue;
    const speed = Math.hypot(match.vx[i], match.vy[i]);
    if (speed < TRAIL_SPEED) continue;
    const color = match.team[i] === TEAM_GREEN ? GREEN : RED;
    trail(target, match.x[i], match.y[i], 0.3 * match.scale[i], color);
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

function drawFighters(
  views: FighterView[], match: Match,
  action: Uint8Array, actionAge: Float32Array,
  dt: number, elapsed: number,
  cobrarGolpe: (slot: number, x: number, y: number) => void,
): void {
  for (let i = 0; i < views.length; i++) {
    const view = views[i];
    if (match.slot[i] !== SLOT_ACTIVE) {
      view.visible = false;
      // Un slot que vuelve a entrar no puede heredar la patada del anterior.
      action[i] = ACT_NONE;
      continue;
    }
    view.visible = true;
    view.x = match.x[i];
    view.y = -match.y[i];

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

    view.pose(
      match.vx[i], match.vy[i], match.grounded[i] === 1, hurt,
      action[i], progress, elapsed,
    );

    // Squash & stretch: se estira al subir y se aplasta al caer. Es lo que
    // separa un muñeco que se traslada de uno que se mueve.
    const stretch = Math.max(-0.18, Math.min(0.18, match.vy[i] * 0.014));
    const scale = match.scale[i];
    view.scale.x = scale * match.facing[i] * (1 - stretch);
    view.scale.y = scale * (1 + stretch);
  }
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
 * Al elegido para el ultra se le pinta el marco en dorado. Es cómo se sabe a
 * quién le toca el super ANTES de que salga, que es la mitad de la gracia del
 * ciclo por turnos: sin eso el super vuelve a ser una sorpresa.
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
    const elegido = match.growing[match.team[i]] === i;

    g.rect(x, y, BAR_WIDTH, BAR_HEIGHT).fill({ color: BAR_BACK, alpha: 0.75 });
    const fill = match.energy[i];
    if (fill > 0) {
      g.rect(x, y, BAR_WIDTH * fill, BAR_HEIGHT)
        .fill(match.team[i] === TEAM_GREEN ? GREEN : RED);
    }
    g.rect(x, y, BAR_WIDTH, BAR_HEIGHT).stroke({
      width: elegido ? 0.035 : 0.018,
      color: elegido ? BAR_GOLD : 0x000000,
      alpha: elegido ? 1 : 0.55,
    });
  }
}

function updateCamera(camera: Camera, match: Match, dt: number, aspect: number): void {
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
  targetHalf = Math.max(MIN_HALF_WIDTH, Math.min(MAX_HALF_WIDTH, targetHalf));

  const k = 1 - Math.exp(-CAMERA_LAMBDA * dt);
  camera.x += (targetX - camera.x) * k;
  camera.y += (targetY - camera.y) * k;
  camera.halfWidth += (targetHalf - camera.halfWidth) * k;
}

function applyCamera(world: Container, app: Application, camera: Camera, shake: number): void {
  const width = app.renderer.width / app.renderer.resolution;
  const height = app.renderer.height / app.renderer.resolution;
  const scale = width / (camera.halfWidth * 2);

  const jitterX = shake > 0 ? (Math.random() * 2 - 1) * shake * SHAKE_GAIN : 0;
  const jitterY = shake > 0 ? (Math.random() * 2 - 1) * shake * SHAKE_GAIN : 0;

  world.scale.set(scale);
  world.x = width / 2 - (camera.x + jitterX) * scale;
  world.y = height / 2 + (camera.y + jitterY) * scale;
}

export { FIGHTER_HALF_HEIGHT };
