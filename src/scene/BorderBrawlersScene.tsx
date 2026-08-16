import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Physics } from '@react-three/rapier';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import type { ProcessedBook } from '../types/binance';
import type { FeedStats, TradeRingBuffer } from '../net/feedCore';
import { OrderBookWalls, PLATFORM_COUNT } from './OrderBookWalls';
import { FighterPool } from './FighterPool';
import { DynamicCamera } from './DynamicCamera';
import { StageBackdrop } from './StageBackdrop';
import { ImpactFx, createImpactPool } from './ImpactFx';
import { createStageFocus } from './stageFocus';
import { PerfHud } from '../dev/PerfHud';
import type { MatchState } from '../game/fighters';
import { createSkyline } from '../game/fighters';

/**
 * Módulo 6 — composición de la escena.
 *
 * Tres objetos mutables se crean acá y se pasan hacia abajo. Ninguno se
 * reemplaza nunca, así que no generan re-renders ni basura: son el canal por
 * donde el escenario le cuenta a la IA dónde está el piso (`skyline`), el pool
 * le cuenta a la cámara dónde mirar (`focus`), y los golpes le cuentan a los
 * efectos qué dibujar (`fx`).
 */

const VOID_DARK = '#0B0F19';

/** Niveles de mipmap del Bloom. Cada uno cuesta 2 draw calls. */
const BLOOM_LEVELS = 4;

export interface BorderBrawlersSceneProps {
  book: ProcessedBook;
  stats: FeedStats;
  trades: TradeRingBuffer;
  match: MatchState;
  /** Pausa la física con la pestaña oculta. Cambia poco: es estado de React. */
  isHidden: boolean;
  lowQuality: boolean;
  showPerf: boolean;
}

export function BorderBrawlersScene(props: BorderBrawlersSceneProps): React.JSX.Element {
  const { book, stats, trades, match, isHidden, lowQuality, showPerf } = props;
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);

  const focus = useMemo(createStageFocus, []);
  const skyline = useMemo(() => createSkyline(PLATFORM_COUNT), []);
  const fx = useMemo(createImpactPool, []);

  useEffect(() => {
    // Compilar antes del primer frame evita el hitch de la primera aparición
    // de cada material. `compileAsync` devuelve una promesa; no hay nada que
    // esperar, sólo que empiece antes de que haga falta.
    void gl.compileAsync(scene, camera);
  }, [gl, scene, camera]);

  return (
    <>
      <color attach="background" args={[VOID_DARK]} />

      {/* MeshToonMaterial necesita luz direccional para que se vean las bandas
          de cel-shading; la ambiental sólo levanta el negro absoluto. */}
      <ambientLight intensity={0.6} />
      <directionalLight position={[4, 9, 7]} intensity={2.2} />
      <directionalLight position={[-6, 3, 4]} intensity={0.8} color="#4a6cff" />

      <StageBackdrop stats={stats} />
      <DynamicCamera focus={focus} />

      <Physics
        timeStep={1 / 60}
        interpolate
        maxCcdSubsteps={4}
        numSolverIterations={4}
        gravity={[0, -9.81, 0]}
        paused={isHidden}
      >
        <OrderBookWalls book={book} stats={stats} skyline={skyline} lowQuality={lowQuality} />
        <FighterPool
          trades={trades}
          stats={stats}
          focus={focus}
          skyline={skyline}
          fx={fx}
          match={match}
          lowQuality={lowQuality}
        />
      </Physics>

      <ImpactFx pool={fx} />

      {/* Ruta HDR: los materiales van con toneMapped={false} y los colores por
          instancia se escriben fuera de 0–1. El umbral por encima de 1,0 hace
          que sólo esos brillen, sin SelectiveBloom ni capas.
          multisampling por defecto es 8: carísimo y redundante con bloom.

          `levels` es el que decide si se cumple el criterio de la Parte E. El
          mipmap blur hace un paso por nivel bajando y otro subiendo, así que el
          default de 8 cuesta ~17 draw calls de post: medido, 19 en total con la
          escena, contra un techo de 16. Con 4 niveles son 9 de post. */}
      {!lowQuality && (
        <EffectComposer multisampling={0}>
          <Bloom
            intensity={1.25}
            luminanceThreshold={1.0}
            luminanceSmoothing={0.04}
            mipmapBlur
            levels={BLOOM_LEVELS}
          />
        </EffectComposer>
      )}

      {showPerf && <PerfHud maxDrawCalls={16} />}
    </>
  );
}
