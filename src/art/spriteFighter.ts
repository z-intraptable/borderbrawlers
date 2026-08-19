import { Container, Sprite } from 'pixi.js';
import { ACTION_HIT, ACT_KICK, ACT_NONE, ACT_PUNCH, ACT_SKILL, ACT_SUPER } from './fighter';
import type { FighterView } from './fighter';
import type { FighterSheets, SheetAnimation } from './loadSheets';

/**
 * El peleador dibujado cuadro por cuadro, con las hojas que salen de Kling.
 *
 * Expone **el mismo contrato** que `createFighterView`: un `Container` con
 * `pose()` y `paint()`. `game.ts` no sabe cuál de los dos le tocó y cambia en
 * una sola línea, la de construcción. Eso es a propósito: el muñeco de piezas
 * sigue siendo el respaldo del personaje que todavía no tiene hoja, y los dos
 * tienen que poder convivir en la misma pelea.
 *
 * **Por qué se reemplaza el muñeco.** Rotar seis piezas con senos y cosenos no
 * llega a parecerse a un juego dibujado a mano, y no por falta de constantes
 * bien puestas: una pieza rígida no se deforma, no anticipa y no arrastra. Acá
 * el dibujo ya viene con todo eso adentro.
 *
 * **Lo que se pierde.** El muñeco respondía de forma continua a `vx` y `vy`; una
 * hoja tiene cuadros fijos. Se compensa eligiendo el cuadro con la velocidad
 * —la carrera avanza más rápido si el personaje va más rápido— pero una pose
 * intermedia exacta ya no existe. Es el precio de que se vea dibujado.
 */

/** Unidades de rig por unidad de mundo, igual que en `fighter.ts`. */
const RIG = 100;
/** Media altura del cuerpo en unidades de rig: `FIGHTER_HALF_HEIGHT * RIG`. */
const HALF = 52;
/**
 * Qué tan adentro del giro —0 de perfil, 1 en el medio— hace falta estar para
 * cambiar al cuadro de frente. La misma constante la usa `game.ts` para saber
 * hasta dónde deshacer el angostamiento del cuerpo, así que vive acá y se
 * importa: que las dos mitades del efecto usen números distintos es
 * exactamente el tipo de bug que no tira ningún error, sólo un salto feo un
 * cuadro antes o después de que el dibujo cambie.
 */
export const UMBRAL_GIRO_FRENTE = 0.42;

/**
 * Cuánto avanza el ciclo de carrera por unidad de mundo recorrida.
 *
 * Atarlo a la distancia y no al reloj es lo que evita que el personaje patine:
 * si el cuadro depende del tiempo, al frenar sigue moviendo las piernas en el
 * lugar. Doce cuadros por 1,6 unidades es aproximadamente un paso por zancada
 * al ritmo al que corre.
 */
const RUN_CYCLE = 1.6;
/** Ciclos por segundo de la respiración, cuando está quieto. */
const IDLE_HZ = 0.55;
/**
 * Cuánto se hincha el cuerpo al respirar, en fracción del alto.
 *
 * Existe porque **cinco de los seis tienen UN solo cuadro de `idle`**: sin esto
 * el peleador quieto es literalmente una estatua, y eso es la mitad de lo que
 * se ve como movimiento duro. Un 2% de alto es medio pixel en pantalla, pero es
 * medio pixel que sube y baja, y alcanza para que el cuerpo se lea vivo.
 */
const RESPIRO = 0.02;

/**
 * A qué animación va cada acción, en orden de preferencia. La primera que la
 * hoja tenga, gana; si no tiene ninguna, la acción se dibuja con `idle`.
 *
 * Existe porque las hojas se generan de a una: hoy Ragnir tiene `run` y `jump`
 * y nada más, y la pelea no puede romperse porque falte `punch`. Cuando esté,
 * entra sola.
 */
const FALLBACK: Record<number, readonly string[]> = {
  [ACT_PUNCH]: ['punch', 'attack'],
  [ACT_KICK]: ['kick', 'punch', 'attack'],
  [ACT_SKILL]: ['skill', 'punch', 'attack'],
  [ACT_SUPER]: ['super', 'skill', 'punch', 'attack'],
};

/**
 * Cuánto se corre el dibujo hacia adelante en el golpe, en unidades de rig.
 *
 * Un peleador que tira una especial sin moverse del lugar parece que la mima. La
 * física no lo puede hacer —moverlo de verdad cambiaría a quién le pega y desde
 * dónde—, así que el empujón es del DIBUJO: sale y vuelve dentro de la misma
 * acción, y al terminar el sprite está exactamente donde lo dejó la simulación.
 *
 * Va en el sprite y no en el contenedor porque el contenedor lo posiciona
 * `game.ts` desde la física; escribir ahí sería pelearse con ella cada frame.
 * El super empuja más que el puño: es la diferencia entre un jab y tirarse
 * encima del otro.
 */
