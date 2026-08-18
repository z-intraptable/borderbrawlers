/**
 * Empaqueta el juego entero en UN archivo HTML que anda sin servidor.
 *
 *     node scripts/artefacto.mjs [escenario]
 *
 * Sale en `shots/borderbrawlers.html`. Es para poder mirar el juego corriendo
 * —mandarlo, abrirlo de un doble clic, publicarlo como artefacto— sin levantar
 * vite ni servir `public/`.
 *
 * Tres cosas hacen falta para que eso funcione:
 *
 * 1. **Las imágenes viajan adentro**, como `data:` en un mapa que lee
 *    `src/art/assetUrl.ts`. No hay `public/` en un archivo suelto.
 * 2. **El arte se reescala.** Cortado mide unos 2500 px de alto por figura y en
 *    pantalla se dibuja a noventa y pico. A 8,8 MB de PNG el archivo no entraría
 *    en ningún lado; a la altura que se usa pesa una fracción y se ve igual.
 * 3. **Arranca en mock.** Un archivo local no puede abrir el WebSocket de
 *    Binance —y un artefacto publicado tiene la red de salida cerrada—, así que
 *    el feed simulado es la única forma de que se vea la pelea.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RAIZ = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PUBLIC = join(RAIZ, 'public');
const SALIDA = join(RAIZ, 'shots', 'borderbrawlers.html');
/** La misma página sin `<html>` propio: es lo que espera el publicador. */
const FRAGMENTO = join(RAIZ, 'shots', 'borderbrawlers-artefacto.html');

/** Qué escenario se lleva. Uno solo: cinco fondos son cinco veces el peso. */
const ESCENARIO = process.argv[2] ?? 'lich';
/**
 * Alto de figura, en píxeles, con el que se embarca el arte.
 *
 * En pantalla un peleador mide unos 90 px, hasta 135 cuando está en gigantismo,
 * y el doble en una pantalla retina: 512 deja margen de sobra y sigue siendo un
 * octavo del original.
 */
const ALTO_FIGURA = 512;
/** Ancho del fondo. El original es 2048 y se dibuja a 960. */
const ANCHO_FONDO = 1600;

const tmp = mkdtempSync(join(tmpdir(), 'bb-artefacto-'));

/* --- 1. reescalar ---------------------------------------------------- */
// Con Pillow, que ya es dependencia de todo el pipeline de arte. Devuelve el
// mapa {ruta -> data URI} por stdout como JSON.
const python = `
import base64, io, json, sys
from pathlib import Path
from PIL import Image

raiz, publico, escenario = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
alto_figura, ancho_fondo = int(sys.argv[4]), int(sys.argv[5])
mapa = {}

def poner(ruta, datos, mime):
    mapa['/' + ruta] = f'data:{mime};base64,' + base64.b64encode(datos).decode()

# --- personajes: se reescalan al alto con el que se dibujan ---
for carpeta in sorted((publico / 'art').iterdir()):
    if not carpeta.is_dir(): continue
    manifiestos = list(carpeta.glob('*.json'))
    if not manifiestos: continue
    m = json.loads(manifiestos[0].read_text())
    # El alto de figura en pixeles es unit * 104 (las unidades de rig que mide).
    # El factor de reescalado sale de llevar eso a ALTO_FIGURA.
    alto_px = m['unit'] * 104
    factor = min(1.0, alto_figura / alto_px)
    for nombre, parte in m['parts'].items():
        origen = carpeta / parte['file']
        im = Image.open(origen).convert('RGBA')
        if factor < 1:
            im = im.resize((max(1, round(im.width * factor)),
                            max(1, round(im.height * factor))), Image.LANCZOS)
            # El pivote está en pixeles de la pieza: se mueve con ella.
            parte['pivot'] = [parte['pivot'][0] * factor, parte['pivot'][1] * factor]
        buf = io.BytesIO(); im.save(buf, 'PNG', optimize=True)
        poner(f'art/{carpeta.name}/{parte["file"]}', buf.getvalue(), 'image/png')
    # unit baja con la imagen: es px por unidad de rig, y la imagen encogió.
    m['unit'] = m['unit'] * factor
    poner(f'art/{carpeta.name}/{manifiestos[0].name}',
          json.dumps(m).encode(), 'application/json')

# --- escenario: un solo fondo y sus dos losas ---
carpeta = publico / 'escenarios' / escenario
fondo = Image.open(carpeta / 'fondo.jpg').convert('RGB')
if fondo.width > ancho_fondo:
    alto = round(fondo.height * ancho_fondo / fondo.width)
    fondo = fondo.resize((ancho_fondo, alto), Image.LANCZOS)
buf = io.BytesIO(); fondo.save(buf, 'JPEG', quality=82, optimize=True)
poner(f'escenarios/{escenario}/fondo.jpg', buf.getvalue(), 'image/jpeg')

for losa in ('losa-centro.png', 'losa-lado.png'):
    ruta = carpeta / losa
    if not ruta.exists(): continue
    im = Image.open(ruta).convert('RGBA')
    if im.width > 600:
        im = im.resize((600, max(1, round(im.height * 600 / im.width))), Image.LANCZOS)
    buf = io.BytesIO(); im.save(buf, 'PNG', optimize=True)
    poner(f'escenarios/{escenario}/{losa}', buf.getvalue(), 'image/png')

poner('escenarios/lista.json', json.dumps([escenario]).encode(), 'application/json')
print(json.dumps(mapa))
`;

