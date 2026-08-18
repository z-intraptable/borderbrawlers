# Nivel avanzado: 50 recursos para llevar tu juego 2D (PixiJS/WebGL + IA) más allá de lo básico

> Continuación del listado anterior. Acá el foco es rendimiento, arquitectura a escala, matemáticas/física más profundas, shaders custom, y pipelines de arte con IA en producción real (no solo "generar una imagen suelta").

## 1. PixiJS / WebGL — rendimiento y bajo nivel

1. **PixiJS Source Code (GitHub, paquetes `@pixi/core`, `@pixi/renderer`)** — leer el renderer directamente es el recurso "avanzado" real: no hay libro que reemplace entender el batching y el resource manager.
2. **"WebGL2 Fundamentals" (webgl2fundamentals.org)** — el nivel siguiente a WebGL Fundamentals: instancing, transform feedback, UBOs.
3. **"WebGL Insights" — Patrick Cozzi (ed.)** — capítulos de expertos de la industria sobre optimización real de WebGL en producción.
4. **PixiJS Batch Rendering internals (blog posts de Mat Groves, creador de Pixi, en Medium/ivank.net)** — cómo Pixi agrupa draw calls; clave para no romper el batching sin darte cuenta.
5. **"GPU Gems" (serie completa, NVIDIA, gratuita online)** — aunque orientada a 3D, los capítulos de post-procesado y particle systems se adaptan bien a filtros 2D.
6. **Spector.js + Chrome GPU Profiling guides** — no es un libro, es la herramienta/manual imprescindible para diagnosticar draw calls reales en tu juego Pixi.
7. **"Real-Time Rendering" — Tomas Akenine-Möller et al. (4th ed.)** — la referencia técnica más densa de la industria; útil para shaders custom y culling avanzado.
8. **PixiJS Filters advanced authoring guide (repo pixi-filters + GLSL shader basics de The Book of Shaders)** — para escribir tus propios shaders de post-proceso.
9. **"The Book of Shaders" — Patricio Gonzalez Vivo & Jen Lowe** (thebookofshaders.com, gratuito) — el manual estándar para aprender GLSL a fondo, aplicable a filtros PixiJS custom.
10. **Object pooling & memory profiling en V8 (docs de Chrome DevTools + "JavaScript engine fundamentals" de V8 blog)** — para eliminar GC pauses en juegos con muchos sprites/partículas.

## 2. Arquitectura avanzada de motor y código a escala

11. **"Foundations of Game Engine Development, Vol. 2: Rendering" — Eric Lengyel** — cómo se construye un pipeline de render desde cero (útil aunque uses Pixi, para entender qué abstrae).
12. **"Game Engine Architecture" — Jason Gregory** (3rd ed.) — el libro más completo sobre arquitectura de motores AAA; muchos patrones bajan directo a un juego 2D grande.
13. **bitECS / Miniplex — documentación avanzada y benchmarks** — arquitectura ECS de alto rendimiento en JS/TS, siguiente paso después del ECS básico.
14. **"Programming Game AI by Example" — Mat Buckland** — más allá de patrones básicos: state machines jerárquicas, steering behaviors, pathfinding aplicado a 2D.
15. **A* / navmesh avanzado — "Amit's A* Pages" (Red Blob Games, redblobgames.com)** — el recurso interactivo más citado del mundo para pathfinding 2D con visualizaciones.
16. **"Introduction to Game AI" — GDC Vault talks avanzadas (Utility AI, Behavior Trees en producción)**.
17. **Netcode for multiplayer 2D — "Gaffer On Games" (gafferongames.com), artículos de Glenn Fiedler** — si tu juego escala a multijugador, es el estándar de la industria.
18. **"Building Scalable JavaScript Applications" (patrones de módulos, workers) + Web Workers API (MDN avanzado)** — para mover física/IA a un hilo separado del render loop.
19. **Command Pattern + Undo/Redo systems en juegos (artículos de Gamasutra/Game Developer archive)** — para editores de nivel o sistemas de replay.
20. **TypeScript avanzado — "Effective TypeScript" — Dan Vanderkam** — genéricos, tipos condicionales; útil cuando el codebase de Claude Code crece y necesitás tipado estricto en sistemas ECS.

## 3. Diseño de juegos — nivel sistemas y balance

21. **"Uncertainty in Games" — Greg Costikyan** — teoría avanzada sobre por qué el azar funciona (o no) en el diseño de sistemas.
22. **"Characteristics of Games" — George Skaff Elias, Richard Garfield, K. Robert Gutschera** — análisis formal y matemático de mecánicas, con Garfield (creador de Magic).
23. **"Advanced Game Design: A Systems Approach" — Michael Sellers** — el paso siguiente a "The Art of Game Design", con foco en modelado de sistemas complejos y feedback loops.
24. **"Game Balance" — Ian Schreiber & Brenda Romero** — el manual más específico sobre matemáticas de balance (curvas de progresión, economías internas).
25. **"Virtual Economies: Design and Analysis" — Vili Lehdonvirta & Edward Castronova** — si tu juego tiene economía interna, moneda o progresión monetizable.
26. **GDC talks sobre "systemic design" (ej. charlas de Riot, Blizzard sobre balance de juegos en vivo)** — actualizadas y con casos reales.
27. **"Procedural Content Generation in Games" — Noor Shaker, Julian Togelius, Mark J. Nelson** (gratuito online, pcgbook.com) — generación procedural de niveles/contenido, muy relevante en 2D indie.
28. **"Persuasive Games" — Ian Bogost** — diseño de juegos con argumentos/sistemas retóricos, para mecánicas con intención más allá del entretenimiento puro.