const EMBESTIDA: Record<number, number> = {
  [ACT_PUNCH]: 7,
  [ACT_KICK]: 10,
  [ACT_SKILL]: 14,
  [ACT_SUPER]: 20,
};

/**
 * La curva del empujón: de 0 al golpe y del golpe de vuelta a 0.
 *
 * Es asimétrica a propósito, y por eso no alcanza con un seno. El golpe de la
 * habilidad cae al 36% de la acción y el del super al 72%: con una curva
 * simétrica el super llegaría a su punto más adelantado bastante antes de bajar
 * los puños, que es justo el cuadro donde tiene que estar más lejos.
 */
function embestida(action: number, t: number): number {
  const golpe = ACTION_HIT[action] ?? 0;
  if (!(golpe > 0) || !(golpe < 1)) return 0;
  const fase = t < golpe ? t / golpe : (1 - t) / (1 - golpe);
  return (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, fase)))) / 2;
}

/**
 * El ritmo de un golpe: lento al cargar, rápido al pegar, lento al volver.
 *
 * `actionT` viene lineal, y reproducir cuadros a ritmo constante es lo que hace
 * que una acción se vea mecánica: los dibujos pueden ser buenos y el golpe igual
 * no pesa. Un golpe animado a mano no reparte el tiempo por igual — se demora en
 * la carga, cruza el impacto en un suspiro y se toma el resto para volver. Eso
 * es lo que acá se le devuelve.
 *
 * La curva se dobla alrededor de `ACTION_HIT`, no del medio: el instante que
 * tiene que llegar rápido es el del impacto, y cae al 36% de la habilidad y al
 * 72% del super. Doblarla en el medio le pondría el acento en cualquier lado.
 *
 * Con dos o tres cuadros por acción esto no interpola nada: cambia CUÁNTO se
 * sostiene cada cuadro, que con tan pocos es justamente donde está el peso.
 */
function ritmo(t: number, golpe: number): number {
  if (!(golpe > 0) || !(golpe < 1)) return t;
  if (t < golpe) {
    const u = t / golpe;
    return golpe * u * u;
  }
  const u = (t - golpe) / (1 - golpe);
  return golpe + (1 - golpe) * (1 - (1 - u) * (1 - u));
}

