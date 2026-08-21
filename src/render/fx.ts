import type { Graphics } from 'pixi.js';

/**
 * Efectos: destellos, chispas, tajos, anillos, esquirlas, polvo y estelas.
 *
 * Un pool de tamaño fijo en arrays tipados, igual que los peleadores.
 *
 * **Por qué se reescribió.** La versión anterior dibujaba TODO con círculos —la
 * chispa, la estela, el polvo, el anillo— y por eso un golpe se veía como una
 * mancha de puntos y no como un impacto. El problema no era la cantidad de
 * partículas sino su forma: un punto no tiene dirección, y un golpe es
 * direccional. Acá cada tipo tiene la forma que le corresponde y, sobre todo,
 * **el golpe sabe hacia dónde va**:
 *
 * - la **chispa** se dibuja como una raya en el sentido de su velocidad, que es
 *   lo que hace que se lea como algo saliendo despedido y no como confeti;
 * - el **destello** es una estrella de cuatro puntas que dura un suspiro, la
 *   forma que el dibujo animado usa desde siempre para decir "acá pegó";
 * - el **tajo** es una medialuna orientada, que dice de dónde vino el golpe;
 * - el **anillo** se achata contra el piso cuando es una onda de choque, porque
 *   una onda que se expande en el suelo no es un círculo visto de frente.
 *
 * **Cero asignaciones**: ni en `emit`, ni en `update`, ni en `draw`. Todo lo que
 * hace falta ya está reservado y el pool descarta la partícula más vieja cuando
 * se llena. Por eso el dibujo usa `moveTo`/`lineTo` y no `poly([...])`: el
 * segundo pide un arreglo nuevo por partícula y por cuadro.
 *
 * Las coordenadas son de MUNDO y con la Y del juego (arriba positivo). La
 * conversión al eje de Pixi se hace en `draw`, en un solo lugar.
 */

export const FX_SPARK = 0;
export const FX_DUST = 1;
/**
 * El orbe: una bola de energía con núcleo blanco, corona del color del bando y
 * contorno oscuro. **Reemplaza al anillo**, que era un círculo fino que se
 * expandía; con dos o tres a la vez la pantalla quedaba llena de aros rojos y
 * amarillos que no se parecían a un poder sino a una onda de radar.
 */
export const FX_ORB = 2;
export const FX_TRAIL = 3;
/** El fogonazo del impacto: una estrella que aparece y se va en un suspiro. */
export const FX_FLASH = 4;
/** La medialuna del golpe, orientada según de dónde vino. */
export const FX_SLASH = 5;
/** Esquirla: un triángulo que gira y cae. Es la materia que salta del impacto. */
export const FX_SHARD = 6;
/** Onda de choque: banda gruesa corriendo por el piso. */
export const FX_WAVE = 7;
/** Rayo: una cuña que sale del centro. Es el estallido radial del super. */
export const FX_BEAM = 8;

const CAPACITY = 420;

/** Puntas del fogonazo. Seis llena; con cuatro quedaba una estrella de lente. */
const PUNTAS = 6;

/**
 * Grosor del contorno, en unidades de mundo.
 *
 * **El contorno lleva el color del BANDO y el relleno es blanco caliente.** Es
 * lo que hace Brawlhalla y es de donde se lee de quién es el golpe: un núcleo
 * blanco con un halo verde o rojo. Reemplaza a las dos ideas anteriores —el
 * aura pegada al cuerpo y la flecha sobre la cabeza—, que tapaban o distraían;
 * el borde del efecto no ocupa lugar nuevo porque ya estaba ahí.
 *
 * Constante y no proporcional al efecto: un contorno que crece con la figura
 * deja de leerse como línea y pasa a ser otra forma.
 */
const TINTA = 0.07;

/** Gravedad de las partículas. Menos que la de los personajes: flotan un poco. */
const FX_GRAVITY = -16;
/**
 * Rozamiento por segundo, por tipo. El polvo se frena enseguida, la chispa casi
 * no, y la esquirla queda en el medio porque pesa.
 */
const DRAG: readonly number[] = [1.6, 4.5, 0, 3, 0, 0, 1.1, 0, 0];
/** Cuáles se mueven solas. Los demás se quedan donde nacieron. */
const VUELA: readonly boolean[] = [true, true, false, false, false, false, true, false, false];

