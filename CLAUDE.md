# BorderBrawlers — contexto para Claude Code

Pelea 3 contra 3 estilo Super Smash Bros / Brawlhalla, dibujada sobre el order
book de Binance en vivo. Verde compradores, rojo vendedores, **sin comandos de
usuario**: todo lo maneja el libro y el flujo de compra/venta. Escala: 1
espectador, demo personal.

Sin framework de UI. Sin motor de física de terceros. **PixiJS 8** para
dibujar, WebSocket directo a Binance para el dato, TypeScript estricto para
todo lo demás. `package.json` sólo trae `pixi.js` y `pixi-filters` como
dependencias de runtime.

**Esto no siempre fue así.** El proyecto arrancó como visualizador 3D puro
(React Three Fiber v9 + Rapier), pasó a ser una pelea 3 vs 3 sin dejar el 3D, y
después se mudó entera a Pixi (`d1d3437`, `bc9d719`) porque Rapier no daba el
control "crujiente" que necesita un personaje jugable — ver más abajo, en
"Por qué no hay motor de física". Si algo de lo que sigue contradice un
recuerdo de la versión three.js, ganó el código: no queda una sola línea de
React, three ni Rapier en `src/`.

---

## Estado

`tsc --noEmit` limpio en strict, `npm test` en verde (10 suites,
sin red ni browser), `npm run build` sin errores.

| Capa | Archivos | Qué hace |
|---|---|---|
| Feed | `src/net/feedCore.ts`, `src/types/binance.ts` | WebSocket a Binance, parseo, reconexión con backoff |
| Simulación | `src/game/match.ts`, `src/game/fighters.ts`, `src/game/physics.ts`, `src/game/roster.ts` | La pelea entera, sin una línea de Pixi. Funciones puras, testeadas sin browser |
| Render | `src/render/game.ts`, `src/render/stage.ts`, `src/render/backdrop.ts`, `src/render/fx.ts`, `src/render/vfxSprites.ts`, `src/render/loadVfx.ts` | `Application` de Pixi, capas, filtros, partículas geométricas y texturas de efecto |
| Arte de personaje | `src/art/fighter.ts`, `src/art/spriteFighter.ts`, `src/art/loadArt.ts`, `src/art/loadSheets.ts`, `src/art/manifest.ts`, `src/art/looks.ts`, `src/art/assetUrl.ts` | Arma cada peleador a partir de piezas recortadas + hojas de sprite |
| HUD | `src/hud/hud.ts` | Marcador y barra de mercado en DOM plano, sin framework |
| Mock | `src/mock/mockFeed.ts` | Generador sintético de trades/libro para desarrollar sin depender del mercado |
| Auxiliar | `src/quality.ts` (`detectLowQuality`) | Heurística de calidad — ver nota abajo, quedó con vocabulario de la versión three.js |
| Servidor | `server/` | Grabador y replay del VPS. No toca el camino en vivo — ver `server/README.md` |

`src/quality.ts` tiene un comentario que habla de `MeshToonMaterial` /
`MeshBasicMaterial`, que son de three.js y ya no existen en el proyecto. La
función en sí (`detectLowQuality`) sigue viva y se usa para decidir Bloom
sí/no; el comentario quedó desactualizado por el pivot a Pixi y conviene
corregirlo si se toca ese archivo.

### Cómo arrancar

```bash
npm install
npm run typecheck
npm run dev        # http://localhost:5173/?source=mock&scenario=normal
```

Vite fija el puerto en `5173` (`server: { port: 5173 }` en `vite.config.ts`).
Empezar con `?source=mock` para no depender del mercado real.

### Query params (`src/main.ts`)

