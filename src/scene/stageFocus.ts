/**
 * Canal de un solo objeto entre el pool de personajes y la cámara.
 *
 * El pool ya recorre sus 50 slots todos los frames; recorrerlos otra vez desde
 * la cámara sería duplicar el trabajo. En vez de eso el pool escribe el
 * resultado acá y la cámara lo lee. Es un objeto mutable creado una sola vez:
 * nunca se reemplaza, así que no genera basura ni re-renders.
 */
export interface StageFocus {
  /** Personajes activos en este frame. */
  count: number;
  /** Centroide de los activos. Sin actividad, queda en el último valor. */
  centroidX: number;
  centroidY: number;
  /** Caja que los contiene, para decidir el zoom. */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** Sube al aparecer una ballena y decae solo. Sirve para sacudir la cámara. */
  impact: number;
}

export function createStageFocus(): StageFocus {
  return {
    count: 0,
    centroidX: 0,
    centroidY: 0,
    minX: 0,
    maxX: 0,
    minY: 0,
    maxY: 0,
    impact: 0,
  };
}

/** Reinicia los acumuladores del frame sin tocar `impact`, que decae aparte. */
export function beginFrame(focus: StageFocus): void {
  focus.count = 0;
  focus.minX = Infinity;
  focus.maxX = -Infinity;
  focus.minY = Infinity;
  focus.maxY = -Infinity;
}

export function accumulate(focus: StageFocus, x: number, y: number): void {
  focus.count++;
  if (x < focus.minX) focus.minX = x;
  if (x > focus.maxX) focus.maxX = x;
  if (y < focus.minY) focus.minY = y;
  if (y > focus.maxY) focus.maxY = y;
}

export function endFrame(focus: StageFocus, decay: number): void {
  if (focus.count > 0) {
    focus.centroidX = (focus.minX + focus.maxX) / 2;
    focus.centroidY = (focus.minY + focus.maxY) / 2;
  } else {
    focus.minX = 0;
    focus.maxX = 0;
    focus.minY = 0;
    focus.maxY = 0;
  }
  focus.impact *= decay;
  if (focus.impact < 0.001) focus.impact = 0;
}
