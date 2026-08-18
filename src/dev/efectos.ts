import { Application, Container, Graphics, Text } from 'pixi.js';
import { AdvancedBloomFilter } from 'pixi-filters/advanced-bloom';
import { createBackdrop } from '../render/backdrop';
import { loadFlames } from '../render/stage';
import {
  beams, burst, createFx, drawFx, dust, flash, impact, orb, shards, slash,
  trail, updateFx, wave,
} from '../render/fx';

/**
 * Banco de efectos: las hogueras y todos los impactos, solos y quietos.
 *
 *   npm run dev  →  http://localhost:5173/efectos.html?edad=0.12
 *
 * Existe porque los efectos son lo único del juego que **no se puede juzgar
 * dentro del juego**: duran entre 0,13 y 0,7 segundos, salen seis a la vez, y
 * arriba tienen una cámara que se sacude. Si un impacto se ve mal ahí no hay
 * forma de saber si el impacto está mal o si está tapado.
 *
 * Con `?edad=` se congela el cuadro a esa edad exacta —todos los efectos nacen
 * en cero y el banco avanza a paso fijo hasta ahí—, que es lo que hace que una
 * captura headless sirva para comparar. Sin el parámetro corre en vivo y cada
 * dos segundos vuelve a disparar todo.
 */

const params = new URLSearchParams(location.search);
const edad = Number(params.get('edad'));
const congelado = Number.isFinite(edad) && edad > 0;

/** Unidades de mundo por pixel de pantalla: la misma escala que usa la pelea. */
const ESCALA = 58;
const PERIODO = 2;

const app = new Application();
await app.init({
  background: 0x0b0f19,
  resizeTo: window,
  antialias: true,
  preference: 'webgl',
});
document.body.appendChild(app.canvas);

const backdrop = createBackdrop();
app.stage.addChild(backdrop.view);

const world = new Container();
app.stage.addChild(world);

const plainFx = new Graphics();
world.addChild(plainFx);

// Mismo reparto que el juego: la capa que brilla va aparte y es la única con
// Bloom. Copiarlo acá no es duplicación gratuita — un efecto juzgado sin Bloom
// no es el efecto que se ve en pantalla.
const glowFx = new Graphics();
const glowLayer = new Container();
glowLayer.addChild(glowFx);
glowLayer.filters = [new AdvancedBloomFilter({
  threshold: 0.35, bloomScale: 1.25, brightness: 1.05, blur: 5, quality: 4,
})];
world.addChild(glowLayer);

// Los contornos del color del bando: encima del Bloom y sin filtro.
const inkFx = new Graphics();
world.addChild(inkFx);

const fx = createFx();
const GREEN = 0x00ff66;
const RED = 0xff0055;
const GOLD = 0xffd700;

/** Cada casillero: dónde cae y qué dispara. En unidades de mundo. */
const CASILLEROS: { titulo: string; tirar(x: number, y: number): void }[] = [
  {
    titulo: 'puño',
    tirar: (x, y) => impact(fx, x, y, 0, 0.7, GREEN),
  },
  {
    titulo: 'patada',
    tirar: (x, y) => impact(fx, x, y, 0, 0.9, RED),
  },
  {
    titulo: 'recibe',
    tirar: (x, y) => impact(fx, x, y, 2.2, 1.2, 0xfff0c0),
  },
  {
    titulo: 'habilidad A',
    tirar: (x, y) => {
      flash(fx, x, y, 0.62, 0.16, GREEN);
      orb(fx, x + 0.3, y, 0.62, 0.3, GREEN);
      slash(fx, x + 0.35, y, 0, 1.25, 0.24, GREEN);
      burst(fx, x, y, 8, 6.5, 0.1, 0.42, GREEN);
    },
  },
  {
    titulo: 'habilidad B',
    tirar: (x, y) => {
      flash(fx, x, y, 0.62, 0.16, RED);
      orb(fx, x, y, 0.95, 0.34, RED);
      beams(fx, x, y, 6, 2.1, 0.28, RED);
      shards(fx, x, y, 6, 5.5, RED);
    },
  },
  {
    titulo: 'super',
    tirar: (x, y) => {
      flash(fx, x, y, 1.05, 0.2, GREEN);
      orb(fx, x, y, 3.4 * 0.42, 0.42, GREEN);
      beams(fx, x, y, 10, 3.4 * 1.15, 0.4, GREEN);
      wave(fx, x, y - 0.52, 3.4 * 1.6, 0.55, GOLD);
      shards(fx, x, y, 12, 9, GOLD);
      burst(fx, x, y, 12, 11, 0.16, 0.7, GOLD);
    },
  },
  {
    titulo: 'KO',
    tirar: (x, y) => {
      flash(fx, x, y, 0.95, 0.22, RED);
      orb(fx, x, y, 1.1, 0.34, RED);
      shards(fx, x, y, 10, 8, RED);
      burst(fx, x, y, 12, 9, 0.16, 0.8, RED);
    },
  },
  {
    titulo: 'polvo y estela',
    tirar: (x, y) => {
      dust(fx, x, y - 0.52, 1.2);
      for (let n = 0; n < 6; n++) trail(fx, x - 0.5 + n * 0.2, y + n * 0.12, 9, 5, 0.16, RED);
    },
  },
];