| Param | Valores | Qué hace |
|---|---|---|
| `source` | `mock` \| `binance-direct` \| `vps-replay` \| `vps-relay` | de dónde sale el feed. Sin el param, va contra Binance en vivo — es el punto del proyecto |
| `scenario` | `calm` \| `normal` \| `volatile` \| `stress` | sólo aplica con `source=mock` |
| `symbol` | p.ej. `ethusdt` | default `btcusdt` |
| `vps` | `ws://host:8080` | base URL para `vps-replay`/`vps-relay` |
| `stage` | slug de `public/escenarios/` | fija un fondo pintado; sin esto, plano de siempre. Se valida con `/^[a-z0-9-]+$/i` para no poder escapar de la carpeta |
| `modo` | `melee` | los seis peleadores sueltos a la vez; sin esto, torneo 1v1 (ver abajo) |
| `duo` | `kor,ragnir` | fija un peleador por bando para trabajar sobre un cambio sin esperar la rotación del torneo |
| `vs` | número | peleadores por bando en modo melé, sin torneo. `?vs=1` es el mano a mano para mirar el motor sin seis cuerpos encima |
| `ritmo` | 0–4 | multiplicador de velocidad de la pelea. Sin el param corre a la mitad del reloj de pared (desde el 18/08: a velocidad real no se llegaba a ver quién le pegaba a quién) |
| `medir` | presente/ausente | dibuja en pantalla el tamaño real de ventana/viewport/canvas/buffer — existe porque un encuadre roto en teléfono no se reproduce en desktop ni en headless, y en el teléfono no hay consola |

Todos los valores enumerados se validan contra una lista permitida (`pick()`
en `main.ts`) en vez de castearse a ciegas: un `?source=binancedirect` mal
tipeado terminaba abriendo un WebSocket a la URL literal `undefined`.

---

## Decisiones cerradas — no reabrir sin motivo nuevo

- **Sin backend en el camino en vivo.** El browser se conecta directo a
  `wss://data-stream.binance.vision:443`. Un relay no puede ganar en latencia
  (desigualdad triangular) y retransmitir market data a terceros va contra los
  términos de uso de Binance.
- **El VPS de Vultr queda para grabación y replay determinista**, no para el
  vivo — es lo único que no se puede hacer sin servidor: repetir el mismo
  minuto del mercado mientras se perfila un cambio. Implementado en `server/`.
  Retención por defecto: **10 GB o 30 días, lo que llegue primero** (~28 días
  de mercado normal). Con TLS resuelto, `vps-relay` también serviría como
  salida ante bloqueo geográfico.
- **Nada va a una base de datos.** Archivos planos append-only, leídos
  secuencialmente por rango de tiempo — un filesystem hace exactamente eso.
- **`@depth20@100ms` es snapshot idempotente, no delta.** Sin bootstrap REST,
  sin buffering, sin manejo de gaps.
- **Por qué no hay motor de física** (`src/game/physics.ts`, reemplaza a
  Rapier). Un motor de cuerpos rígidos simula objetos que CAEN, no personajes
  que se CONTROLAN: con Rapier los peleadores resbalaban por las plataformas,
  se apilaban uno sobre la cabeza del otro y flotaban al empujarse, y cada
  arreglo era pelearle al solver. Smash y Brawlhalla tampoco usan cuerpos
  rígidos para el personaje — usan exactamente esto: velocidad propia y
  colisión contra rectángulos, sin dependencias, testeable sin browser.
- **Cero azar en la pelea.** Había un `mulberry32` con semilla fija cuyo único
  consumidor era el reloj que sacaba una especial cada 8-12 s. Al pasar los
  golpes a la barra de fuerza que cargan las órdenes, ese reloj sobró y con él
  la última fuente de azar: todo lo que pasa en pantalla se puede seguir hasta
  un trade o una cifra del libro. El replay determinista del VPS, que era la
  razón de tener el PRNG, sale ahora de que no hay nada que sembrar.
- **La plantilla es exactamente la pelea: seis personajes, tres por bando, sin
  relevos.** El que se cae reaparece él mismo en su slot. Antes eran
  diecinueve nombres para seis lugares —para que la pelea no se repitiera—,
  recortado a seis por una razón de producción y no de diseño: cada personaje
  necesita un dibujo cortado en piezas, y seis bien cortados se ven mejor que
  diecinueve a medias. `Match.character` sigue siendo un dato por slot en vez
  de una constante, así que volver a agrandar la plantilla es sumar entradas
  en `src/game/roster.ts` y devolverle a `activate` el reparto por ronda.