## 4. Matemáticas y física — nivel producción

29. **"Physics for Game Developers" — David M. Bourg & Bryan Bywalec (2nd ed.)** — física aplicada con ejemplos de código, más profundo que un tutorial de Matter.js.
30. **Box2D source + "Box2D User Manual" oficial** — si necesitás física 2D robusta más allá de Matter.js.
31. **"Numerical Methods for Physical Simulation" (Cornell CS-based recopilaciones, gratuitas)** — integradores (Euler, Verlet, RK4) para simulaciones estables a 2D.
32. **Verlet Integration tutorials avanzados (ej. de "Advanced Character Physics" — Thomas Jakobsen, paper clásico de GDC)** — para telas, cuerdas, ragdolls 2D.
33. **"Continuous Collision Detection" papers y artículos (Erin Catto, GDC talks, creador de Box2D)** — evitar que objetos rápidos atraviesen paredes.
34. **Spatial partitioning avanzado — Quadtrees, Spatial Hashing (artículos de Red Blob Games y "Game Programming Patterns" cap. de optimización)** — para miles de entidades en pantalla.

## 5. Animación y arte 2D — nivel profesional

35. **"Cartoon Animation" — Preston Blair** — el manual clásico de animación estilizada, complemento avanzado al de Richard Williams.
36. **"Framed Ink" — Marcos Mateu-Mestre** — composición visual avanzada, útil para dirección de arte y escenas clave.
37. **Spine2D documentation & runtimes para PixiJS (esotericsoftware.com)** — animación esquelética 2D de nivel profesional, integración directa con Pixi.
38. **DragonBones documentation (alternativa open-source a Spine, con runtime oficial de PixiJS)**.
39. **"Pixel Art for Game Developers" (2nd ed.) — Daniel Silber** — técnicas avanzadas de paleta, dithering y animación pixel a nivel de shipping.
40. **Shader-based 2D lighting (tutoriales de "2D Lighting in WebGL/Pixi", ej. artículos de Codrops)** — normal maps en sprites 2D para iluminación dinámica.

## 6. Pipeline de arte con IA — nivel producción real

41. **ControlNet advanced conditioning (OpenPose, Canny, Depth) — documentación oficial + papers** — consistencia de pose/personaje entre múltiples generaciones, imprescindible para spritesheets coherentes.
42. **LoRA training guides (Stable Diffusion, Civitai docs, Kohya_ss repo)** — entrenar tu propio estilo/personaje para generar assets consistentes en todo el juego.
43. **IP-Adapter / Face-ID consistency guides** — mantener el mismo "personaje" a través de docenas de generaciones sin LoRA completo.
44. **AnimateDiff / video-to-sprite pipelines (repos y tutoriales de comunidad)** — generar frames de animación con IA y extraerlos a spritesheet.
45. **"AI Upscaling for Game Assets" (guías de Real-ESRGAN, Topaz Gigapixel aplicado a pixel art)** — cuidado: el upscaling genérico rompe el pixel art; hay flujos específicos (nearest-neighbor + IA) que hay que seguir al pie de la letra.
46. **Background removal & alpha channel cleanup avanzado (rembg, SAM — Segment Anything Model de Meta)** — automatizar el recorte de sprites generados por IA antes de importarlos a Pixi.
47. **Style-consistency workflows con Midjourney "--cref" / "--sref" (documentación oficial de parámetros)** — mantener estilo visual uniforme en un set grande de assets.
48. **Comfy UI workflows para pipelines repetibles de generación de sprites (comfyanonymous/ComfyUI + workflows compartidos en comunidad)** — para automatizar generación batch en vez de prompt por prompt.
49. **Legal/licensing deep-dive — "Generative AI, Copyright, and Video Games" (artículos de firmas legales especializadas en gaming, ej. de Gamasutra/Game Developer sobre IP con IA, actualizados 2024-2025)** — importante si vas a monetizar o publicar en Steam (que exige declarar contenido generado por IA).
50. **Steamworks documentation — "AI Generated Content Disclosure"** — guía oficial de Valve sobre qué y cómo declarar si usás IA en tus assets, requisito real para publicar.

---

### Ruta sugerida de profundización
Si tu cuello de botella hoy es rendimiento: empezá por #1, #4, #6, #10. Si es arquitectura de código que se te está desordenando: #12, #13, #19. Si el problema es consistencia visual con IA: #41, #42, #43, #48 en ese orden — es la secuencia real que usan estudios indie para no generar arte "random" que no combina entre sprites.
