import { Container, Graphics } from 'pixi.js';
import type { Look } from './looks';
import {
  GEAR_ANTENNA,
  GEAR_EARS,
  GEAR_HEADBAND,
  GEAR_HORNS,
  GEAR_MASK,
  GEAR_SNOUT,
} from './looks';

/**
 * El peleador: un cuerpo articulado que se anima por código.
 *
 * Cabeza, torso, dos brazos y dos piernas son nodos separados con su pivote en
 * la articulación, y animar es rotarlos y moverlos — **nunca** redibujarlos. La
 * geometría se construye una vez; `pose` sólo escribe `rotation`, `x`, `y` y
 * `scale`, que son propiedades del nodo y no reconstruyen ninguna malla.
 *
 * Es el mismo principio que un rig de DragonBones, resuelto acá: partes con
 * pivote, un reloj y una pose por estado. La diferencia es que las poses las
 * escribe este archivo en vez de venir de un exportador, y que no hace falta
 * esperar el arte para que los personajes caminen, salten y peguen. Cuando estén
 * los rigs, esto se reemplaza pieza por pieza: la interfaz que consume la capa
 * de render —`pose` y `paint`— no cambia.
 *
 * Todo se dibuja en el eje Y de Pixi, que crece hacia ABAJO.
 */

/* --- acciones -------------------------------------------------------- */

export const ACT_NONE = 0;
export const ACT_PUNCH = 1;
export const ACT_KICK = 2;
export const ACT_SKILL = 3;
export const ACT_SUPER = 4;

/** Cuánto dura cada acción en pantalla, en segundos. */
export const ACTION_TIME: readonly number[] = [0, 0.26, 0.3, 0.45, 0.75];

/* --- escala del dibujo ----------------------------------------------- */

/**
 * El cuerpo se dibuja cien veces más grande que su tamaño en el mundo y después
 * se achica con `scale`.
 *
 * **Pixi decide en cuántos tramos parte una curva en el espacio LOCAL**, cuando
 * la construye, y no la vuelve a mirar al escalar. Dibujada a media unidad de
 * alto y agrandada doscientas veces por la cámara, la cabeza salía como un
 * octógono y los brazos con las esquinas en escalera. Dibujándola cerca de su
 * tamaño final en píxeles, la subdivisión es la correcta.
 *
 * Es el mismo defecto que apareció en el fondo. Ahí las facetas gustaron y se
 * quedaron; acá no, porque un personaje redondeado facetado se ve roto.
 *
 * Por eso las poses escriben posiciones en ESTAS unidades: viven adentro del
 * contenedor `rig`, que es el que lleva el `1 / RIG`.
 */
const RIG = 100;

/* --- proporciones, en unidades del rig -------------------------------- */

const OUTLINE = 0x05070d;
const OUTLINE_WIDTH = 5.5;
/** Cuánto más oscuro es cada bloque de sombra. Bloques sólidos, nunca degradé. */
const SHADE = 0.62;
const DEEP = 0.4;

const HEAD_Y = -24;
const HEAD_R = 26;
const SHOULDER_X = 17;
const SHOULDER_Y = -3;
const HIP_X = 9;
const HIP_Y = 16;
const ARM_W = 15;
const ARM_LEN = 21;
const LEG_W = 17;
const LEG_LEN = 24;
/** Corrimiento del cuerpo entero para que los pies caigan en el piso. */
const BODY_Y = 5;