export interface Fx {
  kind: Uint8Array;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  age: Float32Array;
  life: Float32Array;
  size: Float32Array;
  /** Orientación en radianes: hacia dónde apunta el tajo, cómo cae la esquirla. */
  angle: Float32Array;
  /** Vueltas por segundo de la esquirla. Cero en todo lo demás. */
  spin: Float32Array;
  color: Uint32Array;
  head: number;
}

/* --- arcos a mano ----------------------------------------------------- */

/**
 * **Por qué acá no se usa `circle`, `ellipse` ni `arc` de Pixi.**
 *
 * Pixi decide en cuántos tramos parte una curva cuando la construye, en el
 * espacio LOCAL, y no la vuelve a mirar al escalar. Esta capa dibuja en
 * unidades de MUNDO —un anillo de una habilidad tiene radio 2,3— y después la
 * cámara la agranda unas sesenta veces. Así que Pixi subdivide un círculo de
 * dos unidades como si midiera dos píxeles: salían hexágonos. Es el mismo
 * problema que ya está anotado en `backdrop.ts` para los cristales, y la misma
 * solución: la geometría se declara, no se deduce.
 *
 * El número de tramos sale del radio en unidades de mundo por un factor que
 * supone la escala típica de la cámara. No hace falta que sea exacto: entre 18
 * y 72 lados ningún anillo se ve poligonal, y setenta y dos `lineTo` por
 * partícula grande es ruido al lado de lo que cuesta el Bloom.
 */
function tramos(radio: number): number {
  return Math.max(18, Math.min(72, Math.round(Math.abs(radio) * 34)));
}

/** Un arco como polilínea. `mover` arranca un camino nuevo; si no, lo continúa. */
function arco(
  g: Graphics, cx: number, cy: number, rx: number, ry: number,
  desde: number, hasta: number, mover: boolean,
): void {
  const n = tramos(Math.max(rx, ry));
  const paso = (hasta - desde) / n;
  for (let k = 0; k <= n; k++) {
    const a = desde + paso * k;
    const qx = cx + Math.cos(a) * rx;
    const qy = cy + Math.sin(a) * ry;
    if (k === 0 && mover) g.moveTo(qx, qy);
    else g.lineTo(qx, qy);
  }
}

/** Un óvalo cerrado. Con `rx === ry` es un círculo. */
function ovalo(g: Graphics, cx: number, cy: number, rx: number, ry: number): void {
  arco(g, cx, cy, rx, ry, 0, Math.PI * 2, true);
  g.closePath();
}

export function createFx(): Fx {
  const fx: Fx = {
    kind: new Uint8Array(CAPACITY),
    x: new Float32Array(CAPACITY),
    y: new Float32Array(CAPACITY),
    vx: new Float32Array(CAPACITY),
    vy: new Float32Array(CAPACITY),
    age: new Float32Array(CAPACITY),
    life: new Float32Array(CAPACITY),
    size: new Float32Array(CAPACITY),
    angle: new Float32Array(CAPACITY),
    spin: new Float32Array(CAPACITY),
    color: new Uint32Array(CAPACITY),
    head: 0,
  };
  // Todas nacen muertas: `age >= life` es la condición de libre.
  fx.age.fill(1);
  fx.life.fill(1);
  return fx;
}

function spawn(
  fx: Fx, kind: number, x: number, y: number,
  vx: number, vy: number, size: number, life: number, color: number,
  angle: number = 0, spin: number = 0,
): void {
  const i = fx.head;
  fx.head = (i + 1) % CAPACITY;
  fx.kind[i] = kind;
  fx.x[i] = x;
  fx.y[i] = y;
  fx.vx[i] = vx;
  fx.vy[i] = vy;
  fx.age[i] = 0;
  fx.life[i] = life;
  fx.size[i] = size;
  fx.angle[i] = angle;
  fx.spin[i] = spin;
  fx.color[i] = color;
}

