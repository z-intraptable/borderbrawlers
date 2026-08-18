import { Assets, Sprite, Texture } from 'pixi.js';
import { assetEmbedded, assetUrl } from '../art/assetUrl';

/**
 * El fondo pintado del escenario, si hay uno.
 *
 * **Es opcional a propósito**, igual que el arte de los personajes: sin imagen,
 * el fondo es el color plano de siempre y el juego corre igual. Eso permite
 * probar un escenario nuevo sin romper nada y volver atrás borrando un archivo.
 *
 * Va DETRÁS de los cristales de volumen, nunca en su lugar. Los cristales y el
 * tinte del cielo son datos del libro dibujados en vivo: son lo único que dice
 * quién está ganando. Un fondo pintado es escenografía, y la escenografía no
 * puede tapar el instrumento.
 */

/**
 * Cuánto se apaga la imagen antes de que la vea nadie.
 *
 * Estuvo mucho tiempo en `0x5d6675` —algo más de un tercio del brillo— porque
 * los peleadores no tenían contorno y un fondo a pleno los tapaba. El precio
 * era que el escenario se veía gris y deslavado, y esa era la diferencia más
 * grande contra la referencia del proyecto: en Brawlhalla el fondo es saturado
 * y brillante, y el personaje igual se lee.
 *
 * Se lee porque **lleva contorno negro**. Al hornear el contorno en las piezas
 * (scripts/contorno.py) desapareció la razón de apagar el fondo, así que este
 * número sube a cuatro quintos. El criterio se invirtió: antes se protegía la
 * figura apagando el escenario, ahora se protege con su propio borde y el
 * escenario puede vivir.
 *
 * No sube a 0xffffff porque los cristales de volumen y el tinte del cielo son
 * DATOS —dicen quién está ganando el libro— y tienen que seguir ganándole a la
 * escenografía. Un quinto de margen es lo que los deja arriba.
 */
const DIM = 0xccd2dd;

export interface Stage {
  sprite: Sprite;
  /** Encaja la imagen en la pantalla y la tiñe hacia el que domina. */
  update(width: number, height: number, tint: number): void;
  /** Cambia de escenario sin tocar nada más. */
  show(texture: Texture): void;
}

/**
 * Los escenarios disponibles, en el orden en que se van turnando.
 *
 * Sale de `public/escenarios/lista.json`, que escribe `npm run escenarios`
 * leyendo las carpetas. Un `import.meta.glob` no sirve acá: `public/` no pasa
 * por Vite, justamente para que las imágenes se sirvan tal cual. Sin el archivo
 * —o con uno roto— devuelve la lista vacía y el juego corre con el fondo plano,
 * que es el comportamiento de siempre.
 */
export async function stageNames(): Promise<string[]> {
  try {
    const response = await fetch(assetUrl('/escenarios/lista.json'));
    if (!response.ok) return [];
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('json')) return [];
    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) return [];
    return raw.filter((name): name is string => typeof name === 'string');
  } catch {
    return [];
  }
}

/**
 * Carga el fondo de un escenario. Devuelve `null` si no existe.
 *
 * Un 404 es "ese escenario no está", no una falla. El nombre viene de un query
 * param, así que un typo tiene que dejar el juego andando con el fondo plano y
 * no tirar la escena entera.
 */
export async function loadStage(name: string): Promise<Texture | null> {
  return loadTexture(`/escenarios/${name.toLowerCase()}/fondo.jpg`);
}

/**
 * Las dos losas dibujadas de un escenario, si las tiene.
 *
 * Son OPCIONALES igual que el fondo: sin ellas las nueve plataformas se dibujan
 * con las tres bandas de color de siempre y el juego corre igual. Un escenario
 * puede tener fondo y no tener losas.
 *
 * Son sólo dos imágenes para nueve plataformas porque **las nueve tienen medidas
 * constantes**: una central ancha y ocho laterales todas iguales. Pedirle al
 * arte una por plataforma sería pedir ocho copias del mismo dibujo.
 */
export interface StagePlatforms {
  centro: Texture;
  lado: Texture;
}

