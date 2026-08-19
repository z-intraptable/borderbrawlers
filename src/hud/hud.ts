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
 *
 * **Arriba el marcador, abajo el mercado.** Estaban al revés: el cartel del
 * ticker ocupaba el borde de arriba —que es el lugar que en un juego de pelea
 * pertenece a los dos bandos— y el marcador quedaba en la mitad de abajo, justo
 * donde pasa la pelea. Mortal Kombat, Tekken y Street Fighter ponen las barras
 * enfrentadas en el borde superior por una razón que se comprueba mirando: es
 * el único lugar de la pantalla donde nunca hay acción, así que se puede leer
 * sin dejar de mirar el combate.
 */

const BULL = '#00FF66';
const BEAR = '#FF0055';
const GOLD = '#FFD700';
const DIM = '#6b7585';
const REFRESH_MS = 250;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/** El contorno negro que hace legible un texto sin caja atrás. */
const CONTORNO = '0 2px 0 #05070d,0 -1px 0 #05070d,1px 0 0 #05070d,-1px 0 0 #05070d';

/**
 * A cuánto daño se considera vacía la barra.
 *
 * El daño de Smash no tiene techo —es un multiplicador de empuje, no una vida—
 * así que una barra necesita un tope elegido. A 200 la barra se vacía justo
 * cuando el peleador empieza a salir despedido de verdad, que es cuando el que
 * mira quiere ver que está en problemas.
 */
