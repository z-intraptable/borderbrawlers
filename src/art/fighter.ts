import { Container, Graphics, Sprite } from 'pixi.js';
import type { FighterArt } from './loadArt';
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
/**
 * Los miembros de atrás. No puede ser tan oscuro como para confundirse con el
 * contorno ni con el fondo: si lo es, el brazo trasero desaparece y su puño
 * queda flotando al costado como una bolita suelta.
 */
const DEEP = 0.5;

/**
 * La cabeza, alta y apenas más chica que el ancho del torso.
 *
 * Bajada y grande tapaba los hombros, y con los hombros tapados el brazo parece
 * nacer de la oreja. Subirla deja ver el nacimiento de los brazos, que es lo que
 * hace legible cualquier pose de golpe.
 *
 * Grande igual: es lo que permite que una figura de cuarenta píxeles se lea, y
 * es por eso que los personajes de Brawlhalla son cabezones.
 */
const HEAD_Y = -29;
const HEAD_R = 23;
/**
 * El hombro va POR FUERA del borde del torso, que llega a 19. Metido para
 * adentro, el brazo trasero queda tapado entero y sólo asoma el puño al
 * balancearse — se ve como una pelota despegada del cuerpo.
 */
const SHOULDER_X = 22;
const SHOULDER_Y = -3;
const HIP_X = 9;
const HIP_Y = 16;
const ARM_W = 15;
/**
 * Los miembros van partidos en dos, con codo y rodilla.
 *
 * Una extremidad de una sola pieza sólo puede rotar desde el hombro o la cadera,
 * y eso es la mitad de por qué un personaje se ve rígido: al correr, la pierna
 * barre como un péndulo en vez de recogerse; al pegar, el brazo sale como un
 * palo. Con dos segmentos el codo carga antes de soltar el golpe y la rodilla se
 * dobla en la fase de vuelo, que es lo que el ojo lee como peso.
 *
 * Es exactamente lo que DragonBones iba a aportar sobre el esqueleto anterior.
 */
const ARM_UPPER = 11;
const ARM_LOWER = 12;
const LEG_W = 17;
const LEG_UPPER = 12;
const LEG_LOWER = 14;
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

/**
 * Una extremidad de dos segmentos: el de arriba cuelga de la articulación raíz
 * —hombro o cadera— y el de abajo cuelga del extremo del de arriba.
 *
 * La rotación del segundo es RELATIVA al primero, porque es su hijo. Un codo a
 * cero es un brazo estirado, no un brazo colgando.
 */
interface Chain {
  upper: Container;
  lower: Container;
  upperG: Graphics;
  lowerG: Graphics;
}

function chain(x: number, y: number, upperLength: number): Chain {
  const upper = new Container();
  upper.x = x;
  upper.y = y;
  const upperG = new Graphics();
  upper.addChild(upperG);

  const lower = new Container();
  lower.y = upperLength;
  const lowerG = new Graphics();
  lower.addChild(lowerG);
  upper.addChild(lower);

  return { upper, lower, upperG, lowerG };
}

/**
 * Cuelga un sprite de una articulación.
 *
 * El ancla del sprite ES el pivote del manifiesto: colocado en (0,0) del nodo,
 * el punto de la imagen marcado como articulación cae exactamente sobre la
 * articulación del esqueleto. Es lo que hace que un brazo dibujado gire desde el
 * hombro sin una sola corrección.
 */
function hang(
  parent: Container, art: FighterArt, part: string, tint: number,
): Sprite | null {
  const texture = art.textures[part as 'head'];
  if (texture === undefined) return null;
  const sprite = new Sprite(texture);
  const [px, py] = art.pivots[part] ?? [0.5, 0.5];
  sprite.anchor.set(px, py);
  // El manifiesto dice cuántos píxeles mide una unidad del rig; el rig dibuja en
  // sus propias unidades, así que la imagen se achica por esa razón.
  sprite.scale.set(1 / art.unit);
  sprite.tint = tint;
  parent.addChild(sprite);
  return sprite;
}

/**
 * @param art piezas dibujadas. Sin ellas se usa el peleador vectorial, que es
 *   lo que permite ver a un personaje con arte propio al lado de los que
 *   todavía no lo tienen, en la misma pelea.
 */
