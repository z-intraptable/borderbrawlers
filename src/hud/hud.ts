import type { FeedStats } from '../net/feedCore';
import type { MatchState } from '../game/fighters';
import { GROWTH_MAX_STAGE, TEAM_GREEN, TEAM_RED } from '../game/fighters';
import { FIGHTERS_PER_TEAM } from '../game/match';

/**
 * El marcador y la barra de mercado, en DOM plano.
 *
 * Sin framework: son unos pocos nodos que se escriben por referencia cada 250
 * ms. Los datos viven en objetos mutables que la simulación escribe cada frame,
 * y el HUD los MUESTREA — no se suscribe. El productor no sabe que el HUD
 * existe, que es lo que mantiene el camino de datos de mercado libre de trabajo
 * de interfaz.
 */

const BULL = '#00FF66';
const BEAR = '#FF0055';
const GOLD = '#FFD700';
const DIM = '#6b7585';
const REFRESH_MS = 250;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/**
 * Dónde está parada cada hoguera, en fracción del ancho de pantalla.
 *
 * Sale de `backdrop.ts`, que las pone en `width * 0.16` y `width * 0.84`. El
 * marcador se para en los mismos dos puntos a propósito: el bando no es una
 * caja al lado de otra, es el número apoyado sobre SU fuego. Si alguna vez se
 * mueven las hogueras, estos dos números se mueven con ellas.
 */
const HOGUERA_VERDE = 0.16;
const HOGUERA_ROJA = 0.84;

/**
 * El toro y el oso, dibujados en línea.
 *
 * Van como SVG y no como emoji porque un emoji lo pinta el sistema operativo:
 * cambia de forma entre Android, iOS y Windows, y no se puede teñir del color
 * del bando ni hacerle un resplandor. Estos heredan `currentColor`.
 */
const TORO = '<svg viewBox="0 0 24 24" width="1.5em" height="1.5em" aria-hidden="true">'
  + '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"'
  + ' d="M4 3.5C2.6 8 3.4 11 7 11.8M20 3.5C21.4 8 20.6 11 17 11.8"/>'
  + '<path fill="currentColor" d="M7.4 9.6h9.2a2.6 2.6 0 0 1 2.6 2.6v1.6A7.2 7.2 0 0 1 12 21'
  + 'a7.2 7.2 0 0 1-7.2-7.2v-1.6a2.6 2.6 0 0 1 2.6-2.6z"/>'
  + '<circle cx="9.6" cy="16.4" r="1" fill="#05070d"/>'
  + '<circle cx="14.4" cy="16.4" r="1" fill="#05070d"/></svg>';

const OSO = '<svg viewBox="0 0 24 24" width="1.5em" height="1.5em" aria-hidden="true">'
  + '<circle cx="5.6" cy="6" r="3.4" fill="currentColor"/>'
  + '<circle cx="18.4" cy="6" r="3.4" fill="currentColor"/>'
  + '<circle cx="12" cy="13.6" r="7.6" fill="currentColor"/>'
  + '<ellipse cx="12" cy="17" rx="3.2" ry="2.4" fill="#05070d" opacity=".55"/>'
  + '<circle cx="9.4" cy="12" r="1" fill="#05070d"/>'
  + '<circle cx="14.6" cy="12" r="1" fill="#05070d"/></svg>';

/**
 * El resplandor del icono cuando el bando anota.
 *
 * Va en una hoja de estilo y no en `style.transform` frame a frame porque es
 * una animación de interfaz: el navegador la corre en su compositor y no gasta
 * nada del presupuesto del juego, que es lo que el HUD tiene que respetar.
 */
