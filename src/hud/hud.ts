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
  const bar = el('div',
    'position:absolute;top:12px;left:12px;display:flex;align-items:center;gap:14px;' +
    'padding:8px 12px;border-radius:8px;background:rgba(11,15,25,.75);' +
    `border:1px solid #263041;font:12px/1.4 ${MONO};color:#e6edf3;user-select:none`);

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

  /* --- marcador, abajo al centro ----------------------------------- */
  const board = el('div',
    'position:absolute;left:0;right:0;bottom:18px;display:flex;justify-content:center;' +
    'gap:18px;pointer-events:none;user-select:none');

  const panels = [TEAM_GREEN, TEAM_RED].map((team) => {
    const color = team === TEAM_GREEN ? BULL : BEAR;
    const panel = el('div',
      'min-width:220px;padding:10px 16px 12px;border-radius:12px;' +
      'background:linear-gradient(180deg,rgba(11,15,25,.55),rgba(11,15,25,.88));' +
      `border:2px solid ${color};box-shadow:0 0 22px ${color}33;` +
      `font:12px/1.2 ${MONO};color:#e6edf3;text-align:center`);

    const head = el('div', 'display:flex;justify-content:space-between;align-items:center');
    const label = el('strong', `color:${color};letter-spacing:3px`,
      team === TEAM_GREEN ? 'COMPRA' : 'VENTA');
    const kos = el('span', `color:${DIM}`, '0 KO');
    head.append(label, kos);

    const damage = el('div',
      `font:700 40px/1 ${MONO};color:${color};` +
      `text-shadow:0 2px 0 #05070d,0 0 18px ${color}66;` +
      'font-variant-numeric:tabular-nums;margin:4px 0 6px', '0%');

    const row = el('div', 'display:flex;justify-content:center;gap:12px;align-items:center');
    const lives = el('span', 'display:flex;gap:4px');
    const dots: HTMLElement[] = [];
    for (let i = 0; i < FIGHTERS_PER_TEAM; i++) {
      const dot = el('span', 'width:9px;height:9px;border-radius:50%;background:#263041');
      dots.push(dot);
      lives.append(dot);
    }
    const charge = el('span', 'display:flex;gap:3px');
    const pips: HTMLElement[] = [];
    for (let i = 0; i < GROWTH_MAX_STAGE; i++) {
      const pip = el('span', 'width:14px;height:5px;border-radius:2px;background:#263041');
      pips.push(pip);
      charge.append(pip);
    }
    row.append(lives, charge);

    /**
     * La barra de ULTRA del equipo. Es una sola por bando y se llena con las
     * órdenes agresoras de ese lado; al llenarse, el peleador al que le toca
     * descarga el super y el turno pasa al siguiente.
     *
     * El texto de al lado dice de quién es el turno —"ULTRA 2/3"— porque el
     * ciclo por turnos sólo sirve si se puede anticipar. Los tres cuadraditos de
     * arriba siguen siendo el paso de gigantismo, que es la misma carga vista en
     * el escenario: acá el número exacto, allá el tamaño del que va a pegar.
     */
    const ultraWrap = el('div', 'margin-top:8px;display:flex;align-items:center;gap:8px');
    const ultraTag = el('span',
      `color:${DIM};letter-spacing:2px;font-size:10px;white-space:nowrap`, 'ULTRA 1/3');
    const ultraTrack = el('div',
      'flex:1;height:7px;border-radius:4px;background:#263041;overflow:hidden');
    const ultraFill = el('div',
      `width:0%;height:100%;background:${GOLD};transition:width .12s linear`);
    ultraTrack.append(ultraFill);
    ultraWrap.append(ultraTag, ultraTrack);

    panel.append(head, damage, row, ultraWrap);
    board.append(panel);
    return { team, color, kos, damage, dots, pips, ultraFill, ultraTag };
  });

  host.append(bar, board);

  const timer = window.setInterval(() => {
    price.textContent = stats.mid > 0 ? stats.mid.toFixed(2) : '—';
    trades.textContent = `${stats.trades} trades`;
    whales.textContent = `${stats.whales} 🐋`;
    fps.textContent = `${perf.frameMs.toFixed(1)} ms`;
    fps.style.color = perf.frameMs <= 16.6 ? BULL : BEAR;

    for (const p of panels) {
      p.kos.textContent = `${match.kos[p.team]} KO`;
      p.damage.textContent = `${Math.round(match.damage[p.team])}%`;
      const alive = match.alive[p.team];
      p.dots.forEach((dot, i) => {
        dot.style.background = i < alive ? p.color : '#263041';
        dot.style.boxShadow = i < alive ? `0 0 8px ${p.color}` : 'none';
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
  }, REFRESH_MS);

  return {
    destroy(): void {
      window.clearInterval(timer);
      bar.remove();
      board.remove();
    },
    setStatus(next: string): void {
      status.textContent = `● ${next}`;
      status.style.color = next === 'live' ? BULL : next === 'error' ? BEAR : GOLD;
    },
  };
}
