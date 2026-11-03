"""
Tiro - servidor local.

Sirve la interfaz y coordina todo: la cola de transcripcion (un archivo detras
de otro, cada uno troceado y transcrito en paralelo por dentro), las
descargas de enlaces, la biblioteca y las respuestas de la IA, que llegan a la
pagina en vivo (SSE para la cola, NDJSON para preguntar y crear).

    python server.py [--port 5240]
"""

import argparse
import atexit
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

import biblioteca
import enlaces
import ia
import motor

RAIZ = os.path.dirname(os.path.abspath(__file__))
DATOS = os.path.join(os.path.expanduser("~"), "Documents", "Tiro")
AJUSTES_PATH = os.path.join(DATOS, "ajustes.json")
CARPETA_DEFECTO = os.path.join(DATOS, "exportado")
SUBIDAS = tempfile.mkdtemp(prefix="verba_subidas_")
atexit.register(lambda: shutil.rmtree(SUBIDAS, ignore_errors=True))

MAX_SUBIDA = 8 * 1024 * 1024 * 1024          # 8 GB por archivo
PROHIBIDO = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
PAGINAS = {"/", "/transcribir", "/biblioteca", "/preguntar", "/crear", "/ajustes"}


# ------------------------------------------------------------------- bus --

class Bus:
    """Reparte sucesos a todas las pestanas conectadas por SSE."""

    def __init__(self):
        self.lock = threading.Lock()
        self.oyentes = []

    def suscribir(self):
        q = queue.Queue(maxsize=4000)
        with self.lock:
            self.oyentes.append(q)
        return q

    def cancelar(self, q):
        with self.lock:
            if q in self.oyentes:
                self.oyentes.remove(q)

    def emitir(self, suceso):
        with self.lock:
            oyentes = list(self.oyentes)
        for q in oyentes:
            try:
                q.put_nowait(suceso)
            except queue.Full:
                pass


BUS = Bus()


# --------------------------------------------------------------- trabajos --

class Trabajo:
    def __init__(self, ruta, nombre, ajustes, temporal=False, origen="archivo", url=""):
        self.id = uuid.uuid4().hex[:12]
        self.ruta = ruta
        self.nombre = nombre
        self.base = os.path.splitext(nombre)[0] if origen != "enlace" else nombre
        self.ajustes = ajustes
        self.temporal = temporal
        self.origen = origen          # archivo | enlace | dictado
        self.url = url
        self.estado = "en_cola"       # descargando | en_cola | trabajando | listo | error | cancelado
        self.fase = "En cola"
        self.progreso = 0.0
        self.idioma = ajustes.get("idioma") or ""
        self.idioma_prob = 0.0
        self.segmentos = []
        self.error = ""
        self.duracion = motor.duracion_media(ruta) if ruta else 0.0
        self.segundos = 0.0
        self.trozos = 0
        self.cancelar = False
        self.eid = ""                 # id en la biblioteca cuando termina

    def resumen(self, con_segmentos=False):
        d = {
            "id": self.id, "nombre": self.nombre, "base": self.base,
            "origen": self.origen, "url": self.url,
            "estado": self.estado, "fase": self.fase,
            "progreso": round(self.progreso, 4),
            "idioma": self.idioma, "idioma_prob": round(self.idioma_prob, 3),
            "duracion": round(self.duracion, 2), "segundos": self.segundos,
            "trozos": self.trozos, "error": self.error,
            "n_segmentos": len(self.segmentos), "eid": self.eid,
            "modelo": self.ajustes.get("modelo", ""),
        }
        if con_segmentos:
            d["segmentos"] = self.segmentos
        return d


TRABAJOS = {}
ORDEN = []
LOCK = threading.Lock()
COLA = queue.Queue()
DESCARGAS = ThreadPoolExecutor(max_workers=3, thread_name_prefix="descarga")


def anotar(trabajo):
    with LOCK:
        TRABAJOS[trabajo.id] = trabajo
        ORDEN.append(trabajo.id)
    BUS.emitir({"tipo": "trabajo", "trabajo": trabajo.resumen()})


def registrar(trabajo):
    anotar(trabajo)
    COLA.put(trabajo.id)


def avisar(t):
    BUS.emitir({"tipo": "trabajo", "trabajo": t.resumen()})