const rotulos: Text[] = [];
for (const casillero of CASILLEROS) {
  const rotulo = new Text({
    text: casillero.titulo,
    style: { fill: 0x8fa0bd, fontFamily: 'monospace', fontSize: 13 },
  });
  rotulo.anchor.set(0.5, 0);
  app.stage.addChild(rotulo);
  rotulos.push(rotulo);
}

/** Coloca la grilla y devuelve el centro de cada casillero, en mundo. */
function grilla(): { x: number; y: number }[] {
  const columnas = 4;
  const anchoCelda = app.renderer.width / columnas;
  const altoCelda = app.renderer.height / 2;
  const puntos: { x: number; y: number }[] = [];
  for (let i = 0; i < CASILLEROS.length; i++) {
    const cx = (i % columnas + 0.5) * anchoCelda;
    const cy = (Math.floor(i / columnas) + 0.55) * altoCelda;
    rotulos[i].x = cx;
    rotulos[i].y = cy - altoCelda * 0.42;
    puntos.push({ x: (cx - app.renderer.width / 2) / ESCALA, y: (app.renderer.height / 2 - cy) / ESCALA });
  }
  return puntos;
}

function disparar(): void {
  const puntos = grilla();
  for (let i = 0; i < CASILLEROS.length; i++) CASILLEROS[i].tirar(puntos[i].x, puntos[i].y);
}

let elapsed = 0;
let desdeDisparo = PERIODO;

function paso(dt: number): void {
  elapsed += dt;
  desdeDisparo += dt;
  if (desdeDisparo >= PERIODO) {
    desdeDisparo = 0;
    disparar();
  }
  updateFx(fx, dt);
  world.x = app.renderer.width / 2;
  world.y = app.renderer.height / 2;
  world.scale.set(ESCALA, ESCALA);
  drawFx(fx, plainFx, glowFx, inkFx);
  backdrop.update(0.58, 0.8, app.renderer.width, app.renderer.height, elapsed);
  app.renderer.background.color = backdrop.skyColor(0.58);
}

void loadFlames('verde').then(async (verdes) => {
  const rojos = await loadFlames('rojo');
  if (verdes !== null && rojos !== null) backdrop.useFlames(verdes, rojos);

  if (congelado) {
    // Paso fijo hasta la edad pedida: una captura headless tiene que dar
    // siempre el mismo cuadro, y con el reloj de pantalla no da.
    //
    // El ticker se PARA. Pixi rinde una vez por tick por su cuenta, y con el
    // Bloom sobre SwiftShader cada rendido cuesta cientos de milisegundos: un
    // lienzo que nunca se queda quieto hace que `page.screenshot` espere hasta
    // agotar su plazo. Parado, se rinde una sola vez, a mano, y ahí queda.
    app.ticker.stop();
    grilla();
    const PASO = 1 / 120;
    disparar();
    desdeDisparo = 0;
    for (let t = 0; t < edad; t += PASO) paso(Math.min(PASO, edad - t));
    app.render();
    document.body.dataset.listo = '1';
    return;
  }
  app.ticker.add(() => paso(Math.min(app.ticker.deltaMS / 1000, 0.05)));
  document.body.dataset.listo = '1';
});
