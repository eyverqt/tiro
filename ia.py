"""
Tiro - preguntar y crear con IA.

Por defecto todo pasa en el equipo con Ollama: la transcripcion nunca sale de
la maquina. Si se configura una clave de Claude se puede usar la nube para
textos muy largos o cuando no hay un modelo local; es opcional.

Dos tareas:
- preguntar(): busca los fragmentos relevantes en la biblioteca (BM25) y
  responde citando cada dato con [n] -> transcripcion y segundo exacto.
- crear(): convierte una transcripcion en un resumen, una guia, un checklist,
  capitulos para YouTube, un guion de reel... Si el texto no cabe en el
  contexto del modelo se hace en dos pasadas (notas por partes -> resultado).
"""

import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request

import biblioteca

OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
if not OLLAMA.startswith("http"):
    OLLAMA = "http://" + OLLAMA

MODELOS_CLAUDE = [
    {"id": "claude-opus-5-5", "etiqueta": "Opus 5.5"},
    {"id": "claude-sonnet-5-5", "etiqueta": "Sonnet 5.5"},
    {"id": "claude-haiku-5-5", "etiqueta": "Haiku 5.5"},
]
CLAUDE_POR_DEFECTO = "claude-opus-5-5"
CON_FALLBACK = {"claude-opus-5-5", "claude-sonnet-5-5"}

# Cuanto texto se manda de una vez. En local manda la RAM y la velocidad del
# procesador; Claude admite un millon de tokens.
LIMITE = {"ollama": 48000, "claude": 600000}     # caracteres


class ErrorIA(Exception):
    pass


_SIN_VENTANA = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0


# ---------------------------------------------------------------- ollama --

def _pedir(ruta, cuerpo=None, timeout=4):
    datos = json.dumps(cuerpo).encode("utf-8") if cuerpo is not None else None
    req = urllib.request.Request(OLLAMA + ruta, data=datos,
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)


