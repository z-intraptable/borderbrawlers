# BorderBrawlers — contexto para Claude Code

Visualizador 3D del order book de Binance como escenario de pelea estilo Super
Smash Bros. React Three Fiber v9 + Rapier, WebGL. Escala: 1 espectador, demo
personal. Prioridad número uno: **presupuesto de frame de 16,6 ms**, por encima
de la elegancia del código.

El documento de referencia es `PROMPT_MAESTRO_BorderBrawlers_v3.md` (fuera del
repo). Este archivo resume lo que hace falta para seguir trabajando acá.

---

## Estado

Los 8 módulos están escritos. `tsc --noEmit` limpio en strict hasta el módulo 5;
los módulos 6 y 7 se escribieron al final de la sesión y **todavía no se
compilaron ni se ejecutaron nunca**. Ese es el primer paso.

| # | Archivo | Estado |
|---|---------|--------|
| 1 | `src/types/binance.ts` | verificado |
| 2 | `src/net/feedCore.ts` + `src/net/useBinanceFeed.ts` | verificado, 40 asserts |
| 3 | `src/scene/OrderBookWalls.tsx` | compila; sin correr |
| 4 | `src/scene/BrawlerPool.tsx` | compila; sin correr |
| 5 | `src/scene/DynamicCamera.tsx` + `src/scene/stageFocus.ts` | compila; sin correr |
| 6 | `src/scene/BorderBrawlersScene.tsx` | **sin compilar** |
| 7 | `src/BorderBrawlers.tsx` | **sin compilar** |
| 8 | `src/mock/mockFeed.ts` | verificado, 20 asserts |

Auxiliares: `src/quality.ts` (`detectLowQuality`), `src/dev/PerfHud.tsx`
(medidor propio), `src/dev/FeedProbe.tsx` (banco de pruebas del feed, **se borra
cuando el módulo 7 esté andando**).

### Primer paso al retomar

```bash
npm run typecheck
npm run dev        # http://localhost:5173/?source=mock&scenario=normal
```

Empezar con `?source=mock` para no depender del mercado. Después
`?source=binance-direct`. `?probe` abre el banco de pruebas del feed sin 3D.

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
  Falta implementarlo (ver Pendientes). Con TLS resuelto, `vps-relay` también
  sirve como salida ante bloqueo geográfico, sin tocar nada más que el flag.
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
- Cero asignaciones de `Vector3`, `Quaternion`, `Matrix4`, `Color` u `Object3D`
  dentro de `useFrame` o del handler del WebSocket.
- Cero setters de estado de React en el camino de datos de mercado.
- La regla del agresor implementada como `trade.m ? 'sell' : 'buy'`, literal.
- Pestaña oculta 60 s y luego visible: sin ráfaga de spawns, sin salto de física.
- Reconexión con backoff exponencial y jitter, sin superar 300 intentos / 5 min.
- `tsc --noEmit` limpio en strict, sin `any` ni `@ts-ignore`.

---

## Tests

```bash
npm test        # smokeMockFeed + smokeFeedCore, ~60 asserts, sin red
npm run test:mem   # igual, con --expose-gc, mide heap retenido
```

El reloj y el constructor de WebSocket se inyectan en `BinanceFeedClient`, así
que las 24 h de la reconexión proactiva se simulan en microsegundos. Cualquier
cambio en `feedCore.ts` tiene que mantener esas suites en verde.

---

## Pendientes

1. **Compilar y correr los módulos 6 y 7.** Nunca se ejecutaron.
2. Ajustar a ojo las constantes de escenario: `HEIGHT_GAIN`, `IMPULSE_GAIN`,
   `HDR_THRESHOLD`, los lambdas de `damp` de la cámara. Están puestas por
   razonamiento, no por haberlas visto.
3. Medir `renderer.info.render.calls` con `?source=mock&scenario=stress` y
   confirmar el ≤ 12.
4. Verificar el comportamiento con la pestaña oculta 60 s (criterio de la
   Parte E que todavía no se probó en vivo).
5. Borrar `src/dev/FeedProbe.tsx` cuando el módulo 7 esté andando.
6. **Grabador y servidor de replay del VPS.** Guardar los frames crudos tal cual
   llegan (~1,4 GB/día, ~180 MB/día comprimido: más de un año en 80 GB) y
   reemitirlos en el mismo formato de cable. El cliente ya tiene el flag
   `vps-replay` y `resolveFeedUrl()` ya arma la URL: falta sólo el servidor.
7. Si alguna vez se quiere `vps-relay` en vivo, hace falta `wss://` — una página
   HTTPS no puede abrir `ws://` a una IP pelada. Requiere dominio propio con
   Caddy, o un túnel de Cloudflare.

## Nota legal

Los términos de uso de Binance licencian los datos de mercado para uso personal
no comercial o interno y prohíben retransmitirlos a terceros. Un proyecto
personal o demo privada es exposición baja. Si esto se vuelve un producto
público comercial hace falta consentimiento escrito de Binance o un proveedor
con licencia de redistribución. No es asesoramiento legal.
