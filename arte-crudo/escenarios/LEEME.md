# Escenarios

Acá van los fondos crudos, como salen del generador. Uno por escenario, en su
propia carpeta si son varias capas.

    arte-crudo/escenarios/
      dojo.png              una sola imagen
      cripta/               o varias capas, de lejos a cerca
        01-cielo.png
        02-lejos.png
        03-cerca.png

## Qué necesita el juego

- **Apaisado, 16:9**, 1920×1080 o más. La cámara no hace zoom, así que la
  imagen se ve entera todo el tiempo.
- **Oscuro y desaturado.** Es fondo, no ilustración. Los peleadores son verde
  `#00FF66` y rojo `#FF0055` puros y miden cincuenta píxeles: si el fondo tiene
  saturación parecida, dejan de leerse y con eso se pierde lo único que el juego
  tiene para decir, que es quién está atacando.
- **Sin personajes, sin objetos en primer plano** y sin nada en la franja del
  medio, que es por donde pasan las plataformas del libro.
- **Sin texto ni marcas de agua.**

## Lo que el fondo NO reemplaza

Las hogueras de volumen por lado y el tinte del cielo hacia el que domina son
datos del mercado dibujados en vivo. Un fondo pintado va DETRÁS de eso, no en
su lugar: si lo tapara, la pantalla dejaría de contar lo que pasa en el libro.

Por eso conviene que la mitad de abajo del fondo sea tranquila —los cristales
de volumen crecen desde ahí— y que el cielo sea neutro, para que el tinte se
note.

## Varias capas, opcional

Si el generador puede darte el fondo separado en capas con transparencia, hay
parallax gratis: cada capa se mueve a distinta velocidad con la cámara. Con una
sola imagen también anda, sin parallax.
