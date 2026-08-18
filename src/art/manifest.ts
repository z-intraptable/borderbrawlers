/**
 * El manifiesto que acompaña a las piezas dibujadas de un personaje.
 *
 * Es el contrato entre el que dibuja y el código. Se valida entero al cargar y
 * se falla con un mensaje que diga QUÉ falta: un manifiesto a medias que carga
 * igual termina en un personaje con el brazo girando desde el codo y media hora
 * buscando el error en el lugar equivocado.
 */

/** Las piezas que el esqueleto sabe usar. `blade` es opcional. */
export const PART_NAMES = [
  'head', 'torso', 'armUpper', 'armLower', 'legUpper', 'legLower',
] as const;

export type PartName = (typeof PART_NAMES)[number];

export interface PartSpec {
  file: string;
  /**
   * Dónde está la articulación dentro de la imagen, como fracción de 0 a 1.
   *
   * Es lo único que no se puede improvisar. La pieza rota alrededor de este
   * punto: si está mal, el brazo gira desde el codo o la cabeza desde la oreja,
   * y no hay ajuste posterior que lo arregle.
   */
  pivot: [number, number];
}

/**
 * Las medidas del esqueleto, sacadas del dibujo.
 *
 * El peleador vectorial tiene proporciones fijas —cabeza de 23 unidades,
 * hombros a 22— porque las eligió este archivo. Un personaje dibujado no tiene
 * por qué respetarlas, y el primero que llegó no las respetaba ni de lejos:
 * cabeza del doble y caderas más anchas. Metido a la fuerza en esas constantes,
 * los brazos le nacían del aire.
 *
 * Así que el que dibuja manda: el cortador mide dónde están el hombro, la
 * cadera, el codo y la rodilla en la imagen, y las escribe acá en unidades del
 * rig. Sin este bloque se usan las constantes vectoriales, que es lo correcto
 * para un personaje sin arte.
 *
 * `armLower` y `legLower` entraron tarde y por un defecto concreto. `cortar.py`
 * siempre las escribió, pero esta lista tenía sólo siete claves y las
 * DESCARTABA en silencio, así que no había forma de decir cuánto mide un
 * antebrazo: el sprite se colgaba a distancia `armUpper` y se dibujaba con el
 * largo que tuviera en píxeles.
 *
 * El síntoma se vio en pantalla antes que en el código. El generador devolvió
 * las dos piezas del brazo de Ragnir casi iguales —32,6 y 33,1 unidades, o sea
 * dos brazos enteros— y encadenadas daban un brazo de 65,7 sobre una figura de
 * 104: el 63% del alto del cuerpo, contra el 44% de un brazo de verdad. Le
 * llegaba abajo de la rodilla. Con las nueve claves, `scripts/proporcion.py`
 * puede normalizar la cadena y esto se mide en vez de heredarse.
 */
export const RIG_KEYS = [
  'shoulderX', 'shoulderY', 'hipX', 'hipY', 'headY',
  'armUpper', 'armLower', 'legUpper', 'legLower',
] as const;

export type RigKey = (typeof RIG_KEYS)[number];
export type Rig = Record<RigKey, number>;

export interface Manifest {
  armature: string;
  /** Cuántos píxeles de la imagen mide una unidad del rig. */
  unit: number;
  rig: Rig | null;
  parts: Record<PartName, PartSpec> & { blade?: PartSpec };
}

function fail(message: string): never {
  throw new Error(`manifiesto de arte inválido: ${message}`);
}

function checkPart(raw: unknown, name: string): PartSpec {
  if (typeof raw !== 'object' || raw === null) fail(`falta la pieza "${name}"`);
  const part = raw as Record<string, unknown>;
  if (typeof part.file !== 'string' || part.file.length === 0) {
    fail(`"${name}" no declara "file"`);
  }
  const pivot = part.pivot;
  if (!Array.isArray(pivot) || pivot.length !== 2) {
    fail(`"${name}" no declara "pivot" como [x, y]`);
  }
  const [x, y] = pivot as unknown[];
  if (typeof x !== 'number' || typeof y !== 'number') {
    fail(`el pivote de "${name}" no es numérico`);
  }
  if (x < 0 || x > 1 || y < 0 || y > 1) {
    // Es el error más probable de todos: escribir el pivote en píxeles.
    fail(`el pivote de "${name}" es [${x}, ${y}] y va en fracción de 0 a 1, no en píxeles`);
  }
  return { file: part.file, pivot: [x, y] };
}

/** Valida un JSON recién parseado y lo devuelve tipado. */
export function parseManifest(raw: unknown): Manifest {
  if (typeof raw !== 'object' || raw === null) fail('no es un objeto');
  const data = raw as Record<string, unknown>;

  if (typeof data.armature !== 'string' || data.armature.length === 0) {
    fail('falta "armature"');
  }
  if (typeof data.unit !== 'number' || !(data.unit > 0)) {
    fail('"unit" tiene que ser los píxeles que mide una unidad del rig');
  }
  if (typeof data.parts !== 'object' || data.parts === null) fail('falta "parts"');
  const rawParts = data.parts as Record<string, unknown>;

  const parts = {} as Manifest['parts'];
  for (const name of PART_NAMES) {
    parts[name] = checkPart(rawParts[name], name);
  }
  if (rawParts.blade !== undefined) parts.blade = checkPart(rawParts.blade, 'blade');

  return { armature: data.armature, unit: data.unit, rig: checkRig(data.rig), parts };
}

function checkRig(raw: unknown): Rig | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object') fail('"rig" no es un objeto');
  const source = raw as Record<string, unknown>;

  const rig = {} as Rig;
  for (const key of RIG_KEYS) {
    const value = source[key];
    // A medias no sirve: un esqueleto con los hombros del dibujo y las caderas
    // de las constantes es peor que cualquiera de los dos completo.
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(`"rig" no declara "${key}" como número`);
    }
    rig[key] = value;
  }
  return rig;
}