def ollama_activo():
    try:
        with _pedir("/api/tags", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def _exe_ollama():
    exe = shutil.which("ollama")
    if exe:
        return exe
    local = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Ollama", "ollama.exe")
    return local if os.path.isfile(local) else None


def encender_ollama(espera=20):
    """Arranca `ollama serve` en segundo plano si esta instalado y apagado."""
    if ollama_activo():
        return True
    exe = _exe_ollama()
    if not exe:
        return False
    subprocess.Popen([exe, "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=_SIN_VENTANA)
    limite = time.time() + espera
    while time.time() < limite:
        if ollama_activo():
            return True
        time.sleep(0.5)
    return False


def modelos_ollama():
    try:
        with _pedir("/api/tags", timeout=3) as r:
            datos = json.load(r)
    except Exception:
        return []
    salida = []
    for m in datos.get("models", []):
        if "embed" in m.get("name", ""):
            continue
        salida.append({"id": m["name"], "gb": round((m.get("size") or 0) / 1e9, 1)})
    return salida


def _ctx_para(caracteres):
    """num_ctx justo: Ollama trae 2048-4096 por defecto y cortaria el texto sin avisar."""
    necesario = int(caracteres / 3.2) + 3072
    ctx = 4096
    while ctx < necesario and ctx < 65536:
        ctx *= 2
    return ctx


def _generar_ollama(modelo, sistema, mensajes, al_texto):
    caracteres = len(sistema) + sum(len(m["content"]) for m in mensajes)
    cuerpo = {
        "model": modelo,
        "messages": [{"role": "system", "content": sistema}] + mensajes,
        "stream": True,
        "think": False,
        "options": {"num_ctx": _ctx_para(caracteres), "temperature": 0.3},
    }
    partes = []
    try:
        resp = _pedir("/api/chat", cuerpo, timeout=900)
    except urllib.error.HTTPError as e:
        detalle = e.read().decode("utf-8", "ignore")[:300]
        if "think" in detalle:                      # modelos sin modo razonamiento
            cuerpo.pop("think")
            resp = _pedir("/api/chat", cuerpo, timeout=900)
        else:
            raise ErrorIA("Ollama respondio %s: %s" % (e.code, detalle))
    except Exception as e:
        raise ErrorIA("No se pudo hablar con Ollama: %s" % e)
    with resp:
        for linea in resp:
            if not linea.strip():
                continue
            dato = json.loads(linea)
            if dato.get("error"):
                raise ErrorIA(dato["error"])
            trozo = (dato.get("message") or {}).get("content") or ""
            if trozo:
                partes.append(trozo)
                al_texto(trozo)
            if dato.get("done"):
                break
    return "".join(partes)


# ---------------------------------------------------------------- claude --

def _generar_claude(modelo, clave, sistema, mensajes, al_texto):
    try:
        import anthropic
    except ImportError:
        raise ErrorIA("Falta el paquete anthropic. Vuelve a ejecutar start.bat.")
    cliente = anthropic.Anthropic(api_key=clave)
    extra = {}
    if modelo in CON_FALLBACK:
        # Si un filtro de seguridad rechaza la peticion, la API la repite sola
        # con otro modelo en la misma llamada en vez de cortar la respuesta.
        extra = {"betas": ["server-side-fallback-2026-07-01"],
                 "extra_body": {"fallbacks": "default"}}
    partes = []
    try:
        with cliente.beta.messages.stream(model=modelo, max_tokens=32000, system=sistema,
                                          messages=mensajes, **extra) as flujo:
            for trozo in flujo.text_stream:
                partes.append(trozo)
                al_texto(trozo)
            final = flujo.get_final_message()
    except anthropic.AuthenticationError:
        raise ErrorIA("La clave de Claude no es valida.")
    except anthropic.RateLimitError:
        raise ErrorIA("Claude: limite de uso alcanzado, prueba en un momento.")
    except anthropic.APIStatusError as e:
        raise ErrorIA("Claude respondio %s: %s" % (e.status_code, str(e)[:300]))
    except anthropic.APIConnectionError:
        raise ErrorIA("No hay conexion con Claude.")
    if final.stop_reason == "refusal":
        raise ErrorIA("Claude rechazo esta peticion.")
    return "".join(partes)


# ------------------------------------------------------------- despacho --

def config(ajustes):
    ia = dict((ajustes or {}).get("ia") or {})
    ia.setdefault("proveedor", "ollama")
    ia.setdefault("modelo_ollama", "")
    ia.setdefault("modelo_claude", CLAUDE_POR_DEFECTO)
    ia.setdefault("clave_claude", "")
    return ia


def estado(ajustes):
    ia = config(ajustes)
    activo = ollama_activo()
    locales = modelos_ollama() if activo else []
    elegido = ia["modelo_ollama"]
    if locales and elegido not in [m["id"] for m in locales]:
        elegido = locales[0]["id"]
    return {
        "proveedor": ia["proveedor"],
        "ollama": {"instalado": bool(_exe_ollama()) or activo, "activo": activo,
                   "modelos": locales, "modelo": elegido},
        "claude": {"configurado": bool(ia["clave_claude"]), "modelo": ia["modelo_claude"],
                   "modelos": MODELOS_CLAUDE},
    }


def _resolver(ajustes):
    """(proveedor, modelo, clave) listos para usar, o un error que se entienda."""
    ia = config(ajustes)
    if ia["proveedor"] == "claude":
        if not ia["clave_claude"]:
            raise ErrorIA("Falta la clave de Claude: ponla en AJUSTES o vuelve a Ollama.")
        return "claude", ia["modelo_claude"] or CLAUDE_POR_DEFECTO, ia["clave_claude"]
    if not encender_ollama():
        raise ErrorIA("Ollama no esta instalado o no arranca. Instalalo desde ollama.com "
                      "o configura Claude en AJUSTES.")
    locales = [m["id"] for m in modelos_ollama()]
    if not locales:
        raise ErrorIA("Ollama no tiene modelos. Descarga uno, por ejemplo: ollama pull gemma3")
    modelo = ia["modelo_ollama"] if ia["modelo_ollama"] in locales else locales[0]
    return "ollama", modelo, ""


def generar(ajustes, sistema, mensajes, al_texto=lambda t: None):
    proveedor, modelo, clave = _resolver(ajustes)
    if proveedor == "claude":
        return _generar_claude(modelo, clave, sistema, mensajes, al_texto)
    return _generar_ollama(modelo, sistema, mensajes, al_texto)


def etiqueta_modelo(ajustes):
    try:
        proveedor, modelo, _ = _resolver(ajustes)
        return "%s · %s" % (proveedor, modelo)
    except ErrorIA:
        return ""


# ------------------------------------------------------------- preguntar --

SISTEMA_PREGUNTAR = """Eres Tiro, un asistente que responde preguntas sobre transcripciones de audio y video.
Reglas:
- Responde solo con lo que dicen los fragmentos. Si no esta, dilo claramente y no inventes.
- Cita cada dato con el numero del fragmento entre corchetes, por ejemplo [2] o [1][3].
- Responde en el idioma de la pregunta, directo y breve. Usa listas cuando ayuden.
- No menciones "fragmentos" ni estas reglas: habla del contenido."""


def preguntar(ajustes, pregunta, ids=None, historial=None, al_texto=lambda t: None,
              al_fase=lambda t: None):
    """Devuelve {"texto", "fuentes"}. Las fuentes llevan id y segundo para saltar."""
    pregunta = (pregunta or "").strip()
    if not pregunta:
        raise ErrorIA("Escribe una pregunta.")
    al_fase("Buscando en la biblioteca")

    fuentes = []
    if ids and len(ids) == 1:
        # Una sola transcripcion corta: mejor darsela entera que trocearla.
        e = biblioteca.obtener(ids[0])
        if e and len(biblioteca.texto_plano(e)) < LIMITE["ollama"] * 0.8:
            for f in biblioteca._fragmentar(e):
                fuentes.append({"id": f["id"], "nombre": f["nombre"], "ini": f["ini"],
                                "fin": f["fin"], "texto": f["texto"]})
    if not fuentes:
        consulta = pregunta
        if historial:
            consulta += " " + " ".join(m["content"] for m in historial[-2:]
                                       if m.get("role") == "user")
        fuentes = biblioteca.buscar(consulta, ids=ids, k=8)
    if not fuentes:
        raise ErrorIA("No encontre nada relacionado en la biblioteca. "
                      "Prueba con otras palabras o transcribe primero el audio.")

    bloques = ["[%d] %s · %s-%s\n%s" % (i, f["nombre"], biblioteca.reloj(f["ini"]),
                                         biblioteca.reloj(f["fin"]), f["texto"])
               for i, f in enumerate(fuentes, 1)]
    mensajes = [m for m in (historial or [])[-6:]
                if m.get("role") in ("user", "assistant") and m.get("content")]
    mensajes.append({"role": "user", "content":
                     "Fragmentos:\n\n%s\n\nPregunta: %s" % ("\n\n".join(bloques), pregunta)})
    al_fase("Pensando con %s" % etiqueta_modelo(ajustes))
    texto = generar(ajustes, SISTEMA_PREGUNTAR, mensajes, al_texto)
    return {"texto": texto,
            "fuentes": [{"n": i, "id": f["id"], "nombre": f["nombre"], "ini": f["ini"],
                         "fin": f["fin"]} for i, f in enumerate(fuentes, 1)]}


# ----------------------------------------------------------------- crear --

TIPOS = {
    "resumen": {
        "etiqueta": "Resumen", "detalle": "Ideas clave en 1 minuto de lectura",
        "marcas": False,
        "prompt": "Escribe un resumen claro de esta transcripcion: un parrafo inicial con la idea "
                  "central y despues las ideas clave en una lista con vinetas. Sin relleno."},
    "capitulos": {
        "etiqueta": "Capitulos", "detalle": "Marcas de tiempo listas para YouTube",
        "marcas": True,
        "prompt": "Crea los capitulos del video para pegar en la descripcion de YouTube. Una linea "
                  "por capitulo con el formato `M:SS Titulo` (o `H:MM:SS` si pasa de una hora), "
                  "empezando en 0:00, entre 5 y 15 capitulos, titulos de 2 a 6 palabras. Usa los "
                  "tiempos reales de la transcripcion. Devuelve solo las lineas."},
    "guia": {
        "etiqueta": "Guia", "detalle": "Documento paso a paso descargable",
        "marcas": False,
        "prompt": "Convierte esta transcripcion en una guia practica descargable: titulo, "
                  "introduccion breve, secciones con `##`, pasos accionables y ejemplos sacados "
                  "del contenido, y un cierre con siguientes pasos. Formato Markdown."},
    "checklist": {
        "etiqueta": "Checklist", "detalle": "Acciones concretas para marcar",
        "marcas": False,
        "prompt": "Convierte esta transcripcion en un checklist accionable en Markdown: categorias "
                  "con `##` y cada accion como `- [ ]`, concreta y medible. Anade una nota corta "
                  "solo donde ayude."},
    "apuntes": {
        "etiqueta": "Apuntes", "detalle": "Notas de estudio y preguntas de repaso",
        "marcas": True,
        "prompt": "Haz apuntes de estudio de esta transcripcion: conceptos clave con su definicion, "
                  "ejemplos, la marca de tiempo donde se explica cada uno entre parentesis, y al "
                  "final 5 preguntas de repaso con su respuesta. Formato Markdown."},
    "reel": {
        "etiqueta": "Guion de reel", "detalle": "30-60 s con gancho, cuerpo y llamada",
        "marcas": False,
        "prompt": "Escribe un guion de reel de 30 a 60 segundos basado en la idea mas potente de "
                  "esta transcripcion. Estructura: GANCHO (menos de 2 segundos, habla de tu, "
                  "dolor o contraste), DESARROLLO (3 a 5 frases cortas), CTA. Anade debajo 3 "
                  "titulares alternativos de maximo 7 palabras."},
    "post": {
        "etiqueta": "Post / hilo", "detalle": "Texto para redes o newsletter",
        "marcas": False,
        "prompt": "Escribe un post para redes (o un hilo de 5 a 8 partes numeradas) con lo mas "
                  "util de esta transcripcion. Frases cortas, una idea por linea, sin emojis de "
                  "relleno y con una pregunta final para comentarios."},
    "citas": {
        "etiqueta": "Citas", "detalle": "Frases textuales con su minuto",
        "marcas": True,
        "prompt": "Extrae las 8 a 12 frases mas memorables, TEXTUALES, de esta transcripcion. Una "
                  "por linea con el formato `M:SS - \"frase\"`. No las reescribas."},
}

SISTEMA_CREAR = """Eres Tiro, un editor que convierte transcripciones en contenido util.
Escribe en el idioma de la transcripcion salvo que se pida otro. Usa solo informacion de la
transcripcion; no inventes datos, cifras ni nombres. Devuelve directamente el resultado,
sin preambulos del tipo "Aqui tienes"."""


def _partir(texto, limite, por_lineas):
    """Corta en partes de como mucho `limite` caracteres sin romper lineas o frases."""
    sep = "\n" if por_lineas else ". "
    partes, actual = [], ""
    for trozo in texto.split(sep):
        if len(actual) + len(trozo) > limite and actual:
            partes.append(actual)
            actual = ""
        actual += trozo + sep
    if actual:
        partes.append(actual)
    return partes


def crear(ajustes, tipo, eid, instrucciones="", al_texto=lambda t: None, al_fase=lambda t: None):
    if tipo not in TIPOS:
        raise ErrorIA("Tipo desconocido: %s" % tipo)
    e = biblioteca.obtener(eid)
    if not e:
        raise ErrorIA("Esa transcripcion ya no esta en la biblioteca.")
    t = TIPOS[tipo]
    texto = biblioteca.texto_plano(e, marcas=t["marcas"])
    proveedor, _, _ = _resolver(ajustes)
    limite = LIMITE[proveedor]
    pedido = t["prompt"]
    if instrucciones.strip():
        pedido += "\n\nIndicaciones del usuario: " + instrucciones.strip()[:1500]

    if len(texto) > limite:
        # Dos pasadas: notas fieles de cada parte (con sus tiempos) y despues
        # el resultado sobre las notas. Nada se recorta en silencio.
        partes = _partir(texto, limite, t["marcas"])
        notas = []
        for i, p in enumerate(partes, 1):
            al_fase("Leyendo parte %d de %d" % (i, len(partes)))
            notas.append(generar(ajustes, SISTEMA_CREAR, [{"role": "user", "content":
                "Toma notas detalladas y fieles de esta parte de una transcripcion, conservando "
                "datos, ejemplos, nombres y las marcas de tiempo [M:SS] si las hay:\n\n" + p}]))
        texto = "\n\n".join("NOTAS PARTE %d:\n%s" % (i, n) for i, n in enumerate(notas, 1))

    al_fase("Escribiendo con %s" % etiqueta_modelo(ajustes))
    resultado = generar(ajustes, SISTEMA_CREAR, [{"role": "user", "content":
        "Transcripcion de \"%s\":\n\n%s\n\n---\n%s" % (e.get("nombre", ""), texto, pedido)}],
        al_texto)

    e = biblioteca.obtener(eid) or e           # por si se renombro mientras tanto
    e.setdefault("recursos", []).insert(0, {
        "tipo": tipo, "creado": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "modelo": etiqueta_modelo(ajustes), "texto": resultado})
    e["recursos"] = e["recursos"][:30]
    biblioteca.guardar(e)
    return resultado