/**
 * Una textura de escenario, o `null` si no está.
 *
 * **Sin sondeo `HEAD` previo.** Antes se preguntaba con `HEAD` si el archivo
 * existía y recién después se pedía con `Assets.load`, para distinguir un 404
 * de verdad del `index.html` que Vite devuelve con estado 200 para cualquier
 * ruta que no conoce. Dos pedidos a la MISMA url es justo lo que rompe: la
 * respuesta al `HEAD` trae `Content-Length` y ningún cuerpo, el navegador
 * archiva esa entrada de caché, y el `GET` que viene atrás sale abortado y su
 * promesa **no se resuelve nunca**. `Assets.load` queda colgado, `startGame`
 * nunca vuelve, el juego no engancha su tick y lo que se ve es el HUD vivo
 * sobre una pantalla negra, con `0.0 ms` de frame. Fue exactamente lo que se vio
 * en la página publicada, y lo que hacía que a veces anduviera y a veces no:
 * dependía de qué hubiera en la caché.
 *
 * Un solo pedido, y el caso del `index.html` se resuelve igual: `Assets.load`
 * no puede decodificar HTML como imagen y rechaza, que es lo mismo que un 404.
 */
async function loadTexture(url: string): Promise<Texture | null> {
  try {
    return await Assets.load<Texture>(assetEmbedded(url) ? assetUrl(url) : url);
  } catch {
    return null;
  }
}

/**
 * Carga las losas de un escenario. Devuelve `null` si le falta alguna de las
 * dos: media dotación —la central dibujada y las laterales de color— se vería
 * peor que ninguna, porque el ojo lee la diferencia como un error y no como un
 * estilo.
 */
export async function loadPlatforms(name: string): Promise<StagePlatforms | null> {
  const carpeta = `/escenarios/${name.toLowerCase()}`;
  const [centro, lado] = await Promise.all([
    loadTexture(`${carpeta}/losa-centro.png`),
    loadTexture(`${carpeta}/losa-lado.png`),
  ]);
  if (centro === null || lado === null) return null;
  return { centro, lado };
}

export function createStage(texture: Texture): Stage {
  const sprite = new Sprite(texture);
  sprite.anchor.set(0.5);
  let current = texture;

  return {
    sprite,
    show(next): void {
      current = next;
      sprite.texture = next;
    },
    update(width, height, tint): void {
      const texture = current;
      // Encaje por COBERTURA, no por contención: se elige la escala más grande
      // de las dos y sobra por el lado que sobre. Con la más chica quedarían
      // dos bandas del color de fondo a los costados, y el escenario se vería
      // como una foto pegada en el medio de la pantalla.
      const scale = Math.max(width / texture.width, height / texture.height);
      sprite.scale.set(scale);
      sprite.x = width / 2;
      sprite.y = height / 2;
      sprite.tint = tint;
    },
  };
}

/**
 * El tinte que le toca a la imagen: el apagado base, empujado hacia el color
 * del cielo del que domina.
 *
 * El cielo plano se tiñe cambiando el color de fondo del renderer, y con una
 * imagen encima ese color deja de verse. Sin esto, poner un escenario apagaría
 * la señal de quién va ganando — que es exactamente lo que el escenario no
 * tiene permitido hacer.
 */
export function stageTint(sky: number): number {
  const sr = (sky >> 16) & 0xff, sg = (sky >> 8) & 0xff, sb = sky & 0xff;
  const dr = (DIM >> 16) & 0xff, dg = (DIM >> 8) & 0xff, db = DIM & 0xff;
  // El cielo es muy oscuro —el neutro es 0x0b0f19—, así que multiplicar por él
  // dejaría la imagen en negro. Lo que se usa es su DESVÍO respecto del neutro.
  const lean = 2.2;
  return (
    (clamp(dr + (sr - 0x0b) * lean) << 16)
    | (clamp(dg + (sg - 0x0f) * lean) << 8)
    | clamp(db + (sb - 0x19) * lean)
  );
}

function clamp(value: number): number {
  return value < 0 ? 0 : value > 255 ? 255 : Math.round(value);
}
