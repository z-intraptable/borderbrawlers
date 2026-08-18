import { Application, Container, Sprite } from 'pixi.js';
import { createFighterView } from '../art/fighter';
import { lookFor } from '../art/looks';
import { loadArt } from '../art/loadArt';
import { loadSheets } from '../art/loadSheets';
import { createSpriteFighterView } from '../art/spriteFighter';
import type { FighterView } from '../art/fighter';
import { createBackdrop } from '../render/backdrop';
import { createStage, loadPlatforms, loadStage, stageTint } from '../render/stage';
import { GRAVITY } from '../game/physics';
import { ACT_KICK, ACT_NONE, ACT_PUNCH, ACT_SKILL, ACT_SUPER, ACTION_TIME } from '../art/fighter';

/**
 * Un personaje corriendo y saltando en el escenario, y nada más.
 *
 *   npm run dev  →  http://localhost:5173/demo.html?quien=Ragnir&stage=lich
 *
 * Existe para mirar la animación sola. En la pelea hay seis peleadores, nueve
 * losas que suben y bajan, chispas, barras y una cámara que persigue: si una
 * carrera se ve mal ahí, no hay forma de saber si el problema es la carrera.
 * Acá está el escenario de verdad y el mismo cuerpo que usa el juego, sin nada
 * más encima.
 *
 * **La física es de juguete a propósito.** `src/game/physics.ts` resuelve una
 * pelea entera contra un skyline que se mueve con la liquidez; acá alcanza con
 * gravedad, tres losas quietas y un recorrido escrito a mano. Copiar la del
 * juego traería el libro de órdenes atrás y esto dejaría de ser un banco.
 *
 * El reloj se puede tomar de afuera —`window.__PASO__(dt)`— para grabar a paso
 * fijo. Con el reloj de pantalla, un headless que rinde a 6 fps por SwiftShader
 * grabaría una carrera en cámara lenta.
 */

const params = new URLSearchParams(location.search);
const quien = params.get('quien') ?? 'Ragnir';
const escenario = params.get('stage') ?? 'lich';

/** Media altura del cuerpo, la misma que usa la pelea. */
const HALF_HEIGHT = 0.52;
const RUN_SPEED = 4.2;
const JUMP_SPEED = 11;

/**
 * Las tres losas del recorrido: alto, centro, alto. En unidades de mundo, con
 * `y` para arriba, que es como piensa la simulación.
 *
 * Tres y no las nueve del juego porque el recorrido tiene que leerse de una:
 * corre, salta el hueco, corre, salta el otro, y vuelve. Con nueve losas a
 * distinta altura la carrera se pierde entre saltos.
 */
const LOSAS: readonly { x: number; half: number; top: number; centro: boolean }[] = [
  { x: -3.4, half: 1.0, top: 1.35, centro: false },
  { x: 0, half: 1.6, top: 0.5, centro: true },
  { x: 3.4, half: 1.0, top: 1.35, centro: false },
];
const GROSOR_CENTRO = 0.9;
const GROSOR_LADO = 0.25;

const host = document.getElementById('root');
if (host === null) throw new Error('#root no existe');

const app = new Application();
await app.init({
  background: 0x0b0f19,
  resizeTo: host,
  // Sin antialias: todo lo que se dibuja acá son sprites con su propio alfa
  // —el fondo, las tres losas y el personaje—, y el MSAA no toca una textura
  // filtrada. Lo que sí hace es obligar a resolver el búfer antes de leerlo,
  // que con SwiftShader es la parte cara de grabar: medido, 7 s por cuadro
  // contra 5.
  antialias: false,
  autoDensity: true,
  resolution: Math.min(window.devicePixelRatio || 1, 2),
  // Para que `canvas.toDataURL()` devuelva el cuadro y no un lienzo en blanco:
  // WebGL descarta el búfer después de presentar, salvo que se le pida que no.
  // Cuesta rendimiento y no importa, porque esta página es un banco.
  preserveDrawingBuffer: true,
});
host.appendChild(app.canvas);

const backdrop = createBackdrop();
app.stage.addChild(backdrop.view);

const stageTexture = await loadStage(escenario);
const stage = stageTexture === null ? null : createStage(stageTexture);
if (stage !== null) app.stage.addChild(stage.sprite);

/** El mundo, en unidades de juego. `y` de pantalla va al revés que el de la simulación. */
const world = new Container();
app.stage.addChild(world);

