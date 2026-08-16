# BorderBrawlers — contexto para Claude Code

Visualizador 3D del order book de Binance como escenario de pelea estilo Super
Smash Bros. React Three Fiber v9 + Rapier, WebGL. Escala: 1 espectador, demo
personal. Prioridad número uno: **presupuesto de frame de 16,6 ms**, por encima
de la elegancia del código.

El documento de referencia es `PROMPT_MAESTRO_BorderBrawlers_v3.md` (fuera del
repo). Este archivo resume lo que hace falta para seguir trabajando acá.

---

## Estado

Los 8 módulos están escritos y **la escena corre entera**. `tsc --noEmit` limpio
en strict, `npm test` en verde, `npm run build` sin errores. Los módulos 6 y 7
se ejecutaron por primera vez y se corrigieron los defectos que aparecieron al
verlos andar (ver abajo).

| # | Archivo | Estado |
|---|---------|--------|
| 1 | `src/types/binance.ts` | verificado |
| 2 | `src/net/feedCore.ts` + `src/net/useBinanceFeed.ts` | verificado, 40 asserts |
| 3 | `src/scene/OrderBookWalls.tsx` | corre |
| 4 | `src/scene/BrawlerPool.tsx` | corre |
| 5 | `src/scene/DynamicCamera.tsx` + `src/scene/stageFocus.ts` | corre |
| 6 | `src/scene/BorderBrawlersScene.tsx` | corre |
| 7 | `src/BorderBrawlers.tsx` | corre |
| 8 | `src/mock/mockFeed.ts` | verificado, 20 asserts |

Auxiliares: `src/quality.ts` (`detectLowQuality`), `src/dev/PerfHud.tsx`
(medidor propio). `src/dev/FeedProbe.tsx` se borró: el módulo 7 anda y el banco
de pruebas del feed ya no aportaba nada que la escena no muestre.

### Cómo arrancar

```bash
npm install
npm run typecheck
npm run dev        # http://localhost:5173/?source=mock&scenario=normal
```

Empezar con `?source=mock` para no depender del mercado. Después
`?source=binance-direct`.

Query params: `source`, `scenario`, `symbol`, `vps`, y `quality=high|low`
(o `?low`). Los valores se validan contra la lista permitida: antes se
casteaban a ciegas y un `?source=binancedirect` terminaba abriendo un
WebSocket a la URL literal `undefined`.

`quality=high` existe para poder medir la ruta con Bloom en una máquina que
`detectLowQuality()` clasifica como lenta; sin eso el criterio de draw calls
no se puede verificar en un headless de 2 núcleos.

---

## Decisiones cerradas — no reabrir sin motivo nuevo

- **Sin backend en el camino en vivo.** El browser se conecta directo a
  `wss://data-stream.binance.vision:443`. Un relay no puede ganar en latencia
  (desigualdad triangular) y el feed cuesta ~0,2 ms por segundo de hilo
  principal, o sea <0,1% del presupuesto. Además, con conexión directa cada
  visitante es cliente de Binance por su cuenta; con un relay público vos
  retransmitís market data a terceros, que los términos de uso prohíben.
- **El VPS de Vultr (2 vCPU / 4 GB / USD 20 mes) queda para grabación y replay
  determinista**, no para el vivo. Es lo único que no se puede hacer sin
  servidor: repetir el mismo minuto infernal del mercado mientras se perfila.
  **Implementado en `server/`** — ver `server/README.md`. Con TLS resuelto,
  `vps-relay` también sirve como salida ante bloqueo geográfico, sin tocar nada
  más que el flag.
- **Nada de esto va a Supabase ni a una base de datos.** Son archivos planos que
  se escriben append-only y se leen secuencialmente por rango de tiempo: un
  filesystem hace exactamente eso y una base no agrega nada. Además el grabador
  es un proceso que sostiene un WebSocket 24/7, que es justo lo que las
  plataformas serverless no hacen. Lo estático (el cliente) sí va a Vercel.
- **`@depth20@100ms` es snapshot idempotente, no delta.** Sin bootstrap REST,
  sin buffering, sin manejo de gaps.
- **`r3f-perf` está prohibido.** `7.2.3`, la última publicada, depende de
  `@react-three/drei@^9` (React 18 / R3F v8) e instala un segundo drei anidado
  junto al drei@10 del proyecto. Era la única fuente de los 8 warnings ERESOLVE.
  Se reemplazó por `src/dev/PerfHud.tsx`, que lee `gl.info` en ~50 líneas.
- **Hosting**: sitio estático. El destino previsto es Vercel.

## Matriz de versiones — exacta, sin caret

```
react 19.2.0 · react-dom 19.2.0 · three 0.185.1
@react-three/fiber 9.7.0 · @react-three/rapier 2.2.0
@react-three/drei 10.7.8 · @react-three/postprocessing 3.0.5
```

- Ventana válida de three: **0.182–0.185**. `@react-three/postprocessing@3`
  exige `three >= 0.182` y `postprocessing@6.39.x` exige `three < 0.186`.