- **El bando se lee en los poderes, no en la ropa.** Cada peleador conserva
  sus colores propios — son personajes dibujados, no siluetas teñidas — y lo
  que dice de qué lado está es el color de sus efectos: verde comprador, rojo
  vendedor. Por eso `roster.ts` viene partido al medio con el bando fijo por
  personaje, y nada se tiñe en runtime.
- **Hosting**: sitio estático, destino previsto Vercel.
- **Pivot de 2026-08-23: la pelea ya no depende del mercado, salvo la barra
  de fuerza de especial/super.** Decisión nueva sobre las viejas de spawn
  por trade, peso por tamaño de trade, y gigantismo/plataformas por
  liquidez del libro — el detalle punto por punto está en "El juego", más
  abajo. Sigue sin haber azar: `planear` (la IA con planificación nueva)
  es tan determinista como el resto de la simulación.

---

## Invariantes del feed (no tocar sin releer)

**Regla del agresor.** `m` es *"¿el comprador es el market maker?"*. El taker
es el agresor y define el color:

```ts
const side: Side = trade.m ? 'sell' : 'buy';   // src/net/feedCore.ts:609
```

Invertirlo produce una visualización plausible y sistemáticamente al revés.

**Ballenas por mediana móvil**, `whale = size > mediana * WHALE_MULT`, sin
clasificar hasta tener muestras mínimas (evita falsos al arrancar). Nunca un
umbral fijo — ver constantes al inicio de `feedCore.ts`.

**Ring buffer de trades preasignado**, pool de slots reutilizados
(`push(id, side, price, size, whale, t)` escribe sobre un slot existente, no
asigna). El libro también vive en estructuras preasignadas. El objetivo:
cero asignaciones por trade en el hilo principal.

**Reloj y constructor de WebSocket inyectables** en `BinanceFeedClient`, así
que la reconexión con backoff exponencial + jitter (hasta 300 intentos / 5
min) se simula en microsegundos en los tests, sin esperar de verdad.

---

## El juego

- **Pivot de 2026-08-23: la pelea ya no depende del mercado, salvo la barra
  de maná.** Decisión nueva sobre una vieja — ver el detalle punto por punto
  más abajo. Lo único que el feed de Binance sigue alimentando es la barra
  de fuerza que habilita especiales y super; spawn, peso, gigantismo y
  plataformas dejaron de estar atados al libro. El motivo: llevar el juego a
  su techo de calidad requiere dos peleadores siempre en cancha gobernados
  por una IA con planificación real, no un visualizador que aparece y
  desaparece según el flujo — ver la auditoría de Smash/Brawlhalla en el
  historial de esta conversación para el razonamiento completo.
- **Los seis están siempre en cancha, sin esperar ningún trade.** Antes un
  trade puntual disparaba el alta (`activate`); ahora `relevar` llena
  cualquier slot libre apenas hay lugar, en torneo y en melé por igual. El
  peso es un stat FIJO por personaje (`ROSTER[].weight`, parejo en 1 por
  ahora — placeholder a ajustar jugando), no algo que trae el trade.
- **Sin gigantismo.** Existió: cuando la liquidez de un lado pasaba el 56%
  del libro, ese equipo agrandaba a uno de los suyos en tres pasos y al
  tercero descargaba el super. Se sacó entero —`growthScale`, `bookShare`,
  `shouldGrow`, la barra de equipo (`ultra`/`ultraTurn`)— junto con la
  dependencia del libro. `m.scale[]` sigue existiendo en 1 fijo porque el
  render y la física ya lo multiplican al tamaño del cuerpo.
- **El super lo dispara la IA con planificación, no el gigantismo ni un
  umbral suelto.** Cada peleador tiene su barra personal (la misma que paga
  la especial); al llegar a `COST_SUPER` el super queda DISPONIBLE, pero
  recién sale cuando `planear` (`fighters.ts`) lo elige por sobre acercarse,
  sostener o tirar la especial — ver "La IA con planificación" más abajo. La
  primera versión, que lo disparaba apenas cruzaba el umbral, terminaba en
  super-spam: bastaba un trade grande para que nadie pudiera pegar ni tirar
  una especial en todo el partido.
