import { Assets, Texture } from 'pixi.js';
import type { Manifest, PartName, Rig } from './manifest';
import { parseManifest } from './manifest';

/**
 * Carga las piezas dibujadas de un personaje, si existen.
 *
 * **La ausencia de arte no es un error.** Mientras un personaje no esté
 * dibujado, la escena lo pinta con el peleador vectorial y la pelea sigue. Eso
 * es lo que permite ver a Deadpool con arte propio al lado de los otros cinco
 * sin esperar a que estén los seis. Un manifiesto ROTO, en cambio, sí es un
 * error y se grita: es la diferencia entre "todavía no lo dibujaste" y "lo
 * dibujaste mal", y confundirlas cuesta una tarde.
 */

export interface FighterArt {
  textures: Record<PartName, Texture> & { blade?: Texture };
  pivots: Record<string, [number, number]>;
  /** Cuántos píxeles de la imagen mide una unidad del rig. */
  unit: number;
  /** Las medidas del esqueleto sacadas del dibujo, si el manifiesto las trae. */
  rig: Rig | null;
  /** Las URLs cargadas, para poder devolverlas después. */
  files: string[];
}

/** Dónde vive el arte de un personaje. */
function folderFor(armature: string): string {
  return `/art/${armature.toLowerCase()}`;
}

import { assetUrl } from './assetUrl';

export async function loadArt(armature: string): Promise<FighterArt | null> {
  const folder = folderFor(armature);
  const url = `${folder}/${armature.toLowerCase()}.json`;

  let manifest: Manifest;
  try {
    const response = await fetch(assetUrl(url));
    // 404 es "todavía no hay arte", no una falla.
    if (!response.ok) return null;
    // Y tampoco alcanza con el 404: el servidor de desarrollo de Vite responde
    // el index.html con estado 200 para cualquier ruta que no conoce, así que un
    // personaje sin dibujar llegaba acá como un JSON roto —"Unexpected token
    // '<'"— y hacía fallar la escena entera. Lo que distingue los dos casos es
    // el tipo de contenido.
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('json')) return null;
    manifest = parseManifest(await response.json());
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${url}: el JSON no parsea — ${error.message}`);
    }
    // Un fetch que ni sale (sin red, sin servidor) tampoco es arte roto.
    if (error instanceof TypeError) return null;
    throw error;
  }

  const entries = Object.entries(manifest.parts) as [string, { file: string; pivot: [number, number] }][];
  const textures = {} as FighterArt['textures'];
  const pivots: Record<string, [number, number]> = {};
  const files: string[] = [];

  // En paralelo: son siete imágenes chicas y en serie se nota al recargar.
  await Promise.all(entries.map(async ([name, spec]) => {
    const file = `${folder}/${spec.file}`;
    let texture: Texture;
    try {
      texture = await Assets.load<Texture>(assetUrl(file));
    } catch {
      throw new Error(`${url} declara "${spec.file}" y no se pudo cargar ${file}`);
    }
    textures[name as PartName] = texture;
    pivots[name] = spec.pivot;
    files.push(file);
  }));

  return { textures, pivots, unit: manifest.unit, rig: manifest.rig, files };
}

/**
 * Libera las texturas de un personaje.
 *
 * El caché de `Assets` sobrevive al `Application`, así que destruir el canvas no
 * alcanza: sin esto, cada recarga en caliente de Vite deja otra copia de las
 * hojas en memoria de GPU. Se descargan los ARCHIVOS, que son lo que `Assets`
 * tiene cacheado; el manifiesto vino por `fetch` y no está en ese caché.
 */
export async function unloadArt(art: FighterArt): Promise<void> {
  await Promise.all(art.files.map((file) => Assets.unload(file).catch(() => {})));
}