class Sucesos:
    """Puente entre el motor y el bus, con el progreso limitado en frecuencia."""

    def __init__(self, trabajo):
        self.t = trabajo
        self.ultimo = 0.0

    def fase(self, texto):
        self.t.fase = texto
        BUS.emitir({"tipo": "fase", "id": self.t.id, "texto": texto})

    def progreso(self, valor):
        self.t.progreso = max(self.t.progreso, min(1.0, valor))
        ahora = time.time()
        if ahora - self.ultimo < 0.2 and valor < 1.0:
            return
        self.ultimo = ahora
        BUS.emitir({"tipo": "progreso", "id": self.t.id,
                    "valor": round(self.t.progreso, 4)})

    def idioma(self, codigo, prob):
        self.t.idioma, self.t.idioma_prob = codigo, prob
        BUS.emitir({"tipo": "idioma", "id": self.t.id,
                    "codigo": codigo, "prob": round(prob, 3)})

    def segmento(self, dato):
        BUS.emitir({"tipo": "segmento", "id": self.t.id,
                    "ini": round(dato["ini"], 2), "fin": round(dato["fin"], 2),
                    "texto": dato["texto"]})

    def cancelado(self):
        return self.t.cancelar


def a_biblioteca(t):
    """Lo transcrito pasa a la biblioteca: buscable, preguntable y exportable."""
    entrada = biblioteca.guardar({
        "nombre": t.base, "origen": t.origen, "url": t.url,
        "idioma": t.idioma, "duracion": round(t.duracion, 2),
        "modelo": t.ajustes.get("modelo", ""), "segundos": t.segundos,
        "segmentos": [{"ini": round(s["ini"], 2), "fin": round(s["fin"], 2),
                       "texto": s["texto"]} for s in t.segmentos],
    })
    t.eid = entrada["id"]


def limpiar_temporal(t):
    if t.temporal and t.ruta:
        try:
            os.remove(t.ruta)
        except OSError:
            pass


def obrero():
    """Hilo unico que va sacando trabajos de la cola."""
    while True:
        tid = COLA.get()
        with LOCK:
            t = TRABAJOS.get(tid)
        if not t or t.cancelar:
            if t:
                t.estado, t.fase = "cancelado", "Cancelado"
                avisar(t)
                limpiar_temporal(t)
            COLA.task_done()
            continue

        t.estado, t.fase = "trabajando", "Preparando"
        avisar(t)
        try:
            res = motor.transcribir(t.ruta, t.ajustes, Sucesos(t))
            t.segmentos = res["segmentos"]
            t.idioma = res["idioma"]
            t.duracion = res["duracion"]
            t.segundos = res["segundos"]
            t.trozos = res["trozos"]
            t.progreso = 1.0
            if t.segmentos:
                a_biblioteca(t)
            t.estado = "listo"
            veloz = (t.duracion / t.segundos) if t.segundos else 0
            t.fase = "Listo en %ss · %.1fx tiempo real" % (t.segundos, veloz)
        except motor.Cancelado:
            t.estado, t.fase = "cancelado", "Cancelado"
        except Exception as e:
            t.estado, t.fase = "error", "Error"
            t.error = (str(e) or e.__class__.__name__)[:400]
        finally:
            limpiar_temporal(t)
            avisar(t)
            BUS.emitir({"tipo": "fin", "id": t.id, "estado": t.estado, "eid": t.eid})
            COLA.task_done()


def bajar(t):
    """Descarga el audio de un enlace y lo mete en la cola de transcripcion."""
    if t.cancelar:
        t.estado, t.fase = "cancelado", "Cancelado"
        avisar(t)
        return
    s = Sucesos(t)
    try:
        s.fase("Bajando el audio")
        ruta, titulo, dur = enlaces.descargar(
            t.url, al_avanzar=lambda p: s.progreso(p * 0.05), cancelado=s.cancelado)
        t.ruta, t.temporal = ruta, True
        t.nombre = t.base = titulo or t.nombre
        t.duracion = motor.duracion_media(ruta) or dur or 0.0
        t.estado, t.fase = "en_cola", "En cola"
        avisar(t)
        COLA.put(t.id)
    except enlaces.Cancelado:
        t.estado, t.fase = "cancelado", "Cancelado"
        avisar(t)
    except Exception as e:
        t.estado, t.fase = "error", "Error"
        t.error = ("No se pudo bajar: %s" % (str(e) or e.__class__.__name__))[:400]
        avisar(t)


# -------------------------------------------------------- dialogos nativos --