- **El golpe básico (puño/patada) es gratis.** Ya no gasta la barra de
  fuerza — sale de un cooldown propio, sin mirar el mercado. La barra
  queda 100% para especial y super, que es literalmente lo único que el
  mercado sigue decidiendo en la pelea.
- **El daño es la regla de Smash**: cuanto más acumulado, más lejos sale el
  empujón — sin eso la pelea es plana.
- **El escenario es fijo.** Antes las plataformas subían y bajaban con la
  liquidez del libro (`updateStageFromBook`, sacada entera); ahora la losa
  central ancha (`CENTER_HALF_WIDTH`) y las dos plataformas laterales por
  costado quedan en su posición default para siempre. Bajó de cuatro
  repisas angostas a dos anchas por costado en su momento: con cuatro,
  ninguna medía más de 1,6 cuerpos y no eran plataformas, eran repisas —
  esa parte del layout no cambió con el pivot, sólo dejó de moverse.
- **Poderes a distancia.** Una especial no estalla encima de quien la tira:
  sale disparada, viaja, y recién estalla al llegar (o al pool cíclico de
  hasta ~12 en vuelo). No le pega a los propios.
- **La IA con planificación (`planear` en `fighters.ts`), no un reactivo
  puro.** Cada peleador reevalúa su plan —acercarse, retirarse, sostener,
  tirar la especial, tirar el super— cada `REPLAN_INTERVAL` (0,4 s de
  simulación, no cada cuadro: sería carísimo para seis unidades a 60 fps y
  se vería nervioso). Es un árbol de decisión con un paso de mirada
  adelante (1-ply, en el sentido de minimax): a especial y super, que
  exponen al que las tira, se les resta lo mejor que el rival podría
  contestar ahora mismo con su propio contexto. Entre una replanificación y
  la siguiente, las primitivas de movimiento de siempre (`pickTarget`,
  `separation`, `wantsJump`, `shouldBrakeAtLedge`, `shouldBrakeToTurn`)
  ejecutan el plan vigente — la capa nueva decide QUÉ hacer, no CÓMO
  moverse. Sigue sin haber azar: los empates se resuelven por el orden fijo
  de las candidatas.
- **Torneo 1v1 por defecto.** Cada bando manda uno; el que gana se queda, el
  que cae no vuelve y entra el siguiente de la plantilla; el bando que se
  queda sin sus tres pierde el match. Ceremonia de cierre de `CEREMONIA = 7`
  segundos antes de reiniciar — lo que tarda en leerse el título y entender
  quién ganó. `?modo=melee` da los seis sueltos a la vez, útil para mirar el
  motor con todo lleno.
- **El fondo reacciona al volumen por lado**: hoguera verde y roja, cielo
  teñido hacia el que domina — esto no lo tocó el pivot, sigue leyendo el
  libro en vivo. El super rota el escenario pintado
  (`public/escenarios/lista.json`, generado por `npm run escenarios` porque
  `public/` no pasa por Vite y el browser no puede listar carpetas); el corte
  cae dentro del hitstop del super para no verse como un parpadeo suelto.
  `?stage=` fija uno.

La lógica vive en `src/game/fighters.ts` y `src/game/match.ts`, sin Pixi ni
DOM, con asserts. `src/render/game.ts` sólo la lee y la dibuja.

### Render (`src/render/game.ts`)

`Application` de Pixi con capas ordenadas a mano, no z-index automático:
fondo → losas → cuerpos → capas de VFX (glow con Bloom, ink sin Bloom) →
HUD (DOM, aparte del canvas). Después de armar las capas de brillo/tinta de
los efectos hay que volver a subir los cuerpos al tope (`08955b2`) o un
especial/super/estallido —que mide 2-3 veces el ancho del personaje— tapa al
peleador durante todo el burst. `ShockwaveFilter` sobre el impacto de los
golpes fuertes.

