import * as THREE from 'three';

/**
 * Texturas generadas por código.
 *
 * No hay ningún asset que descargar y no lo va a haber hasta que exista arte
 * dibujado. Lo que sí se puede hacer sin ilustrador es esto: una rampa de
 * cel-shading y una textura de piedra con el filo iluminado, generadas al
 * montar y cacheadas. Es lo que separa "primitiva de three.js" de "algo
 * dibujado", y es la mayor parte de la distancia visual que se puede recortar
 * con código.
 *
 * **Segunda costura para el arte**: el día que existan texturas pintadas, se
 * reemplazan estas dos funciones. Nada más las conoce.
 */

/**
 * Rampa de tonos para `MeshToonMaterial`.
 *
 * Sin `gradientMap`, `MeshToonMaterial` trae una rampa por defecto que casi no
 * se distingue de un material plano. Los escalones duros son la firma del
 * cel-shading: la luz no se degrada, salta. `NearestFilter` es obligatorio —
 * con filtrado lineal los escalones se interpolan y vuelve el degradé que
 * justamente estábamos evitando.
 */
export function createToonGradient(steps = 3): THREE.DataTexture {
  const data = new Uint8Array(steps * 4);
  for (let i = 0; i < steps; i++) {
    // Bloques bien separados y sesgados a los claros. La sombra tiene que ser un
    // bloque sólido que insinúe volumen, no un degradé: en cuanto los escalones
    // se acercan, el ojo lee "3D con luz suave" en vez de "dibujo animado".
    const t = i / Math.max(1, steps - 1);
    const value = Math.round(255 * (0.5 + 0.5 * t));
    data[i * 4 + 0] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Plataforma: bloques planos de color, sin una sola muestra de ruido.
 *
 * La primera versión de esto tenía vetas de piedra y una sombra en degradé.
 * Está mal para el estilo buscado: el arte vectorial no tiene textura rugosa ni
 * ruido digital, y un degradé rompe el cel-shading igual que lo rompería en el
 * personaje. Todo el volumen lo tienen que dar bloques sólidos con bordes
 * definidos — acá son tres: filo claro, cara media, sombra dura abajo.
 *
 * En la V de la caja, 1 es arriba: el filo cae en el borde superior de las
 * cuatro caras laterales y en la tapa, que es de dónde el ojo saca "acá se
 * puede pisar".
 */
export function createPlatformTexture(): THREE.CanvasTexture {
  const W = 8;
  const H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  if (ctx === null) {
    // Sin contexto 2D no hay textura, pero tampoco motivo para tumbar la
    // escena: el material sigue funcionando con su color plano.
    return new THREE.CanvasTexture(canvas);
  }

  // Tres bandas sólidas, sin transición. El canvas es de 8 píxeles de ancho
  // porque no hay ningún detalle horizontal que representar.
  ctx.fillStyle = '#e8f1ff';
  ctx.fillRect(0, 0, W, Math.round(H * 0.24));
  ctx.fillStyle = '#5a6d92';
  ctx.fillRect(0, Math.round(H * 0.24), W, Math.round(H * 0.34));
  ctx.fillStyle = '#2b3552';
  ctx.fillRect(0, Math.round(H * 0.58), W, H);

  const texture = new THREE.CanvasTexture(canvas);
  // NearestFilter para que las bandas no se interpolen: un borde definido es
  // justamente lo que distingue el bloque plano del degradé.
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Las barras del libro van con color plano y nada más.
 *
 * Tenían un degradé vertical y un reflejo al costado; por la misma razón que la
 * plataforma, sobran. Se deja la función para no dispersar la decisión: si
 * mañana hacen falta bandas, se agregan acá.
 */
export function createBarTexture(): THREE.CanvasTexture | null {
  return null;
}