/**
 * El impacto completo de un golpe cuerpo a cuerpo.
 *
 * Una sola llamada porque las tres piezas —fogonazo, tajo y chispas— son *un*
 * golpe y tienen que salir juntas y con la misma dirección. Repartirlas en tres
 * llamadas fue lo que dejó la versión anterior con chispas radiales que no
 * decían nada: cada quien elegía su ángulo por su cuenta.
 *
 * `dir` es hacia dónde viaja el golpe, en radianes.
 */
export function impact(
  fx: Fx, x: number, y: number, dir: number, strength: number, color: number,
): void {
  const s = Math.max(0.4, strength);
  flash(fx, x, y, 0.55 * s, 0.13, 0xffffff);
  slash(fx, x, y, dir, 0.9 * s, 0.17, color);
  // Las chispas salen en abanico HACIA ADELANTE, no en círculo: un golpe manda
  // la materia para el lado en que pegó.
  const count = 5 + Math.round(s * 4);
  for (let n = 0; n < count; n++) {
    const spread = (Math.random() - 0.5) * 1.5;
    const angle = dir + spread;
    const speed = (3.4 + Math.random() * 4.6) * s;
    spawn(
      fx, FX_SPARK, x, y,
      Math.cos(angle) * speed,
      Math.sin(angle) * speed + 1.6,
      0.05 + Math.random() * 0.06,
      0.18 + Math.random() * 0.16,
      color,
    );
  }
}

/** El fogonazo solo: una estrella blanca que dura un suspiro. */
export function flash(
  fx: Fx, x: number, y: number, size: number, life: number, color: number,
): void {
  spawn(fx, FX_FLASH, x, y, 0, 0, size, life, color, Math.random() * Math.PI);
}

/** La medialuna del golpe. `dir` es hacia dónde va el golpe. */
export function slash(
  fx: Fx, x: number, y: number, dir: number, size: number, life: number, color: number,
): void {
  spawn(fx, FX_SLASH, x, y, 0, 0, size, life, color, dir);
}

/**
 * Chispas en círculo. Queda para lo que NO tiene dirección —una descarga que
 * revienta en el lugar—; para un golpe va `impact`, que las manda hacia adelante.
 */
