import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/**
 * Tres páginas y no una:
 *
 * - `index.html` es el juego, y es lo que se ve al entrar. Con los parámetros
 *   por defecto arranca contra Binance en vivo, que es el punto del proyecto.
 * - `consola.html` es la misma pelea adentro de un iframe, con los selectores
 *   —simulado o en vivo, par, 1 vs 1 o 3 vs 3, personaje del banco—. Existe
 *   porque cambiar de modo es recargar el juego con otros parámetros, y hacerlo
 *   a mano en la barra de direcciones no es una demo.
 * - `demo.html` es el banco de animación: un peleador solo corriendo y saltando.
 *
 * Antes esto se publicaba como tres HTML con TODO el arte embebido en `data:`,
 * que es lo que arma `scripts/artefacto.mjs`. Servía para mandar un archivo
 * suelto; como sitio no, porque con seis personajes dibujados cuadro por cuadro
 * el arte pasa de diez megas y eso adentro de un HTML es una sola descarga
 * bloqueante. Compilado de verdad, `public/art/**` viaja como archivos y el
 * navegador los pide cuando los necesita. El artefacto sigue existiendo para lo
 * que fue pensado: mandarlo por chat y abrirlo de un doble clic.
 */
export default defineConfig({
  server: { port: 5173 },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        juego: resolve(__dirname, 'index.html'),
        consola: resolve(__dirname, 'consola.html'),
        banco: resolve(__dirname, 'demo.html'),
      },
    },
  },
});