export function createFighterView(
  look: Look, color: number, art: FighterArt | null = null,
): FighterView {
  const root = new Container() as FighterView;

  // Las proporciones salen del dibujo cuando hay dibujo. Las constantes de
  // arriba describen al peleador vectorial y no describen a nadie más: el
  // primer personaje dibujado que llegó tenía la cabeza del doble y las caderas
  // más anchas, y encajarlo en ellas le dejaba los brazos naciendo del aire.
  const rig_ = art?.rig ?? null;
  const shoulderX = rig_?.shoulderX ?? SHOULDER_X;
  const shoulderY = rig_?.shoulderY ?? SHOULDER_Y;
  const hipX = rig_?.hipX ?? HIP_X;
  const hipY = rig_?.hipY ?? HIP_Y;
  const headY = rig_?.headY ?? HEAD_Y;
  const armUpper = rig_?.armUpper ?? ARM_UPPER;
  const legUpper = rig_?.legUpper ?? LEG_UPPER;

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
  /**
   * El TORSO ES EL PADRE de los brazos y de la cabeza.
   *
   * Durante mucho tiempo no lo fue: era un `Graphics` hermano de ellos, y todas
   * las poses escribían `torso.rotation` sin que nadie la heredara. El cuerpo
   * no podía inclinarse llevándose los brazos y la cabeza — se inclinaba solo,
   * y los miembros quedaban flotando en su sitio.
   *
   * Ese desacople es lo que obligaba a que las amplitudes fueran diminutas: con
   * la inclinación del puñetazo en 0,30 radianes ya se empezaba a notar que los
   * hombros no acompañaban, así que nunca se pudo pasar de ahí. Un rig en el
   * que el torso no es un hueso no es un rig; es seis dibujos rotando sueltos, y
   * se ve exactamente así.
   *
   * Las piernas NO cuelgan del torso: nacen de la pelvis, y una pelvis que se
   * mueve con el pecho hace caminar como un títere. Siguen colgando de `body`.
   */
  const backArm = chain(-shoulderX, shoulderY, armUpper);
  const backLeg = chain(-hipX, hipY, legUpper);
  const torso = new Container();
  const torsoG = new Graphics();
  torso.addChild(torsoG);
  const frontLeg = chain(hipX, hipY, legUpper);
  const frontArm = chain(shoulderX, shoulderY, armUpper);
  const head = new Container();
  const headG = new Graphics();
  head.addChild(headG);
  head.y = headY;

  // El orden de `addChild` ES el orden de dibujo: Pixi no ordena por z. Lo de
  // atrás primero, para que en una figura de tres cuartos el brazo y la pierna
  // traseros queden detrás del cuerpo.
  //
  // Los brazos y la cabeza entran al torso; las piernas, al cuerpo. Como el
  // torso se dibuja después de la pierna trasera y antes de la delantera, sus
  // hijos —los dos brazos y la cabeza— quedan todos por delante del torso. El
  // brazo de atrás se sigue leyendo como de atrás por su tinte más oscuro, que
  // ya era el recurso para distinguirlos.
  torso.addChild(backArm.upper, frontArm.upper, head);
  body.addChild(backLeg.upper, torso, frontLeg.upper);

  // La pelota va en el puño de atrás, así que es hija del brazo y lo acompaña
  // en toda la animación sin una línea de código extra.
  const ball = new Graphics();
  if (look.ball) backArm.lower.addChild(ball);

  if (art !== null) {
    // Las piezas traseras usan la MISMA imagen con un tinte más oscuro. Dibujar
    // dos versiones de cada brazo sería el doble de trabajo para el que dibuja y
    // el doble de textura, para expresar una diferencia de luz.
    const BACK_TINT = 0x8a8a8a;
    hang(torsoG, art, 'torso', 0xffffff);
    hang(head, art, 'head', 0xffffff);
    hang(frontArm.upperG, art, 'armUpper', 0xffffff);
    hang(frontArm.lowerG, art, 'armLower', 0xffffff);
    hang(frontLeg.upperG, art, 'legUpper', 0xffffff);
    hang(frontLeg.lowerG, art, 'legLower', 0xffffff);
    hang(backArm.upperG, art, 'armUpper', BACK_TINT);
    hang(backArm.lowerG, art, 'armLower', BACK_TINT);
    hang(backLeg.upperG, art, 'legUpper', BACK_TINT);
    hang(backLeg.lowerG, art, 'legLower', BACK_TINT);
    if (look.blade) hang(blade, art, 'blade', 0xffffff);
  }

  const draw = (tint: number, glow: boolean): void => {
    if (art !== null) {
      // Con arte dibujado, lo único que sigue siendo vectorial es el aura del
      // gigantismo: es un efecto del juego, no una pieza del personaje.
      aura.clear();
      if (glow) aura.circle(0, 5, 74).fill({ color: 0xffd700, alpha: 0.2 });
      return;
    }
    const shade = darken(tint, SHADE);
    const deep = darken(tint, DEEP);
    const line: Line = { width: OUTLINE_WIDTH, color: OUTLINE, alignment: 0.5 };

    /* --- piernas ---------------------------------------------------- */
    // La de atrás bien oscura y la de adelante clara: es lo que separa las dos
    // piernas cuando se cruzan en el ciclo de carrera. Con el mismo tono, un
    // personaje corriendo parece tener una sola pierna gruesa.
    for (const [leg, fill] of [[backLeg, deep], [frontLeg, shade]] as const) {
      // Muslo. Se solapa con la pantorrilla en la rodilla: sin ese solape,
      // doblar la pierna abre un hueco justo en la articulación.
      leg.upperG.clear();
      leg.upperG.roundRect(-LEG_W / 2, -5, LEG_W, LEG_UPPER + 9, 7).fill(fill).stroke(line);
      leg.lowerG.clear();
      leg.lowerG.roundRect(-LEG_W / 2 + 1, -4, LEG_W - 2, LEG_LOWER + 5, 6).fill(fill).stroke(line);
      // El pie, más ancho que la pierna: es lo que da apoyo a la figura.
      leg.lowerG.roundRect(-LEG_W / 2, LEG_LOWER - 2, LEG_W + 7, 12, 5).fill(fill).stroke(line);
    }

    /* --- brazos ------------------------------------------------------ */
    for (const [arm, fill] of [[backArm, deep], [frontArm, tint]] as const) {
      arm.upperG.clear();
      arm.upperG.roundRect(-ARM_W / 2, -5, ARM_W, ARM_UPPER + 9, 7).fill(fill).stroke(line);
      arm.lowerG.clear();
      arm.lowerG.roundRect(-ARM_W / 2 + 1, -4, ARM_W - 2, ARM_LOWER + 3, 6).fill(fill).stroke(line);
      // El puño redondo y grande: en proporción chibi es lo que hace legible un
      // golpe a cuarenta píxeles de alto.
      arm.lowerG.circle(0, ARM_LOWER + 4, 10.5).fill(fill).stroke(line);
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
    headG.circle(7, 2, 16).fill(shade);
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
      ball.circle(0, ARM_LOWER + 4, 13).fill(look.accent).stroke(line);
      ball.moveTo(-13, ARM_LOWER + 4).lineTo(13, ARM_LOWER + 4)
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
      torso.rotation = -0.32;
      head.rotation = -0.34;
      head.y = headY + 3;
      set(backArm, 2.5, 0.5);
      set(frontArm, -2.5, 0.6);
      set(backLeg, 0.5, 0.5);
      set(frontLeg, -0.35, 0.25);
      body.y = BODY_Y + 2;
      return;
    }

    if (action !== ACT_NONE) {
      // `t` va de 0 a 1 a lo largo de la acción. El golpe sale rápido y vuelve
      // lento: `impulse` sube en el primer cuarto y baja en el resto, que es lo
      // que hace que se lea como un golpe y no como un saludo.
      const t = Math.min(1, actionT);
      poseAction(action, t < 0.25 ? t / 0.25 : 1 - (t - 0.25) / 0.75, t);
      return;
    }

    if (!grounded) {
      // En el aire: subiendo se recoge, cayendo se abre. Es la lectura de peso
      // más barata que hay, y con rodilla se lee todavía mejor — el que sube
      // lleva las piernas plegadas contra el cuerpo.
      const rising = vy > 0;
      torso.rotation = rising ? 0.1 : -0.08;
      head.rotation = rising ? 0.08 : -0.1;
      head.y = headY;
      set(backArm, rising ? -2.3 : -1.5, rising ? 0.5 : 0.9);
      set(frontArm, rising ? 2.3 : 1.5, rising ? 0.4 : 0.8);
      set(backLeg, rising ? 0.75 : -0.3, rising ? 1.5 : 0.35);
      set(frontLeg, rising ? -0.5 : 0.35, rising ? 1.1 : 0.2);
      body.y = BODY_Y;
      return;
    }

    if (speed > 0.35) {
      // Ciclo de carrera. La frecuencia sigue a la velocidad real en vez de ser
      // fija: si no, correr y caminar se ven igual y las piernas patinan.
      const cycle = elapsed * (3.2 + speed * 1.5);
      const swing = Math.sin(cycle);
      const lean = Math.min(0.22, speed * 0.045);
      torso.rotation = lean;
      head.rotation = lean * 0.5;

      // La rodilla se dobla en la fase de RECOBRO —cuando la pierna vuelve
      // hacia adelante— y va estirada en la de apoyo. Doblarla siempre igual da
      // el trote de juguete que se quería evitar.
      set(backLeg, swing * 0.85, Math.max(0, -swing) * 1.35);
      set(frontLeg, -swing * 0.85, Math.max(0, swing) * 1.35);

      // Los brazos van en contrafase con las piernas, que es como camina un
      // bípedo. En fase se ve como un juguete a cuerda. El codo queda siempre
      // algo flexionado: un brazo estirado corriendo se ve como un maniquí.
      set(backArm, -swing * 0.7, 0.55 + Math.max(0, swing) * 0.5);
      set(frontArm, swing * 0.7, 0.55 + Math.max(0, -swing) * 0.5);

      // Dos rebotes por ciclo: el cuerpo sube en cada apoyo, no en cada paso.
      body.y = BODY_Y - Math.abs(Math.cos(cycle)) * 3.5;
      head.y = headY;
      return;
    }

    // Quieto: respira. Un personaje perfectamente inmóvil se lee como un error.
    const breath = Math.sin(elapsed * 1.9);
    torso.rotation = 0;
    head.rotation = breath * 0.04;
    head.y = headY - breath * 1.2;
    set(backArm, 0.16 + breath * 0.06, 0.3);
    set(frontArm, -0.16 - breath * 0.06, 0.34);
    set(backLeg, 0.03, 0.06);
    set(frontLeg, -0.03, 0.06);
    body.y = BODY_Y + breath * 1.2;
  };

  /** Rotación de la articulación raíz y del codo o rodilla, que es relativa. */
  function set(part: Chain, root_: number, bend: number): void {
    part.upper.rotation = root_;
    part.lower.rotation = bend;
  }

  /**
   * Las poses de acción se escriben como un DESVÍO desde el reposo, no como una
   * postura absoluta: cada rotación va multiplicada por el impulso.
   *
   * Escritas como postura absoluta —`frontArm = -1.57`— el brazo aparece
   * extendido desde el primer cuadro y se queda extendido en el último, porque
   * con impulso cero la constante sigue ahí. El golpe se veía como una cruz: los
   * dos brazos en horizontal, sin salida ni vuelta.
   */
  function poseAction(action: number, impulse: number, t: number): void {
    head.y = headY;
    // Carga: el primer cuarto de la acción, en el que el golpe todavía no salió.
    // Es lo que hace que un golpe tenga anticipación en vez de aparecer.
    const windup = t < 0.25 ? 1 - t / 0.25 : 0;
    switch (action) {
      case ACT_PUNCH:
        // El codo se pliega en la carga y se estira al soltar. El brazo de
        // atrás va para el otro lado como contrapeso.
        torso.rotation = impulse * 0.3;
        head.rotation = impulse * 0.12;
        set(frontArm, -1.72 * impulse, windup * 2.2);
        // El codo SUMA sobre el hombro, porque es su hijo. Con 0,95 arriba y
        // 1,05 abajo el puño trasero terminaba a la altura del hombro y los dos
        // brazos quedaban en cruz. El de atrás es contrapeso: va abajo y atrás,
        // cerca de la cadera.
        set(backArm, 0.55 * impulse, 0.25 + impulse * 0.25);
        set(backLeg, -impulse * 0.28, 0.15);
        set(frontLeg, impulse * 0.34, 0.1);
        body.y = BODY_Y;
        break;
      case ACT_KICK:
        torso.rotation = -impulse * 0.42;
        head.rotation = -impulse * 0.2;
        // Misma idea con la rodilla: se recoge y se estira al impactar.
        set(frontLeg, -1.5 * impulse, windup * 1.9);
        set(backLeg, impulse * 0.3, 0.2);
        set(frontArm, 0.8 * impulse, 0.45);
        set(backArm, -0.9 * impulse, 0.5);
        body.y = BODY_Y - impulse * 5;
        break;
      case ACT_SKILL:
        // Las dos manos al frente: es la pose que sostiene cualquiera de las dos
        // especiales sin comprometerse con ninguna en particular.
        torso.rotation = impulse * 0.16;
        head.rotation = -impulse * 0.1;
        set(frontArm, -1.45 * impulse, windup * 1.4 + 0.2);
        set(backArm, -1.2 * impulse, windup * 1.4 + 0.25);
        set(backLeg, -impulse * 0.2, 0.12);
        set(frontLeg, impulse * 0.2, 0.12);
        body.y = BODY_Y;
        break;
      default:
        // Super: brazos al cielo y cuerpo estirado. Codos y rodillas casi
        // rectos, que es lo que da la silueta abierta.
        torso.rotation = -impulse * 0.2;
        head.rotation = -impulse * 0.3;
        set(frontArm, 3.0 * impulse, windup * 1.6);
        set(backArm, -3.0 * impulse, windup * 1.6);
        set(backLeg, impulse * 0.16, 0.08);
        set(frontLeg, -impulse * 0.16, 0.08);
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
