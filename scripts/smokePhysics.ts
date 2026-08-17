/* Smoke test del controlador de personaje. Lógica pura: sin Pixi, sin browser. */
import {
  GRAVITY,
  MAX_FALL_SPEED,
  SNAP_DOWN,
  SNAP_UP,
  createMoveResult,
  platformAt,
  step,
} from '../src/game/physics';
import { createSkyline } from '../src/game/fighters';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) { failures++; console.log(`  FAIL  ${name} ${detail}`); }
  else console.log(`  ok    ${name} ${detail}`);
}

/**
 * Dos plataformas con un hueco, y una más arriba:
 *
 *                       [-1, 1] alto 3
 *   [-6,-2] alto 0    POZO    [2, 6] alto 0
 */
const sky = createSkyline(3);
sky.minX[0] = -6; sky.maxX[0] = -2; sky.topY[0] = 0;
sky.minX[1] = 2;  sky.maxX[1] = 6;  sky.topY[1] = 0;
sky.minX[2] = -1; sky.maxX[2] = 1;  sky.topY[2] = 3;

const HW = 0.3;
const HH = 0.5;
const DT = 1 / 60;
const out = createMoveResult();

console.log('\n== qué plataforma pisa ==');
{
  check('la de abajo a la izquierda', platformAt(sky, -4, HW, 0, 0.1) === 0);
  check('sobre el pozo, ninguna', platformAt(sky, 0, HW, 0, 0.1) === -1);
  check('la de arriba, si está a su altura', platformAt(sky, 0, HW, 3, 0.1) === 2);
  check('parado arriba, NO agarra la de abajo aunque se solape en x',
    platformAt(sky, 0, HW, 3, 0.1) !== 0);
  // El personaje es más ancho que un punto: al borde toca la plataforma aunque
  // su centro esté sobre el vacío.
  check('el borde cuenta: medio cuerpo afuera todavía pisa',
    platformAt(sky, -1.9, HW, 0, 0.1) === 0);
  check('con el cuerpo entero afuera ya no', platformAt(sky, -1.5, HW, 0, 0.1) === -1);
}

console.log('\n== caída y aterrizaje ==');
{
  // Cayendo desde 5 sobre la plataforma de la izquierda.
  let x = -4, y = 5, vx = 0, vy = 0, grounded = false;
  let steps = 0;
  while (!grounded && steps < 600) {
    step(sky, x, y, vx, vy, HW, HH, grounded, DT, out);
    ({ x, y, vx, vy, grounded } = out);
    steps++;
  }
  check('termina aterrizando', grounded, `${steps} pasos`);
  check('los pies quedan EXACTAMENTE sobre el tope', Math.abs(y - HH - 0) < 1e-9, (y - HH).toFixed(9));
  check('la velocidad vertical se anula', vy === 0);
  check('el primer paso en el piso avisa `landed`', out.landed);

  // Un paso más ya no es aterrizaje nuevo.
  step(sky, x, y, vx, vy, HW, HH, grounded, DT, out);
  check('el paso siguiente ya no avisa', !out.landed);
  check('y sigue parado', out.grounded);
}

console.log('\n== no atraviesa a alta velocidad ==');
{
  // Cayendo a la máxima velocidad, desde justo encima: en un frame recorre
  // MAX_FALL_SPEED/60 ≈ 0,43 unidades, mucho más que el grosor de una losa.
  const y0 = 0 + HH + 0.4;
  step(sky, -4, y0, 0, -MAX_FALL_SPEED, HW, HH, false, DT, out);
  check('la detecta por cruce, no por posición final', out.grounded);
  check('y la deja apoyada arriba, no adentro', Math.abs(out.y - HH) < 1e-9);
}

