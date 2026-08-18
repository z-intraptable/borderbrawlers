import { Assets, Rectangle, Texture } from 'pixi.js';
import { assetUrl } from './assetUrl';

/**
 * Carga la hoja de sprites de un personaje, si existe.
 *
 * **La ausencia de hoja no es un error**, igual que la ausencia de piezas: el
 * personaje sin hoja se dibuja con el muñeco de piezas y la pelea sigue. Es lo
 * que permite tener a Ragnir animado cuadro por cuadro al lado de los otros
 * cinco sin esperar a que estén los seis. Una hoja ROTA sí se grita: es la
 * diferencia entre "todavía no la generaste" y "la generaste mal".
 *
 * La escribe `scripts/hoja-sprites.py` desde los clips de Kling.
 */

export interface SheetFrame {
  texture: Texture;
  /** Dónde cae el centroide de la silueta dentro del cuadro, en fracción. */
  anchorX: number;
  anchorY: number;
}

export interface FighterSheets {
  /** Cuántos píxeles de la hoja mide una unidad de rig. */
  unit: number;
  /**
   * Unidades de rig del centroide para abajo hasta los pies, en la pose de
   * pie. Es lo que deja al personaje parado sobre la plataforma en vez de
   * hundido o flotando.
   */
  ground: number;
  animations: Map<string, SheetFrame[]>;
  /** La URL cargada, para poder devolverla después. */
  file: string;
}

interface RawFrame {
  rect: [number, number, number, number];
  anchor: [number, number];
}

interface RawSheets {
  file: string;
  unit: number;
  ground: number;
  animations: Record<string, { frames: RawFrame[] }>;
}

function isRawSheets(value: unknown): value is RawSheets {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.file === 'string'
    && typeof v.unit === 'number' && v.unit > 0
    && typeof v.ground === 'number'
    && typeof v.animations === 'object' && v.animations !== null;
}

export async function loadSheets(armature: string): Promise<FighterSheets | null> {
  const folder = `/art/${armature.toLowerCase()}`;
  const url = `${folder}/hojas.json`;

  let raw: unknown;
  try {
    const response = await fetch(assetUrl(url));
    if (!response.ok) return null;
    // Vite responde el index.html con estado 200 para cualquier ruta que no
    // conoce, así que el 404 no alcanza para distinguir "no hay hoja". El tipo
    // de contenido sí.
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('json')) return null;
    raw = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${url}: el JSON no parsea — ${error.message}`);
    }
    if (error instanceof TypeError) return null;
    throw error;
  }

  if (!isRawSheets(raw)) throw new Error(`${url}: no tiene forma de hoja de sprites`);

  const file = `${folder}/${raw.file}`;
  const base: Texture = await Assets.load(assetUrl(file));

  const animations = new Map<string, SheetFrame[]>();
  for (const [name, animation] of Object.entries(raw.animations)) {
    const frames: SheetFrame[] = [];
    for (const frame of animation.frames) {
      const [x, y, w, h] = frame.rect;
      if (!(w > 0) || !(h > 0)) throw new Error(`${url}: ${name} tiene un cuadro vacío`);
      // Una sub-textura sobre la MISMA fuente: las 17 poses de un personaje son
      // una sola textura para la GPU, y por lo tanto un solo draw call.
      frames.push({
        texture: new Texture({
          source: base.source,
          frame: new Rectangle(x, y, w, h),
        }),
        anchorX: frame.anchor[0],
        anchorY: frame.anchor[1],
      });
    }
    if (frames.length > 0) animations.set(name, frames);
  }
  if (animations.size === 0) throw new Error(`${url}: no trae ninguna animación`);

  return { unit: raw.unit, ground: raw.ground, animations, file };
}

/** Devuelve la textura de la hoja. El caché de `Assets` sobrevive al `Application`. */
export async function unloadSheets(sheets: FighterSheets): Promise<void> {
  await Assets.unload(assetUrl(sheets.file));
}