_PS_ARCHIVOS = r"""
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$d = New-Object System.Windows.Forms.OpenFileDialog
$d.Multiselect = $true
$d.Title = 'Elige los audios o videos a transcribir'
$d.Filter = 'Audio y video|%FILTRO%|Todos los archivos|*.*'
$f = New-Object System.Windows.Forms.Form
$f.TopMost = $true
if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) {
  $d.FileNames -join [Environment]::NewLine
}
"""

_PS_CARPETA = r"""
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Carpeta donde guardar lo exportado'
$d.ShowNewFolderButton = $true
$f = New-Object System.Windows.Forms.Form
$f.TopMost = $true
if ($d.ShowDialog($f) -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath }
"""

_lock_dialogo = threading.Lock()


def _powershell(script):
    exe = shutil.which("powershell") or shutil.which("pwsh")
    if not exe:
        return []
    r = subprocess.run([exe, "-NoProfile", "-STA", "-NonInteractive", "-Command", script],
                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                       creationflags=motor._SIN_VENTANA)
    salida = r.stdout.decode("utf-8", "ignore") if r.stdout else ""
    return [l.strip() for l in salida.splitlines() if l.strip()]


def _tk(carpeta):
    try:
        import tkinter
        from tkinter import filedialog
    except Exception:
        return []
    raiz = tkinter.Tk()
    raiz.withdraw()
    try:
        raiz.attributes("-topmost", True)
        if carpeta:
            r = filedialog.askdirectory(title="Carpeta donde guardar")
            return [r] if r else []
        return list(filedialog.askopenfilenames(title="Elige los audios o videos"))
    except Exception:
        return []
    finally:
        raiz.destroy()


def elegir(carpeta=False):
    """Dialogo nativo del sistema. Da rutas reales: cero copias, cero espera."""
    with _lock_dialogo:
        if os.name == "nt":
            filtro = ";".join("*" + e for e in motor.EXTENSIONES)
            script = _PS_CARPETA if carpeta else _PS_ARCHIVOS.replace("%FILTRO%", filtro)
            rutas = _powershell(script)
            if rutas:
                return rutas
        return _tk(carpeta)


# ---------------------------------------------------------------- ajustes --

_lock_ajustes = threading.Lock()


