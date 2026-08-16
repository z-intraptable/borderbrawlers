import { Application, Container, Graphics } from 'pixi.js';
import type { Match } from '../game/match';
import {
  EVENT_HIT,
  EVENT_KO,
  EVENT_SKILL,
  EVENT_SUPER,
  FIGHTER_HALF_HEIGHT,
  PLATFORM_COUNT,
  STAGE_HALF_WIDTH,
  platformCenterX,
  platformHalfWidth,
  stepMatch,
  updateStageFromBook,
} from '../game/match';
import { SLOT_ACTIVE, TEAM_GREEN } from '../game/fighters';
import type { BinanceFeedClient } from '../net/feedCore';
import { createDoll } from '../art/doll';
import type { Doll } from '../art/doll';

/**
 * La capa que dibuja. Lee el estado de la simulación y lo pinta; no decide nada.
 *
 * En Pixi el eje Y crece hacia ABAJO y en el mundo del juego crece hacia
 * arriba, así que todo lo que se coloca lleva la Y negada. Se hace acá y en un
 * solo lugar: mezclar los dos criterios es la forma más rápida de terminar con
 * un escenario dado vuelta y no entender por qué.
 */

const GREEN = 0x00ff66;
const RED = 0xff0055;
const PLATFORM_TOP = 0xe8f1ff;
const PLATFORM_FACE = 0x5a6d92;
const PLATFORM_SHADE = 0x2b3552;

/** Paso fijo de simulación. La física no depende de los fps del monitor. */
const FIXED_DT = 1 / 60;
/** Tope de pasos por frame: tras un hipo, se pierde tiempo antes que congelar. */
const MAX_STEPS = 5;

/* --- cámara --------------------------------------------------------- */

const MIN_HALF_WIDTH = 8;
const MAX_HALF_WIDTH = STAGE_HALF_WIDTH + 5;
const CAMERA_LAMBDA = 3.2;
const PAN_LIMIT_X = STAGE_HALF_WIDTH * 0.3;
const SHAKE_GAIN = 0.35;

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

  /** Contenedor del mundo: acá vive la cámara, como escala y posición. */
  const world = new Container();
  app.stage.addChild(world);

  const platforms = new Graphics();
  world.addChild(platforms);

  const fx = new Graphics();

  const dolls: Doll[] = [];
  for (let i = 0; i < match.slot.length; i++) {
    const doll = createDoll(match.team[i] === TEAM_GREEN ? GREEN : RED);
    doll.visible = false;
    world.addChild(doll);
    dolls.push(doll);
  }
  world.addChild(fx);

  const camera: Camera = { x: 0, y: 2.5, halfWidth: MAX_HALF_WIDTH };

  /* --- efectos: un pool chico de destellos ------------------------- */
  const SPARKS = 24;
  const sparkX = new Float32Array(SPARKS);
  const sparkY = new Float32Array(SPARKS);
  const sparkAge = new Float32Array(SPARKS).fill(99);
  const sparkLife = new Float32Array(SPARKS).fill(1);
  const sparkSize = new Float32Array(SPARKS);
  const sparkColor = new Uint32Array(SPARKS);
  let sparkHead = 0;

  function spark(x: number, y: number, size: number, life: number, color: number): void {
    const i = sparkHead;
    sparkHead = (sparkHead + 1) % SPARKS;
    sparkX[i] = x; sparkY[i] = y; sparkAge[i] = 0;
    sparkLife[i] = life; sparkSize[i] = size; sparkColor[i] = color;
  }

  let accumulator = 0;
  let lastBookId = -1;

  const tick = (): void => {
    const started = performance.now();
    const frameMs = app.ticker.deltaMS;
    accumulator += Math.min(frameMs, 250) / 1000;

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

    let steps = 0;
    while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
      stepMatch(match, client.trades, client.stats, FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;

      for (let e = 0; e < match.events.count; e++) {
        const kind = match.events.kind[e];
        const x = match.events.x[e];
        const y = match.events.y[e];
        if (kind === EVENT_HIT) spark(x, y, 0.5 * match.events.magnitude[e], 0.25, 0xfff0c0);
        else if (kind === EVENT_KO) spark(x, y, 1.6, 0.7, 0xffffff);
        else if (kind === EVENT_SUPER) spark(x, y, match.events.magnitude[e], 0.5, 0xffd700);
        // Habilidad común: un anillo del color del equipo. Cuando existan los
        // rigs, acá además se reproduce `skillAnimation(personaje, magnitude)`.
        else if (kind === EVENT_SKILL) {
          spark(x, y, 1.1, 0.4, match.events.team[e] === TEAM_GREEN ? 0x66ffb0 : 0xff88aa);
        }
      }
    }
    if (steps >= MAX_STEPS) accumulator = 0;

    const dt = Math.min(frameMs / 1000, 0.1);
    drawStage(platforms, match);
    updateCamera(camera, match, dt);
    applyCamera(world, app, camera, match.shake);
    drawFighters(dolls, match);

    fx.clear();
    for (let i = 0; i < SPARKS; i++) {
      if (sparkAge[i] >= sparkLife[i]) continue;
      sparkAge[i] += dt;
      const t = sparkAge[i] / sparkLife[i];
      if (t >= 1) continue;
      const radius = sparkSize[i] * (0.4 + t * 1.7);
      fx.circle(sparkX[i], -sparkY[i], radius)
        .fill({ color: sparkColor[i], alpha: (1 - t) * (1 - t) * 0.85 });
    }

    onFrame(performance.now() - started);
  };

  app.ticker.add(tick);

  return {
    app,
    destroy(): void {
      app.ticker.remove(tick);
      app.destroy(true, { children: true });
    },
  };
}

/* ------------------------------------------------------------------ */

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

function drawFighters(dolls: Doll[], match: Match): void {
  for (let i = 0; i < dolls.length; i++) {
    const doll = dolls[i];
    if (match.slot[i] !== SLOT_ACTIVE) {
      doll.visible = false;
      continue;
    }
    doll.visible = true;
    doll.x = match.x[i];
    doll.y = -match.y[i];

    // Squash & stretch: se estira al subir y se aplasta al caer. Es lo que
    // separa un muñeco que se traslada de uno que se mueve.
    const vy = match.vy[i];
    const stretch = Math.max(-0.18, Math.min(0.18, vy * 0.014));
    const scale = match.scale[i];
    doll.scale.x = scale * match.facing[i] * (1 - stretch);
    doll.scale.y = scale * (1 + stretch);
  }
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