const guion = join(tmp, 'empaquetar.py');
writeFileSync(guion, python);
console.log('reescalando arte…');
const crudo = execFileSync('python3',
  [guion, RAIZ, PUBLIC, ESCENARIO, String(ALTO_FIGURA), String(ANCHO_FONDO)],
  { maxBuffer: 1 << 30, encoding: 'utf8' });
const mapa = JSON.parse(crudo);

/* --- 2. el bundle, en una sola pieza ---------------------------------- */
//
// Con esbuild y no con el build de vite. Vite usa Rollup, y Rollup con
// `inlineDynamicImports` levanta los módulos de Pixi en un orden que rompe una
// dependencia circular suya: la página muere con "Cannot access 'browserAll'
// before initialization" antes de dibujar nada. esbuild deja los `import()`
// perezosos —los envuelve en una función en vez de izarlos—, así que el módulo
// se evalúa recién cuando se pide y la circular no molesta.
//
// El build normal del proyecto sigue siendo el de vite, con su división de
// código. Esto es sólo para el archivo suelto.
//
// Entra además `pixi.js/unsafe-eval`. Pixi arma sus shaders con `new Function`,
// y una página servida con una CSP estricta —como la de un artefacto publicado—
// no permite eval: sin este módulo la escena muere con "Current environment does
// not allow unsafe-eval" y no dibuja nada. Va SÓLO acá y no en el build normal
// porque la variante sin eval es algo más lenta, y el proyecto tiene un
// presupuesto de 16,6 ms por frame que manda por encima de todo.
// El entry va DENTRO del repo, no en /tmp: esbuild resuelve `pixi.js` desde la
// carpeta del archivo que importa, y desde /tmp no hay node_modules arriba.
const entrada = join(RAIZ, '.artefacto-entrada.js');
writeFileSync(entrada, [
  "import 'pixi.js/unsafe-eval';",
  `import ${JSON.stringify(join(RAIZ, 'src', 'main.ts'))};`,
].join('\n'));

const bundle = join(tmp, 'bundle.js');
console.log('empaquetando el código…');
execFileSync('npx', [
  'esbuild', entrada,
  '--bundle', '--format=esm', '--target=es2022', '--minify',
  `--outfile=${bundle}`,
], { cwd: RAIZ, stdio: ['ignore', 'ignore', 'inherit'] });

const codigo = readFileSync(bundle, 'utf8');
rmSync(entrada, { force: true });
const estilos = '';

const pesoMapa = Object.values(mapa).reduce((n, v) => n + v.length, 0);
console.log(`  ${Object.keys(mapa).length} assets · ${(pesoMapa / 1e6).toFixed(1)} MB en data:`);
console.log(`  bundle ${(codigo.length / 1e6).toFixed(1)} MB`);

// El juego lee sus opciones de la query string, y un archivo abierto de un doble
// clic no tiene ninguna. Se las ponemos antes de que el bundle las lea.
const arranque = `
  window.__BB_ASSETS__ = ${JSON.stringify(mapa)};
  if (!location.search.includes('source=')) {
    history.replaceState(null, '', location.pathname + '?source=mock&scenario=volatile&stage=${ESCENARIO}');
  }
`;

/* --- 3. los dos archivos --------------------------------------------- */
//
// El suelto lleva documento entero, para abrirlo de un doble clic. El de
// artefacto NO: el publicador envuelve lo que le das en su propio
// `<!doctype><head><body>`, así que un documento adentro de otro documento
// quedaría anidado. Ahí va sólo el contenido.
//
// Tema único a propósito, y pintado explícito: esto es una pantalla de arcade,
// no un documento. El fondo `#0B0F19` es el mismo color con el que arranca el
// renderer, así que no hay destello de otro color mientras carga, y no hereda
// el fondo del visor si el que mira tiene el tema claro.
const estilo = `
html,body{margin:0;padding:0;height:100%;background:#0B0F19;overflow:hidden}
#root{position:relative;width:100vw;height:100vh;background:#0B0F19}
${estilos}`;

const cuerpo = `<title>BorderBrawlers</title>
<style>${estilo}</style>
<div id="root"></div>
<script>${arranque}</script>
<script type="module">${codigo}</script>
`;

const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${cuerpo}</head>
<body>
</body>
</html>
`;

writeFileSync(SALIDA, html);
writeFileSync(FRAGMENTO, cuerpo);
console.log(`listo: ${SALIDA} — ${(html.length / 1e6).toFixed(1)} MB`);
console.log(`       ${FRAGMENTO} (para publicar como artefacto)`);