- **Nunca** instalar `@dimforge/rapier3d-compat` aparte: rapier@2.2.0 lo fija en
  `0.19.2` y hacerlo a mano produce un binding WASM duplicado.
- R3F v9 usa React 19. La augmentación de JSX va con
  `declare module '@react-three/fiber'` e interfaz `ThreeElements`, nunca en el
  namespace global `JSX`. Los tipos `MeshProps`, `Object3DNode`, `MaterialNode`,
  `BufferGeometryNode` y `Props` **no existen** en v9.
- Rapier v1 es para React 18 y v2 para React 19. No mezclar ejemplos de v1.

---

## Invariantes del código

**Regla del agresor.** `m` es *"¿el comprador es el market maker?"*. El taker es
el agresor y define el color. Está escrito literalmente así en `feedCore.ts` y
hay un test por cada lado. Invertirlo produce una visualización plausible y
sistemáticamente al revés.

```ts
const side: 'buy' | 'sell' = trade.m ? 'sell' : 'buy';
```

El color del personaje **es** esa regla hecha visible: `buy` verde, `sell` rojo,
ballena en dorado fuera del rango 0–1 para que la levante el Bloom. Se pinta con
un `setColorAt` por spawn y un solo `needsUpdate` al final del frame. Hasta la
auditoría los personajes salían todos dorados y el lado no se veía en ningún
lado de la escena.

**Ballenas por mediana móvil**, ventana de 200 trades, `size > mediana * 8`, sin
clasificar hasta tener 20 muestras. Nunca un umbral fijo.

**Cero estado de React en el camino de datos de mercado.** El libro vive en
`Float64Array` preasignados; los trades en un ring buffer de 256 con pool de
objetos y descarte del más viejo. `useState` sí para el chrome de UI de baja
frecuencia: estado de conexión, visibilidad, símbolo, toggle de calidad.

**Cero asignaciones en `useFrame` y en el handler del socket.** Todos los
temporales (`Object3D`, `Vector3`, `Color`, `Matrix4`, y los `{x,y,z}` que come
Rapier) están preasignados a nivel de módulo. Verificado: 400k trades con
crecimiento de heap retenido cero.

**Visual y física desacopladas.** Un `InstancedMesh` es un único `Object3D` y no
admite un collider por instancia. El libro son 40 instancias en 1 draw call
(10 Hz) y sólo 3 colliders: 2 muros agregados redimensionados con
`setHalfExtents` a 4 Hz, más la plataforma del spread. Nunca desmontar y
remontar componentes para cambiar una forma.

**Ningún collider más fino que 0,2 unidades** — los finos causan tunneling.

**Los acumuladores de sub-frecuencia no se resetean en los early return.** El
libro se redibuja sólo cuando cambia `lastUpdateId`, y la física va a 4 Hz con
un acumulador propio. Resetear ese acumulador en el return de "no hay snapshot
nuevo" descarta el tick pendiente en 5 de cada 6 frames — 60 Hz de render contra
10 Hz de snapshots — y los muros terminan redimensionándose 0,7 veces por
segundo en vez de 4. El síntoma no es un error: es física que va atrasada
respecto de lo que se ve.

**`interpolate`, no `interpolation`.** El README de rapier lo escribe mal en un
ejemplo; React no valida props desconocidos, así que el error es silencioso.

**El zoom no se clampea directo.** En R3F la cámara ortográfica tiene el frustum
en unidades de píxel (`camera.right === size.width / 2`), así que un zoom
razonable ronda 50–100 y depende de la resolución. Se clampea la extensión
visible en unidades de mundo. Y hay que llamar `camera.updateProjectionMatrix()`
en el mismo frame en que se toca `camera.zoom`, o no pasa nada y no hay error.

**La calidad se resuelve en el montaje, nunca en caliente.** El toggle remonta
el `<Canvas>` con una `key`. Alternar el tipo de material en runtime fuerza
compilar y linkear un `WebGLProgram` nuevo y congela.

### Dos hallazgos sobre `@react-three/rapier@2.2.0`

Verificados leyendo el código fuente de la versión fijada, no la documentación.

1. **`setMatrixAt` a mano no sirve** para las instancias del pool. La matriz se
   recompone cada frame como `compose(translation, rotation, state.scale)`,
   donde `state` vive en `useRapier().rigidBodyStates` (marcado `@internal`,
   pero es el único camino). La escala por instancia se cambia ahí.
2. **El bucle de sincronización saltea los cuerpos dormidos**: la guarda es
   `rigidBody.isSleeping() && !("isInstancedMesh" in state.object)`, y para
   cuerpos instanciados `state.object` es el wrapper del `RigidBody`, no el
   `InstancedMesh`. Si se llama `sleep()` en el mismo frame en que se retira el
   personaje, la escala 0 no llega a escribirse y queda un cubo congelado en el
   aire. Por eso el retiro es **en dos fases**: un frame para encoger y
   teletransportar, y recién al siguiente `sleep()`.

---

