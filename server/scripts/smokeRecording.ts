/* Smoke test del formato de grabación y del lector de ventanas. Sin red. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  HOUR_MS,
  decodeFrame,
  encodeFrame,
  fileNameFor,
  hourKey,
  hourStartMs,
  hoursCovering,
  listRecordings,
  loadWindow,
  parseFileName,
} from '../src/recording';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; console.log(`  FAIL  ${name} ${detail}`); }
  else console.log(`  ok    ${name} ${detail}`);
}

const T0 = Date.parse('2026-08-16T14:00:00.000Z');

const DEPTH = '{"stream":"btcusdt@depth20@100ms","data":{"lastUpdateId":42,"bids":[["61234.56","1.5"]],"asks":[["61234.57","2.0"]]}}';
const TRADE = '{"stream":"btcusdt@aggTrade","data":{"e":"aggTrade","E":1,"s":"BTCUSDT","a":7,"p":"61234.56","q":"0.5","f":1,"l":2,"T":1,"m":true,"M":true}}';

console.log('\n== ida y vuelta del formato ==');
{
  const line = encodeFrame(T0, DEPTH);
  check('la línea termina en \\n', line.endsWith('\n'));
  const back = decodeFrame(line.trimEnd());
  check('el timestamp vuelve intacto', back?.t === T0, String(back?.t));
  check('el payload vuelve BYTE POR BYTE', back?.payload === DEPTH);
  check('un depth no se marca como trade', back?.trade === false);

  const trade = decodeFrame(encodeFrame(T0, TRADE).trimEnd());
  check('un aggTrade sí se marca', trade?.trade === true);
  check('el payload del trade vuelve intacto', trade?.payload === TRADE);
}

console.log('\n== el crudo no se normaliza ==');
{
  // Esto es el punto entero del formato: un round-trip por JSON.parse +
  // JSON.stringify reordena claves y come el `.0`, y entonces el replay ya no
  // es lo mismo que llegó del vivo.
  const raro = '{"stream":"x","data":{"z":1,"a":1.0,"e":"aggTrade","q":"0.50000000"}}';
  const back = decodeFrame(encodeFrame(T0, raro).trimEnd());
  check('orden de claves, 1.0 y ceros a la derecha sobreviven', back?.payload === raro);
  check('y NO sobrevivirían con un round-trip por JSON',
    JSON.stringify(JSON.parse(raro)) !== raro);
}

console.log('\n== líneas corruptas no voltean el lector ==');
{
  for (const bad of ['', 'basura', '{"t":}', '{"t":123', '{"t":123,"d":', '{"t":abc,"d":{}}', '{"x":1,"d":{}}']) {
    check(`rechaza ${JSON.stringify(bad).slice(0, 24)}`, decodeFrame(bad) === null);
  }
  // Una grabación cortada por un apagón termina justo así.
  check('rechaza una línea trunca a la mitad', decodeFrame(encodeFrame(T0, DEPTH).slice(0, 40)) === null);
}

console.log('\n== nombres de archivo y horas ==');
{
  check('hourKey es la hora UTC', hourKey(T0) === '2026-08-16T14', hourKey(T0));
  check('hourStartMs trunca a la hora', hourStartMs(T0 + 1234) === T0);
  const name = fileNameFor('BTCUSDT', T0 + 999);
  check('el nombre lleva el símbolo en minúsculas', name === 'btcusdt-2026-08-16T14.ndjson', name);
  const parsed = parseFileName(name);
  check('parseFileName es la inversa', parsed?.symbol === 'btcusdt' && parsed.hourMs === T0 && !parsed.gzip);
  const gz = parseFileName(fileNameFor('btcusdt', T0, true));
  check('reconoce el .gz', gz?.gzip === true && gz.hourMs === T0);
  check('un símbolo con guiones no confunde al parser',
    parseFileName('btc-perp-2026-08-16T14.ndjson')?.symbol === 'btc-perp');
  for (const bad of ['otracosa.txt', 'btcusdt.ndjson', 'btcusdt-2026-13.ndjson', '-2026-08-16T14.ndjson']) {
    check(`rechaza el nombre ${bad}`, parseFileName(bad) === null);
  }
}

console.log('\n== horas que cubre una ventana ==');
{
  check('una ventana dentro de una hora da una hora', hoursCovering(T0 + 60_000, T0 + 120_000).length === 1);
  check('una ventana que cruza el cambio de hora da dos',
    hoursCovering(T0 + HOUR_MS - 1000, T0 + HOUR_MS + 1000).length === 2);
  check('tres horas dan tres', hoursCovering(T0, T0 + 2 * HOUR_MS).length === 3);
  check('un rango invertido da vacío', hoursCovering(T0 + 1000, T0).length === 0);
}

/* ------------------------- lectura en disco ------------------------- */

