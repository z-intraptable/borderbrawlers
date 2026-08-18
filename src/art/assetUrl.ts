/**
 * Traduce la ruta de un asset a lo que hay que pedir de verdad.
 *
 * En desarrollo y en el sitio desplegado no hace nada: `/art/kor/head.png` es
 * `/art/kor/head.png`, servido por `public/`. Existe para el **build de una sola
 * pieza**, el que empaqueta el juego entero en un HTML autocontenido para poder
 * mirarlo sin levantar un servidor. Ahí no hay `public/` ni rutas absolutas: las
 * imágenes y los manifiestos viajan embebidos como `data:` adentro del propio
 * archivo, y este mapa es cómo el código de siempre los encuentra.
 *
 * El mapa lo escribe `scripts/artefacto.mjs` en un `<script>` anterior al
 * bundle. Si no está —que es el caso normal— la función devuelve la ruta tal
 * cual y no cuesta nada.
 *
 * Se resuelve acá y no parcheando `fetch` desde afuera porque Pixi carga las
 * texturas en un Web Worker, y un worker no ve un `fetch` parcheado en la página
 * — pero sí sabe leer una `data:` URL como cualquier otra.
 */

declare global {
  interface Window {
    __BB_ASSETS__?: Record<string, string>;
  }
}

export function assetUrl(path: string): string {
  const map = typeof window === 'undefined' ? undefined : window.__BB_ASSETS__;
  if (map === undefined) return path;
  return map[path] ?? path;
}

/**
 * ¿Existe este asset? Con el mapa embebido la pregunta se contesta sin pedir
 * nada; sin mapa hay que salir a preguntarle al servidor.
 *
 * Las dos rutas que la usan chequean `content-type` para distinguir "no está" de
 * "está roto", porque el servidor de Vite contesta el index.html con 200 para
 * cualquier ruta que no conoce. Una `data:` URL no tiene ese problema, así que
 * saber de antemano que está en el mapa alcanza.
 */
export function assetEmbedded(path: string): boolean {
  const map = typeof window === 'undefined' ? undefined : window.__BB_ASSETS__;
  return map !== undefined && map[path] !== undefined;
}