## Criterio de aceptación (Parte E) — verificable

- `renderer.info.render.calls` **≤ 12** con 50 personajes activos y el libro
  completo. `PerfHud` lo muestra en vivo y se pone rojo al pasarse.
  Medido con `?source=mock&scenario=stress`: **11 en calidad alta** (escena más
  todos los pasos del Bloom) y **2 en calidad baja**.

  Dos cosas hacían que ese número fuera mentira y están arregladas:
  `PerfHud` apaga `gl.info.autoReset` (three resetea los contadores en cada
  `render()`, y `EffectComposer` hace uno por paso, así que lo que se leía era
  el último quad del Bloom: "1 draw call"), y el Bloom va con `levels={4}` en
  vez del default de 8, porque el mipmap blur cuesta 2 draw calls por nivel y
  con 8 el total daba 19.
- Cero asignaciones de `Vector3`, `Quaternion`, `Matrix4`, `Color` u `Object3D`
  dentro de `useFrame` o del handler del WebSocket.
- Cero setters de estado de React en el camino de datos de mercado.
- La regla del agresor implementada como `trade.m ? 'sell' : 'buy'`, literal.
- Pestaña oculta 60 s y luego visible: sin ráfaga de spawns, sin salto de física.
  Verificado en headless emulando lo que hace el browser de verdad —
  `visibilityState` a `hidden` **y** rAF suspendido, que es la mitad que se
  olvida. 60 s ocultos acumulan ~2400 trades y al volver el peor frame no se
  movió (16,8 ms) ni hubo ráfaga.
- Reconexión con backoff exponencial y jitter, sin superar 300 intentos / 5 min.
- `tsc --noEmit` limpio en strict, sin `any` ni `@ts-ignore`.

---

## Tests

```bash
npm test           # smokeMockFeed + smokeFeedCore, ~60 asserts, sin red
npm run test:mem   # igual, con --expose-gc, mide heap retenido

cd server && npm test   # formato de grabación + servidor de replay, sin red
```

La suite del servidor levanta el servidor de replay de verdad en otro proceso y
le conecta **el `BinanceFeedClient` real**, el mismo del browser, con un
`socketFactory` de Node. Si el libro se llena y los trades salen bien sin tocar
una línea del cliente, el replay es indistinguible del vivo — que es la única
propiedad que le pedimos.

El reloj y el constructor de WebSocket se inyectan en `BinanceFeedClient`, así
que las 24 h de la reconexión proactiva se simulan en microsegundos. Cualquier
cambio en `feedCore.ts` tiene que mantener esas suites en verde.

---

## Pendientes

1. **Correr contra Binance de verdad.** El camino en vivo nunca se ejercitó: el
   sandbox donde se auditó no tunelea WebSockets y el cliente se quedó en
   `reconnecting`, que es lo correcto pero no prueba nada del feed real. Es lo
   único del proyecto que sigue sin verse funcionando.
2. Ajustar a ojo las constantes de escenario: `HEIGHT_GAIN`, `IMPULSE_GAIN`,
   `HDR_THRESHOLD`, los lambdas de `damp` de la cámara. Están puestas por
   razonamiento, no por haberlas visto. En las capturas el encuadre deja bastante
   aire muerto abajo y los personajes pasan por encima de los muros altos: los
   colliders son 2 cuboides con la altura PROMEDIO del lado, así que un pico de
   liquidez se ve pero no se choca. Es decisión de diseño, no bug; si molesta, el
   ajuste es de constantes, no de arquitectura.
3. Medir el presupuesto de 16,6 ms en una GPU real. Los números de fps de la
   auditoría salieron de SwiftShader por software (6–10 fps) y no dicen nada:
   lo que sí es válido de ahí son los draw calls y el conteo de triángulos.
4. **Desplegar el grabador en el VPS.** El código está y anda (`server/`, con
   tests de punta a punta), pero nunca corrió contra Binance de verdad ni contra
   un disco real — por lo mismo que el punto 1.

   El presupuesto de disco del README viejo estaba mal y ya se corrigió: medido
   con `npm run sizing`, un día son 0,36 GB comprimidos y **un año son ~131 GB**,
   contra los "180 MB/día, más de un año en 80 GB" que se habían supuesto. La
   compresión real de este formato es 5x, no 8x. Un año NO entra en el disco de
   80 GB; `--keep-days 14` deja ~5 GB permanentes, que es lo que hace falta para
   perfilar.
5. Si alguna vez se quiere `vps-relay` en vivo, hace falta `wss://` — una página
   HTTPS no puede abrir `ws://` a una IP pelada. Requiere dominio propio con
   Caddy, o un túnel de Cloudflare.

## Nota legal

Los términos de uso de Binance licencian los datos de mercado para uso personal
no comercial o interno y prohíben retransmitirlos a terceros. Un proyecto
personal o demo privada es exposición baja. Si esto se vuelve un producto
público comercial hace falta consentimiento escrito de Binance o un proveedor
con licencia de redistribución. No es asesoramiento legal.
