import { Assets, Texture } from 'pixi.js';
import { assetUrl } from '../art/assetUrl';

/**
 * Las texturas de efectos, generadas con Nano Banana Pro y separadas en
 * `scripts/separar-vfx.py`.
 *
 * Vienen en pares porque el resto del juego dibuja los efectos así: un
 * `glow` blanco con alfa —lo que carga el Bloom y lo que se tiñe del color
 * del bando— y un `ink` negro —el contorno, aparte, para que el Bloom no se
 * lo coma—. Antes esas dos capas eran geometría a mano; estas seis son la
 * misma idea con textura real en vez de polígonos.
 */
export interface VfxSheet {
  glow: Texture;
  ink: Texture;
}

const NOMBRES = [
  'impacto', 'orbe', 'tajo', 'onda', 'humo', 'esquirlas', 'escudo', 'esquive',
] as const;
export type VfxNombre = (typeof NOMBRES)[number];

export type VfxTexturas = Record<VfxNombre, VfxSheet>;

/**
 * Ausencia no es error: igual que el arte cortado y las hojas de sprites, un
 * efecto sin textura sigue dibujándose con la geometría de siempre —`fx.ts`
 * no cambia—, así que un 404 acá no puede tirar abajo la pelea.
 */
async function cargarPar(nombre: VfxNombre): Promise<VfxSheet | null> {
  try {
    const [glow, ink] = await Promise.all([
      Assets.load<Texture>(assetUrl(`/vfx/${nombre}-glow.png`)),
      Assets.load<Texture>(assetUrl(`/vfx/${nombre}-ink.png`)),
    ]);
    return { glow, ink };
  } catch {
    return null;
  }
}

export async function loadVfxTexturas(): Promise<Partial<VfxTexturas>> {
  const pares = await Promise.all(NOMBRES.map(cargarPar));
  const resultado: Partial<VfxTexturas> = {};
  NOMBRES.forEach((nombre, i) => {
    const par = pares[i];
    if (par !== null) resultado[nombre] = par;
  });
  return resultado;
}