function darken(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

export interface FighterView extends Container {
  /**
   * Coloca el cuerpo. Recibe primitivas y no un objeto a propósito: se llama
   * seis veces por frame y un literal por llamada son 360 objetos por segundo
   * para el recolector.
   */
  pose(
    vx: number, vy: number, grounded: boolean, hurt: boolean,
    action: number, actionT: number, elapsed: number,
  ): void;
  /** Se llama al entrar o salir del gigantismo. */
  paint(color: number, glow: boolean): void;
}

type Line = { width: number; color: number; alignment: number };

/** Una parte con pivote en su articulación. */
function joint(x: number, y: number): { node: Container; g: Graphics } {
  const node = new Container();
  const g = new Graphics();
  node.addChild(g);
  node.x = x;
  node.y = y;
  return { node, g };
}

export function createFighterView(look: Look, color: number): FighterView {
  const root = new Container() as FighterView;

  /** El que traduce de unidades del rig a unidades de mundo. */
  const rig = new Container();
  rig.scale.set(1 / RIG);
  root.addChild(rig);

  const body = new Container();
  body.y = BODY_Y;
  rig.addChild(body);

  const aura = new Graphics();
  body.addChild(aura);

  // Hoja a la espalda: detrás de todo, para que se lea como que está del otro
  // lado del cuerpo. Es geometría fija, no se anima: se lleva puesta.
  const blade = new Graphics();
  if (look.blade) body.addChild(blade);

  // Orden de dibujo: lo de atrás primero. En una figura de tres cuartos el
  // brazo y la pierna de atrás tienen que quedar detrás del torso, o el cuerpo
  // se ve plano y las extremidades parecen pegadas por delante.
  const backArm = joint(-SHOULDER_X, SHOULDER_Y);
  const backLeg = joint(-HIP_X, HIP_Y);
  const torsoG = new Graphics();
  const frontLeg = joint(HIP_X, HIP_Y);
  const frontArm = joint(SHOULDER_X, SHOULDER_Y);
  const head = new Container();
  const headG = new Graphics();
  head.addChild(headG);
  head.y = HEAD_Y;
  body.addChild(backArm.node, backLeg.node, torsoG, frontLeg.node, frontArm.node, head);

  // La pelota va en el puño de atrás, así que es hija del brazo y lo acompaña
  // en toda la animación sin una línea de código extra.
  const ball = new Graphics();
  if (look.ball) backArm.node.addChild(ball);

  const draw = (tint: number, glow: boolean): void => {
    const shade = darken(tint, SHADE);
    const deep = darken(tint, DEEP);
    const line: Line = { width: OUTLINE_WIDTH, color: OUTLINE, alignment: 0.5 };

    /* --- piernas ---------------------------------------------------- */
    // La de atrás bien oscura y la de adelante clara: es lo que separa las dos
    // piernas cuando se cruzan en el ciclo de carrera. Con el mismo tono, un
    // personaje corriendo parece tener una sola pierna gruesa.
    for (const [g, fill] of [[backLeg.g, deep], [frontLeg.g, shade]] as const) {
      g.clear();
      g.roundRect(-LEG_W / 2, -4, LEG_W, LEG_LEN + 6, 7).fill(fill).stroke(line);
      // El pie, más ancho que la pierna: es lo que da apoyo a la figura.
      g.roundRect(-LEG_W / 2 - 1, LEG_LEN - 2, LEG_W + 8, 12, 5).fill(fill).stroke(line);
    }

    /* --- brazos ------------------------------------------------------ */
    for (const [g, fill] of [[backArm.g, deep], [frontArm.g, tint]] as const) {
      g.clear();
      g.roundRect(-ARM_W / 2, -4, ARM_W, ARM_LEN + 4, 7).fill(fill).stroke(line);
      // El puño redondo y grande: en proporción chibi es lo que hace legible un
      // golpe a cuarenta píxeles de alto.
      g.circle(0, ARM_LEN + 4, 10.5).fill(fill).stroke(line);
    }

    /* --- torso -------------------------------------------------------- */
    torsoG.clear();
    torsoG.roundRect(-19, -15, 38, 35, 12).fill(tint).stroke(line);
    // Bloque de sombra: un sólido con borde neto, del lado opuesto a la luz.
    torsoG.roundRect(4, -14, 14, 33, 10).fill(shade);
    // Cinturón: corta la silueta a la altura de la cadera. Sin él, torso y
    // piernas se leen como un bloque único.
    torsoG.roundRect(-20, 12, 40, 9, 3).fill(look.accent).stroke(line);

    /* --- cabeza ------------------------------------------------------- */
    headG.clear();
    drawGear(headG, look, tint, shade, line);
    headG.circle(0, 0, HEAD_R).fill(tint).stroke(line);
    headG.circle(8, 2, 18).fill(shade);
    drawFace(headG, look, line);

    /* --- accesorios ---------------------------------------------------- */
    if (look.blade) {
      blade.clear();
      blade.moveTo(-4, -34).lineTo(34, 14)
        .stroke({ width: 7, color: 0xdfe7f2, alignment: 0.5 });
      blade.moveTo(-12, -44).lineTo(-1, -30)
        .stroke({ width: 10, color: OUTLINE, alignment: 0.5 });
    }
    if (look.ball) {
      ball.clear();
      ball.circle(0, ARM_LEN + 4, 13).fill(look.accent).stroke(line);
      ball.moveTo(-13, ARM_LEN + 4).lineTo(13, ARM_LEN + 4)
        .stroke({ width: 2.5, color: OUTLINE, alignment: 0.5 });
    }

    /* --- aura del gigantismo ------------------------------------------ */
    aura.clear();
    if (glow) aura.circle(0, 5, 74).fill({ color: 0xffd700, alpha: 0.2 });
  };

  draw(color, false);
  root.paint = (next: number, glow: boolean): void => draw(next, glow);

  /* --- la máquina de poses ------------------------------------------- */

  // Hacia dónde mira lo resuelve la capa de render invirtiendo la escala del
  // contenedor, así que las poses se escriben SIEMPRE mirando a la derecha y acá
  // no hace falta el `facing`. Es la misma convención que se le va a pedir al
  // rig cuando exista.
  root.pose = (vx, vy, grounded, hurt, action, actionT, elapsed): void => {
    const speed = Math.abs(vx);

    if (hurt) {
      // Doblado hacia atrás, brazos sueltos: la pose de recibir es la que más
      // rápido comunica que el golpe entró.
      torsoG.rotation = -0.32;
      head.rotation = -0.34;
      head.y = HEAD_Y + 3;
      backArm.node.rotation = 2.5;
      frontArm.node.rotation = -2.5;
      backLeg.node.rotation = 0.5;
      frontLeg.node.rotation = -0.35;
      body.y = BODY_Y + 2;
      return;
    }

    if (action !== ACT_NONE) {
      // `t` va de 0 a 1 a lo largo de la acción. El golpe sale rápido y vuelve
      // lento: `impulse` sube en el primer cuarto y baja en el resto, que es lo
      // que hace que se lea como un golpe y no como un saludo.
      const t = Math.min(1, actionT);
      poseAction(action, t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75);
      return;
    }

    if (!grounded) {
      // En el aire: subiendo se recoge, cayendo se abre. Es la lectura de peso
      // más barata que hay.
      const rising = vy > 0;
      torsoG.rotation = rising ? 0.1 : -0.08;
      head.rotation = rising ? 0.08 : -0.1;
      head.y = HEAD_Y;
      backArm.node.rotation = rising ? -2.3 : -1.5;
      frontArm.node.rotation = rising ? 2.3 : 1.5;
      backLeg.node.rotation = rising ? 0.75 : -0.3;
      frontLeg.node.rotation = rising ? -0.5 : 0.35;
      body.y = BODY_Y;
      return;
    }

    if (speed > 0.35) {
      // Ciclo de carrera. La frecuencia sigue a la velocidad real en vez de ser
      // fija: si no, correr y caminar se ven igual y las piernas patinan.
      const cycle = elapsed * (3.2 + speed * 1.5);
      const swing = Math.sin(cycle);
      const lean = Math.min(0.22, speed * 0.045);
      torsoG.rotation = lean;
      head.rotation = lean * 0.5;
      backLeg.node.rotation = swing * 0.85;
      frontLeg.node.rotation = -swing * 0.85;
      // Los brazos van en contrafase con las piernas, que es como camina un
      // bípedo. En fase se ve como un juguete a cuerda.
      backArm.node.rotation = -swing * 0.7;
      frontArm.node.rotation = swing * 0.7;
      // Dos rebotes por ciclo: el cuerpo sube en cada apoyo, no en cada paso.
      body.y = BODY_Y - Math.abs(Math.cos(cycle)) * 3.5;
      head.y = HEAD_Y;
      return;
    }

    // Quieto: respira. Un personaje perfectamente inmóvil se lee como un error.
    const breath = Math.sin(elapsed * 1.9);
    torsoG.rotation = 0;
    head.rotation = breath * 0.04;
    head.y = HEAD_Y - breath * 1.2;
    backArm.node.rotation = 0.16 + breath * 0.06;
    frontArm.node.rotation = -0.16 - breath * 0.06;
    backLeg.node.rotation = 0.03;
    frontLeg.node.rotation = -0.03;
    body.y = BODY_Y + breath * 1.2;
  };

  function poseAction(action: number, impulse: number): void {
    head.y = HEAD_Y;
    switch (action) {
      case ACT_PUNCH:
        // El brazo de adelante sale recto y el torso acompaña; el de atrás va
        // para el otro lado como contrapeso.
        torsoG.rotation = impulse * 0.3;
        head.rotation = impulse * 0.12;
        frontArm.node.rotation = -1.57 - impulse * 0.15;
        backArm.node.rotation = 1.3 - impulse * 0.9;
        backLeg.node.rotation = -impulse * 0.28;
        frontLeg.node.rotation = impulse * 0.34;
        body.y = BODY_Y;
        break;
      case ACT_KICK:
        torsoG.rotation = -impulse * 0.42;
        head.rotation = -impulse * 0.2;
        frontLeg.node.rotation = -1.5 * impulse;
        backLeg.node.rotation = impulse * 0.3;
        frontArm.node.rotation = impulse * 1.2;
        backArm.node.rotation = -impulse * 1.5;
        body.y = BODY_Y - impulse * 5;
        break;
      case ACT_SKILL:
        // Las dos manos al frente: es la pose que sostiene cualquiera de las dos
        // especiales sin comprometerse con ninguna en particular.
        torsoG.rotation = impulse * 0.16;
        head.rotation = -impulse * 0.1;
        frontArm.node.rotation = -1.4 * impulse;
        backArm.node.rotation = -1.15 * impulse;
        backLeg.node.rotation = -impulse * 0.2;
        frontLeg.node.rotation = impulse * 0.2;
        body.y = BODY_Y;
        break;
      default:
        // Super: brazos al cielo y cuerpo estirado.
        torsoG.rotation = -impulse * 0.2;
        head.rotation = -impulse * 0.3;
        frontArm.node.rotation = 3.0 * impulse;
        backArm.node.rotation = -3.0 * impulse;
        backLeg.node.rotation = impulse * 0.16;
        frontLeg.node.rotation = -impulse * 0.16;
        body.y = BODY_Y - impulse * 10;
        break;
    }
  }

  return root;
}

/* --- piezas de identidad --------------------------------------------- */

/** Lo que va DETRÁS de la cabeza: cuernos, orejas, antena, hocico. */
function drawGear(g: Graphics, look: Look, tint: number, shade: number, line: Line): void {
  switch (look.gear) {
    case GEAR_HORNS:
      // Cuernos anchos y cortos, bien separados: es la silueta del toro.
      g.moveTo(-20, -10)
        .quadraticCurveTo(-46, -26, -41, 3)
        .quadraticCurveTo(-31, -7, -18, 3)
        .fill(look.accent).stroke(line);
      g.moveTo(20, -10)
        .quadraticCurveTo(46, -26, 41, 3)
        .quadraticCurveTo(31, -7, 18, 3)
        .fill(look.accent).stroke(line);
      break;
    case GEAR_EARS:
      g.circle(-21, -22, 15).fill(shade).stroke(line);
      g.circle(21, -22, 15).fill(shade).stroke(line);
      break;
    case GEAR_ANTENNA:
      g.moveTo(0, -24).quadraticCurveTo(-3, -38, -6, -46)
        .stroke({ width: 4.5, color: OUTLINE, alignment: 0.5 });
      g.circle(-7, -49, 7.5).fill(look.accent).stroke(line);
      break;
    case GEAR_SNOUT:
      g.circle(-20, 7, 12.5).fill(tint).stroke(line);
      break;
    default:
      break;
  }
}

/** Lo que va DELANTE de la cabeza: visor, máscara, vincha. */
function drawFace(g: Graphics, look: Look, line: Line): void {
  if (look.gear === GEAR_MASK) {
    // Máscara: dos ojos blancos con contorno sobre el color del traje. Es la
    // cara más reconocible del elenco y no necesita nada más.
    g.ellipse(-11, -3, 8, 6).fill(0xf2f7ff).stroke(line);
    g.ellipse(11, -3, 8, 6).fill(0xf2f7ff).stroke(line);
    return;
  }
  if (look.gear === GEAR_SNOUT) {
    g.circle(-25, 5, 4.5).fill(OUTLINE);
    g.ellipse(-2, -5, 6.5, 5.5).fill(0xf2f7ff).stroke(line);
    return;
  }
  if (look.gear === GEAR_HEADBAND) {
    g.roundRect(-26, -17, 52, 10, 4).fill(look.accent).stroke(line);
  }
  // Visor: una sola forma clara que da dirección de mirada sin dibujar cara.
  g.roundRect(-20, -9, 30, 11, 5).fill(0xf2f7ff).stroke(line);
}
