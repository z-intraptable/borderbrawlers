import { Application, Container, Graphics } from 'pixi.js';
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
import { characterFor } from '../game/roster';
import { burst, createFx, drawFx, dust, ring, trail, updateFx } from './fx';
import { createBackdrop } from './backdrop';

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
const PLATFORM_TOP = 0xe8f1ff;
const PLATFORM_FACE = 0x5a6d92;
const PLATFORM_SHADE = 0x2b3552;

/** Paso fijo de simulación. La física no depende de los fps del monitor. */
const FIXED_DT = 1 / 60;
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

const MIN_HALF_WIDTH = 8;
const MAX_HALF_WIDTH = STAGE_HALF_WIDTH + 5;
const CAMERA_LAMBDA = 3.2;
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

export async function startGame(
  host: HTMLElement,
  match: Match,
  client: BinanceFeedClient,
  onFrame: (ms: number) => void,
): Promise<GameHandle> {
  const app = new Application();
  await app.init({
    background: 0x0b0f19,
    resizeTo: host,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  });
  host.appendChild(app.canvas);

  const backdrop = createBackdrop();
  app.stage.addChild(backdrop.view);

  /** Contenedor del mundo: acá vive la cámara, como escala y posición. */
  const world = new Container();
  app.stage.addChild(world);

  const platforms = new Graphics();
  world.addChild(platforms);

  /** Polvo y sombras: no brillan, van con el resto del mundo. */
  const plainFx = new Graphics();
  world.addChild(plainFx);

  // Se pide el arte de cada personaje una sola vez, en paralelo. El que no lo
  // tenga dibujado todavía devuelve null y sale vectorial, en la misma pelea.
  const armatures = [...new Set(
    Array.from(match.slot, (_, i) => characterFor(match.team[i], match.character[i]).armature),
  )];
  const loaded = await Promise.all(armatures.map((name) => loadArt(name)));
  const artByArmature = new Map<string, FighterArt | null>(
    armatures.map((name, i) => [name, loaded[i]]),
  );

  /**
   * Un cuerpo articulado por slot. El personaje que le toca a cada slot es fijo
   * —un slot no cambia de bando— así que la silueta se resuelve una sola vez.
   */
  const views: FighterView[] = [];
  for (let i = 0; i < match.slot.length; i++) {
    const character = characterFor(match.team[i], match.character[i]);
    const view = createFighterView(
      lookFor(character.armature),
      match.team[i] === TEAM_GREEN ? GREEN : RED,
      artByArmature.get(character.armature) ?? null,
    );
    view.visible = false;
    world.addChild(view);
    views.push(view);
  }

  /**
   * Qué acción está reproduciendo cada peleador y hace cuánto. Vive en la capa
   * de render y no en la simulación: es estado de presentación, y meterlo en
   * `Match` obligaría a la simulación a saber cuánto dura una animación.
   */
  const action = new Uint8Array(match.slot.length);
  const actionAge = new Float32Array(match.slot.length);

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
    const dt = Math.min(frameMs / 1000, 0.1);
    elapsed += dt;

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
      accumulator += Math.min(frameMs, 250) / 1000;
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
    updateFx(fx, dt);

    drawStage(platforms, match);
    updateCamera(camera, match, dt);
    applyCamera(world, app, camera, match.shake);
    drawFighters(views, match, action, actionAge, dt, elapsed);
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
    app.renderer.background.color = backdrop.skyColor(greenShare);

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
          startAction(action, actionAge, m.events.slot[e], ACT_SKILL);
          ring(target, x, y, 2.3, 0.42, teamColor);
          burst(target, x, y, 8, 5, 0.1, 0.4, teamColor);
          break;
        case EVENT_SUPER:
          startAction(action, actionAge, m.events.slot[e], ACT_SUPER);
          ring(target, x, y, magnitude, 0.6, GOLD);
          ring(target, x, y, magnitude * 0.6, 0.45, 0xffffff);
          burst(target, x, y, 14, 11, 0.2, 0.7, GOLD);
          stop = Math.max(stop, HITSTOP_SUPER);
          shockwaveTime = 0;
          shockwaveX = x;
          shockwaveY = y;
          world.filters = [shockwave];
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
      backdrop.destroy();
      // El caché de `Assets` sobrevive al `Application`: sin esto, cada recarga
      // en caliente de Vite deja otra copia de las hojas en memoria de GPU.
      for (const art of artByArmature.values()) {
        if (art !== null) void unloadArt(art);
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

function drawStage(g: Graphics, match: Match): void {
  g.clear();
  for (let i = 0; i < PLATFORM_COUNT; i++) {
    const cx = platformCenterX(i);
    const half = platformHalfWidth(i);
    const top = match.skyline.topY[i];
    const thickness = i === 0 ? 0.9 : 0.55;

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
      actionAge[i] += dt;
      if (actionAge[i] >= ACTION_TIME[action[i]]) action[i] = ACT_NONE;
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

function updateCamera(camera: Camera, match: Match, dt: number): void {
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
  targetY = Math.max(1.4, Math.min(4.5, targetY * 0.7 + 1));
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
