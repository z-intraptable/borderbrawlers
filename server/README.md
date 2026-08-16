# Grabador y servidor de replay

Lo único del proyecto que necesita un servidor, y no está en el camino en vivo.

El vivo va directo del browser a Binance: un relay no puede ganar en latencia y
retransmitir market data a terceros va contra los términos de uso. Lo que **no**
se puede hacer sin servidor es repetir el mismo minuto del mercado una y otra
vez. Sin eso no hay forma de saber si un cambio mejoró o empeoró el frame time:
contra el mercado en vivo no hay dos corridas comparables.

```
record.ts   se conecta a Binance y escribe el crudo a disco
replay.ts   reemite una ventana grabada en el mismo formato de cable
```

El cliente no distingue el replay del vivo: usa el mismo `BinanceFeedClient`, el
mismo parseo, y `resolveFeedUrl()` ya arma la URL. Sólo cambia el flag.

```
http://localhost:5173/?source=vps-replay&vps=ws://mi-vps:8080
```

---

## Uso

```bash
cd server
npm install

npm run record -- --dir /var/lib/borderbrawlers --symbols btcusdt --keep-days 14
npm run replay -- --dir /var/lib/borderbrawlers --port 8080

npm test        # formato + servidor de punta a punta, sin red
npm run sizing  # cuánto ocupa grabar, medido
npm run typecheck
```

### `record`

| flag | default | |
|---|---|---|
| `--dir` | `recordings` | dónde escribir |
| `--symbols` | `btcusdt` | lista separada por comas |
| `--host` | `wss://data-stream.binance.vision:443` | |
| `--keep-days` | `0` | borra lo más viejo. 0 = no borrar nunca |

Un archivo por hora UTC y por símbolo, comprimido al cerrarse:

```
btcusdt-2026-08-16T14.ndjson      la hora en curso
btcusdt-2026-08-16T13.ndjson.gz   ya cerrada
```

No reimplementa nada de la red: usa el mismo `BinanceFeedClient` del browser con
`ingest: false`, así que hereda el backoff con jitter, el límite de 300 intentos
por 5 minutos y la reconexión proactiva a las 24 h, que están cubiertos por
`npm test` en la raíz. Una segunda implementación de eso sería la que se
desincroniza y se descubre un martes a las 3 AM con seis horas de hueco.

### `replay`

```
ws://host:8080/replay/btcusdt?at=2026-08-16T14:32:00Z&window=60&speed=1&loop=1
```

| parámetro | default | |
|---|---|---|
| `at` | última ventana grabada | inicio. ISO 8601 o ms epoch |
| `window` | `60` | segundos, tope 900 |
| `speed` | `1` | 0,1 a 20 |
| `loop` | `1` | repetir al terminar |
| `gap` | `0` | ms de pausa entre repeticiones |

Sin `at` la ventana se mueve con el reloj. Para una medición que se pueda
repetir hay que pasarlo.

También responde `GET /health` y `GET /recordings/<symbol>`, que lista las horas
disponibles — es de dónde sacar el `at`.

---

## Cuánto ocupa

Medido, no estimado: `npm run sizing` corre una hora del generador sintético por
escenario, la codifica con el formato real y la comprime con el mismo gzip que
usa el grabador.

| escenario | trades/s | por día | comprimido | **por año** |
|---|---|---|---|---|
| calm | 3 | 0,95 GB | 0,24 GB | **87 GB** |
| normal | 54 | 1,86 GB | 0,36 GB | **131 GB** |
| volatile | 99 | 2,67 GB | 0,44 GB | **161 GB** |

**Un año no entra en el disco de 80 GB del VPS**, ni siquiera en el caso más
tranquilo. La estimación vieja del README (180 MB/día, "más de un año en 80 GB")
se quedaba corta por más del doble: la compresión real de este formato es 5x, no
las 8x que se habían supuesto.

