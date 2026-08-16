import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import { Physics } from '@react-three/rapier';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import type { ProcessedBook } from '../types/binance';
import type { FeedStats, TradeRingBuffer } from '../net/feedCore';
import { OrderBookWalls } from './OrderBookWalls';
import { BrawlerPool } from './BrawlerPool';
import { DynamicCamera } from './DynamicCamera';
import { createStageFocus } from './stageFocus';
import { PerfHud } from '../dev/PerfHud';

/**
 * Módulo 6 — composición de la escena.
 */

const VOID_DARK = '#0B0F19';

/** Niveles de mipmap del Bloom. Cada uno cuesta 2 draw calls. Ver abajo. */
const BLOOM_LEVELS = 4;

export interface BorderBrawlersSceneProps {
  book: ProcessedBook;
  stats: FeedStats;
  trades: TradeRingBuffer;
  /** Pausa la física con la pestaña oculta. Cambia poco: es estado de React. */
  isHidden: boolean;
  lowQuality: boolean;
  showPerf: boolean;
}

export function BorderBrawlersScene(props: BorderBrawlersSceneProps): React.JSX.Element {
  const { book, stats, trades, isHidden, lowQuality, showPerf } = props;
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);

  const focus = useMemo(createStageFocus, []);

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
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 9, 7]} intensity={2.1} />
      <directionalLight position={[-6, 3, 4]} intensity={0.7} color="#4a6cff" />

      <DynamicCamera focus={focus} />

      <Physics
        timeStep={1 / 60}
        interpolate
        maxCcdSubsteps={4}
        numSolverIterations={4}
        gravity={[0, -9.81, 0]}
        paused={isHidden}
      >
        <OrderBookWalls book={book} stats={stats} lowQuality={lowQuality} />
        <BrawlerPool trades={trades} stats={stats} focus={focus} lowQuality={lowQuality} />
      </Physics>

      {/* Ruta HDR: los materiales van con toneMapped={false} y los colores por
          instancia se escriben fuera de 0–1. El umbral por encima de 1,0 hace
          que sólo esos brillen, sin SelectiveBloom ni capas.
          multisampling por defecto es 8: carísimo y redundante con bloom.

          `levels` es el que decide si se cumple el criterio de la Parte E. El
          mipmap blur hace un paso por nivel bajando y otro subiendo, así que el
          default de 8 cuesta ~17 draw calls de post: medido, 19 en total con la
          escena, contra un techo de 12. Con 4 niveles son 11, y el halo sigue
          alcanzando porque lo que brilla son barras finas, no superficies
          grandes. */}
      {!lowQuality && (
        <EffectComposer multisampling={0}>
          <Bloom
            intensity={1.2}
            luminanceThreshold={1.0}
            luminanceSmoothing={0.03}
            mipmapBlur
            levels={BLOOM_LEVELS}
          />
        </EffectComposer>
      )}

      {showPerf && <PerfHud />}
    </>
  );
}