`src/render/fx.ts` dibuja las partículas del cuerpo a cuerpo con geometría
pura (dos `Graphics`: `glow` tintable del color de bando, `ink` el contorno
negro fijo) — decodificar un PNG por golpe no es viable con seis peleadores
pegándose varias veces por segundo. Las texturas de verdad
(`src/render/vfxSprites.ts` + `loadVfx.ts`, pool de diez sprites fijos, cero
asignación por cuadro) van sólo en los momentos que ya de por sí frenan el
ritmo — especial, super, estallido, KO —, generadas con Nano Banana Pro y
separadas en las mismas dos capas glow/ink por `scripts/separar-vfx.py`, así
que un poder de cualquier bando sale teñido del color que le toca. Si una
textura no cargó, el golpe se sigue viendo con la geometría de siempre: la
textura es un agregado, nunca una dependencia.

### Arte de personaje

Pipeline en capas, en orden de cuánto detalle necesita cada acción:

1. **Piezas recortadas** (`torso`, `head`, `armupper`, `armlower`,
   `leglower`, `legupper`) armadas como muñeco de piezas — cortadas de un
   único dibujo de pie con `scripts/cortar.py` a partir de una receta en
   `recetas/<personaje>.json` que dice dónde están las articulaciones. Cubre
   `idle`/`run`/`jump`/`hurt` y el cuerpo a cuerpo.
2. **Hojas de sprite** (`hojas.png`/`hojas.webp` + `hojas.json`) para las
   acciones que no se pueden fingir rotando piezas — especiales, super,
   dash — generadas a partir de clips de Kling con `scripts/hoja-sprites.py`.
   El WebP bajó el peso de 26,6 MB a 6,5 MB por visita (`6252154`).
3. **El cuadro de `gira`** (turnaround, un frame). El giro fingido —angostar
   el ancho al 34%— seguía leyéndose como que el personaje desaparece un
   instante, sobre todo con fondo pintado detrás. La solución fue un frame de
   FRENTE real para el instante del cruce, generado con Kling + Nano Banana
   Pro a partir del propio sprite del juego e inyectado con
   `scripts/inyectar-giro.py`. **Los seis** lo tienen generado — este párrafo
   decía que Asuri, WuShang y Dusk no lo necesitaban por tener el `idle` ya de
   frente, pero `public/art/*/hojas.json` confirma la acción `gira` presente
   en los seis; quedó desactualizado, corregido el 2026-08-22.
   `src/art/spriteFighter.ts` decide cuál mostrar según el umbral de giro
   (`UMBRAL_GIRO_FRENTE`).

`public/art/deadpool/` existe en disco pero **no está en el roster** —
`src/game/roster.ts` tiene exactamente seis entradas (Kor/Mako/Asuri verdes,
Ragnir/WuShang/Dusk rojos) y Deadpool no es una de ellas. Quedó del período en
que se probaba el método de corte con una sola figura de referencia
(`3d78c3c`, `44ef457`); no se está usando ni desarrollando activamente.

**Quién entra al roster es una condición de corte, no de gusto**: brazos
despegados del torso, hueco entre las piernas, nada cruzando por delante del
cuerpo. Un arma en diagonal sobre el pecho obliga a inventar lo que hay
detrás, y eso ya no es cortar — es dibujar.

---

## Pipeline de arte (`scripts/`)

Agrupado por etapa. Cada script trae su propio docstring en español con
ejemplo de uso; esto es sólo el mapa.

**Del generador a la figura recortable**
`fondo.py` / `alfa.py` — sacan el fondo (blanco o damero) y dejan alfa real.
`piezas.py` — lista componentes conectados del alfa, para escribir una receta
sin medir a ojo. `receta.py` — escribe la receta de un kit en fila. `armar.py`
— arma la figura quieta desde el manifiesto, fuera del juego, para probar
números de rig. `proporcion.py` — sólo mide y avisa, **no reescala** (quedó
documentado que reescalar fue un error).