export function createSpriteFighterView(sheets: FighterSheets): FighterView {
  const root = new Container() as FighterView;

  const rig = new Container();
  rig.scale.set(1 / RIG);
  root.addChild(rig);

  const sprite = new Sprite();
  rig.addChild(sprite);

  /** Píxeles de hoja a unidades de rig. */
  const scale = 1 / sheets.unit;

  const idle = sheets.animations.get('idle') ?? null;
  const run = sheets.animations.get('run') ?? null;
  const jump = sheets.animations.get('jump') ?? null;
  const hurtAnim = sheets.animations.get('hurt') ?? null;
  const fallAnim = sheets.animations.get('fall') ?? null;
  /**
   * El cuadro de frente, generado con Kling/Nano Banana para el giro.
   *
   * No todos los personajes lo tienen todavía —se hizo Kor y Ragnir primero,
   * de a uno por vez que da la técnica de referencia+turnaround—, así que es
   * opcional: sin él, `pose()` sigue angostando el perfil como hacía antes.
   */
  const gira = sheets.animations.get('gira') ?? null;
  // Sin `idle` propio, el primer cuadro de la carrera hace de pose de pie: es
  // el mismo personaje parado en una zancada, y se lee mucho mejor que dejarlo
  // en blanco.
  const stand = idle ?? run ?? jump;
  if (stand === null) throw new Error('la hoja no trae ninguna animación usable');

  /**
   * Deja un cuadro puesto.
   *
   * El ancla se escribe por cuadro y no una vez: cada cuadro tiene su propio
   * centroide dentro de su propio rectángulo, y usar el del anterior corre el
   * cuerpo unos píxeles en cada cambio. Eso es exactamente el temblor que la
   * alineación del script existe para sacar.
   */
  function show(animation: SheetAnimation, index: number): void {
    const frames = animation.frames;
    const frame = frames[Math.max(0, Math.min(frames.length - 1, index))];
    if (frame === undefined) return;
    sprite.texture = frame.texture;
    sprite.anchor.set(frame.anchorX, frame.anchorY);
    sprite.scale.set(scale);
    // Sin acción no hay empujón; la que lo quiera lo escribe después de `show`.
    sprite.x = 0;
    // El centroide queda en el origen del rig; de ahí a los pies hay `ground`
    // unidades, y los pies tienen que caer a `HALF` del centro del cuerpo.
    //
    // El `ground` es **el de esta animación**, no uno solo para el personaje.
    // Con uno solo —medido sobre la primera acción, que en la práctica es
    // correr— la pose de pie quedaba flotando hasta 11 unidades y la patada
    // hundida 8 en la losa. Es la diferencia entre un personaje apoyado y uno
    // que levita.
    sprite.y = HALF - animation.ground;
  }

  /** El cuadro de un ciclo que se repite, con el índice envuelto. */
  function cycle(animation: SheetAnimation, phase: number): void {
    const n = animation.frames.length;
    const i = Math.floor(phase * n) % n;
    show(animation, i < 0 ? i + n : i);
  }

  /**
   * Hincha y desinfla el cuerpo, con los pies clavados.
   *
   * El ancla del sprite es el centroide, así que escalarlo en Y le mueve los
   * pies: el personaje respirando se hundiría en la losa y saldría de ella. Los
   * pies caen a `ground` unidades del ancla, así que compensar es escalar esa
   * distancia con el mismo factor. El ancho va al revés que el alto porque un
   * cuerpo que se estira se afina: es lo que hace que se lea como volumen y no
   * como un zoom.
   */
  function respirar(animation: SheetAnimation, fase: number): void {
    const aire = Math.sin(fase * Math.PI * 2) * RESPIRO;
    sprite.scale.y = scale * (1 + aire);
    sprite.scale.x = scale * (1 - aire * 0.5);
    sprite.y = HALF - animation.ground * (1 + aire);
  }

  /** Cuánto se recorrió, para que la carrera avance con la distancia. */
  let travelled = 0;
  let lastElapsed = 0;

  root.pose = (
    vx: number, vy: number, grounded: boolean, hurt: boolean,
    action: number, actionT: number, elapsed: number, turn: number,
  ): void => {
    const dt = Math.max(0, Math.min(0.1, elapsed - lastElapsed));
    lastElapsed = elapsed;
    travelled += Math.abs(vx) * dt;

    // El giro pasa a mostrar el cuadro de FRENTE en vez de seguir angostando
    // el de perfil. Va antes que golpeado y que la acción a propósito: un
    // puño que conecta justo en medio del cruce tiene que seguir viéndose de
    // frente y no partirse en dos cuadros por medio paso de diferencia.
    if (gira !== null && turn >= UMBRAL_GIRO_FRENTE) {
      show(gira, 0);
      return;
    }

    if (hurt) {
      // Golpeado en el piso es un retroceso; golpeado en el aire es salir
      // despedido, que es otro dibujo: el cuerpo va dando vueltas. Es la
      // diferencia entre encajar un golpe y que te saquen del escenario, y en un
      // juego donde el knockback es la mecánica central se tiene que ver.
      const cual = !grounded && fallAnim !== null ? fallAnim : hurtAnim;
      if (cual !== null) {
        // Encajar un golpe es lo más asimétrico que hay: el cuerpo se dobla en
        // un cuadro y tarda en enderezarse. El impacto va al principio.
        show(cual, Math.floor(ritmo(actionT, 0.15) * cual.frames.length));
        return;
      }
    }

    if (action !== ACT_NONE) {
      const names = FALLBACK[action] ?? [];
      for (const name of names) {
        const animation = sheets.animations.get(name);
        if (animation === undefined) continue;
        // `actionT` ya viene normalizado de 0 a 1 por `game.ts`, así que la
        // acción no necesita reloj propio y no puede quedar desfasada del golpe.
        // Lo que sí se le cambia es el RITMO: ver `ritmo`.
        const fase = ritmo(actionT, ACTION_HIT[action] ?? 0);
        show(animation, Math.floor(fase * animation.frames.length));
        sprite.x = (EMBESTIDA[action] ?? 0) * embestida(action, actionT);
        return;
      }
    }

    if (!grounded && jump !== null) {
      // El salto no cicla: se recorre según en qué parte del arco está. Subir es
      // la primera mitad de la hoja y caer la segunda, así que la velocidad
      // vertical elige el cuadro directamente.
      const n = jump.frames.length;
      const subiendo = Math.max(-1, Math.min(1, vy / 9));
      show(jump, Math.round((1 - subiendo) * 0.5 * (n - 1)));
      return;
    }

    if (run !== null && Math.abs(vx) > 0.35) {
      cycle(run, travelled / RUN_CYCLE);
      return;
    }

    cycle(stand, elapsed * IDLE_HZ);
    respirar(stand, elapsed * IDLE_HZ);
  };

  // Nadie la llama —está declarada en el contrato y verificado que `game.ts` no
  // la usa—, pero tiene que existir para que el tipo cierre. Teñir un dibujo con
  // `tint` le apagaría los colores propios, que es justo lo contrario de lo que
  // el proyecto decidió: el bando se lee en los poderes, no en la ropa.
  root.paint = (): void => {};

  return root;
}