const ANIMACION = '@keyframes bbAnota{'
  + '0%{transform:scale(1)}'
  + '18%{transform:scale(1.45)}'
  + '100%{transform:scale(1)}}'
  + '.bb-anota{animation:bbAnota .55s cubic-bezier(.2,.9,.3,1)}'
  + '@keyframes bbGana{'
  + '0%{transform:scale(2.1);opacity:0;letter-spacing:.5em}'
  + '55%{transform:scale(.94);opacity:1;letter-spacing:.12em}'
  + '100%{transform:scale(1);opacity:1;letter-spacing:.16em}}'
  + '.bb-gana{animation:bbGana .7s cubic-bezier(.16,1,.3,1) both}'
  + '@media (prefers-reduced-motion:reduce){.bb-anota{animation:none}}';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  css: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface HudHandle {
  destroy(): void;
  setStatus(status: string): void;
}

export function mountHud(
  host: HTMLElement,
  stats: FeedStats,
  match: MatchState,
  symbol: string,
  source: string,
  perf: { frameMs: number },
): HudHandle {
  /* --- barra de mercado, arriba a la izquierda --------------------- */
  // Las medidas van con `clamp` y no fijas: en un teléfono de 390 px de ancho,
  // ocho datos a 12 px con separación de 14 se salen de la pantalla, y los dos
  // paneles de 220 px no entran uno al lado del otro. Con `clamp` la misma
  // barra se achica sola sin una segunda hoja de estilos ni un media query, y
  // en pantalla grande queda exactamente como estaba.
  const bar = el('div',
    'position:absolute;top:10px;left:10px;right:10px;display:flex;align-items:center;' +
    'flex-wrap:wrap;gap:clamp(6px,1.8vw,14px);width:fit-content;max-width:calc(100% - 20px);' +
    'padding:clamp(5px,1.5vw,8px) clamp(8px,2vw,12px);border-radius:8px;' +
    'background:rgba(11,15,25,.75);' +
    `border:1px solid #263041;font:clamp(9px,2.4vw,12px)/1.4 ${MONO};` +
    'color:#e6edf3;user-select:none');

  const title = el('strong', 'letter-spacing:2px');
  title.innerHTML = `<span style="color:${BULL}">BORDER</span><span style="color:${BEAR}">BRAWLERS</span>`;
  const symbolNode = el('span', `color:${DIM}`, symbol.toUpperCase());
  const price = el('span', 'font-variant-numeric:tabular-nums', '—');
  const status = el('span', `color:${GOLD}`, '● connecting');
  const sourceNode = el('span', `color:${DIM}`, source);
  const trades = el('span', `color:${DIM}`, '0 trades');
  const whales = el('span', `color:${GOLD}`, '0 🐋');
  const fps = el('span', `color:${DIM}`, '—');
  bar.append(title, symbolNode, price, status, sourceNode, trades, whales, fps);

  /* --- marcador, cada bando sobre su hoguera ------------------------ */
  // Sin contenedor: ni caja, ni borde, ni fondo. Lo que hacía falta para que se
  // leyera igual es CONTORNO en el texto, no una caja atrás — y así el fuego de
  // abajo queda a la vista en vez de tapado por un rectángulo.
  const estilo = document.createElement('style');
  estilo.textContent = ANIMACION;
  document.head.append(estilo);

  const CONTORNO = '0 2px 0 #05070d,0 -1px 0 #05070d,1px 0 0 #05070d,-1px 0 0 #05070d';

  /**
   * El título del final. Uno solo, que cambia de texto y de color.
   *
   * Va en el HUD y no dibujado en el escenario porque tiene que leerse igual con
   * cualquier zoom de cámara y en cualquier pantalla; un texto en coordenadas de
   * mundo se achica con la cámara justo cuando más grande tiene que estar.
   */
  const titulo = el('div',
    'position:absolute;left:0;right:0;top:26%;display:none;text-align:center;' +
    'pointer-events:none;user-select:none;' +
    `font:900 clamp(30px,10vw,104px)/1 ${MONO};` +
    'text-shadow:0 4px 0 #05070d,0 0 40px currentColor');

  const panels = [TEAM_GREEN, TEAM_RED].map((team) => {
    const verde = team === TEAM_GREEN;
    const color = verde ? BULL : BEAR;
    // Dos cosas que sólo se vieron con el juego andando y la primera versión
    // puesta: el marcador queda ADENTRO de la hoguera, y ahí el verde sobre
    // verde no se lee. Entonces sube por encima de la punta de las llamas —que
    // miden 0,22 del alto de pantalla— y se apoya en un halo oscuro difuso.
    //
    // El halo no es un contenedor: no tiene borde, ni esquina, ni un lado donde
    // termine. Es sombra. Una caja atrás del texto es justo lo que se sacó.
    const panel = el('div',
      `position:absolute;bottom:clamp(58px,16vh,140px);` +
      `left:${(verde ? HOGUERA_VERDE : HOGUERA_ROJA) * 100}%;transform:translateX(-50%);` +
      'display:flex;flex-direction:column;align-items:center;gap:3px;' +
      'padding:clamp(8px,2vw,16px) clamp(14px,4vw,30px);' +
      'background:radial-gradient(closest-side ellipse at 50% 50%,' +
      'rgba(5,7,13,.82),rgba(5,7,13,.55) 55%,rgba(5,7,13,0) 100%);' +
      `font:clamp(10px,2.6vw,13px)/1.2 ${MONO};color:#e6edf3;text-align:center;` +
      'pointer-events:none;user-select:none;white-space:nowrap');

    const head = el('div', 'display:flex;align-items:center;gap:clamp(4px,1.2vw,8px);' +
      `color:${color};filter:drop-shadow(0 0 10px ${color}aa)`);
    const icono = el('span', 'display:flex;transform-origin:50% 60%;font-size:1.35em');
    icono.innerHTML = verde ? TORO : OSO;
    const label = el('strong',
      `letter-spacing:clamp(2px,.9vw,6px);font-size:clamp(14px,3.6vw,21px);` +
      `text-shadow:${CONTORNO}`, verde ? 'BULLS' : 'BEARS');
    // El toro mira a la pelea desde la izquierda y el oso desde la derecha, así
    // que el icono va del lado de afuera en cada bando.
    head.append(...(verde ? [icono, label] : [label, icono]));

    const damage = el('div',
      `font:700 clamp(32px,9.5vw,58px)/1 ${MONO};color:${color};` +
      `text-shadow:${CONTORNO},0 0 26px ${color};` +
      'font-variant-numeric:tabular-nums', '0%');

    const kos = el('div',
      `color:#9fb0c4;letter-spacing:2px;text-shadow:${CONTORNO}`, '0 KO');

    const lives = el('div', 'display:flex;gap:5px;margin-top:2px');
    const dots: HTMLElement[] = [];
    for (let i = 0; i < FIGHTERS_PER_TEAM; i++) {
      const dot = el('span',
        'width:clamp(9px,2.4vw,13px);height:clamp(9px,2.4vw,13px);border-radius:50%;' +
        'background:#1b2331;outline:2px solid #05070d');
      dots.push(dot);
      lives.append(dot);
    }

    const charge = el('div', 'display:flex;gap:3px');
    const pips: HTMLElement[] = [];
    for (let i = 0; i < GROWTH_MAX_STAGE; i++) {
      const pip = el('span', 'width:13px;height:4px;border-radius:2px;background:#263041');
      pips.push(pip);
      charge.append(pip);
    }

    // La barra de ULTRA sin su cajita: una línea que se llena. El texto de al
    // lado dice de quién es el turno, porque el ciclo por turnos sólo sirve si
    // se puede anticipar.
    const ultraWrap = el('div',
      'display:flex;align-items:center;gap:6px;margin-top:3px;width:clamp(96px,22vw,150px)');
    const ultraTag = el('span',
      `color:#9fb0c4;letter-spacing:1px;font-size:clamp(9px,2.2vw,11px);` +
      `text-shadow:${CONTORNO}`, 'ULTRA 1/3');
    const ultraTrack = el('div',
      'flex:1;height:4px;border-radius:3px;background:#26304199;' +
      'outline:1px solid #05070d99;overflow:hidden');
    const ultraFill = el('div',
      `width:0%;height:100%;background:${GOLD};transition:width .12s linear`);
    ultraTrack.append(ultraFill);
    ultraWrap.append(ultraTag, ultraTrack);

    panel.append(head, damage, kos, lives, charge, ultraWrap);
    host.append(panel);
    return { team, color, panel, icono, kos, damage, dots, pips, ultraFill, ultraTag, anotados: 0 };
  });

  host.append(bar, titulo);

  /** Qué título está puesto, para no reiniciar la animación en cada refresco. */
  let mostrando = -1;

  const timer = window.setInterval(() => {
    price.textContent = stats.mid > 0 ? stats.mid.toFixed(2) : '—';
    trades.textContent = `${stats.trades} trades`;
    whales.textContent = `${stats.whales} 🐋`;
    fps.textContent = `${perf.frameMs.toFixed(1)} ms`;
    fps.style.color = perf.frameMs <= 16.6 ? BULL : BEAR;

    for (const p of panels) {
      // `kos[equipo]` cuenta los que ESE bando volteó, así que subir es anotar.
      // Se mira por muestreo y no por evento a propósito: el HUD no se suscribe
      // a la simulación, y a 250 ms no hay forma de que entren dos KO en la
      // misma lectura sin que uno de los dos sea del ciclo siguiente.
      const anotados = match.kos[p.team];
      if (anotados > p.anotados) {
        p.anotados = anotados;
        p.icono.classList.remove('bb-anota');
        // Leer una propiedad de layout fuerza el reflow; sin esto el navegador
        // junta el quitar y el poner en un solo cambio y la animación no
        // arranca de nuevo cuando se anota dos veces seguidas.
        void p.icono.offsetWidth;
        p.icono.classList.add('bb-anota');
      }
      p.kos.textContent = `${anotados} KO`;
      p.damage.textContent = `${Math.round(match.damage[p.team])}%`;
      // Los puntitos son el PLANTEL, no los que están parados en el escenario:
      // en torneo hay uno solo peleando y los otros dos esperan su turno, así
      // que `alive` diría siempre 1 y el marcador no contaría nada.
      const quedan = match.plantel[p.team];
      p.dots.forEach((dot, i) => {
        dot.style.background = i < quedan ? p.color : '#1b2331';
        dot.style.boxShadow = i < quedan ? `0 0 8px ${p.color}` : 'none';
      });
      const stage = match.charge[p.team];
      p.pips.forEach((pip, i) => {
        pip.style.background = i < stage ? GOLD : '#263041';
        pip.style.boxShadow = i < stage ? `0 0 8px ${GOLD}` : 'none';
      });

      const ultra = match.ultra[p.team];
      p.ultraFill.style.width = `${Math.round(ultra * 100)}%`;
      // Llena, brilla: es el aviso de que el super sale en cualquier momento.
      p.ultraFill.style.boxShadow = ultra >= 1 ? `0 0 12px ${GOLD}` : 'none';
      p.ultraTag.textContent = `ULTRA ${match.ultraTurn[p.team] + 1}/${FIGHTERS_PER_TEAM}`;
      p.ultraTag.style.color = ultra >= 1 ? GOLD : DIM;
    }

    if (match.ganador !== mostrando) {
      mostrando = match.ganador;
      if (mostrando < 0) {
        titulo.style.display = 'none';
        titulo.classList.remove('bb-gana');
      } else {
        const verde = mostrando === TEAM_GREEN;
        titulo.textContent = verde ? 'BULLS WINS' : 'BEARS WINS';
        titulo.style.color = verde ? BULL : BEAR;
        titulo.style.display = 'block';
        titulo.classList.remove('bb-gana');
        void titulo.offsetWidth;
        titulo.classList.add('bb-gana');
      }
    }
  }, REFRESH_MS);

  return {
    destroy(): void {
      window.clearInterval(timer);
      bar.remove();
      estilo.remove();
      titulo.remove();
      for (const p of panels) p.panel.remove();
    },
    setStatus(next: string): void {
      status.textContent = `● ${next}`;
      status.style.color = next === 'live' ? BULL : next === 'error' ? BEAR : GOLD;
    },
  };
}