const dir = await mkdtemp(join(tmpdir(), 'bb-rec-'));
try {
  // Hora 14 en texto plano, hora 15 comprimida: el lector tiene que dar lo
  // mismo en los dos casos y coserlas en una sola línea de tiempo.
  const hour14 = [
    encodeFrame(T0 + 0, DEPTH),
    encodeFrame(T0 + 100, TRADE),
    encodeFrame(T0 + 200, DEPTH),
    'línea basura del apagón\n',
    encodeFrame(T0 + 300, TRADE),
  ].join('');
  await writeFile(join(dir, fileNameFor('btcusdt', T0)), hour14);

  const hour15 = [encodeFrame(T0 + HOUR_MS + 50, DEPTH), encodeFrame(T0 + HOUR_MS + 150, TRADE)].join('');
  await writeFile(join(dir, fileNameFor('btcusdt', T0 + HOUR_MS, true)), gzipSync(hour15));

  // Otro símbolo, para confirmar que no se cruzan.
  await writeFile(join(dir, fileNameFor('ethusdt', T0)), encodeFrame(T0 + 10, DEPTH));

  console.log('\n== inventario ==');
  {
    const files = await listRecordings(dir, 'btcusdt');
    check('encuentra las dos horas del símbolo', files.length === 2, String(files.length));
    check('ordenadas de más vieja a más nueva', files[0].hourMs < files[1].hourMs);
    check('no mezcla otros símbolos', (await listRecordings(dir, 'ethusdt')).length === 1);
    check('un símbolo sin grabar da vacío', (await listRecordings(dir, 'solusdt')).length === 0);
    check('un directorio inexistente da vacío, no explota',
      (await listRecordings(join(dir, 'no-existe'), 'btcusdt')).length === 0);
  }

  console.log('\n== carga de una ventana ==');
  {
    const all = await loadWindow(dir, 'btcusdt', T0, T0 + 400, 1000);
    check('lee los 4 frames buenos', all.frames.length === 4, String(all.frames.length));
    check('y cuenta la línea corrupta como salteada', all.skipped === 1, String(all.skipped));
    check('en orden de tiempo', all.frames.every((f, i) => i === 0 || f.t >= all.frames[i - 1].t));
    check('con el payload intacto', all.frames[0].payload === DEPTH);
    check('marcando los trades', all.frames.map((f) => f.trade).join() === 'false,true,false,true');

    const half = await loadWindow(dir, 'btcusdt', T0 + 100, T0 + 300, 1000);
    check('el borde inferior es inclusivo y el superior exclusivo',
      half.frames.length === 2 && half.frames[0].t === T0 + 100, String(half.frames.length));

    const gz = await loadWindow(dir, 'btcusdt', T0 + HOUR_MS, T0 + HOUR_MS + 1000, 1000);
    check('lee la hora comprimida igual que la de texto', gz.frames.length === 2, String(gz.frames.length));
    check('el payload del .gz también vuelve intacto', gz.frames[0].payload === DEPTH);

    const across = await loadWindow(dir, 'btcusdt', T0 + 200, T0 + HOUR_MS + 100, 1000);
    check('cose texto plano y .gz en una sola línea de tiempo',
      across.frames.length === 3, String(across.frames.length));
    check('sin desordenar el tiempo al cambiar de archivo',
      across.frames.every((f, i) => i === 0 || f.t >= across.frames[i - 1].t));

    const capped = await loadWindow(dir, 'btcusdt', T0, T0 + 400, 2);
    check('maxFrames corta y lo dice', capped.frames.length === 2 && capped.truncated);

    const empty = await loadWindow(dir, 'btcusdt', T0 - HOUR_MS, T0 - 1, 1000);
    check('una ventana sin grabación da vacío sin tirar', empty.frames.length === 0 && !empty.truncated);
  }

  console.log('\n== determinismo ==');
  {
    // Es la razón de ser del replay: dos corridas de la misma ventana tienen
    // que dar exactamente la misma secuencia, o no se puede medir si un cambio
    // mejoró o empeoró nada.
    const a = await loadWindow(dir, 'btcusdt', T0, T0 + HOUR_MS + 200, 1000);
    const b = await loadWindow(dir, 'btcusdt', T0, T0 + HOUR_MS + 200, 1000);
    check('dos cargas de la misma ventana son idénticas',
      JSON.stringify(a.frames) === JSON.stringify(b.frames), `${a.frames.length} frames`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