const DANO_MAXIMO = 200;

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
 * Las animaciones de interfaz.
 *
 * Van en una hoja de estilo y no en `style.transform` frame a frame porque son
 * animaciones de interfaz: el navegador las corre en su compositor y no gastan
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
  // El golpe: la barra tiembla cuando le entra daño. Es lo que hace que el
  // número no sea lo único que avisa que algo pasó.
  + '@keyframes bbGolpe{'
  + '0%{transform:translateX(0)}25%{transform:translateX(-3px)}'
  + '60%{transform:translateX(2px)}100%{transform:translateX(0)}}'
  + '.bb-golpe{animation:bbGolpe .22s ease-out}'
  + '@media (prefers-reduced-motion:reduce){'
  + '.bb-anota,.bb-golpe{animation:none}}';

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
  const estilo = document.createElement('style');
  estilo.textContent = ANIMACION;
  document.head.append(estilo);

  /* --- el marcador, arriba de todo y enfrentado ---------------------- */
  // Una sola fila con los dos bandos mirándose. `padding-top` con
  // `env(safe-area-inset-top)` porque en un iPhone el borde de arriba de la
  // página está tapado por la muesca y ahí no se lee nada.
  const marcador = el('div',
    'position:absolute;top:0;left:0;right:0;display:flex;align-items:flex-start;' +
    'gap:clamp(6px,2vw,20px);pointer-events:none;user-select:none;' +
    'padding:calc(env(safe-area-inset-top,0px) + clamp(6px,1.6vh,14px)) ' +
    'clamp(8px,2.5vw,26px) clamp(10px,2vh,18px);' +
    `font:clamp(9px,2.2vw,12px)/1.2 ${MONO};color:#e6edf3;` +
    // El velo no es una caja: es una sombra que se apaga hacia abajo, así que no
    // tiene borde ni un lado donde termine y el escenario sigue detrás.
    'background:linear-gradient(180deg,rgba(5,7,13,.86),rgba(5,7,13,.55) 55%,rgba(5,7,13,0))');

  const paneles = [TEAM_GREEN, TEAM_RED].map((team) => {
    const verde = team === TEAM_GREEN;
    const color = verde ? BULL : BEAR;
    const lado = verde ? 'flex-start' : 'flex-end';

    const panel = el('div',
      `flex:1;display:flex;flex-direction:column;align-items:${lado};gap:clamp(3px,.7vh,6px);` +
      'min-width:0');

    /* nombre e icono, del lado de afuera */
    const head = el('div', 'display:flex;align-items:center;gap:clamp(4px,1.2vw,9px);' +
      `color:${color};filter:drop-shadow(0 0 10px ${color}aa)`);
    const icono = el('span', 'display:flex;transform-origin:50% 60%;font-size:1.25em');
    icono.innerHTML = verde ? TORO : OSO;
    const label = el('strong',
      'letter-spacing:clamp(2px,.9vw,6px);font-size:clamp(13px,3.4vw,22px);' +
      `text-shadow:${CONTORNO}`, verde ? 'BULLS' : 'BEARS');
    // El toro entra desde la izquierda y el oso desde la derecha: el icono va
    // siempre del lado de afuera, mirando a la pelea.
    head.append(...(verde ? [icono, label] : [label, icono]));

    /* la barra de resistencia, que se vacía hacia el centro */
    // El riel se llena desde el borde de AFUERA. Es lo que hace que las dos
    // barras se consuman una contra la otra: en un juego de pelea eso se lee sin
    // que nadie lo explique.
    const riel = el('div',
      'position:relative;width:100%;height:clamp(9px,2.2vh,17px);' +
      'background:rgba(5,7,13,.72);border-radius:3px;overflow:hidden;' +
      `outline:1px solid ${color}55;box-shadow:inset 0 0 12px rgba(0,0,0,.7)`);
    const borde = verde ? 'left:0' : 'right:0';
    // El trozo fantasma: sigue al daño con retraso, así se ve CUÁNTO se acaba de
    // perder. Es el chunk blanco de los juegos de pelea, y es la mitad del
    // impacto de un golpe fuerte.
    const fantasma = el('div',
      `position:absolute;top:0;bottom:0;${borde};width:100%;background:#fff8e0;` +
      'opacity:.55;transition:width .45s cubic-bezier(.4,0,.2,1) .12s');
    const relleno = el('div',
      `position:absolute;top:0;bottom:0;${borde};width:100%;` +
      `background:linear-gradient(180deg,${color},${color}99);` +
      `box-shadow:0 0 14px ${color}aa;transition:width .12s linear`);
    riel.append(fantasma, relleno);

    /* la fila de abajo: daño, KO, plantel y ultra */
    const fila = el('div',
      `display:flex;align-items:center;gap:clamp(5px,1.6vw,12px);width:100%;` +
      `flex-direction:${verde ? 'row' : 'row-reverse'}`);

    const damage = el('div',
      `font:700 clamp(17px,4.6vw,30px)/1 ${MONO};color:${color};` +
      `text-shadow:${CONTORNO},0 0 20px ${color};` +
      'font-variant-numeric:tabular-nums', '0%');

    const kos = el('div',
      `color:#9fb0c4;letter-spacing:1px;text-shadow:${CONTORNO};white-space:nowrap`, '0 KO');

    // Los puntitos del plantel, al estilo de las rondas ganadas de Mortal
    // Kombat: cuántos peleadores le quedan al bando.
    const lives = el('div', 'display:flex;gap:clamp(3px,.9vw,5px)');
    const dots: HTMLElement[] = [];
    for (let i = 0; i < FIGHTERS_PER_TEAM; i++) {
      const dot = el('span',
        'width:clamp(8px,2.1vw,12px);height:clamp(8px,2.1vw,12px);border-radius:50%;' +
        'background:#1b2331;outline:2px solid #05070d');
      dots.push(dot);
      lives.append(dot);
    }

    const charge = el('div', 'display:flex;gap:2px');
    const pips: HTMLElement[] = [];
    for (let i = 0; i < GROWTH_MAX_STAGE; i++) {
      const pip = el('span', 'width:clamp(7px,1.8vw,12px);height:3px;border-radius:2px;' +
        'background:#263041');
      pips.push(pip);
      charge.append(pip);
    }

    // La barra de ULTRA, fina y debajo de todo: es la que avisa que viene el
    // super, y tiene que verse sin competirle a la de resistencia.
    const ultraWrap = el('div',
      'display:flex;align-items:center;gap:5px;flex:1;min-width:0;' +
      `flex-direction:${verde ? 'row' : 'row-reverse'}`);
    const ultraTag = el('span',
      `color:${DIM};letter-spacing:1px;font-size:clamp(8px,1.9vw,10px);` +
      `text-shadow:${CONTORNO}`, 'ULTRA');
    const ultraTrack = el('div',
      'flex:1;min-width:24px;height:3px;border-radius:2px;background:#26304199;' +
      'outline:1px solid #05070d99;overflow:hidden;position:relative');
    const ultraFill = el('div',
      `position:absolute;top:0;bottom:0;${borde};width:0%;background:${GOLD};` +
      'transition:width .12s linear');
    ultraTrack.append(ultraFill);
    ultraWrap.append(ultraTag, ultraTrack, charge);

    fila.append(damage, kos, lives, ultraWrap);
    panel.append(head, riel, fila);
    return {
      team, color, panel, icono, riel, relleno, fantasma,
      kos, damage, dots, pips, ultraFill, ultraTag, anotados: 0, dano: 0,
    };
  });

  // El separador del medio. En Tekken y en Mortal Kombat hay algo ahí —un
  // reloj, un emblema— y sin nada las dos barras se leen como una sola.
  const centro = el('div',
    'align-self:center;display:flex;flex-direction:column;align-items:center;gap:2px;' +
    `color:${DIM};font:700 clamp(11px,2.8vw,18px)/1 ${MONO};letter-spacing:2px;` +
    `text-shadow:${CONTORNO};flex:0 0 auto`, 'VS');
  marcador.append(paneles[0].panel, centro, paneles[1].panel);

  /* --- el mercado, abajo y entre las hogueras ------------------------- */
  // Baja del borde de arriba al de abajo, al hueco que dejan la hoguera verde y
  // la roja —`backdrop.ts` las planta en 0,16 y 0,84 del ancho—, así que el
  // centro de abajo es justo donde no hay fuego. Sin caja ni borde: el mismo
  // halo difuso que se usó para el marcador, para que las llamas se sigan
  // viendo atrás en vez de quedar tapadas por un rectángulo.
  //
  // Y el logo va teñido mitad y mitad: BORDER en verde y BRAWLERS en rojo, que
  // son los dos fuegos que lo flanquean. Ésa es la fusión.
  const bar = el('div',
    'position:absolute;left:50%;transform:translateX(-50%);' +
    'bottom:calc(env(safe-area-inset-bottom,0px) + clamp(6px,1.6vh,16px));' +
    'display:flex;align-items:center;justify-content:center;flex-wrap:wrap;' +
    'gap:clamp(5px,1.6vw,14px);max-width:calc(100% - 16px);' +
    'padding:clamp(4px,1.2vw,9px) clamp(12px,4vw,34px);' +
    'background:radial-gradient(closest-side ellipse at 50% 50%,' +
    'rgba(5,7,13,.88),rgba(5,7,13,.6) 58%,rgba(5,7,13,0) 100%);' +
    `font:clamp(9px,2.3vw,12px)/1.4 ${MONO};color:#e6edf3;` +
    `text-shadow:${CONTORNO};user-select:none;pointer-events:none;text-align:center`);

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

  /**
   * El título del final. Uno solo, que cambia de texto y de color.
   *
   * Va en el HUD y no dibujado en el escenario porque tiene que leerse igual con
   * cualquier zoom de cámara y en cualquier pantalla; un texto en coordenadas de
   * mundo se achica con la cámara justo cuando más grande tiene que estar.
   */
  const titulo = el('div',
    'position:absolute;left:0;right:0;top:36%;display:none;text-align:center;' +
    'pointer-events:none;user-select:none;' +
    `font:900 clamp(30px,10vw,104px)/1 ${MONO};` +
    'text-shadow:0 4px 0 #05070d,0 0 40px currentColor');

  host.append(marcador, bar, titulo);

  /** Qué título está puesto, para no reiniciar la animación en cada refresco. */
  let mostrando = -1;

  const timer = window.setInterval(() => {
    price.textContent = stats.mid > 0 ? stats.mid.toFixed(2) : '—';
    trades.textContent = `${stats.trades} trades`;
    whales.textContent = `${stats.whales} 🐋`;
    fps.textContent = `${perf.frameMs.toFixed(1)} ms`;
    fps.style.color = perf.frameMs <= 16.6 ? BULL : BEAR;

    for (const p of paneles) {
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

      const dano = match.damage[p.team];
      p.damage.textContent = `${Math.round(dano)}%`;
      // La barra se vacía a medida que sube el daño. El `fantasma` lleva el
      // mismo número pero con transición lenta, así que durante medio segundo se
      // ve el pedazo que se acaba de perder.
      const resistencia = Math.max(0, 1 - dano / DANO_MAXIMO);
      p.relleno.style.width = `${(resistencia * 100).toFixed(1)}%`;
      p.fantasma.style.width = `${(resistencia * 100).toFixed(1)}%`;
      // En rojo cuando queda poco: el color del bando ya no alcanza para avisar.
      p.relleno.style.filter = resistencia < 0.25 ? 'saturate(1.6) brightness(1.3)' : 'none';
      if (dano > p.dano + 4) {
        p.riel.classList.remove('bb-golpe');
        void p.riel.offsetWidth;
        p.riel.classList.add('bb-golpe');
      }
      p.dano = dano;

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
      // El "n/3" es de quién es el TURNO entre los tres carriles, y en torneo hay
      // un carril solo: el número cambiaría sin que cambie nada en pantalla.
      p.ultraTag.textContent = match.torneo
        ? 'ULTRA'
        : `ULTRA ${match.ultraTurn[p.team] + 1}/${FIGHTERS_PER_TEAM}`;
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
      marcador.remove();
    },
    setStatus(next: string): void {
      status.textContent = `● ${next}`;
      status.style.color = next === 'live' ? BULL : next === 'error' ? BEAR : GOLD;
    },
  };
}
