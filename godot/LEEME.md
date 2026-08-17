# BorderBrawlers en Godot — el banco de rigging

Esto no es el juego todavía. Es **una sola escena** donde se prueba si el método
de animación sirve, antes de portar las cinco mil líneas de simulación que ya
funcionan en la versión de Pixi. Si el método no convence, se descarta esta
carpeta y no se perdió nada más que un día.

## Por qué existe

En la versión de Pixi los personajes se cortaban en seis piezas y se colgaban de
un esqueleto de frente y simétrico. Los dibujos son renders **en tres cuartos y
en pose dinámica**, así que cada pieza viene con el escorzo y la luz de una pose
distinta de aquella en la que se la vuelve a poner. Por bien medidas que estén
las articulaciones, no encajan. Y se hacía a ciegas, midiendo píxeles en un
JSON.

Godot cambia las dos cosas: permite deformar la figura **entera** sin cortarla,
y sobre todo permite hacerlo **viendo**, arrastrando un hueso y mirando el
resultado en el momento.

## Arrancar

1. Bajá **Godot 4.4** o más nuevo de https://godotengine.org/download — es un
   único ejecutable, no tiene instalador ni pide permisos de administrador.
   Alcanza la versión estándar; la de .NET no hace falta.
2. Abrí Godot, *Importar*, y elegí `godot/project.godot` de este repo.
3. F5 para correr. Vas a ver el cartel de que no hay personajes: es lo esperado
   hasta que hagas el primero.

Teclas del banco: `←` `→` cambian de pose, `↑` `↓` de personaje, espacio pausa
el recorrido automático.

## El contrato

Cada personaje es **una escena** en `personajes/<nombre>/<nombre>.tscn`, con
`personajes/peleador.gd` puesto en el nodo raíz. Lo único que el juego le exige
es un `AnimationPlayer` con nueve animaciones que se llamen exactamente:

```
idle · run · jump · hurt · attack_punch · attack_kick · skill1 · skill2 · super
```

Son las mismas que ya declara `src/game/roster.ts` en la versión de Pixi. Si el
rig las llama distinto, no anda.

**Cómo esté hecho el dibujo por dentro no le importa a nadie más que a esa
escena.** Figura entera deformada con huesos, piezas sueltas, o cuadros
dibujados uno por uno: los tres cumplen el mismo contrato. Eso es a propósito y
es la lección de la versión anterior — el juego sabía demasiado del rig, y por
eso cambiar de método obligaba a tocar el juego. Acá el método se puede cambiar
personaje por personaje sin que se entere una línea de la pelea.

Con un rig a medio hacer, el banco abre igual y avisa qué animaciones faltan. Se
puede trabajar de a una.

## Método A — la figura entera, deformada con huesos

Es el que hay que probar primero, porque es el que arregla la causa del
problema: **no se corta nada**, así que no hay costuras, ni pivotes mal puestos,
ni un brazo que nace del aire. Y funciona con la pose en la que está dibujado el
personaje, sea de frente o en tres cuartos, porque los huesos se acomodan al
dibujo en vez de al revés.

Consecuencia: la lista de "quiénes clasifican para el corte" deja de importar.
**Los 57 legends sirven**, incluidos los que tienen el arma cruzada sobre el
pecho.

Para Asuri, que ya tiene el PNG acá en `personajes/asuri/asuri.png`:

1. Escena nueva, nodo raíz `Node2D`, nombre `Asuri`. Guardala como
   `personajes/asuri/asuri.tscn` y poné `personajes/peleador.gd` en la raíz.
2. Agregá un **`Polygon2D`** hijo. En el inspector, `Texture` → arrastrá
   `asuri.png`.
3. Con el `Polygon2D` seleccionado, en la barra de arriba entrá a **UV** →
   pestaña **Puntos**, y dibujá el contorno de la figura. No hace falta
   precisión: un contorno grueso alcanza, con más puntos donde el dibujo se
   dobla (codos, rodillas, cuello).
4. Agregá un **`Skeleton2D`** hermano, y adentro los `Bone2D` con estos nombres:

   ```
   raiz · torso · cabeza
   brazoIzqAlto · brazoIzqBajo · brazoDerAlto · brazoDerBajo
   piernaIzqAlta · piernaIzqBaja · piernaDerAlta · piernaDerBaja
   ```

   Colgados unos de otros como el cuerpo: `torso` de `raiz`, `cabeza` y los
   cuatro `...Alto` de `torso`, cada `...Bajo` de su `...Alto`. Arrastralos hasta
   que caigan **adentro** del dibujo, en el lugar donde está esa parte del
   cuerpo. Con la pose en tres cuartos, los huesos van donde el dibujo los
   muestra, no simétricos.
5. En el `Polygon2D`, propiedad `Skeleton` → apuntá al `Skeleton2D`. Volvé a
   **UV** → pestaña **Huesos** y pintá qué parte del dibujo mueve cada hueso.
   Godot tiene *Sincronizar huesos con polígono* para arrancar con un reparto
   automático que después se corrige a mano.
6. Agregá un **`AnimationPlayer`** y creá las nueve animaciones. Se hace
   moviendo los huesos y poniendo llaves; `idle`, `run` y `jump` en bucle, el
   resto de una pasada.
7. F5. El banco la carga sola.

## Método B — cuadros dibujados, sin rig

El plan B, y no es un consuelo: el juego de pelea 2D que pasaste
(`field_trip_fighters`, en Godot) usa exactamente esto, con artista propio. Cada
pose es un dibujo, y no hay esqueleto en ninguna parte.

En Godot son `Sprite2D` + `SpriteFrames`, o un `AnimatedSprite2D`, y las mismas
nueve animaciones con los mismos nombres. **El contrato no cambia**, así que un
personaje puede estar hecho con el método A y el de al lado con el B, en la
misma pelea.

Lo que cuesta es generar los dibujos: una imagen por pose y por personaje.

## Conectar Claude a Godot

Existen servidores MCP que le dan a Claude control del editor: abrir el
proyecto, correr la escena, leer los errores y sacar capturas. Verificados en el
registro de npm:

| paquete | qué hace |
|---|---|
| `breakpoint-mcp` | CLI, editor en vivo, LSP y depurador; hecho y probado con Claude |
| `godot-mcp-runtime` | además de editar archivos, corre el juego y devuelve qué pasó |
| `@coding-solo/godot-mcp` | abre el editor, corre proyectos, captura la salida |

Los tres necesitan el ejecutable de Godot al lado, así que van en **tu máquina**,
con Claude Code instalado local sobre esta carpeta. En el contenedor donde se
escribió esto no hay Godot y no se puede bajar: la salida a internet está
filtrada.

Lo que eso habilita es que Claude corra la escena y vea el resultado, que es el
lazo que se pierde al salir del browser. **Lo que no habilita es hacer el rig
solo**: poner los huesos adentro del dibujo es trabajo de ojo.
