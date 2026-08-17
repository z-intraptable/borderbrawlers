class_name Peleador
extends Node2D

## El contrato entre el rig y el juego.
##
## Todo personaje es una escena con este script en la raíz. Lo único que el
## juego le pide es un `AnimationPlayer` con nueve animaciones que se llamen
## exactamente como dice [constant ANIMACIONES]. Cómo esté hecho el dibujo
## adentro —figura entera deformada con huesos, piezas sueltas, o cuadros
## dibujados uno por uno— **no le importa a nadie más que a la escena**.
##
## Esa indiferencia es a propósito y es la lección de la versión anterior: el
## juego sabía demasiado del rig —dónde caía el hombro, cuánto medía el brazo—
## y por eso cambiar de método obligaba a tocar el juego. Acá el método se puede
## cambiar personaje por personaje sin que se entere una sola línea de la pelea.
##
## Los nueve nombres son los mismos que ya declara `src/game/roster.ts` en la
## versión de Pixi. No se inventan de nuevo: si el rig las llama distinto, no
## anda, y conviene que el que riggea trabaje contra esta lista y no contra la
## memoria.

const ANIMACIONES: PackedStringArray = [
	"idle",
	"run",
	"jump",
	"hurt",
	"attack_punch",
	"attack_kick",
	"skill1",
	"skill2",
	"super",
]

## Las que se repiten solas. El resto son de una pasada y, al terminar, el
## peleador vuelve a `idle`.
const EN_BUCLE: PackedStringArray = ["idle", "run", "jump"]

var _player: AnimationPlayer = null
var _actual := ""

func _ready() -> void:
	_player = _buscar_player()
	if _player == null:
		push_error("%s: falta el AnimationPlayer. Ver godot/LEEME.md." % name)
		return
	var faltan := animaciones_faltantes()
	if not faltan.is_empty():
		# Un aviso y no un error: media escena a medio riggear tiene que poder
		# abrirse igual, o no se puede trabajar de a poco. Lo que no puede pasar
		# es que falte en silencio y aparezca como un personaje congelado.
		push_warning("%s: faltan animaciones %s" % [name, ", ".join(faltan)])
	_player.animation_finished.connect(_al_terminar)
	pose("idle")


## Qué animaciones del contrato no están en la escena.
func animaciones_faltantes() -> PackedStringArray:
	var faltan := PackedStringArray()
	if _player == null:
		return ANIMACIONES.duplicate()
	for nombre in ANIMACIONES:
		if not _player.has_animation(nombre):
			faltan.append(nombre)
	return faltan


## Reproduce una pose. Si no está en la escena, no hace nada y avisa una vez.
func pose(nombre: String) -> void:
	if _player == null or not _player.has_animation(nombre):
		return
	if _actual == nombre:
		return
	_actual = nombre
	var animacion := _player.get_animation(nombre)
	animacion.loop_mode = (
		Animation.LOOP_LINEAR if nombre in EN_BUCLE else Animation.LOOP_NONE
	)
	_player.play(nombre)


## La pose que se está reproduciendo.
func pose_actual() -> String:
	return _actual


## Mira a la derecha con 1 y a la izquierda con -1. Se espeja con la escala, que
## es una propiedad del nodo y no cuesta nada; dibujar el personaje dos veces sí.
func mirar(hacia: int) -> void:
	scale.x = absf(scale.x) * signf(float(hacia))


func _al_terminar(_nombre: StringName) -> void:
	# Una acción termina y se vuelve al reposo. Quién decide la próxima acción es
	# la pelea, no el personaje: acá sólo se cierra la que estaba.
	_actual = ""
	pose("idle")


func _buscar_player() -> AnimationPlayer:
	for hijo in get_children():
		if hijo is AnimationPlayer:
			return hijo
	return null
