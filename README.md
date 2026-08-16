# BorderBrawlers

Visualizador 3D del order book de Binance como escenario de pelea estilo Super
Smash Bros. Los niveles del libro son plataformas; cada trade ejecutado lanza un
personaje hacia el centro con impulso proporcional a su tamaño.

React Three Fiber v9 + Rapier, WebGL, presupuesto de frame de 16,6 ms.

---

## Estado

| # | Módulo | Estado |
|---|--------|--------|
| 1 | `src/types/binance.ts` | listo, verificado |
| 2 | `src/net/feedCore.ts` + `src/net/useBinanceFeed.ts` | listo, verificado |
| 3 | `src/scene/OrderBookWalls.tsx` | listo |
| 4 | `src/scene/BrawlerPool.tsx` | listo |
| 5 | `src/scene/DynamicCamera.tsx` + `stageFocus.ts` | listo |
| 6 | `src/scene/BorderBrawlersScene.tsx` | listo |
| 7 | `src/BorderBrawlers.tsx` | listo |
| 8 | `src/mock/mockFeed.ts` | listo, verificado |
| — | `server/` — grabador y replay del VPS | listo, verificado |

Ver `CLAUDE.md` para el contexto completo: decisiones cerradas, invariantes del
código, y los pendientes.

```bash
npm run dev
# http://localhost:5173/?source=mock&scenario=normal
```

Parámetros por query string: `?source=` (`mock` | `binance-direct` |
`vps-replay` | `vps-relay`), `?scenario=` (`calm` | `normal` | `volatile` |
`stress`), `?symbol=`, `?vps=`, `?low` y `?quality=high|low`.

`src/dev/PerfHud.tsx` muestra en vivo el criterio de aceptación de la Parte E
(`renderer.info.render.calls <= 12`, frame ms, peor frame del período).

### Por qué no usamos `r3f-perf`

El prompt maestro pedía montar `<Perf />` desde el primer día. No se puede con
esta matriz: `r3f-perf@7.2.3` —la última publicada— depende de
`@react-three/drei@^9.103.0`, y drei@9 declara peers de React 18 y
`@react-three/fiber@^8`. npm resuelve instalando un **segundo drei anidado**
escrito contra la API de R3F v8, junto al drei@10 del proyecto, ambos
importando el mismo fiber@9. Es la mezcla v8/v9 que la Parte A prohíbe, y era
la única fuente de los 8 warnings `ERESOLVE` del install.

`PerfHud.tsx` lee `gl.info` directamente —que es de dónde `r3f-perf` saca sus
números— en unas 50 líneas, sin dependencias y sin conflictos de peers.

---

## Setup

```bash
npm i
npm run dev        # http://localhost:5173
npm run typecheck  # tsc --noEmit, strict
npm test           # smoke tests de los módulos 1, 2 y 8
```

Las versiones están fijadas **sin caret** a propósito. `@react-three/postprocessing@3`
exige `three >= 0.182.0` y `postprocessing@6.39.x` exige `three < 0.186.0`: la
ventana válida es **0.182–0.185**. Un `npm update` te saca de ahí y rompe el build.

Nunca instales `@dimforge/rapier3d-compat` por separado: `@react-three/rapier@2.2.0`
lo fija en `0.19.2` y hacerlo a mano produce un binding WASM duplicado.

---

## Arquitectura de datos

Cuatro fuentes intercambiables detrás de un flag, todas emitiendo **las mismas
formas de cable de Binance**. Cambiar de fuente no toca una línea de la escena.

```
mock            generador sintético local, sin red
binance-direct  browser → Binance. Camino en vivo por defecto. 1 hop, USD 0
vps-replay      reemisión determinista de stream grabado, para perfilar
vps-relay       passthrough en vivo. Sólo si Binance bloquea el directo
```

### Por qué el camino en vivo es directo y no pasa por el VPS

- **El relay nunca puede ganar en latencia.** `browser→VPS→Binance` es, por
  desigualdad triangular, ≥ `browser→Binance`.
- **El feed no es el cuello de botella.** El parseo completo cuesta ~0,2 ms por
  segundo (`depth20@100ms` son ~1,15 KB y `JSON.parse` ~15 µs, a 10 Hz). Contra
  un presupuesto de 1000 ms/s, es menos del 0,1%. Los 60 FPS se pierden en
  Rapier, draw calls y GC, no en la red.