const losasArt = await loadPlatforms(escenario);
if (losasArt !== null) {
  for (const losa of LOSAS) {
    const sprite = new Sprite(losa.centro ? losasArt.centro : losasArt.lado);
    sprite.anchor.set(0.5, 0);
    sprite.x = losa.x;
    sprite.y = -losa.top;
    sprite.width = losa.half * 2;
    sprite.height = (losa.centro ? GROSOR_CENTRO : GROSOR_LADO) + 0.14;
    world.addChild(sprite);
  }
}

/**
 * El cuerpo: la hoja de sprites si el personaje la tiene, y si no el muñeco de
 * piezas. Es exactamente el criterio de `game.ts`, y está repetido acá a
 * propósito: si el banco eligiera distinto que el juego, no probaría al juego.
 */
const hojas = await loadSheets(quien);
let view: FighterView;
if (hojas !== null) {
  view = createSpriteFighterView(hojas);
} else {
  view = createFighterView(lookFor(quien), 0x00ff66, await loadArt(quien));
}
world.addChild(view);

/* --- el recorrido ----------------------------------------------------- */

let x = LOSAS[0].x;
let y = LOSAS[0].top + HALF_HEIGHT;
let vx = RUN_SPEED;
let vy = 0;
let grounded = true;
let facing = 1;
let elapsed = 0;

/**
 * La ronda de acciones: el banco las va tirando una tras otra.
 *
 * Sin esto sólo se veían la carrera, el salto y el quieto, que son los estados
 * continuos; la patada, la habilidad y el super no se veían nunca, y son
 * justamente los que hay que mirar de cerca porque son tres dibujos y no un
 * ciclo. `pausa` es el aire entre una y la siguiente: pegadas no se distingue
 * dónde termina una acción y arranca la otra.
 */
const RONDA: readonly number[] = [ACT_PUNCH, ACT_KICK, ACT_SKILL, ACT_SUPER];
/** Segundos de carrera entre una ronda de acciones y la siguiente. */
const CORRER = 5;
const NOMBRE: Record<number, string> = {
  [ACT_PUNCH]: 'puño', [ACT_KICK]: 'patada',
  [ACT_SKILL]: 'habilidad', [ACT_SUPER]: 'super',
};
const PAUSA = 0.7;
let cual = 0;
let accion = ACT_NONE;
let edad = 0;
/** Cuánto hace que terminó la última ronda. Mientras cuenta, el peleador corre. */
let descanso = 0;
let mostrando = false;

function girarAccion(dt: number): void {
  edad += dt;
  if (accion === ACT_NONE) {
    if (edad < PAUSA) return;
    accion = RONDA[cual % RONDA.length];
    cual++;
    edad = 0;
  } else if (edad >= ACTION_TIME[accion]) {
    accion = ACT_NONE;
    edad = 0;
  }
  const cartel = document.getElementById('accion');
  if (cartel !== null) cartel.textContent = accion === ACT_NONE ? '' : NOMBRE[accion];
}

/** La losa que hay abajo de `x`, o null si está sobre el hueco. */
function losaBajo(px: number): typeof LOSAS[number] | null {
  for (const losa of LOSAS) {
    if (px >= losa.x - losa.half && px <= losa.x + losa.half) return losa;
  }
  return null;
}

/**
 * Salta cuando se está por acabar el piso.
 *
 * Un salto dura 2·11/34 = 0,65 s y a 4,2 de carrera cruza 2,7 unidades, así que
 * despegar a 0,9 del borde pasa cualquiera de los dos huecos con aire de sobra.
 * Es la misma idea que `shouldJump` en `src/game/fighters.ts` —el personaje
 * consulta el skyline y no el mundo de física— reducida a tres losas.
 */
const MIRAR_ADELANTE = 0.9;

function conviene_saltar(): boolean {
  if (!grounded) return false;
  return losaBajo(x + Math.sign(vx) * MIRAR_ADELANTE) === null;
}

const BORDE = 4.0;

