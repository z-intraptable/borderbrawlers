/*
 * Smoke test de la IA con planificación (Fase 2 del pivot de 2026-08-23, ver
 * CLAUDE.md). `puntajeAccion` y `planear` son funciones puras -- sin match,
 * sin física, sin trades -- así que se prueban armando el `PlanContext` a
 * mano y comparando el resultado contra lo que se espera de un peleador que
 * razona bien: ataca cuando conviene, se guarda el super para rematar, no
 * se tira al vacío por retirarse, y siempre da la misma respuesta al mismo
 * estado (cero azar en la pelea, como el resto del proyecto).
 */
import {
  ACCION_ACERCAR,
  ACCION_ESPECIAL,
  ACCION_RETIRAR,
  ACCION_SOSTENER,
  ACCION_SUPER,
  COST_SKILL,
  COST_SUPER,
  planear,
  puntajeAccion,
} from '../src/game/fighters';
import type { PlanContext } from '../src/game/fighters';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; console.log(`  FAIL  ${name} ${detail}`); }
  else console.log(`  ok    ${name} ${detail}`);
}

const ALCANCE = 22;

/** Un contexto neutro, para no repetir los siete campos en cada caso. */
function ctx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    distancia: 3,
    energia: 0,
    alcance: ALCANCE,
    cercaDelBorde: false,
    dañoPropio: 0,
    dañoRival: 0,
    superEnfriando: false,
    ...over,
  };
}

console.log('\n== puntajeAccion: qué se puede y qué no ==');
{
  check('sin barra, la especial no se puede',
    puntajeAccion(ACCION_ESPECIAL, ctx({ energia: COST_SKILL - 0.01 })) === -Infinity);
  check('con la barra justa, sí',
    puntajeAccion(ACCION_ESPECIAL, ctx({ energia: COST_SKILL })) > -Infinity);
  check('fuera de alcance, la especial tampoco',
    puntajeAccion(ACCION_ESPECIAL, ctx({ energia: 1, distancia: ALCANCE + 1 })) === -Infinity);

  check('sin barra, el super no se puede',
    puntajeAccion(ACCION_SUPER, ctx({ energia: COST_SUPER - 0.01 })) === -Infinity);
  check('con la barra justa, sí',
    puntajeAccion(ACCION_SUPER, ctx({ energia: COST_SUPER })) > -Infinity);

  check('retirarse al borde del vacío no se puede',
    puntajeAccion(ACCION_RETIRAR, ctx({ cercaDelBorde: true })) === -Infinity);
  check('retirarse con piso atrás sí se puede',
    puntajeAccion(ACCION_RETIRAR, ctx({ cercaDelBorde: false })) > -Infinity);

  check('acercarse y sostener siempre se pueden',
    puntajeAccion(ACCION_ACERCAR, ctx()) > -Infinity
    && puntajeAccion(ACCION_SOSTENER, ctx()) > -Infinity);

  // Sin esto medido con mercado agitado sintético: 0 especiales en 20
  // partidos enteros, porque la barra se recarga tan rápido que el super
  // siempre gana apenas puede -- ver `superEnfriando` en fighters.ts.
  check('con barra llena pero enfriando, el super no se puede',
    puntajeAccion(ACCION_SUPER, ctx({ energia: 1, superEnfriando: true })) === -Infinity);
}

console.log('\n== puntajeAccion: qué conviene más ==');
{
  check('con la barra llena, la especial puntúa más que a la mitad',
    puntajeAccion(ACCION_ESPECIAL, ctx({ energia: 1 }))
    > puntajeAccion(ACCION_ESPECIAL, ctx({ energia: COST_SKILL })));

  check('el super puntúa más contra un rival ya golpeado',
    puntajeAccion(ACCION_SUPER, ctx({ energia: 1, dañoRival: 150 }))
    > puntajeAccion(ACCION_SUPER, ctx({ energia: 1, dañoRival: 0 })));

  check('retirarse conviene más cuanto más daño propio acumulado',
    puntajeAccion(ACCION_RETIRAR, ctx({ dañoPropio: 150, dañoRival: 20 }))
    > puntajeAccion(ACCION_RETIRAR, ctx({ dañoPropio: 20, dañoRival: 20 })));
}

console.log('\n== planear: el árbol completo ==');
{
  // Ninguno tiene barra: no hay nada mejor que acercarse.
  check('sin barra de ninguno de los dos, acerca',
    planear(ctx(), ctx()) === ACCION_ACERCAR);

  // Barra que alcanza para la especial pero no para el super: no hay otra
  // mejor que ésa.
  check('con barra sólo para la especial, la tira',
    planear(ctx({ energia: COST_SKILL }), ctx({ energia: 0 })) === ACCION_ESPECIAL);

  // Barra llena, pero el super todavía enfriando: vuelve a valer la
  // especial. Es la regresión real que motivó `superEnfriando`.
  check('con barra llena y el super enfriando, tira la especial en vez de esperar',
    planear(ctx({ energia: 1, superEnfriando: true }), ctx({ energia: 0 })) === ACCION_ESPECIAL);

  // Las dos barras llenas: la especial expone, y el rival puede contestar
  // con la suya -- el 1-ply tiene que notarlo y no siempre elegir especial.
  {
    const propio = ctx({ energia: 1 });
    const rival = ctx({ energia: 1 });
    const elegido = planear(propio, rival);
    check('con las dos barras llenas, la respuesta del rival pesa en la cuenta',
      puntajeAccion(elegido, propio)
        - (elegido === ACCION_ESPECIAL || elegido === ACCION_SUPER
          ? Math.max(puntajeAccion(ACCION_ESPECIAL, rival), puntajeAccion(ACCION_SUPER, rival)) * 0.3
          : 0)
      >= puntajeAccion(ACCION_ACERCAR, propio),
      `eligió ${elegido}`);
  }

  // Super listo: puntúa más que la especial sola, así que gana.
  check('con el super listo, lo prefiere a la especial',
    planear(ctx({ energia: 1 }), ctx()) === ACCION_SUPER);

  // Al borde del vacío no se retira aunque el daño diga que convendría.
  check('acumulado alto pero al borde del vacío: no se tira',
    planear(ctx({ dañoPropio: 300, dañoRival: 0, cercaDelBorde: true }), ctx())
    !== ACCION_RETIRAR);

  // Determinismo: mismo estado, misma decisión, siempre.
  const a = planear(ctx({ energia: 0.7, dañoPropio: 40 }), ctx({ energia: 0.2 }));
  const b = planear(ctx({ energia: 0.7, dañoPropio: 40 }), ctx({ energia: 0.2 }));
  check('el mismo estado da siempre la misma decisión', a === b, `${a} === ${b}`);
}

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
