import { Application, Container, Text } from 'pixi.js';
import { createFighterView } from '../art/fighter';
import {
  ACT_KICK,
  ACT_NONE,
  ACT_PUNCH,
  ACT_SKILL,
  ACT_SUPER,
} from '../art/fighter';
import { lookFor } from '../art/looks';
import { loadArt } from '../art/loadArt';
import { ROSTER } from '../game/roster';
import { TEAM_GREEN } from '../game/fighters';

/**
 * Banco de pruebas del elenco: los seis personajes grandes, en fila, pasando por
 * todas sus poses.
 *
 * La escena de juego los dibuja a cuarenta píxeles y tapados de chispas, que es
 * el peor lugar posible para decidir si un brazo está bien puesto. Acá se los ve
 * al tamaño en que se dibujan las poses y sin nada encima.
 *
 *   npm run dev  →  http://localhost:5173/showcase.html
 */

const GREEN = 0x00ff66;
const RED = 0xff0055;

/** Las poses en el orden en que se recorren, con cuánto dura cada una. */
const TOUR: readonly { label: string; action: number; seconds: number }[] = [
  { label: 'idle', action: ACT_NONE, seconds: 2 },
  { label: 'run', action: ACT_NONE, seconds: 2.4 },
  { label: 'jump', action: ACT_NONE, seconds: 1.2 },
  { label: 'fall', action: ACT_NONE, seconds: 1.2 },
  { label: 'hurt', action: ACT_NONE, seconds: 1.2 },
  { label: 'attack_punch', action: ACT_PUNCH, seconds: 1.2 },
  { label: 'attack_kick', action: ACT_KICK, seconds: 1.2 },
  { label: 'skill', action: ACT_SKILL, seconds: 1.6 },
  { label: 'super', action: ACT_SUPER, seconds: 2 },
];

const host = document.getElementById('root');
if (host === null) throw new Error('#root no existe');

const app = new Application();
await app.init({
  background: 0x0b0f19,
  resizeTo: host,
  antialias: true,
  autoDensity: true,
  resolution: Math.min(window.devicePixelRatio || 1, 2),
});
host.appendChild(app.canvas);

const stage = new Container();
app.stage.addChild(stage);

/**
 * `?solo=asuri,deadpool` deja sólo a ésos.
 *
 * La plantilla pasó de seis a diecinueve y en una fila no se ve nada. Sin
 * filtro se acomodan en una grilla; con filtro, los que se están cortando
 * quedan grandes, que es para lo que existe este banco.
 */
const wanted = (new URLSearchParams(window.location.search).get('solo') ?? '')
  .split(',').map((name) => name.trim().toLowerCase()).filter((name) => name !== '');
const CAST = wanted.length === 0
  ? ROSTER
  : ROSTER.filter((character) => wanted.includes(character.armature.toLowerCase()));
if (CAST.length === 0) throw new Error(`?solo= no coincide con nadie: ${wanted.join(', ')}`);

const art = await Promise.all(CAST.map((character) => loadArt(character.armature)));

const views = CAST.map((character, i) => {
  const view = createFighterView(
    lookFor(character.armature),
    character.team === TEAM_GREEN ? GREEN : RED,
    art[i],
  );
  stage.addChild(view);
  return view;
});

const names = CAST.map((character) => {
  const text = new Text({
    text: character.label,
    style: { fontFamily: 'monospace', fontSize: 14, fill: 0x8fa3bf },
  });
  text.anchor.set(0.5, 0);
  stage.addChild(text);
  return text;
});

const caption = new Text({
  text: '',
  style: { fontFamily: 'monospace', fontSize: 20, fill: 0xe6edf3 },
});
caption.anchor.set(0.5, 0);
app.stage.addChild(caption);

/**
 * `?pose=attack_kick` fija una pose en vez de recorrerlas.
 *
 * El recorrido automático sirve para mirar; para CAPTURAR no, porque obliga al
 * script a adivinar en qué tramo está y basta con que un frame tarde de más
 * para que la imagen salga rotulada con la pose de al lado. Con la pose fijada,
 * lo que se captura es exactamente lo que se pidió.
 */
const pinned = new URLSearchParams(window.location.search).get('pose');
const pinnedIndex = TOUR.findIndex((step) => step.label === pinned);

let elapsed = 0;
let stepIndex = pinnedIndex >= 0 ? pinnedIndex : 0;
let stepAge = 0;

app.ticker.add(() => {
  const dt = Math.min(app.ticker.deltaMS / 1000, 0.1);
  elapsed += dt;
  stepAge += dt;

  let step = TOUR[stepIndex];
  if (pinnedIndex < 0 && stepAge >= step.seconds) {
    stepAge = 0;
    stepIndex = (stepIndex + 1) % TOUR.length;
    step = TOUR[stepIndex];
  }

  const width = app.renderer.width / app.renderer.resolution;
  const height = app.renderer.height / app.renderer.resolution;
  // Una unidad de mundo mide esto en píxeles. El personaje mide 1,04 de alto.
  // Grilla: hasta seis por fila. Con diecinueve en una sola fila cada uno
  // mediría treinta píxeles, que es justo el tamaño al que no se puede juzgar
  // si un brazo está bien puesto — el defecto que este banco existe para no
  // tener.
  const columns = Math.min(views.length, 6);
  const rows = Math.ceil(views.length / columns);
  const unit = Math.min(height * 0.42 / rows, width / (columns * 1.5));
  const slotWidth = width / (columns + 1);
  const rowHeight = height * 0.8 / rows;

  // Las poses de vuelo y de golpe no se disparan solas acá: se fuerzan los
  // mismos parámetros con los que las llamaría la escena.
  const running = step.label === 'run';
  const airborne = step.label === 'jump' || step.label === 'fall';
  const vx = running ? 3.6 : 0;
  const vy = step.label === 'jump' ? 8 : step.label === 'fall' ? -8 : 0;
  const looping = step.action === ACT_NONE;
  // Con una pose fijada, la acción se congela en su EXTENSIÓN MÁXIMA —el 25% del
  // recorrido, donde el impulso llega a 1—, que es el cuadro que hay que
  // juzgar. Sin fijar, se reproduce en bucle para ver la salida y la vuelta.
  const actionT = looping ? 0 : pinnedIndex >= 0 ? 0.25 : (stepAge % 0.7) / 0.7;

  for (let i = 0; i < views.length; i++) {
    const view = views[i];
    view.x = slotWidth * ((i % columns) + 1);
    view.y = height * 0.2 + rowHeight * (Math.floor(i / columns) + 0.55);
    view.scale.set(unit);
    view.pose(vx, vy, !airborne, step.label === 'hurt', step.action, actionT, elapsed);
    names[i].x = view.x;
    names[i].y = view.y + unit * 0.62;
  }

  caption.x = width / 2;
  caption.y = height * 0.08;
  caption.text = step.label;

});