**Corte y limpieza de piezas**
`cortar.py` — corta la figura entera según la receta y escribe el manifiesto.
`contorno.py` — contorno negro sobre lo ya cortado. `piezas-sueltas.py` —
acerca piezas que se fueron lejos, borra esquirlas. `blancos-sueltos.py` —
borra fondo blanco encerrado adentro del dibujo. `sombra-de-piso.py` — borra
sombras que Kling dibujó adentro del sprite. `piso-por-accion.py` — fija la
distancia del centroide a los pies por animación.

**Hojas de sprite**
`cortar-poses.py` — parte una hoja de poses en una imagen por pose.
`juntar-poses.py` — junta poses sueltas en una hoja para `hoja-sprites.py`.
`hoja-sprites.py` — convierte clips de Kling en la hoja de sprites final de un
personaje. `cuadros.py` — saca cuadros que Kling dibujó con otro personaje
encima. `intercalar.py` — interpola cuadros intermedios pieza por pieza, sin
generar arte nuevo. `recortar-accion.py` — rehace una acción sola sin tocar
las demás. `reempacar.py` — reempaqueta hojas sin tocar un píxel de dibujo.
`ventana-ciclo.py` — encuentra el tramo de un clip que es ciclo real, para la
carrera. `hoja-fuego.py` — corta una hoja de llamas de Kling en tira de
cuadros para Pixi (no sirve `hoja-sprites.py` para esto).

**El giro**
`inyectar-giro.py` — mete el frame de `gira` generado como acción de un
cuadro, ver arriba.

**VFX**
`separar-vfx.py` — separa una textura de efecto de Nano Banana en las capas
glow/ink que ya usa `fx.ts`.

**Escenarios**
`escenarios.mjs` — escribe `public/escenarios/lista.json` leyendo disco.
`fuego-recolor.py` — saca la hoguera roja de la verde por recolor, en vez de
generar dos dibujos.

**Medición y auditoría**
`auditar.py` — ordena candidatos de `arte-crudo/candidatos/` por facilidad de
corte según los criterios eliminatorios. `hoja.py` — arma una hoja de
contactos de candidatos para elegir mirando (`shots/candidatos.png`).
`medirFlujo.ts`, `medirRuido.ts`, `medirVacio.ts` — métricas sobre capturas.

**Verificación visual (headless, Playwright)**
`mirar.mjs` — abre una URL del juego y saca una foto, imprime consola/red.
`mirar-movil.mjs` — igual, con caja de teléfono en horizontal.
`mirar-efectos.mjs` — banco de efectos a varias edades. `shoot.mjs` /
`video.mjs` / `video-cdp.mjs` — capturan la escena corriendo sobre el feed
mock (foto o video, por screenshot o por CDP). `demo-video.mjs` — graba el
banco de animación a paso fijo. `showcase.mjs` — una imagen por pose de todo
el elenco. `webm.py` / `gif.py` — arman video/GIF desde los cuadros
capturados (el GIF va a 12 fps a propósito: es la velocidad real del bucle,
no una elección de gusto).

**Empaquetado**
`artefacto.mjs` — empaqueta el juego entero en un único HTML que anda sin
servidor.

---

## Tests

```bash
npm test           # 10 suites, sin red ni browser
npm run test:mem   # smokeFeedCore con --expose-gc, mide heap retenido
```

| Suite | Cubre |
|---|---|
| `smokeFeedCore.ts` | Núcleo del feed: parseo, reconexión, backoff. Relojes y sockets falsos |
| `smokeMockFeed.ts` | El generador sintético |
| `smokeFighters.ts` | Reglas de pelea puras: cargas, daño, empuje, el super |
| `smokePhysics.ts` | Controlador de personaje: gravedad, snap a plataformas, caída |
| `smokePoderes.ts` | Poderes a distancia: salen, viajan, estallan lejos de quien los tiró, no le pegan a los propios, el pool no se satura |
| `smokeRoster.ts` | Los seis siempre en cancha sin esperar un trade; el que cae reaparece él mismo |
| `smokeTorneo.ts` | Regla del torneo 1v1: gana y se queda, cae y no vuelve, pierde sin los tres, el relevo no espera al mercado |
| `smokeCombos.ts` | Cadenas de combo del cuerpo a cuerpo: el orden declarado, el finisher pega de más, un silencio largo corta la cadena |
| `smokePlanner.ts` | La IA con planificación: qué acción se puede y cuál conviene, el árbol completo con la respuesta del rival restada, determinismo |

