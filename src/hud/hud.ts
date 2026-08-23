import type { FeedStats } from '../net/feedCore';
import type { MatchState } from '../game/fighters';
import { TEAM_GREEN, TEAM_RED } from '../game/fighters';
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
 * El glifo de equipo: una flecha angular, arriba para BULLS y abajo para
 * BEARS. Reemplaza al toro y al oso dibujados en línea.
 *
 * El dibujo detallado de un animal pesa demasiado espacio de pantalla para
 * pantalla horizontal, donde el alto disponible es el recurso escaso —y un
 * marcador de juego de pelea no necesita ilustración, necesita leerse en un
 * vistazo—. La flecha dice lo mismo que decía el animal (sube/baja el
 * mercado) con una forma angular de HUD, no una figura que finge ser un
 * bicho. Va como SVG y no como emoji por lo mismo de siempre: hereda
 * `currentColor`, así sale teñida y con resplandor del color del bando.
 */
const FLECHA_ARRIBA = '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">'
  + '<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="square"'
  + ' stroke-linejoin="miter" d="M12 21V5M4.5 11.5 12 4l7.5 7.5"/></svg>';

const FLECHA_ABAJO = '<svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true">'
  + '<path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="square"'
  + ' stroke-linejoin="miter" d="M12 3v16M4.5 12.5 12 20l7.5-7.5"/></svg>';

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
): HudHandle {
  const estilo = document.createElement('style');
  estilo.textContent = ANIMACION;
  document.head.append(estilo);

  /* --- el marcador, arriba de todo y enfrentado ---------------------- */
  // Rediseñado fino y horizontal: en pantalla horizontal el alto es el
  // recurso escaso —a lo ancho sobra— así que cada pieza se achicó y se puso
  // en línea en vez de apilada. `padding-top` con `env(safe-area-inset-top)`
  // porque en un iPhone el borde de arriba de la página está tapado por la
  // muesca y ahí no se lee nada.
  const marcador = el('div',
    'position:absolute;top:0;left:0;right:0;display:flex;align-items:center;' +
    'gap:clamp(8px,2.4vw,28px);pointer-events:none;user-select:none;' +
    'padding:calc(env(safe-area-inset-top,0px) + clamp(4px,.9vh,8px)) ' +
    'clamp(8px,2vw,20px) clamp(4px,.8vh,8px);' +
    `font:clamp(8px,1.5vw,11px)/1.2 ${MONO};color:#e6edf3;` +
    // El velo no es una caja: es una sombra que se apaga hacia abajo, así que no
    // tiene borde ni un lado donde termine y el escenario sigue detrás.
    'background:linear-gradient(180deg,rgba(5,7,13,.82),rgba(5,7,13,.4) 70%,rgba(5,7,13,0))');

  const paneles = [TEAM_GREEN, TEAM_RED].map((team) => {
    const verde = team === TEAM_GREEN;
    const color = verde ? BULL : BEAR;
    const lado = verde ? 'flex-start' : 'flex-end';

    const panel = el('div',
      `flex:1;display:flex;flex-direction:column;align-items:${lado};gap:2px;min-width:0`);

    /* cabecera: glifo + label + puntitos del plantel, en UNA línea angosta
       en vez de tres filas apiladas */
    const head = el('div',
      `display:flex;align-items:center;gap:clamp(3px,.9vw,7px);width:100%;` +
      `flex-direction:${verde ? 'row' : 'row-reverse'}`);
    const marca = el('span',
      `display:flex;align-items:center;gap:clamp(3px,.7vw,6px);color:${color};` +
      `filter:drop-shadow(0 0 6px ${color}99)`);
    const icono = el('span', 'display:flex;font-size:.85em');
    icono.innerHTML = verde ? FLECHA_ARRIBA : FLECHA_ABAJO;
    const label = el('strong',
      'letter-spacing:clamp(1px,.5vw,3px);font-size:clamp(10px,2vw,14px)', verde ? 'BULLS' : 'BEARS');
    marca.append(...(verde ? [icono, label] : [label, icono]));

    // Los puntitos del plantel, chicos y cuadrados —una esquirla de HUD, no
    // una ficha de mesa— al estilo de las rondas ganadas de un juego de
    // pelea: cuántos peleadores le quedan al bando.
    const lives = el('div', 'display:flex;gap:2px');
    const dots: HTMLElement[] = [];
    for (let i = 0; i < FIGHTERS_PER_TEAM; i++) {
      const dot = el('span',
        'width:clamp(5px,1vw,7px);height:clamp(5px,1vw,7px);' +
        'background:#1b2331;outline:1px solid #05070d');
      dots.push(dot);
      lives.append(dot);
    }

    const marcas = el('div',
      `display:flex;align-items:center;gap:5px;flex:1;min-width:0;justify-content:${lado}`);
    marcas.append(lives);

    head.append(marca, marcas);

    /* la barra de resistencia: un filete fino, no un bloque */
    // El riel se llena desde el borde de AFUERA. Es lo que hace que las dos
    // barras se consuman una contra la otra: en un juego de pelea eso se lee
    // sin que nadie lo explique.
    const riel = el('div',
      'position:relative;width:100%;height:clamp(3px,.7vh,5px);' +
      'background:rgba(5,7,13,.72);overflow:hidden;' +
      `outline:1px solid ${color}44`);
    const borde = verde ? 'left:0' : 'right:0';
    // El trozo fantasma: sigue al daño con retraso, así se ve CUÁNTO se acaba
    // de perder. Es el chunk blanco de los juegos de pelea, y es la mitad del
    // impacto de un golpe fuerte.
    const fantasma = el('div',
      `position:absolute;top:0;bottom:0;${borde};width:100%;background:#fff8e0;` +
      'opacity:.55;transition:width .45s cubic-bezier(.4,0,.2,1) .12s');
    const relleno = el('div',
      `position:absolute;top:0;bottom:0;${borde};width:100%;` +
      `background:${color};box-shadow:0 0 8px ${color}cc;transition:width .12s linear`);
    riel.append(fantasma, relleno);

    /* la fila de abajo: daño y KO, en una línea chica */
    const fila = el('div',
      `display:flex;align-items:center;gap:clamp(4px,1.2vw,10px);width:100%;` +
      `flex-direction:${verde ? 'row' : 'row-reverse'}`);

    const damage = el('div',
      `font:700 clamp(12px,2.6vw,18px)/1 ${MONO};color:${color};` +
      `text-shadow:${CONTORNO},0 0 10px ${color};` +
      'font-variant-numeric:tabular-nums', '0%');

    const kos = el('div',
      `color:#9fb0c4;font-size:.9em;text-shadow:${CONTORNO};white-space:nowrap`, '0 KO');

    fila.append(damage, kos);
    panel.append(head, riel, fila);
    return {
      team, color, panel, icono, riel, relleno, fantasma,
      kos, damage, dots, anotados: 0, dano: 0,
    };
  });

  // El separador del medio: una línea angosta y el "VS" chico. En Tekken y en
  // Mortal Kombat hay algo ahí —un reloj, un emblema— y sin nada las dos
  // barras se leen como una sola.
  const centro = el('div',
    'align-self:center;display:flex;align-items:center;gap:4px;' +
    `color:${DIM};font:700 clamp(9px,1.7vw,13px)/1 ${MONO};letter-spacing:2px;` +
    'flex:0 0 auto', 'VS');
  marcador.append(paneles[0].panel, centro, paneles[1].panel);

  /* --- el mercado, chiquito en el borde de abajo ---------------------- */
  // Antes era una barra entera —logo, símbolo, precio, estado de conexión,
  // fuente del feed, trades, ballenas, fps— centrada abajo. Ocupaba lugar de
  // sobra para lo que un espectador necesita mirar mientras dura la pelea:
  // sólo el nombre y el precio. El resto (estado/fuente/trades/ballenas/fps)
  // era diagnóstico de desarrollo, no algo para ver jugando; ese detalle
  // sigue disponible en la consola si hace falta, no en pantalla.
  const bar = el('div',
    'position:absolute;left:0;' +
    'bottom:calc(env(safe-area-inset-bottom,0px) + clamp(3px,.8vh,8px));' +
    'display:flex;align-items:baseline;gap:clamp(4px,1vw,8px);' +
    'padding:2px clamp(6px,1.6vw,12px);' +
    `font:clamp(7px,1.4vw,9px)/1.2 ${MONO};color:#e6edf3;opacity:.7;` +
    `text-shadow:${CONTORNO};user-select:none;pointer-events:none`);

  const title = el('strong', 'letter-spacing:1px');
  title.innerHTML = `<span style="color:${BULL}">BORDER</span><span style="color:${BEAR}">BRAWLERS</span>`;
  const symbolNode = el('span', `color:${DIM}`, symbol.toUpperCase());
  // El precio hace de indicador de estado a la vez: dorado mientras conecta,
  // rojo si el feed se cae. Un punto de color aparte para decir lo mismo era
  // otra pieza de texto en un lugar que ahora tiene que ser mínimo.
  const price = el('span', `color:${GOLD};font-variant-numeric:tabular-nums`, '—');
  bar.append(title, symbolNode, price);

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
    if (stats.mid > 0) price.textContent = stats.mid.toFixed(2);

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
      // Ya no hay texto de estado aparte: el color del precio dice lo mismo
      // en el espacio mínimo que le queda al rótulo del borde.
      price.style.color = next === 'live' ? BULL : next === 'error' ? BEAR : GOLD;
    },
  };
}
