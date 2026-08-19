# BorderBrawlers

Pelea estilo Super Smash Bros / Brawlhalla sobre el order book de Binance.

3 contra 3, verde compradores contra rojo vendedores, **sin comandos de
usuario**: todo lo maneja el libro de órdenes y el flujo de compra y venta.
Los peleadores saltan entre plataformas que suben y bajan con la liquidez, se
empujan y se sacan del ring. Cuando un lado domina el libro, agranda a uno de
los suyos en tres pasos y descarga un super que despide a todo rival cerca.
Por defecto es torneo 1v1: cada bando manda uno, el que gana se queda.

Sin framework de UI, sin motor de física de terceros: **PixiJS 8** para
dibujar y TypeScript estricto para todo lo demás. `src/game/` simula la pelea
entera con funciones puras y arrays tipados, testeadas sin browser; `src/
render/` sólo la lee y la dibuja.

Ver `CLAUDE.md` para el contexto completo: decisiones cerradas, invariantes
del feed, el pipeline de arte de los peleadores y los pendientes reales.

```bash
npm i
npm run dev        # http://localhost:5173/?source=mock&scenario=normal
npm run typecheck  # tsc --noEmit, strict
npm test           # 7 smoke suites, sin red ni browser
```

Parámetros por query string: `?source=` (`mock` | `binance-direct` |
`vps-replay` | `vps-relay`), `?scenario=` (`calm` | `normal` | `volatile` |
`stress`, sólo con `source=mock`), `?symbol=`, `?vps=`, `?stage=` (fondo
pintado), `?modo=melee` (los seis sueltos en vez de torneo 1v1), `?duo=kor,
ragnir` (fija un peleador por bando para trabajar), `?vs=` (peleadores por
bando en melé), `?ritmo=` (velocidad, 0–4), `?medir` (regla de tamaños en
pantalla, para depurar el encuadre en teléfono).

Todos los valores enumerados se validan contra una lista permitida — un
`?source=binancedirect` mal tipeado no abre un WebSocket a `undefined`, avisa
por consola y usa el default.

---

## Arquitectura de datos

Cuatro fuentes intercambiables detrás de un flag, todas emitiendo **las mismas
formas de cable de Binance**. Cambiar de fuente no toca una línea del juego.

```
mock            generador sintético local, sin red
binance-direct  browser → Binance. Camino en vivo por defecto. 1 hop, USD 0
vps-replay      reemisión determinista de stream grabado, para perfilar
vps-relay       passthrough en vivo. Sólo si Binance bloquea el directo
```

### Por qué el camino en vivo es directo y no pasa por el VPS

- **El relay nunca puede ganar en latencia.** `browser→VPS→Binance` es, por
  desigualdad triangular, ≥ `browser→Binance`.
- **El feed no es el cuello de botella.** El parseo completo cuesta ~0,2 ms
  por segundo de hilo principal — menos del 0,1% de un presupuesto de frame de
  16,6 ms.
- **Posición legal.** Con conexión directa cada visitante es cliente de
  Binance por su cuenta. Con un relay público, vos retransmitís market data a
  terceros, que es justo lo que prohíben los términos de uso.

### Para qué sí sirve el VPS

**Grabar y reproducir.** Para perfilar hace falta correr *el mismo minuto del
mercado* una y otra vez. Contra el mercado en vivo no hay dos corridas
comparables, así que "esto mejoró o empeoró" no se puede contestar.

Implementado en **`server/`** — grabador y servidor de replay, con tests de
punta a punta que no tocan la red. Ver `server/README.md`. Retención por
defecto: 10 GB o 30 días, lo que llegue primero (~28 días de mercado normal,
la cinta se pisa sola). También sirve como salida ante bloqueo geográfico con
`vps-relay`, sin cambiar nada más que el flag.

`server/` no tiene commits desde que se implementó y nunca corrió contra
Binance real ni contra disco real — el camino en vivo tampoco se ejercitó de
punta a punta en este entorno de desarrollo.

---

## Reglas que no se negocian

**Regla del agresor.** `m` es *"¿el comprador es el market maker?"*. El maker
estaba en reposo; el taker es el agresor y define el color. Invertirlo
produce una visualización que se ve plausible y está sistemáticamente al
revés.

```ts
const side: 'buy' | 'sell' = trade.m ? 'sell' : 'buy';
```

**Ballenas por mediana móvil, nunca por umbral fijo.** Un umbral en BTC no
sirve para ETH ni sobrevive a un movimiento de precio.

**Cero azar en la pelea.** Todo lo que pasa en pantalla se puede seguir hasta
un trade o una cifra del libro — no hay generador con semilla en el camino de
juego.

**`@depth20@100ms` es snapshot idempotente, no delta.** Sin bootstrap REST,
sin buffering, sin manejo de gaps.

---

## El elenco y su arte

Seis peleadores fijos, tres por bando (`src/game/roster.ts`): **Kor, Mako,
Asuri** verdes; **Ragnir, WuShang, Dusk** rojos. Sin relevos — el que se cae
del ring reaparece él mismo en su slot.

Cada uno se arma en capas: piezas recortadas de un dibujo de pie para el
movimiento normal, hojas de sprite generadas de clips de Kling para las
especiales, y un frame de turnaround generado aparte (Kor, Ragnir, Mako) para
que el giro no se vea como que el personaje desaparece un instante. El
pipeline completo de recorte, generación y verificación visual vive en
`scripts/` — está documentado en `CLAUDE.md`.

---

## Verificación

```bash
npm test           # 7 suites: feed, mock, reglas de pelea, física del
                    # personaje, poderes a distancia, plantilla fija, torneo
npm run test:mem   # smokeFeedCore con --expose-gc, mide heap retenido
cd server && npm test   # formato de grabación + servidor de replay, sin red
```

El reloj y el constructor de WebSocket se inyectan en `BinanceFeedClient`, así
que la reconexión con backoff exponencial (hasta 300 intentos / 5 min) y la
reconexión proactiva de 24 h se simulan en microsegundos, sin esperar de
verdad.

Verificación visual fuera de la suite automática — sin assert, a ojo, sobre
capturas headless con Playwright: `node scripts/mirar.mjs <url> [foto.png]`.
Existe porque un defecto de encuadre o un personaje que no aparece no se ve en
el typecheck ni en los tests.

---

## Nota legal

Los términos de uso de Binance licencian los datos de mercado para uso
personal no comercial o interno, y prohíben retransmitirlos o publicarlos a
terceros. Un proyecto personal o una demo privada es exposición baja. Si esto
se vuelve un producto público comercial hace falta consentimiento escrito de
Binance o un proveedor con licencia de redistribución. No es asesoramiento
legal.