`cd server && npm test` — formato de grabación y servidor de replay, contra
el `BinanceFeedClient` real con un `socketFactory` de Node, sin red.

---

## Otros directorios

- **`godot/`** — banco de rigging, EN CURSO, no es el juego. Prueba si
  deformar la figura entera con huesos (en vez de cortarla en piezas
  simétricas de frente) sirve mejor para los dibujos en tres cuartos y pose
  dinámica que trae el arte actual. Si convence, es candidato a portar las
  ~5000 líneas de simulación que ya funcionan en Pixi; si no, se descarta sin
  pérdida. Ver `godot/LEEME.md`.
- **`docs/`** — `guia-arte.md`, `REFERENCIA-BRAWLHALLA.md`, `ficha-deadpool.md`.
- **`recetas/`** — un JSON de articulaciones por personaje (entrada de
  `cortar.py`) más `PROMPT-KIT-PARTES.md`, el prompt para regenerar kits.
- **`web/`** — HTML standalone, último tocado en el commit del pivot a
  sprites (`2019734`); no se confirmó si sigue generándose con
  `scripts/artefacto.mjs` o quedó de un empaquetado puntual — revisar antes de
  asumir que está al día.
- **`index.html`** — el juego (entrada real de `npm run dev`). `demo.html`,
  `efectos.html`, `showcase.html`, `consola.html` — bancos de prueba
  auxiliares para animación, VFX y elenco, fuera del camino principal.
- **`.agents/skills/`** — skills de Higgsfield instaladas para este repo, no
  código del proyecto.

---

## Pendientes reales

No hay TODOs ni FIXMEs en `src/`. Lo que sigue abierto, a nivel de commits y
del banco de Godot en curso:

1. **El banco de Godot** (`godot/`) — decidir si el rigging por huesos
   reemplaza el corte en piezas, y si conviene portar la simulación. Sigue sin
   arrancar: `godot/personajes/asuri/` sólo tiene el dibujo de referencia
   (`asuri.png`), no hay `asuri.tscn` — ver `godot/LEEME.md`.
2. ~~Correr contra Binance de verdad, de punta a punta~~ — **hecho el
   2026-08-23**, en local (Windows, `npm run dev` sin `?source=mock`): conecta
   sin errores contra `wss://data-stream.binance.vision`. El sandbox de
   Claude Code on the web sigue sin salida de red real (proxy de la sesión
   devuelve 403 a `data-stream.binance.vision` y `api.binance.com`), así que
   esto necesita seguir probándose desde una máquina o VPS sin ese proxy.
3. **`server/` (grabador/replay)** no tiene commits desde que se implementó
   (`6bb017a`, `67f857a`); sigue sin haber corrido contra Binance real ni
   contra disco real, por la misma razón de red que tenía el punto 2 (mismo
   camino para probarlo: local o VPS, no este sandbox).
4. Medir el presupuesto de frame en una GPU real — los números de este
   sandbox salen de SwiftShader por software y sólo valen para comparar draw
   calls, no fps.
5. ~~`web/` sin confirmar si está actualizado~~ — **hecho el 2026-08-23**:
   estaba desactualizado (18/08, previo al HUD compacto, a apagar los poderes
   a distancia y a la regeneración del arte de Kor), regenerado con
   `scripts/artefacto.mjs`. De paso se corrigieron dos bugs del script: las
   hojas `.webp` se reescribían siempre como PNG (deshacía la compresión de
   `6252154`) y el bundle de esbuild no definía `import.meta.env`, así que el
   artefacto crasheaba entero al arrancar.

## Nota legal

Los términos de uso de Binance licencian los datos de mercado para uso
personal no comercial o interno y prohíben retransmitirlos a terceros. Un
proyecto personal o demo privada es exposición baja. Si esto se vuelve un
producto público comercial hace falta consentimiento escrito de Binance o un
proveedor con licencia de redistribución. No es asesoramiento legal.