console.log('\n== plataformas de una vía ==');
{
  // Subiendo por debajo de la plataforma alta: tiene que atravesarla.
  step(sky, 0, 2.0, 0, 12, HW, HH, false, DT, out);
  check('subiendo la atraviesa', !out.grounded, `y=${out.y.toFixed(2)}`);
  check('y no le corta el salto', out.vy > 0);

  // La misma plataforma, cayendo sobre ella: tiene que frenarlo.
  step(sky, 0, 3 + HH + 0.05, 0, -4, HW, HH, false, DT, out);
  check('cayendo la pisa', out.grounded && out.platform === 2);
}

console.log('\n== caminar hasta el borde ==');
{
  // Parado en el borde derecho de la plataforma izquierda, caminando al vacío.
  let x = -2.2, y = HH, vx = 4, vy = 0, grounded = true;
  let fellAfter = -1;
  for (let i = 0; i < 40; i++) {
    step(sky, x, y, vx, vy, HW, HH, grounded, DT, out);
    ({ x, y, vx, vy, grounded } = out);
    if (!grounded && fellAfter < 0) fellAfter = i;
  }
  check('se cae al pasarse del borde', fellAfter >= 0, `a los ${fellAfter} pasos`);
  check('y sigue cayendo, no se queda flotando', y < 0, y.toFixed(2));
}

console.log('\n== plataforma que se mueve ==');
{
  // Parado sobre la plataforma 0 mientras sube: tiene que subir con ella.
  let x = -4, y = HH, vx = 0, vy = 0, grounded = true;
  for (let i = 0; i < 30; i++) {
    sky.topY[0] += 0.03; // ~1,8 unidades por segundo, dentro del tope del escenario
    step(sky, x, y, vx, vy, HW, HH, grounded, DT, out);
    ({ x, y, vx, vy, grounded } = out);
  }
  check('la plataforma que sube lo levanta', grounded, `y=${y.toFixed(2)}`);
  check('y queda apoyado sobre ella, no hundido',
    Math.abs(y - HH - sky.topY[0]) < 1e-6, (y - HH - sky.topY[0]).toFixed(6));

  // Ahora baja.
  for (let i = 0; i < 30; i++) {
    sky.topY[0] -= 0.03;
    step(sky, x, y, vx, vy, HW, HH, grounded, DT, out);
    ({ x, y, vx, vy, grounded } = out);
  }
  check('la plataforma que baja no lo deja flotando', grounded);
  check('y lo sigue teniendo apoyado',
    Math.abs(y - HH - sky.topY[0]) < 1e-6, (y - HH - sky.topY[0]).toFixed(6));

  sky.topY[0] = 0;
}

console.log('\n== límites del pegado al piso ==');
{
  // Un escalón más alto que SNAP_UP no se sube caminando: hay que saltar.
  sky.topY[1] = SNAP_UP + 0.3;
  step(sky, 2.5, HH, 6, 0, HW, HH, true, DT, out);
  check('un escalón más alto que el tope de pegado no se sube caminando',
    !out.grounded || Math.abs(out.y - HH - sky.topY[1]) > 1e-6, `y=${out.y.toFixed(2)}`);
  sky.topY[1] = 0;

  // Una bajada dentro de SNAP_DOWN sí se sigue.
  sky.topY[1] = -SNAP_DOWN * 0.5;
  step(sky, 4, HH, 2, 0, HW, HH, true, DT, out);
  check('una bajada chica se sigue sin despegarse', out.grounded);
  sky.topY[1] = 0;
}

console.log('\n== gravedad ==');
{
  step(sky, 0, 20, 0, 0, HW, HH, false, DT, out);
  check('la gravedad tira para abajo', out.vy < 0, out.vy.toFixed(3));
  check('y es la constante declarada', Math.abs(out.vy - GRAVITY * DT) < 1e-9);

  let vy = 0;
  for (let i = 0; i < 600; i++) {
    step(sky, 0, 5000, 0, vy, HW, HH, false, DT, out);
    vy = out.vy;
  }
  check('la caída tiene tope', Math.abs(vy) <= MAX_FALL_SPEED + 1e-9, vy.toFixed(2));
}

console.log(failures === 0 ? '\nTODO OK\n' : `\n${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
