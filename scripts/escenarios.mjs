/**
 * Escribe `public/escenarios/lista.json` con los escenarios que hay en disco.
 *
 *   node scripts/escenarios.mjs
 *
 * Hace falta porque `public/` no pasa por Vite —las imágenes se sirven tal
 * cual—, así que el browser no tiene forma de listar una carpeta. Se corre
 * después de agregar o sacar un escenario; el juego lee el archivo al arrancar
 * y va turnando los que estén en la lista cada vez que alguien tira un super.
 *
 * Una carpeta cuenta como escenario sólo si tiene el `fondo.jpg`: media carpeta
 * subida da un 404 en medio de la pelea, y ahí el escenario ya está en pantalla.
 */
import { readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'public/escenarios';

const names = readdirSync(DIR)
  .filter((name) => statSync(join(DIR, name)).isDirectory())
  .filter((name) => existsSync(join(DIR, name, 'fondo.jpg')))
  .sort();

writeFileSync(join(DIR, 'lista.json'), `${JSON.stringify(names, null, 2)}\n`);
console.log(`${names.length} escenario(s): ${names.join(', ') || '(ninguno)'}`);