El piso lo pone el libro, no los trades: `depth20@100ms` son ~1,1 KB diez veces
por segundo, o sea ~0,95 GB/día que se pagan igual aunque no se opere. Los
trades son lo que mueve el número entre 87 y 161 GB.

En la práctica no hace falta un año. Para perfilar alcanzan unos pocos minutos
interesantes, y `--keep-days 14` deja ~5 GB en disco de forma permanente. Si en
algún momento hace falta archivo largo, la salida es zstd en vez de gzip o
guardar sólo el stream de trades.

---

## Decisiones del formato

**Se guarda el texto original de Binance, byte por byte.**

```
{"t":1755357600123,"d":{"stream":"btcusdt@aggTrade","data":{...}}}
```

`t` es cuándo entró el frame; `d` es lo que mandó Binance sin tocar. Un
round-trip por `JSON.parse` + `JSON.stringify` normaliza orden de claves,
convierte `1.0` en `1` y come ceros a la derecha en las cantidades. Todo eso
llega distinto en el vivo, y el replay tiene que ser indistinguible del vivo o
no sirve para medir. Grabar cuesta entonces una concatenación de strings, y
leer no necesita parsear: hay un test que verifica justamente que un payload con
claves desordenadas y `1.0` sobrevive intacto, y que con JSON no sobreviviría.

**Una hora por archivo.** Es la granularidad más fina en la que todavía vale la
pena comprimir, y elegir "el minuto de las 14:32" no obliga a descomprimir un
día entero.

**La ventana se carga entera en RAM antes de emitir.** 60 s son ~1 MB. Es lo que
hace que el replay sea determinista de verdad —un hipo del disco no puede correr
un frame de lugar— y que repetir el bucle salga gratis. `MAX_FRAMES` es la red
de contención para que un `?window=` grande no se coma el VPS.

**El reloj de emisión no deriva.** Cada frame se agenda contra el instante de
pared del primer frame de la vuelta, no contra "cuándo salió el anterior".
Encadenar `setTimeout` desde el frame previo acumula el error de cada timer y a
los 60 s la grabación ya va corrida.

**Bajo contrapresión se descartan snapshots, nunca trades.** Un `depth20` es
idempotente por definición: perder uno no deja al cliente inconsistente, el
siguiente lo reemplaza entero. Cada trade, en cambio, es un personaje que sale
al escenario. El tipo de frame se calcula una vez al cargar, no por frame.

---

## Deploy

Vultr 2 vCPU / 4 GB / 80 GB, USD 20/mes. El grabador usa CPU despreciable; el
pico está en el gzip de cada hora, que corre encadenado y nunca en paralelo
justamente para no competir con la grabación.

```ini
# /etc/systemd/system/bb-record.service
[Unit]
Description=BorderBrawlers recorder
After=network-online.target

[Service]
Type=simple
User=borderbrawlers
WorkingDirectory=/opt/borderbrawlers/server
ExecStart=/usr/bin/npx tsx src/record.ts --dir /var/lib/borderbrawlers --symbols btcusdt --keep-days 14
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

El de replay es igual con `src/replay.ts --dir /var/lib/borderbrawlers --port 8080`.

### TLS

Una página servida por HTTPS **no puede abrir `ws://` a una IP pelada**: el
browser lo bloquea por mixed content. Para usar el replay desde el sitio
deployado hace falta `wss://`, o sea un dominio con certificado. Con Caddy son
tres líneas:

```
bb.midominio.com {
    reverse_proxy localhost:8080
}
```

Mientras se trabaje en `localhost:5173` esto no hace falta: una página HTTP sí
puede abrir `ws://`.

### Nota legal

El servidor de replay no debe quedar expuesto a terceros. Los términos de uso de
Binance licencian los datos para uso personal o interno y prohíben
retransmitirlos: una grabación reemitida es exactamente eso. Firewall a la IP
propia, o autenticación. Para uso personal, la exposición es baja; publicarlo no.
