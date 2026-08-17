extends Node2D

## Banco de pruebas del rig.
##
## Una sola cosa en pantalla: los personajes que haya en `res://personajes/`,
## pasando por las nueve poses del contrato. Sin mercado, sin física, sin
## plataformas. **Es donde se decide si el método de animación sirve**, antes de
## portar cinco mil líneas de simulación que después habría que tirar.
##
## La escena de juego los dibuja a cuarenta píxeles y tapados de chispas, que es
## el peor lugar posible para decidir si un brazo está bien puesto.
##
## Teclas:
##   ← →   pose anterior / siguiente
##   ↑ ↓   personaje anterior / siguiente
##   espacio  pausa el recorrido automático
##
## Las teclas se leen directo del evento y no del mapa de acciones a propósito:
## el mapa vive en `project.godot` con un formato que el editor reescribe solo,
## y una entrada mal puesta a mano ahí rompe el proyecto entero al abrirlo.

## Cuánto dura cada pose en el recorrido automático.
const DURACION := 1.6

## Dónde buscar personajes. Cada subcarpeta con un `.tscn` adentro es uno.
const CARPETA := "res://personajes/"

var _peleadores: Array[Peleador] = []
var _nombres: Array[String] = []
var _pose := 0
var _quien := 0
var _edad := 0.0
var _pausado := false

@onready var _rotulo: Label = $Interfaz/Rotulo
@onready var _ayuda: Label = $Interfaz/Ayuda


func _ready() -> void:
	_cargar()
	if _peleadores.is_empty():
		_rotulo.text = "no hay personajes en %s\nver godot/LEEME.md" % CARPETA
		return
	_acomodar()
	_aplicar()


func _process(delta: float) -> void:
	if _peleadores.is_empty() or _pausado:
		return
	_edad += delta
	if _edad < DURACION:
		return
	_edad = 0.0
	_pose = (_pose + 1) % Peleador.ANIMACIONES.size()
	_aplicar()


func _unhandled_key_input(evento: InputEvent) -> void:
	var tecla := evento as InputEventKey
	if tecla == null or not tecla.pressed or tecla.echo:
		return
	match tecla.keycode:
		KEY_RIGHT:
			_mover_pose(1)
		KEY_LEFT:
			_mover_pose(-1)
		KEY_DOWN:
			_mover_quien(1)
		KEY_UP:
			_mover_quien(-1)
		KEY_SPACE:
			_pausado = not _pausado
			_aplicar()
		_:
			return
	get_viewport().set_input_as_handled()


func _mover_pose(paso: int) -> void:
	if _peleadores.is_empty():
		return
	var total := Peleador.ANIMACIONES.size()
	_pose = posmod(_pose + paso, total)
	_edad = 0.0
	_pausado = true
	_aplicar()


func _mover_quien(paso: int) -> void:
	if _peleadores.is_empty():
		return
	_quien = posmod(_quien + paso, _peleadores.size())
	_acomodar()
	_aplicar()


## Carga cada escena de personaje que haya en disco.
##
## Se buscan en tiempo de ejecución y no con una lista escrita: agregar un
## personaje tiene que ser dejar una carpeta, no tocar código. En la versión
## exportada `DirAccess` sólo ve lo que se empaquetó, que es exactamente lo que
## se quiere — los `.import` y los `.png` sueltos no aparecen.
func _cargar() -> void:
	var raiz := DirAccess.open(CARPETA)
	if raiz == null:
		push_error("no se puede abrir %s" % CARPETA)
		return
	for carpeta in raiz.get_directories():
		var ruta := "%s%s/%s.tscn" % [CARPETA, carpeta, carpeta]
		if not ResourceLoader.exists(ruta):
			continue
		var escena: PackedScene = load(ruta)
		var nodo := escena.instantiate()
		if nodo is not Peleador:
			push_warning("%s no tiene el script de Peleador en la raíz" % ruta)
			nodo.queue_free()
			continue
		add_child(nodo)
		_peleadores.append(nodo)
		_nombres.append(carpeta)


## Uno solo en pantalla, en el medio y grande. Los otros quedan cargados y
## ocultos: cambiar de personaje es cambiar de `visible`, no volver a instanciar.
func _acomodar() -> void:
	var medida := get_viewport_rect().size
	for i in _peleadores.size():
		var peleador := _peleadores[i]
		peleador.visible = i == _quien
		peleador.position = Vector2(medida.x * 0.5, medida.y * 0.78)


func _aplicar() -> void:
	if _peleadores.is_empty():
		return
	var nombre := Peleador.ANIMACIONES[_pose]
	_peleadores[_quien].pose(nombre)
	var faltan := _peleadores[_quien].animaciones_faltantes()
	var aviso := ""
	if nombre in faltan:
		aviso = "  (esta pose todavía no está)"
	_rotulo.text = "%s — %s%s" % [_nombres[_quien], nombre, aviso]
	_ayuda.text = "← → pose    ↑ ↓ personaje    espacio %s" % (
		"seguir" if _pausado else "pausar"
	)
