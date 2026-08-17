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

export interface Manifest {
  armature: string;
  /** Cuántos píxeles de la imagen mide una unidad del rig. */
  unit: number;
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

  return { armature: data.armature, unit: data.unit, parts };
}