- **Posición legal.** Con conexión directa cada visitante es cliente de Binance
  por su cuenta. Con un relay público, vos retransmitís market data a terceros,
  que es justo lo que prohíben los términos de uso.

### Para qué sí sirve el VPS

**Grabar y reproducir.** Para perfilar hace falta correr *el mismo minuto
infernal del mercado* una y otra vez mientras mirás el profiler. Contra el
mercado en vivo no hay dos corridas comparables, así que "esto mejoró o empeoró"
no se puede contestar.

Está implementado en **`server/`** — grabador y servidor de replay, con tests de
punta a punta que no tocan la red. Ver `server/README.md`.

Cuánto ocupa, medido con `npm run sizing` sobre el formato real:

| escenario | por día | comprimido | por año |
|---|---|---|---|
| calm | 0,95 GB | 0,24 GB | 87 GB |
| normal | 1,86 GB | 0,36 GB | 131 GB |
| volatile | 2,67 GB | 0,44 GB | 161 GB |

Un año **no** entra en el disco de 80 GB del VPS: la compresión real de este
formato es 5x, no las 8x que suponía la estimación anterior. Tampoco hace falta
— `--keep-days 14` deja ~5 GB permanentes y alcanza de sobra para perfilar.

Y queda como salida ante bloqueo geográfico, con `vps-relay`, sin cambiar nada
más que el flag.

---

## Reglas que no se negocian

**Regla del agresor.** `m` es *"¿el comprador es el market maker?"*. El maker
estaba en reposo; el taker es el agresor y define el color. Invertirlo produce
una visualización que se ve plausible y está sistemáticamente al revés.

```ts
const side: 'buy' | 'sell' = trade.m ? 'sell' : 'buy';
```

**Ballenas por mediana móvil, nunca por umbral fijo.** Un umbral en BTC no sirve
para ETH ni sobrevive a un movimiento de precio. `whale = size > mediana * 8`,
sobre una ventana de 200 trades, y sin clasificar hasta tener 20 muestras.

**Nada de estado de React en el camino de datos de mercado.** El libro vive en
arrays tipados preasignados; los trades en un ring buffer de 256 con pool de
objetos y política descartar-el-más-viejo. `useState` sí, para el chrome de UI
de baja frecuencia: estado de conexión, visibilidad, toggle de calidad.

**`@depth20@100ms` es snapshot idempotente, no delta.** Sin bootstrap REST, sin
buffering, sin manejo de gaps.

---

## Verificación

`npm test` corre dos suites, sin red y sin esperas reales:

- **`smokeMockFeed`** — formato de cable exacto, orden de bids/asks, libro no
  cruzado, determinismo por semilla, escalado de los cuatro escenarios.
- **`smokeFeedCore`** — mediana móvil contra implementación naive, ring buffer
  descartando el más viejo, regla del agresor, umbral de ballena, backoff
  exponencial con jitter y su techo, límite de 300 intentos / 5 min, reconexión
  proactiva de 24 h *make-before-break* (el socket viejo sigue abierto hasta que
  el nuevo confirma), limpieza en `stop()`, y crecimiento de heap retenido cero
  sobre 400k trades.

El reloj y el constructor de WebSocket se inyectan, así que las 24 h se simulan
en microsegundos.

`cd server && npm test` corre otras dos, también sin red:

- **`smokeRecording`** — ida y vuelta del formato, la garantía de que el crudo
  no se normaliza, líneas corruptas que no voltean al lector, nombres de
  archivo, selección de horas, y dos cargas de la misma ventana que dan
  exactamente lo mismo.
- **`smokeReplayServer`** — levanta el servidor en otro proceso y le conecta el
  `BinanceFeedClient` real. Verifica que la grabación llega byte por byte, que
  el libro se llena y los trades se cuentan sin tocar una línea del cliente, y
  que dos corridas de la misma ventana son idénticas.

```bash
npm run test:mem   # igual que npm test pero con --expose-gc
```

---

## Nota legal

Los términos de uso de Binance licencian los datos de mercado para uso personal
no comercial o interno, y prohíben retransmitirlos o publicarlos a terceros. Un
proyecto personal o una demo privada es exposición baja. Si esto se vuelve un
producto público comercial hace falta consentimiento escrito de Binance o un
proveedor con licencia de redistribución. No es asesoramiento legal.