export function burst(
  fx: Fx, x: number, y: number,
  count: number, speed: number, size: number, life: number, color: number,
): void {
  const offset = Math.random() * Math.PI * 2;
  for (let n = 0; n < count; n++) {
    const angle = offset + (n / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    const magnitude = speed * (0.55 + Math.random() * 0.45);
    spawn(
      fx, FX_SPARK, x, y,
      Math.cos(angle) * magnitude,
      Math.sin(angle) * magnitude + speed * 0.25,
      size * (0.6 + Math.random() * 0.6),
      life * (0.7 + Math.random() * 0.6),
      color,
    );
  }
}

/** Esquirlas: triángulos que giran y caen. Es lo que revienta en un super. */
export function shards(
  fx: Fx, x: number, y: number, count: number, speed: number, color: number,
): void {
  for (let n = 0; n < count; n++) {
    const angle = (n / count) * Math.PI * 2 + Math.random() * 0.6;
    const magnitude = speed * (0.5 + Math.random() * 0.7);
    spawn(
      fx, FX_SHARD, x, y,
      Math.cos(angle) * magnitude,
      Math.abs(Math.sin(angle)) * magnitude + speed * 0.5,
      0.12 + Math.random() * 0.13,
      0.55 + Math.random() * 0.45,
      color,
      Math.random() * Math.PI * 2,
      (Math.random() - 0.5) * 9,
    );
  }
}

/** Polvo al aterrizar: sale para los costados y casi no sube. */
export function dust(fx: Fx, x: number, y: number, strength: number): void {
  const count = 4 + Math.round(strength * 3);
  for (let n = 0; n < count; n++) {
    const dir = n % 2 === 0 ? 1 : -1;
    spawn(
      fx, FX_DUST, x + dir * 0.1, y,
      dir * (0.9 + Math.random() * 1.5) * strength,
      Math.random() * 0.9,
      0.1 + Math.random() * 0.09,
      0.28 + Math.random() * 0.2,
      0xc8d4e8,
    );
  }
}

/**
 * Una bola de energía. Es el cuerpo de una habilidad.
 *
 * `color` es el del BANDO y se usa para la corona y el contorno; el centro es
 * siempre blanco caliente. Ésa es la regla nueva de toda esta capa: el poder se
 * dibuja igual para los seis y lo que dice de quién es, es el borde.
 */
/**
 * OJO al llamar: el diámetro real en pantalla es `radius * ~3.1`, no
 * `radius * 2`. `drawFx` (más abajo, caso `FX_ORB`) dibuja seis anillos de
 * degradé hasta `1.55 * radius` —el halo que necesita el Bloom para no
 * cortar de golpe— más cuatro púas hasta `1.5 * radius`. Un radio de 1.1
 * pasado sin hacer esta cuenta es un orbe de 3.4 unidades de mundo, más de
 * tres veces el alto de un peleador (1.04) — fue justo el bug que tapaba al
 * personaje en súper/KO/estallido: `vfxSprites.burst()` ya se había achicado
 * pero esta bola de acá, la geometría a mano, seguía en el tamaño viejo.
 */
export function orb(fx: Fx, x: number, y: number, radius: number, life: number, color: number): void {
  spawn(fx, FX_ORB, x, y, 0, 0, radius, life, color, Math.random() * Math.PI);
}

/**
 * El estallido radial: `count` cuñas saliendo del centro.
 *
 * Es la forma que el dibujo animado usa para una descarga de energía —una bola
 * y rayos— y es lo que separa un poder de una onda expansiva. Sin esto el super
 * era un aro creciendo, que se lee como un radar y no como algo que revienta.
 */
export function beams(
  fx: Fx, x: number, y: number, count: number, largo: number, life: number, color: number,
): void {
  const offset = Math.random() * Math.PI * 2;
  for (let n = 0; n < count; n++) {
    const angle = offset + (n / count) * Math.PI * 2;
    // Alternados largo/corto: todos iguales queda una estrella de reloj.
    const escala = n % 2 === 0 ? 1 : 0.62;
    spawn(fx, FX_BEAM, x, y, 0, 0, largo * escala, life * (0.8 + escala * 0.2), color, angle);
  }
}

/** Onda de choque contra el piso: el anillo del super, achatado. */
export function wave(fx: Fx, x: number, y: number, radius: number, life: number, color: number): void {
  spawn(fx, FX_WAVE, x, y, 0, 0, radius, life, color);
}

/**
 * Un tramo de estela, en el sentido en que va el cuerpo.
 *
 * **Antes era un círculo relleno en el centro del peleador, emitido todos los
 * cuadros.** A sesenta por segundo y con 0,22 s de vida son trece círculos
 * apilados exactamente en el mismo punto, sobre la capa que lleva Bloom: no se
 * veía una estela, se veía **una bola de luz pegada al cuerpo** que tapaba el
 * dibujo. Era lo que más ensuciaba la pantalla y lo más fácil de confundir con
 * un efecto de poder.
 *
 * Una estela es un rastro: va DETRÁS y tiene la forma de por dónde se pasó. Se
 * guarda la velocidad —la partícula no se mueve, `VUELA` la deja quieta— y se
 * dibuja como un trazo orientado que se afina al apagarse.
 */
export function trail(
  fx: Fx, x: number, y: number, vx: number, vy: number, size: number, color: number,
): void {
  spawn(fx, FX_TRAIL, x, y, vx, vy, size, 0.2, color);
}

export function updateFx(fx: Fx, dt: number): void {
  for (let i = 0; i < CAPACITY; i++) {
    if (fx.age[i] >= fx.life[i]) continue;
    fx.age[i] += dt;
    const kind = fx.kind[i];
    if (!VUELA[kind]) continue;
    fx.angle[i] += fx.spin[i] * dt;
    fx.vy[i] += FX_GRAVITY * dt;
    const drag = 1 - Math.min(1, DRAG[kind] * dt);
    fx.vx[i] *= drag;
    fx.vy[i] *= drag;
    fx.x[i] += fx.vx[i] * dt;
    fx.y[i] += fx.vy[i] * dt;
  }
}

/**
 * Dibuja en dos capas: `plain` para lo que no brilla y `glow` para lo que sí.
 *
 * La separación es lo que permite que el Bloom sea SELECTIVO. Aplicarlo a toda
 * la escena lava los contornos negros, que son la mitad del estilo; aplicándolo
 * sólo a esta capa brillan el super, las habilidades y el aura del gigantismo,
 * y el resto queda limpio.
 */
/**
 * Dibuja en TRES capas, y el reparto es lo que da el estilo.
 *
 *   plain  polvo. No brilla y va detrás de todo.
 *   glow   los rellenos calientes. Es la única capa con Bloom.
 *   ink    los contornos: negro afuera y el color del BANDO adentro. Va encima
 *          del Bloom y no lo atraviesa, así que sale nítido.
 *
 * **Por qué tres y no dos.** Los efectos anteriores eran trazos finos y
 * brillantes: un anillo que se expande, unas chispas, todo resuelto con luz.
 * Eso se ve como un juego de naves, no como éste. Los seis personajes están
 * dibujados con relleno plano y contorno negro —es todo el estilo del juego— y
 * los poderes tienen que estar dibujados igual, que es lo que hacen Smash,
 * Brawlhalla, Dragon Ball y Street Fighter: formas LLENAS, borde duro, mucho
 * contraste, nada de degradés.
 *
 * Con dos capas no se puede: si el contorno va en la capa que brilla, el Bloom
 * se lo come y vuelve a ser una mancha; si va en la de atrás, queda tapado por
 * su propio relleno. Tiene que ir en una tercera, adelante y sin filtro.
 *
 * **Y de ahí sale de qué bando es el golpe.** El relleno es siempre blanco
 * caliente —un poder es un poder—, y el borde lleva el color del equipo. Antes
 * eso lo decía un aura pegada al cuerpo, y después una flecha sobre la cabeza;
 * las dos tapaban o distraían. El contorno del efecto no ocupa lugar: ya estaba
 * ahí.
 */
export function drawFx(fx: Fx, plain: Graphics, glow: Graphics, ink: Graphics): void {
  plain.clear();
  glow.clear();
  ink.clear();
  for (let i = 0; i < CAPACITY; i++) {
    if (fx.age[i] >= fx.life[i]) continue;
    const t = fx.age[i] / fx.life[i];
    const fade = (1 - t) * (1 - t);
    const px = fx.x[i];
    const py = -fx.y[i];
    const color = fx.color[i];

    switch (fx.kind[i]) {
      case FX_ORB: {
        // La bola de energía. Nace de golpe, aguanta y se apaga encogiendo un
        // poco: el ciclo de un ki blast. Tres anillos concéntricos rellenos
        // —blanco, color, contorno— es lo que le da el borde duro.
        const brote = t < 0.18 ? t / 0.18 : 1;
        const r = fx.size[i] * brote * (1 - t * 0.25);
        const vivo = 0.5 + fade * 0.5;

        // Corona del bando, y adentro el núcleo blanco. El núcleo es más chico
        // que la mitad a propósito: si ocupa casi todo, el color del equipo
        // queda de filete y no se lee a la distancia de la cámara.
        // Seis anillos y no dos. Con dos, la bola es un disco plano de color con
        // un disco blanco encima —que es exactamente lo que se veía en pantalla,
        // una calcomanía— porque `Graphics` no rellena con degradé radial. Seis
        // radios con alfas escalonados son ese degradé hecho a mano: el ojo deja
        // de separar los bordes y lee una caída de luz.
        //
        // Los dos primeros pasan de 1: son el halo que se derrama fuera del
        // cuerpo de la bola. Sin él la bola termina de golpe y el Bloom no tiene
        // de dónde agarrarse.
        const capas: Array<[number, number, number]> = [
          [1.55, 0.12, color],
          [1.24, 0.24, color],
          [1.0, 0.82, color],
          [0.74, 0.5, 0xffffff],
          [0.52, 0.8, 0xffffff],
          [0.3, 1, 0xffffff],
        ];
        for (const [f, alfa, c] of capas) {
          ovalo(glow, px, py, r * f, r * f);
          glow.fill({ color: c, alpha: vivo * alfa });
        }

        // Las púas: cuatro puntas cortas que hacen que la bola no sea un punto.
        //
        // Cortas de verdad. Estaban en 2,25 veces el radio, y eso hace que el
        // tamaño que se le pide al orbe no tenga nada que ver con el que ocupa:
        // el anillo del gigantismo, pedido en 1,15 unidades, medía 5,2 de punta
        // a punta —un tercio de la pantalla— y con tres pasos de carga quedaban
        // tres estrellas gigantes encimadas. El que llama tiene que poder
        // razonar sobre el número que pasa.
        const a0 = fx.angle[i] + t * 1.6;
        for (let k = 0; k < 4; k++) {
          const a = a0 + (k * Math.PI) / 2;
          const largo = r * (1.15 + brote * 0.35);
          const ancho = r * 0.3;
          glow.moveTo(px + Math.cos(a) * largo, py + Math.sin(a) * largo);
          glow.lineTo(px + Math.cos(a + 1.57) * ancho, py + Math.sin(a + 1.57) * ancho);
          glow.lineTo(px + Math.cos(a - 1.57) * ancho, py + Math.sin(a - 1.57) * ancho);
          glow.closePath();
          glow.fill({ color, alpha: vivo * 0.85 });
        }

        // Sin filete. El trazo alrededor de la bola le pone borde de figura
        // recortada a algo que tiene que ser luz, y además delata que el
        // círculo de `Graphics` es un polígono: en pantalla se veía el
        // decágono. Lo que la separa del fondo es el Bloom.
        break;
      }
      case FX_BEAM: {
        // Una cuña que sale disparada y se afina. El vértice arranca pegado al
        // centro y se va alejando: así el rayo SALE en vez de aparecer entero.
        const desde = fx.size[i] * t * 0.55;
        const hasta = fx.size[i] * (0.35 + t * 0.9);
        const a = -fx.angle[i];
        const ancho = fx.size[i] * 0.14 * fade;
        const cx = Math.cos(a);
        const cy = Math.sin(a);
        const nx = -cy * ancho;
        const ny = cx * ancho;
        glow.moveTo(px + cx * hasta, py + cy * hasta);
        glow.lineTo(px + cx * desde + nx, py + cy * desde + ny);
        glow.lineTo(px + cx * desde - nx, py + cy * desde - ny);
        glow.closePath();
        glow.fill({ color, alpha: 0.35 + fade * 0.65 });
        break;
      }
      case FX_WAVE: {
        // La onda del super: una BANDA gruesa contra el piso, no un aro fino.
        // Achatada a un tercio porque corre por el suelo; vista de frente
        // parecería flotando en el aire.
        const r = fx.size[i] * (0.1 + t * 1.05);
        const grosor = fx.size[i] * 0.16 * fade + 0.04;
        ovalo(glow, px, py, r, r * 0.32);
        ovalo(glow, px, py, Math.max(0.01, r - grosor), Math.max(0.01, (r - grosor) * 0.32));
        // `evenodd`: el óvalo de adentro perfora al de afuera y queda la banda.
        // Con el relleno por defecto se llenaría el disco entero.
        glow.fill({ color: 0xffffff, alpha: fade * 0.9 });
        ovalo(ink, px, py, r, r * 0.32);
        ink.stroke({ width: TINTA, color, alpha: fade });
        break;
      }
      case FX_FLASH: {
        // El fogonazo del impacto: una estrella de seis puntas irregular,
        // rellena y con contorno. Es el "hit spark" de Smash y de Brawlhalla, y
        // la razón de que sea llena y no de rayos finos es que un golpe tiene
        // que TAPAR algo por un instante.
        const brote = t < 0.25 ? t / 0.25 : 1;
        const r = fx.size[i] * (0.5 + brote * 0.6) * (1 - t * 0.3);
        const corto = r * 0.56;
        const a = fx.angle[i];
        for (let k = 0; k < PUNTAS * 2; k++) {
          const ang = a + (k * Math.PI) / PUNTAS;
          const rad = k % 2 === 1 ? corto : (k % 4 === 0 ? r : r * 0.78);
          const qx = px + Math.cos(ang) * rad;
          const qy = py + Math.sin(ang) * rad;
          if (k === 0) { glow.moveTo(qx, qy); ink.moveTo(qx, qy); }
          else { glow.lineTo(qx, qy); ink.lineTo(qx, qy); }
        }
        glow.closePath();
        glow.fill({ color: 0xffffff, alpha: 0.45 + fade * 0.55 });
        ink.closePath();
        ink.stroke({ width: TINTA, color, alpha: 0.5 + fade * 0.5 });
        break;
      }
      case FX_SLASH: {
        // Medialuna: el rastro del brazo que pasó, así que **abraza el golpe**.
        // El centro del arco va detrás del punto de impacto y la panza cae
        // encima de él; centrada EN el impacto quedaba una sonrisa colgada
        // abajo, sin relación con hacia dónde iba el golpe.
        const r = fx.size[i] * (0.45 + t * 1.1);
        const grosor = fx.size[i] * 0.4 * (1 - t);
        // El eje Y de Pixi apunta al revés que el del juego: se refleja el
        // ángulo antes de dibujar o el tajo sale espejado.
        const medio = -fx.angle[i];
        const abre = 1.15 - t * 0.5;
        const cx = px - Math.cos(medio) * r * 0.7;
        const cy = py - Math.sin(medio) * r * 0.7;
        const interior = Math.max(0.01, r - grosor);
        for (const capa of [glow, ink]) {
          arco(capa, cx, cy, r, r, medio - abre, medio + abre, true);
          arco(capa, cx, cy, interior, interior, medio + abre, medio - abre, false);
          capa.closePath();
        }
        glow.fill({ color: 0xffffff, alpha: (1 - t) * 0.85 });
        ink.stroke({ width: TINTA, color, alpha: (1 - t) * 0.95 });
        break;
      }
      case FX_SPARK: {
        // Una RAYA en el sentido de la velocidad, no un punto. El largo sale de
        // cuán rápido va: una chispa lenta es casi un punto y una rápida es un
        // trazo. Sale gratis y es lo que da sensación de fuerza.
        const rapidez = Math.hypot(fx.vx[i], fx.vy[i]);
        const largo = Math.min(0.8, rapidez * 0.055);
        const inv = largo > 1e-4 && rapidez > 1e-4 ? largo / rapidez : 0;
        glow.moveTo(px, py);
        glow.lineTo(px - fx.vx[i] * inv, py + fx.vy[i] * inv);
        glow.stroke({
          width: fx.size[i] * (1 - t * 0.6),
          color,
          alpha: 0.4 + fade * 0.6,
          cap: 'round',
        });
        break;
      }
      case FX_SHARD: {
        // Triángulo girando: la materia que salta del impacto. Es lo que hace
        // que un super se sienta como algo que ROMPIÓ y no como una luz que se
        // prende.
        const r = fx.size[i] * (0.6 + fade * 0.6);
        const a = fx.angle[i];
        const p0x = px + Math.cos(a) * r;
        const p0y = py + Math.sin(a) * r;
        for (const capa of [glow, ink]) {
          capa.moveTo(p0x, p0y);
          capa.lineTo(px + Math.cos(a + 2.4) * r * 0.75, py + Math.sin(a + 2.4) * r * 0.75);
          capa.lineTo(px + Math.cos(a - 2.4) * r * 0.75, py + Math.sin(a - 2.4) * r * 0.75);
          capa.closePath();
        }
        glow.fill({ color: 0xffffff, alpha: 0.4 + fade * 0.5 });
        ink.stroke({ width: TINTA * 0.8, color, alpha: 0.5 + fade * 0.5 });
        break;
      }
      case FX_TRAIL: {
        // Un trazo hacia atrás, largo según lo rápido que iba. Sin velocidad
        // —no debería pasar— no se dibuja nada, que es mejor que un punto.
        const rapidez = Math.hypot(fx.vx[i], fx.vy[i]);
        if (rapidez < 1e-4) break;
        const largo = Math.min(0.7, rapidez * 0.05);
        glow.moveTo(px, py);
        glow.lineTo(px - (fx.vx[i] / rapidez) * largo, py + (fx.vy[i] / rapidez) * largo);
        glow.stroke({
          width: fx.size[i] * fade,
          color,
          alpha: fade * 0.55,
          cap: 'round',
        });
        break;
      }
      default: {
        const r = fx.size[i] * (1 + t * 1.6);
        ovalo(plain, px, py, r, r);
        plain.fill({ color, alpha: fade * 0.45 });
        break;
      }
    }
  }
}
