import { Container, Graphics } from 'pixi.js';

/**
 * El peleador placeholder, dibujado con vectores.
 *
 * **Esta es la costura para el arte.** Toda la simulación trata al personaje
 * como un rectángulo con un ancho y un alto; lo único que decide cómo se ve es
 * esta función. El día que existan los rigs de DragonBones se reemplaza el
 * contenido de `createDoll` por el armature y nada más cambia: ni la física, ni
 * la IA, ni el feed, ni la cámara.
 *
 * Las proporciones siguen la ficha de estilo: cabeza grande, torso chico, manos
 * y pies robustos, contorno negro grueso y continuo, colores planos sin
 * degradados. La cabeza desproporcionada no es un capricho — es lo que hace que
 * una figura de cuarenta píxeles se lea, y es por eso que los personajes de
 * Brawlhalla son cabezones.
 *
 * Todo está dibujado en unidades de mundo, con el origen en el centro del
 * cuerpo, pero **en el eje Y de Pixi, que crece hacia ABAJO**: los pies van en
 * +0,52 y la cabeza en -0,26. La primera versión usaba la Y del juego —arriba
 * positivo— y los muñecos salían parados de cabeza. La conversión entre los dos
 * criterios se hace una sola vez, al colocar el contenedor; adentro se dibuja
 * en el sistema de Pixi y se acabó.
 */

const OUTLINE = 0x05070d;
const OUTLINE_WIDTH = 0.075;

/** Cuánto más oscuro es el bloque de sombra. Bloque sólido, nunca degradé. */
const SHADE = 0.62;

function darken(color: number, factor: number): number {
  const r = Math.round(((color >> 16) & 0xff) * factor);
  const g = Math.round(((color >> 8) & 0xff) * factor);
  const b = Math.round((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

export interface Doll extends Container {
  /** Se llama al cambiar de equipo o al entrar en gigantismo. */
  paint(color: number, glow: boolean): void;
}

export function createDoll(color: number): Doll {
  const root = new Container() as Doll;
  const body = new Graphics();
  root.addChild(body);

  const draw = (tint: number, glow: boolean): void => {
    const shade = darken(tint, SHADE);
    const line = { width: OUTLINE_WIDTH, color: OUTLINE, alignment: 0.5 };
    body.clear();

    // Pies: anchos, para que la figura se apoye con peso.
    body.roundRect(-0.26, 0.39, 0.22, 0.16, 0.05).fill(shade).stroke(line);
    body.roundRect(0.04, 0.39, 0.22, 0.16, 0.05).fill(shade).stroke(line);

    // Piernas.
    body.roundRect(-0.19, 0.2, 0.15, 0.24, 0.06).fill(shade).stroke(line);
    body.roundRect(0.04, 0.2, 0.15, 0.24, 0.06).fill(shade).stroke(line);

    // Torso, chico respecto de la cabeza.
    body.roundRect(-0.2, -0.1, 0.4, 0.32, 0.1).fill(tint).stroke(line);
    // Bloque de sombra del torso: un sólido, con borde neto.
    body.roundRect(0.02, -0.1, 0.18, 0.32, 0.1).fill(shade);

    // Puños, en guardia y bien redondos.
    body.circle(-0.28, 0.06, 0.115).fill(tint).stroke(line);
    body.circle(0.28, 0.06, 0.115).fill(tint).stroke(line);

    // Cabeza, la pieza dominante.
    body.circle(0, -0.28, 0.27).fill(tint).stroke(line);
    // Sombra de la cabeza: media luna sólida del lado opuesto a la luz.
    body.circle(0.09, -0.26, 0.19).fill(shade);
    // Visor: una sola forma clara que da dirección de mirada sin dibujar cara.
    body.roundRect(-0.2, -0.34, 0.3, 0.12, 0.05).fill(0xf2f7ff).stroke(line);

    if (glow) {
      // Aura del gigantismo. Va detrás del cuerpo y por eso se dibuja al final
      // con una segunda pasada: en Pixi lo último dibujado queda encima, así
      // que el aura se pinta con transparencia para no tapar la silueta.
      body.circle(0, 0, 0.72).fill({ color: 0xffd700, alpha: 0.22 });
    }
  };

  draw(color, false);
  root.paint = (next: number, glow: boolean): void => draw(next, glow);
  return root;
}
