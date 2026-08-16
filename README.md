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
| 3 | `src/scene/OrderBookWalls.tsx` | pendiente |
| 4 | `src/scene/BrawlerPool.tsx` | pendiente |
| 5 | `src/scene/DynamicCamera.tsx` | pendiente |
| 6 | `src/scene/BorderBrawlersScene.tsx` | pendiente |
| 7 | `src/BorderBrawlers.tsx` | pendiente |
| 8 | `src/mock/mockFeed.ts` | listo, verificado |

`src/dev/FeedProbe.tsx` es un banco de pruebas temporal: drena la cola con rAF y
muestra el libro en texto, para validar el camino de datos antes de que exista
la escena. Se borra cuando esté el módulo 7.

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
infernal del mercado* una y otra vez mientras mirás el profiler. El stream son
~1,4 GB/día crudos, ~180 MB/día comprimido: más de un año en 80 GB.

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
