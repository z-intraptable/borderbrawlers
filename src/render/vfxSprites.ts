import { Container, Sprite } from 'pixi.js';
import type { VfxNombre, VfxTexturas } from './loadVfx';

/**
 * Ráfagas con textura real, para los golpes que importan: la especial, el
 * super, el estallido de un poder, el KO.
 *
 * **Por qué no reemplaza a `fx.ts`.** El cuerpo a cuerpo dispara chispas
 * decenas de veces por segundo con seis peleadores en pantalla, y ahí la
 * geometría a mano —sin decodificar textura, sin overdraw de un PNG grande—
 * es la elección correcta; es la misma razón por la que el libro entero se
 * dibuja con `InstancedMesh` y no con seis mil sprites. Las texturas son para
 * los momentos que ya de por sí frenan el tiempo: unos pocos por minuto, no
 * por segundo.
 *
 * **Por qué un pool fijo de sprites y no `Sprite` nuevos por ráfaga.** Mismo
 * criterio que el resto del render: cero asignaciones por frame. Cada
 * ranura tiene su par glow/ink creado una vez: `burst` sólo les cambia la
 * textura, la posición y el tinte.
 */

const RAFAGAS = 10;

/**
 * Cuántas unidades de mundo mide el LADO de la textura para un `size` de 1.
 * Las seis vienen recortadas a ~420 px de una grilla pareja, así que un solo
 * factor sirve para las seis sin que ninguna quede desproporcionada respecto
 * a las otras.
 */
/**
 * Bajaron dos veces. Primero ~35% porque el burst tapaba al personaje entero
 * en un celular en vertical. Después, al pasar las seis texturas primero a
 * render fotorrealista y después (mismo día, 20/08/2026) a cel-shading estilo
 * Dragon Ball FighterZ / Marvel vs Capcom, bajaron de nuevo: el arte plano
 * original dejaba mucho margen transparente alrededor del núcleo, pero tanto
 * el fotorrealismo como el cel-shading llenan el cuadrado casi entero (rayos,
 * humo y esquirlas hasta el borde de los 1024 px), así que el MISMO `ESCALA`
 * de antes se ve bastante más grande en pantalla con cualquiera de los dos
 * artes nuevos, aunque el número no haya cambiado. El personaje sigue arriba
 * de todas las capas de VFX (ver `game.ts`), así que esto es puramente el
 * tamaño de la mancha.
 */
const ESCALA: Record<VfxNombre, number> = {
  impacto: 1.2,
  orbe: 1.1,
  tajo: 1.2,
  onda: 1.5,
  humo: 1.1,
  esquirlas: 1.1,
};

interface Rafaga {
  glow: Sprite;
  ink: Sprite;
  age: number;
  life: number;
  size: number;
  nombre: VfxNombre | null;
}

export interface VfxSprites {
  update(dt: number): void;
  /**
   * Dispara una ráfaga con textura. Si el nombre no cargó —falló la descarga,
   * o el juego arrancó antes de que llegara— no hace nada: la geometría a
   * mano que ya dibujó `fx.ts` en el mismo golpe sigue ahí y el golpe se ve
   * igual, sólo que sin el agregado.
   */
  burst(
    nombre: VfxNombre, x: number, y: number, size: number, life: number,
    color: number, angle?: number,
  ): void;
}

export function createVfxSprites(
  glowLayer: Container, inkLayer: Container, texturas: Partial<VfxTexturas>,
): VfxSprites {
  const rafagas: Rafaga[] = [];
  for (let i = 0; i < RAFAGAS; i++) {
    const glow = new Sprite();
    const ink = new Sprite();
    glow.visible = false;
    ink.visible = false;
    glow.anchor.set(0.5);
    ink.anchor.set(0.5);
    glowLayer.addChild(glow);
    inkLayer.addChild(ink);
    rafagas.push({ glow, ink, age: 0, life: 0, size: 1, nombre: null });
  }
  let siguiente = 0;

  function burst(
    nombre: VfxNombre, x: number, y: number, size: number, life: number,
    color: number, angle = 0,
  ): void {
    const par = texturas[nombre];
    if (par === undefined) return;
    const r = rafagas[siguiente];
    siguiente = (siguiente + 1) % RAFAGAS;
    r.nombre = nombre;
    r.age = 0;
    r.life = life;
    r.size = size;
    r.glow.texture = par.glow;
    r.ink.texture = par.ink;
    r.glow.tint = color;
    r.glow.visible = true;
    r.ink.visible = true;
    r.glow.x = x; r.glow.y = -y;
    r.ink.x = x; r.ink.y = -y;
    r.glow.rotation = -angle;
    r.ink.rotation = -angle;
  }

  function update(dt: number): void {
    for (const r of rafagas) {
      if (r.nombre === null) continue;
      r.age += dt;
      if (r.age >= r.life) {
        r.glow.visible = false;
        r.ink.visible = false;
        r.nombre = null;
        continue;
      }
      const t = r.age / r.life;
      // Misma curva que el resto de `fx.ts`: entra de golpe, se apaga con el
      // cuadrado del tiempo. Y crece un poco mientras vive, que es lo que
      // separa un impacto de una calcomanía pegada.
      const fade = (1 - t) * (1 - t);
      const brote = t < 0.15 ? t / 0.15 : 1;
      const escala = (ESCALA[r.nombre] * r.size * brote * (1 + t * 0.25))
        / r.glow.texture.width;
      r.glow.scale.set(escala);
      r.ink.scale.set(escala);
      r.glow.alpha = 0.5 + fade * 0.5;
      r.ink.alpha = fade;
    }
  }

  return { update, burst };
}
