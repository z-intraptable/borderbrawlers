# Ficha de arte — Deadpool (DragonBones)

Lo que hay que producir para reemplazar el peleador vectorial por arte riggeado.

---

## 0. Lo primero: DragonBones riggea, no dibuja

Es un editor de animación esqueletal. Se le dan **las piezas del cuerpo ya
dibujadas**, se arma el esqueleto y se anima. No genera arte.

Así que el trabajo son dos etapas y la primera es la larga:

1. **Dibujar las piezas** (sección 2). Sin esto DragonBones no tiene qué mover.
2. **Riggear y animar** (secciones 3 y 4).

También conviene saber que **ya hay un esqueleto andando en código**
(`src/art/fighter.ts`): partes con pivote, nueve poses, ciclo de carrera,
golpes. Si DragonBones no arranca o el export se complica, ese camino sigue
disponible y sólo necesita la etapa 1. No estás apostando todo a una herramienta.

### Dónde conseguirla

El proyecto está discontinuado: la última versión es la **5.6.3, de 2020**, y el
autor no responde desde hace años. La página oficial de descarga muchas veces no
carga, así que hay espejos:

- [Internet Archive — DragonBones Pro 5.6.3](https://archive.org/details/dragon-bones-pro-v-5.6.3)
- [MajorGeeks — DragonBones Pro 5.6.2](https://www.majorgeeks.com/files/details/dragonbones_pro.html)
- [Página oficial](https://dragonbones.github.io/en/download.html) (intermitente)
- [Código del editor](https://github.com/DragonBones/DesignPanel)

Es una aplicación de escritorio para Windows y Mac. Vos estás en Windows, así
que va.

**Que esté discontinuada no es un problema para nosotros**, porque no vamos a
usar su runtime —ese sí está muerto para Pixi 8— sino sólo el editor, y lo que
sale de él son imágenes y un archivo de datos.

---

## 2. Las piezas a dibujar

Un PNG por pieza, **fondo transparente**, sin sombra pegada al personaje —la
sombra la pone el juego—. Todas **mirando a la derecha**: el código espeja con la
escala, y una pieza dibujada hacia la izquierda sale al revés en plena pelea.

| Pieza | Archivo | Lienzo | Qué es |
|---|---|---|---|
| Cabeza | `head.png` | 240 × 240 | Máscara completa, con los dos ojos |
| Torso | `torso.png` | 200 × 176 | Del cuello a la cadera, con el cinturón |
| Brazo superior ×2 | `arm-upper.png` | 96 × 110 | Del hombro al codo |
| Antebrazo ×2 | `arm-lower.png` | 96 × 120 | Del codo al puño, puño incluido |
| Muslo ×2 | `leg-upper.png` | 110 × 110 | De la cadera a la rodilla |
| Pantorrilla ×2 | `leg-lower.png` | 110 × 130 | De la rodilla al pie, pie incluido |
| Katana | `blade.png` | 200 × 240 | La hoja cruzada a la espalda |

Los brazos y las piernas van **partidos en dos** porque DragonBones sí puede
doblar codos y rodillas — es lo que gana sobre el esqueleto que tenemos, que las
mueve de una pieza. Se dibuja una sola vez cada segmento: el de atrás es el mismo
recurso con un tinte más oscuro aplicado en el editor.

**Los segmentos se dibujan verticales**, colgando, con la articulación arriba.
Es la posición de reposo desde la que rotan.

### Proporciones

La cabeza desproporcionada no es un capricho: es lo que hace que una figura de
cuarenta píxeles se lea, y es por eso que los personajes de Brawlhalla son
cabezones.

- Cabeza: círculo de **208 px** de diámetro
- Torso: **152 de ancho × 140 de alto**, esquinas bien redondeadas
- Hombros: separados **136 px**, a la altura del borde superior del torso
- Caderas: separadas **72 px**
- Brazo entero: **60 de ancho × 100 de largo**, más un puño redondo de **84**
- Pierna entera: **68 de ancho × 96 de largo**, más un pie de **100 × 48**
- Personaje completo: **408 px** de alto

---

## 3. Paleta y estilo

El traje va en **el color del equipo**, no en el del personaje. Verde comprador
contra rojo vendedor es la regla del agresor hecha visible, y es el único dato
del mercado que se lee de un vistazo; si cada personaje trajera su paleta, mirar
la pantalla dejaría de decir quién está atacando. Deadpool juega en el equipo
rojo, así que en su caso coinciden.

| Uso | Hex |
|---|---|
| Traje, luz | `#FF0055` |
| Traje, sombra | `#9E0035` |
| Piezas traseras | `#66002A` |
| Correas y cinturón | `#1B1F2B` |
| Ojos de la máscara | `#F2F7FF` |
| Contorno | `#05070D` |
| Acero de la hoja | `#DFE7F2` |

Reglas de estilo, de la ficha del proyecto:

- Contorno negro **grueso y continuo**, de unos 22 px a esta escala.
- Sombreado **cel**: bloques sólidos con borde neto. **Ningún degradé.**
- **Sin texturas rugosas, sin ruido digital, sin pinceladas.** Vector plano.
- Una sola dirección de luz, desde la izquierda, en todas las piezas.

---

## 4. El esqueleto

Nombres de huesos, con la jerarquía. Conviene respetarlos: si algún día leemos
el export directo, son el contrato.

```
root
└── hip
    ├── torso
    │   ├── head
    │   ├── arm_back_upper  →  arm_back_lower
    │   └── arm_front_upper →  arm_front_lower
    ├── leg_back_upper  →  leg_back_lower
    └── leg_front_upper →  leg_front_lower
```

Orden de dibujo, de atrás hacia adelante: `blade`, brazo trasero, pierna
trasera, `torso`, pierna delantera, brazo delantero, `head`. En una figura de
tres cuartos el brazo y la pierna de atrás tienen que quedar **detrás** del
torso, o el cuerpo se ve plano y las extremidades parecen pegadas por delante.

El origen del esqueleto va **entre los pies**, no en la cadera. Es lo que hace
que el personaje se apoye en el piso sin corrección: el juego lo posiciona por
los pies.

---

## 5. Las nueve animaciones

**Los nombres son el contrato con `src/game/roster.ts`.** Si el rig las llama
distinto, no anda. Van exactamente así:

| Nombre | Bucle | Cuadros @24fps | Qué pasa |
|---|---|---|---|
| `idle` | sí | 40 | Respira. Pecho que sube, cabeza que acompaña, peso que se corre apenas. |
| `run` | sí | 16 | Piernas alternadas, **brazos en contrafase** —así camina un bípedo; en fase se ve como un juguete a cuerda—, dos rebotes por ciclo. |
| `jump` | no | 12 | Se agacha, empuja, se recoge en el aire. |
| `hurt` | no | 10 | Doblado hacia atrás, brazos sueltos. Es la que más rápido comunica que el golpe entró. |
| `attack_punch` | no | 12 | Puño recto del brazo delantero, torso acompañando, el otro brazo de contrapeso. |
| `attack_kick` | no | 14 | Patada de la pierna delantera, cuerpo hacia atrás. |
| `taunt_4th_wall` | no | 24 | La primera especial. Se da vuelta y mira **a la cámara**, gesto con la mano. |
| `attack_katana_slash` | no | 16 | La segunda especial. Desenvaina y corta en diagonal, dejando un arco. |
| `super_ui_smash` | no | 36 | El super. Brazos al cielo, cuerpo estirado, descarga. Es la más larga porque para el tiempo del juego. |

Opcional pero recomendada: **`fall`**, en bucle, 8 cuadros, cuerpo abierto
cayendo. Si no está, se sostiene el último cuadro de `jump`.

**Regla de tiempo para los golpes:** salen rápido y vuelven lento. La extensión
máxima va cerca del **primer cuarto** de la animación y el resto es la vuelta. Es
lo que hace que se lea como un golpe y no como un saludo.

---

## 6. El export

Exportá **todo lo que la herramienta ofrezca** y pasámelo. En concreto lo que
espero encontrar:

- `Deadpool_ske.json` — el esqueleto y las animaciones
- `Deadpool_tex.json` — el mapa del atlas
- `Deadpool_tex.png` — el atlas de texturas

Ajustes: escala **1.0**, sin comprimir el JSON, y el atlas en **2048 × 2048** si
entra.

No voy a afirmar de memoria qué opciones exactas tiene el menú de export de la
5.6.3 — no pude verificarlo. **Por eso el primer entregable es un solo personaje
y no los seis**: con el archivo real en la mano escribo el cargador que
corresponda, y si el formato obliga a un paso de conversión son unas treinta
líneas. Lo que no quiero es que riggees a los seis y recién ahí descubramos que
había que exportar distinto.

Si además hay una opción de **secuencia de imágenes** o **hoja de sprites**,
exportá también eso: es el camino más simple y el que menos depende de nada.

---

## 7. Cómo se prueba

```bash
npm run dev
# http://localhost:5173/showcase.html          recorre las poses
# http://localhost:5173/showcase.html?pose=run fija una
```

Ahí se ve grande y sin nada encima. La escena lo dibuja a cuarenta píxeles y
tapado de chispas, que es el peor lugar para decidir si un brazo quedó bien.

Qué mirar, en este orden:

1. **Los pies.** En `idle` tienen que apoyar, ni flotar ni hundirse. Es lo que
   más falla en la práctica.
2. **Los pivotes.** Si el brazo gira desde el codo, el hueso está mal puesto.
3. **Los encastres.** Si al levantar el brazo aparece un hueco en el hombro, a
   la pieza le falta hombro.
4. **La contrafase de la carrera.**
5. Recién después, color y contorno.

Y en la pelea de verdad:

```bash
node scripts/shoot.mjs 10 volatile
```

Deadpool con arte al lado de los otros cinco vectoriales, en la misma pelea. Es
a propósito: se puede ver el resultado sin esperar a los seis.

---

## 8. Nota práctica sobre el dibujo de las piezas

Si las piezas las vas a generar con una IA de imagen, pedí **una sola figura de
cuerpo entero** en 1024 × 1024, con los brazos separados del cuerpo, y de ahí
cortá los segmentos. Pedir las piezas por separado da doce dibujos que no
combinan entre sí: el tono del brazo no es el del torso y el contorno tiene otro
grosor.

Los servicios de imagen suelen rechazar los pedidos que nombran personajes de
marca. Describir **el diseño** —traje rojo y negro, máscara con dos óvalos
blancos, katanas cruzadas a la espalda— da además mejor resultado: el modelo
dibuja lo que se le describe en vez de promediar todo lo que vio asociado a un
nombre.

Vale la aclaración de siempre: los nombres y diseños del elenco son marcas de
terceros y esto es de uso personal.