def leer_ajustes():
    try:
        with open(AJUSTES_PATH, "r", encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def mezclar_ajustes(cambios):
    """Funde los cambios con lo guardado (asi la pagina no pisa la clave de Claude)."""
    with _lock_ajustes:
        d = leer_ajustes()
        for k, v in (cambios or {}).items():
            if isinstance(v, dict) and isinstance(d.get(k), dict):
                d[k].update(v)
            else:
                d[k] = v
        os.makedirs(DATOS, exist_ok=True)
        with open(AJUSTES_PATH, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
        return d


def ajustes_publicos(d):
    """Lo que ve la pagina: la clave de Claude nunca sale, solo si existe."""
    d = json.loads(json.dumps(d))
    if isinstance(d.get("ia"), dict) and d["ia"].get("clave_claude"):
        d["ia"]["clave_claude"] = "guardada"
    return d


# ----------------------------------------------------------------- guardar --

def nombre_seguro(texto, por_defecto="transcripcion"):
    limpio = PROHIBIDO.sub("_", (texto or "").strip()).strip(" .")
    return limpio[:150] or por_defecto


def escribir(carpeta, base, ext, texto):
    carpeta = os.path.abspath(os.path.expanduser(carpeta or CARPETA_DEFECTO))
    os.makedirs(carpeta, exist_ok=True)
    base = nombre_seguro(base)
    destino = os.path.join(carpeta, base + ext)
    n = 2
    while os.path.exists(destino):
        destino = os.path.join(carpeta, "%s (%d)%s" % (base, n, ext))
        n += 1
    with open(destino, "w", encoding="utf-8", newline="\n") as f:
        f.write(texto)
    return destino


def formatear_entrada(e, formato):
    meta = {"archivo": e.get("nombre", ""), "idioma": e.get("idioma", ""),
            "duracion": e.get("duracion", 0), "modelo": e.get("modelo", ""),
            "origen": e.get("url") or e.get("origen", ""), "generado": e.get("creado", "")}
    return motor.formatear(formato, e.get("segmentos") or [], meta)


def _hay_whisper():
    try:
        import faster_whisper           # noqa: F401
        return True
    except Exception:
        return False


# ---------------------------------------------------------------- handler --

class Handler(SimpleHTTPRequestHandler):
    server_version = "Tiro/1.0"
    protocol_version = "HTTP/1.1"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=RAIZ, **kw)

    # --- utilidades ---------------------------------------------------
    def _json(self, obj, codigo=200):
        cuerpo = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(codigo)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(cuerpo)

    def _cuerpo(self):
        largo = int(self.headers.get("Content-Length") or 0)
        if largo <= 0:
            return {}
        return json.loads(self.rfile.read(largo).decode("utf-8"))

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def log_message(self, formato, *args):
        if self.path.startswith("/api/") and "eventos" not in self.path:
            sys.stderr.write("  %s\n" % (formato % args))

    def _trabajo(self, tid):
        with LOCK:
            return TRABAJOS.get(tid)

    def _flujo(self):
        """Respuesta NDJSON en vivo. Devuelve una funcion para enviar cada linea."""
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        def enviar(obj):
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()
        return enviar

    def _permitido(self):
        """
        La API solo responde a la propia app. Sin esto, cualquier web abierta en
        el navegador podria encolar archivos, leer la biblioteca o cambiar ajustes.
        """
        puerto = self.server.server_address[1]
        host = self.headers.get("Host") or ""
        if host not in ("127.0.0.1:%d" % puerto, "localhost:%d" % puerto):
            return False
        origen = self.headers.get("Origin")
        return not origen or origen == "http://" + host

    # --- GET ----------------------------------------------------------
    def do_GET(self):
        ruta = urlparse(self.path)
        if ruta.path in PAGINAS:
            # URLs limpias: /biblioteca, /preguntar... todas sirven la misma pagina
            self.path = "/index.html"
            return super().do_GET()
        if not ruta.path.startswith("/api/"):
            return super().do_GET()
        if not self._permitido():
            return self._json({"error": "origen no permitido"}, 403)

        q = parse_qs(ruta.query)
        uno = lambda k, d="": (q.get(k) or [d])[0]

        if ruta.path == "/api/estado":
            cap = motor.capacidades()
            ajustes = leer_ajustes()
            return self._json({
                "ok": True,
                "ffmpeg": bool(motor.FFMPEG),
                "whisper": _hay_whisper(),
                "ytdlp": enlaces.disponible(),
                "cap": cap,
                "idiomas": [{"codigo": c, "nombre": n} for c, n in motor.IDIOMAS],
                "modelos": [{"clave": k, "etiqueta": v["etiqueta"],
                             "listo": motor.modelo_descargado(k)}
                            for k, v in motor.MODELOS.items()],
                "formatos": [{"clave": k, "etiqueta": v["etiqueta"]}
                             for k, v in motor.FORMATOS.items()],
                "tipos": [{"clave": k, "etiqueta": v["etiqueta"], "detalle": v["detalle"]}
                          for k, v in ia.TIPOS.items()],
                "modelo_defecto": motor.MODELO_POR_DEFECTO,
                "extensiones": motor.EXTENSIONES,
                "carpeta_defecto": ajustes.get("carpeta") or CARPETA_DEFECTO,
                "carpeta_biblioteca": biblioteca.CARPETA,
                "ajustes": ajustes_publicos(ajustes),
            })

        if ruta.path == "/api/ia":
            return self._json(ia.estado(leer_ajustes()))

        if ruta.path == "/api/trabajos":
            with LOCK:
                lista = [TRABAJOS[i].resumen() for i in ORDEN if i in TRABAJOS]
            return self._json({"trabajos": lista})

        if ruta.path == "/api/texto":
            t = self._trabajo(uno("id"))
            if not t:
                return self._json({"error": "no existe"}, 404)
            texto, _ = motor.formatear(uno("formato", "txt"), t.segmentos,
                                       {"archivo": t.nombre, "idioma": t.idioma})
            return self._json({"texto": texto, "nombre": t.base})

        if ruta.path == "/api/biblioteca":
            return self._json({"entradas": biblioteca.listar(),
                               "stats": biblioteca.estadisticas()})

        if ruta.path == "/api/biblioteca/uno":
            e = biblioteca.obtener(uno("id"))
            if not e:
                return self._json({"error": "no existe"}, 404)
            return self._json(e)

        if ruta.path == "/api/biblioteca/texto":
            e = biblioteca.obtener(uno("id"))
            if not e:
                return self._json({"error": "no existe"}, 404)
            texto, ext = formatear_entrada(e, uno("formato", "txt"))
            return self._json({"texto": texto, "ext": ext, "nombre": e.get("nombre", "")})

        if ruta.path == "/api/buscar":
            ids = [i for i in uno("ids").split(",") if i]
            return self._json({"resultados": biblioteca.buscar(uno("q"), ids=ids or None,
                                                               k=int(uno("k", "30") or 30))})

        if ruta.path == "/api/elegir":
            return self._json({"rutas": elegir(carpeta=(uno("tipo") == "carpeta"))})

        if ruta.path == "/api/abrir":
            destino = uno("ruta")
            if destino and os.path.exists(destino):
                try:
                    os.startfile(destino if os.path.isdir(destino)
                                 else os.path.dirname(destino))
                except Exception:
                    pass
            return self._json({"ok": True})

        if ruta.path == "/api/eventos":
            return self._sse()

        return self._json({"error": "ruta desconocida"}, 404)

    # --- SSE ----------------------------------------------------------
    def _sse(self):
        # El cuerpo no lleva longitud ni troceado: se delimita cerrando el
        # socket, asi que esta conexion se dedica solo a este flujo.
        self.close_connection = True
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()

        q = BUS.suscribir()
        try:
            self.wfile.write(b": conectado\n\n")
            self.wfile.flush()
            while True:
                try:
                    suceso = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")   # mantiene viva la conexion
                    self.wfile.flush()
                    continue
                dato = json.dumps(suceso, ensure_ascii=False)
                self.wfile.write(("data: %s\n\n" % dato).encode("utf-8"))
                self.wfile.flush()
        except Exception:
            pass
        finally:
            BUS.cancelar(q)

    # --- POST ---------------------------------------------------------
    def do_POST(self):
        ruta = urlparse(self.path)
        if not self._permitido():
            self.close_connection = True      # sin leer el cuerpo: no se reutiliza
            return self._json({"error": "origen no permitido"}, 403)

        if ruta.path == "/api/subir":
            return self._subir()

        try:
            cuerpo = self._cuerpo()
        except Exception:
            return self._json({"error": "json invalido"}, 400)

        rutas = {
            "/api/encolar": self._encolar,
            "/api/enlaces": self._enlaces,
            "/api/cancelar": self._cancelar,
            "/api/borrar": self._borrar,
            "/api/ajustes": self._ajustes,
            "/api/ia/encender": lambda c: self._json({"ok": ia.encender_ollama()}),
            "/api/biblioteca/borrar": lambda c: self._json({"ok": biblioteca.borrar(c.get("id"))}),
            "/api/biblioteca/renombrar": self._renombrar,
            "/api/exportar": self._exportar,
            "/api/escribir": self._escribir,
            "/api/preguntar": self._preguntar,
            "/api/crear": self._crear,
        }
        accion = rutas.get(ruta.path)
        if not accion:
            return self._json({"error": "ruta desconocida"}, 404)
        return accion(cuerpo)

    def _subir(self):
        """Recibe los bytes de un archivo soltado en la ventana o de un dictado."""
        nombre = unquote(self.headers.get("X-Nombre") or "audio")
        nombre = nombre_seguro(os.path.basename(nombre), "audio")
        largo = int(self.headers.get("Content-Length") or 0)
        if largo <= 0:
            return self._json({"error": "archivo vacio"}, 400)
        if largo > MAX_SUBIDA:
            return self._json({"error": "archivo demasiado grande"}, 413)

        destino = os.path.join(SUBIDAS, uuid.uuid4().hex[:8] + "_" + nombre)
        restante = largo
        try:
            with open(destino, "wb") as f:
                while restante > 0:
                    trozo = self.rfile.read(min(1 << 20, restante))
                    if not trozo:
                        break
                    f.write(trozo)
                    restante -= len(trozo)
        except Exception as e:
            return self._json({"error": str(e)[:200]}, 500)
        if restante > 0:
            try:
                os.remove(destino)
            except OSError:
                pass
            return self._json({"error": "la subida se corto"}, 400)
        return self._json({"ok": True, "ruta": destino, "nombre": nombre})

    @staticmethod
    def _ajustes_trabajo(cuerpo):
        return {
            "idioma": (cuerpo.get("idioma") or "").strip(),
            "modelo": cuerpo.get("modelo") or motor.MODELO_POR_DEFECTO,
            "vocabulario": (cuerpo.get("vocabulario") or "").strip()[:900],
            "fiel": bool(cuerpo.get("fiel", True)),
            "workers": cuerpo.get("workers") or 0,
        }

    def _encolar(self, cuerpo):
        ajustes = self._ajustes_trabajo(cuerpo)
        nuevos, rechazados = [], []
        for item in (cuerpo.get("archivos") or [])[:500]:
            if isinstance(item, str):
                item = {"ruta": item}
            ruta = item.get("ruta") or ""
            if not ruta or not os.path.isfile(ruta):
                rechazados.append({"nombre": item.get("nombre") or ruta,
                                   "motivo": "no se encuentra el archivo"})
                continue
            nombre = item.get("nombre") or os.path.basename(ruta)
            ext = os.path.splitext(nombre)[1].lower()
            if ext and ext not in motor.EXTENSIONES:
                rechazados.append({"nombre": nombre,
                                   "motivo": "formato no reconocido (%s)" % ext})
                continue
            origen = "dictado" if item.get("origen") == "dictado" else "archivo"
            t = Trabajo(ruta, nombre, ajustes,
                        temporal=os.path.dirname(ruta) == SUBIDAS, origen=origen)
            registrar(t)
            nuevos.append(t.resumen())
        return self._json({"encolados": nuevos, "rechazados": rechazados})

    def _enlaces(self, cuerpo):
        if not enlaces.disponible():
            return self._json({"error": "falta yt-dlp: vuelve a ejecutar start.bat"}, 400)
        ajustes = self._ajustes_trabajo(cuerpo)
        urls = [u.strip() for u in re.split(r"\s+", cuerpo.get("texto") or "")
                if u.strip().startswith("http")][:50]
        if not urls:
            return self._json({"error": "no hay enlaces que empiecen por http"}, 400)
        nuevos, rechazados = [], []
        for u in urls:
            try:
                videos = enlaces.expandir(u)
            except Exception as e:
                rechazados.append({"nombre": u, "motivo": str(e).split("\n")[0][:200]})
                continue
            for enlace, titulo, dur in videos:
                t = Trabajo("", titulo, ajustes, origen="enlace", url=enlace)
                t.duracion = float(dur or 0)
                t.estado, t.fase = "descargando", "Esperando para bajar"
                anotar(t)
                DESCARGAS.submit(bajar, t)
                nuevos.append(t.resumen())
        return self._json({"encolados": nuevos, "rechazados": rechazados})

    def _cancelar(self, cuerpo):
        tid = cuerpo.get("id")
        with LOCK:
            objetivo = ([TRABAJOS[tid]] if tid and tid in TRABAJOS else
                        [t for t in TRABAJOS.values()
                         if t.estado in ("en_cola", "trabajando", "descargando")])
        for t in objetivo:
            t.cancelar = True
            if t.estado == "en_cola":
                t.estado, t.fase = "cancelado", "Cancelado"
                avisar(t)
        return self._json({"ok": True, "cancelados": len(objetivo)})

    def _borrar(self, cuerpo):
        tid = cuerpo.get("id")
        with LOCK:
            t = TRABAJOS.pop(tid, None)
            if tid in ORDEN:
                ORDEN.remove(tid)
        if t:
            t.cancelar = True
            if t.estado not in ("trabajando",):
                limpiar_temporal(t)
        return self._json({"ok": True})

    def _ajustes(self, cuerpo):
        cambios = {}
        if "carpeta" in cuerpo:
            cambios["carpeta"] = str(cuerpo["carpeta"] or "")[:500]
        if isinstance(cuerpo.get("ia"), dict):
            permitido = {"proveedor", "modelo_ollama", "modelo_claude", "clave_claude"}
            cambios["ia"] = {k: str(v)[:300] for k, v in cuerpo["ia"].items() if k in permitido}
            if cambios["ia"].get("clave_claude") == "guardada":
                cambios["ia"].pop("clave_claude")
        return self._json({"ajustes": ajustes_publicos(mezclar_ajustes(cambios))})

    def _renombrar(self, cuerpo):
        r = biblioteca.renombrar(cuerpo.get("id"), cuerpo.get("nombre"))
        return self._json({"entrada": r} if r else {"error": "no existe"}, 200 if r else 404)

    def _exportar(self, cuerpo):
        """Escribe una o varias transcripciones de la biblioteca en disco."""
        formato = cuerpo.get("formato") or "txt"
        carpeta = cuerpo.get("carpeta") or leer_ajustes().get("carpeta") or CARPETA_DEFECTO
        hechos, fallos = [], []
        for eid in (cuerpo.get("ids") or [])[:1000]:
            e = biblioteca.obtener(eid)
            if not e:
                fallos.append({"id": eid, "motivo": "no existe"})
                continue
            try:
                texto, ext = formatear_entrada(e, formato)
                hechos.append({"id": eid, "ruta": escribir(carpeta, e.get("nombre"), ext, texto)})
            except Exception as ex:
                fallos.append({"id": eid, "motivo": str(ex)[:200]})
        if hechos and cuerpo.get("carpeta"):
            mezclar_ajustes({"carpeta": cuerpo["carpeta"]})
        return self._json({"guardados": hechos, "fallos": fallos})

    def _escribir(self, cuerpo):
        """Guarda un texto suelto (lo creado con IA) como .md o .txt."""
        ext = ".md" if cuerpo.get("ext") != ".txt" else ".txt"
        carpeta = cuerpo.get("carpeta") or leer_ajustes().get("carpeta") or CARPETA_DEFECTO
        try:
            destino = escribir(carpeta, cuerpo.get("nombre") or "tiro", ext,
                               cuerpo.get("texto") or "")
        except Exception as e:
            return self._json({"error": str(e)[:200]}, 500)
        return self._json({"ruta": destino})

    def _preguntar(self, cuerpo):
        enviar = self._flujo()
        try:
            r = ia.preguntar(leer_ajustes(), cuerpo.get("pregunta"),
                             ids=[i for i in (cuerpo.get("ids") or []) if i] or None,
                             historial=cuerpo.get("historial") or [],
                             al_texto=lambda t: enviar({"t": "texto", "v": t}),
                             al_fase=lambda f: enviar({"t": "fase", "v": f}))
            enviar({"t": "fuentes", "v": r["fuentes"]})
            enviar({"t": "fin"})
        except ia.ErrorIA as e:
            self._error_flujo(enviar, str(e))
        except (BrokenPipeError, ConnectionError):
            pass                                  # la pagina cancelo
        except Exception as e:
            self._error_flujo(enviar, "Fallo inesperado: %s" % e)

    def _crear(self, cuerpo):
        enviar = self._flujo()
        try:
            ia.crear(leer_ajustes(), cuerpo.get("tipo"), cuerpo.get("id"),
                     instrucciones=cuerpo.get("instrucciones") or "",
                     al_texto=lambda t: enviar({"t": "texto", "v": t}),
                     al_fase=lambda f: enviar({"t": "fase", "v": f}))
            enviar({"t": "fin"})
        except ia.ErrorIA as e:
            self._error_flujo(enviar, str(e))
        except (BrokenPipeError, ConnectionError):
            pass
        except Exception as e:
            self._error_flujo(enviar, "Fallo inesperado: %s" % e)

    @staticmethod
    def _error_flujo(enviar, texto):
        try:
            enviar({"t": "error", "v": texto})
        except Exception:
            pass


# -------------------------------------------------------------------- main --

def main():
    ap = argparse.ArgumentParser(description="Tiro")
    ap.add_argument("--port", type=int, default=5240)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-abrir", action="store_true")
    args = ap.parse_args()

    if not motor.FFMPEG:
        print("\n  AVISO: no se encontro ffmpeg en el PATH. Sin el no se puede")
        print("  leer el audio de los videos. https://www.gyan.dev/ffmpeg/builds/\n")
    if not _hay_whisper():
        print("\n  AVISO: falta faster-whisper. Instalalo con:")
        print("      pip install -r requirements.txt\n")

    threading.Thread(target=obrero, daemon=True).start()
    # Ollama tarda unos segundos en arrancar: se enciende ya, en segundo plano,
    # para que la primera pregunta no espere.
    threading.Thread(target=ia.encender_ollama, daemon=True).start()

    cap = motor.capacidades()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    url = "http://%s:%s/" % (args.host, args.port)
    print("")
    print("  Tiro escuchando en %s" % url)
    print("  Motor: %s / %s - %d trozos en paralelo x %d hilos" % (
        cap["dispositivo"], cap["computo"], cap["workers"], cap["hilos"]))
    print("  Biblioteca: %s" % biblioteca.CARPETA)
    print("  Ctrl+C o cerrar la ventana para detener.")
    print("")
    if not args.no_abrir:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        print("\n  Detenido.")


if __name__ == "__main__":
    main()