function paso(dt: number): void {
  elapsed += dt;

  // Turnos: cinco segundos corriendo y saltando, y después se planta a tirar la
  // ronda de acciones. Las acciones no se pueden mirar en movimiento —el arco de
  // la habilidad son tres dibujos y la carrera doce— y frenar sólo hace falta
  // acá, en el banco; en la pelea de verdad se tiran corriendo.
  if (!mostrando) {
    descanso += dt;
    if (descanso >= CORRER && grounded) {
      mostrando = true;
      descanso = 0;
      vx = 0;
      edad = PAUSA;
    }
  } else if (accion === ACT_NONE && cual > 0 && cual % RONDA.length === 0 && edad === 0) {
    mostrando = false;
    cual = 0;
    vx = facing * RUN_SPEED;
  }

  // Da la vuelta en las puntas del escenario.
  if (x > BORDE && vx > 0) vx = -RUN_SPEED;
  if (x < -BORDE && vx < 0) vx = RUN_SPEED;
  if (!mostrando && conviene_saltar()) {
    vy = JUMP_SPEED;
    grounded = false;
  }

  vy += GRAVITY * dt;
  x += vx * dt;
  const antes = y;
  y += vy * dt;

  const losa = losaBajo(x);
  const piso = losa === null ? null : losa.top + HALF_HEIGHT;
  grounded = false;
  if (piso !== null && vy <= 0 && antes >= piso - 0.02 && y <= piso) {
    y = piso;
    vy = 0;
    grounded = true;
  }
  // Se cayó al vacío: vuelve arriba de la losa del medio, mirando al otro lado.
  if (y < -4) {
    x = 0;
    y = LOSAS[1].top + HALF_HEIGHT;
    vy = 0;
    vx = -vx;
  }
  if (vx !== 0) facing = vx > 0 ? 1 : -1;

  view.x = x;
  view.y = -y;
  girarAccion(mostrando ? dt : 0);
  const duracion = ACTION_TIME[accion];
  view.pose(vx, vy, grounded, false, accion,
    duracion > 0 ? edad / duracion : 0, elapsed);
  // Squash & stretch, igual que en la pelea: se estira al subir y se aplasta al
  // caer. Es lo que separa un muñeco que se traslada de uno que se mueve.
  const stretch = Math.max(-0.18, Math.min(0.18, vy * 0.014));
  view.scale.x = facing * (1 - stretch);
  view.scale.y = 1 + stretch;
}

/** La cámara: quieta y centrada en el escenario, para que se vea el recorrido. */
function encuadrar(): void {
  // `resizeTo` de Pixi engancha el evento `resize` de la ventana, y en una
  // ventana que nunca cambia de tamaño —un headless con viewport fijo, un
  // iframe recién montado— ese evento no llega nunca: el renderer se queda con
  // la medida con la que arrancó y el fondo cubre una esquina del canvas en vez
  // de la pantalla. Preguntar por el tamaño acá cuesta dos lecturas por cuadro
  // y no depende de que el evento aparezca.
  if (host !== null
    && (app.renderer.width !== host.clientWidth
      || app.renderer.height !== host.clientHeight)
    && host.clientWidth > 0 && host.clientHeight > 0) {
    app.renderer.resize(host.clientWidth, host.clientHeight);
  }
  const { width, height } = app.screen;
  // El personaje mide 1,04 unidades y tiene que leerse. Con la cámara del juego
  // abierta a 9,6 queda en el 10% del alto del cuadro, que es el piso del rango
  // de la referencia (docs/REFERENCIA-BRAWLHALLA.md); a 5,4 da 17%, que es el
  // techo. Las losas se achicaron en la misma proporción: acercar la cámara sin
  // tocarlas deja al personaje igual de chico CONTRA la losa, que es lo que en
  // realidad se mira.
  const halfWidth = 5.4;
  const scale = width / (halfWidth * 2);
  world.scale.set(scale);
  world.x = width / 2;
  world.y = height * 0.66;
  backdrop.update(0.5, 0.4, width, height, elapsed);
  if (stage !== null) stage.update(width, height, stageTint(backdrop.skyColor(0.5)));
}

paso(0);
encuadrar();

// `?paso=manual` apaga el reloj de pantalla y deja que lo maneje el que graba.
// Con los dos andando a la vez, la escena avanza el doble y la carrera sale
// acelerada respecto de lo que se ve en vivo.
if (params.get('paso') !== 'manual') {
  app.ticker.add((ticker) => {
    paso(Math.min(0.05, ticker.deltaMS / 1000));
    encuadrar();
  });
}

interface Banco {
  __PASO__(dt: number): void;
  __APP__: Application;
}
// Para grabar a paso fijo desde afuera: el ticker sigue corriendo, pero el que
// graba adelanta el reloj él y captura entre paso y paso.
(window as unknown as Banco).__PASO__ = (dt: number): void => {
  paso(dt);
  encuadrar();
  app.renderer.render(app.stage);
};
(window as unknown as Banco).__APP__ = app;
