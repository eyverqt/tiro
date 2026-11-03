"""
Tiro - motor de transcripcion.

Decodifica cualquier audio o video con ffmpeg a PCM 16 kHz mono, lo parte en
trozos cortando siempre por silencio (nunca a mitad de palabra) y transcribe
los trozos EN PARALELO con faster-whisper. Todo local: una vez descargado el
modelo no vuelve a tocar la red.

No se usa directamente; lo llama server.py.
"""

import math
import os
import shutil
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np

# -------------------------------------------------------------- constantes --

SR = 16000                 # frecuencia de muestreo que espera whisper
BYTES_MUESTRA = 2          # s16le
BLOQUE_MS = 20             # resolucion del analisis de silencio
BLOQUE = SR * BLOQUE_MS // 1000

TROZO_MAXIMO = 300.0       # segundos: ningun trozo pasa de aqui
TROZO_MARGEN = 30.0        # +/- segundos donde buscar el mejor silencio
MINIMO_PARA_PARTIR = 300.0 # por debajo de esto no compensa partir

EXTENSIONES = (
    ".mp3 .wav .m4a .aac .flac .ogg .oga .opus .wma .aiff .aif .alac .amr .ac3 "
    ".mp4 .mkv .mov .avi .webm .wmv .flv .m4v .mpg .mpeg .ts .m2ts .3gp .mts .vob"
).split()

# Modelos ordenados de mas rapido a mas exacto. "turbo" es el punto dulce:
# calidad cercana a large-v3 a una fraccion del tiempo, y multilingue.
MODELOS = {
    "turbo":  {"id": "large-v3-turbo", "etiqueta": "Turbo"},
    "large":  {"id": "large-v3",       "etiqueta": "Máxima"},
    "medium": {"id": "medium",         "etiqueta": "Equilibrado"},
    "small":  {"id": "small",          "etiqueta": "Rápido"},
    "base":   {"id": "base",           "etiqueta": "Muy rápido"},
    "tiny":   {"id": "tiny",           "etiqueta": "Mínimo"},
}
MODELO_POR_DEFECTO = "turbo"

IDIOMAS = [
    ("", "Detectar automaticamente"),
    ("es", "Espanol"), ("en", "Ingles"), ("pt", "Portugues"), ("fr", "Frances"),
    ("de", "Aleman"), ("it", "Italiano"), ("ca", "Catalan"), ("gl", "Gallego"),
    ("eu", "Euskera"), ("nl", "Neerlandes"), ("ru", "Ruso"), ("uk", "Ucraniano"),
    ("pl", "Polaco"), ("cs", "Checo"), ("ro", "Rumano"), ("el", "Griego"),
    ("tr", "Turco"), ("ar", "Arabe"), ("he", "Hebreo"), ("fa", "Persa"),
    ("hi", "Hindi"), ("bn", "Bengali"), ("ur", "Urdu"), ("ta", "Tamil"),
    ("zh", "Chino"), ("ja", "Japones"), ("ko", "Coreano"), ("vi", "Vietnamita"),
    ("th", "Tailandes"), ("id", "Indonesio"), ("ms", "Malayo"), ("tl", "Filipino"),
    ("sv", "Sueco"), ("no", "Noruego"), ("da", "Danes"), ("fi", "Finlandes"),
    ("hu", "Hungaro"), ("bg", "Bulgaro"), ("sr", "Serbio"), ("hr", "Croata"),
    ("sk", "Eslovaco"), ("sl", "Esloveno"), ("lt", "Lituano"), ("lv", "Leton"),
    ("et", "Estonio"), ("is", "Islandes"), ("sw", "Suajili"), ("af", "Afrikaans"),
    ("la", "Latin"),
]


class ErrorMotor(Exception):
    pass


class Cancelado(Exception):
    pass


# ----------------------------------------------------------------- ffmpeg --

def _buscar(nombre):
    ruta = shutil.which(nombre)
    if ruta:
        return ruta
    # por si esta al lado del proyecto o en una carpeta ffmpeg/bin
    aqui = os.path.dirname(os.path.abspath(__file__))
    for cand in (os.path.join(aqui, nombre + ".exe"),
                 os.path.join(aqui, "ffmpeg", "bin", nombre + ".exe")):
        if os.path.isfile(cand):
            return cand
    return None


FFMPEG = _buscar("ffmpeg")
FFPROBE = _buscar("ffprobe")

_SIN_VENTANA = 0
if os.name == "nt":
    _SIN_VENTANA = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


def _correr(cmd):
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          creationflags=_SIN_VENTANA)


def duracion_media(ruta):
    """Segundos de duracion segun ffprobe. 0 si no se sabe."""
    if not FFPROBE:
        return 0.0
    r = _correr([FFPROBE, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nw=1:nk=1", ruta])
    try:
        return float(r.stdout.decode("utf-8", "ignore").strip())
    except Exception:
        return 0.0


def decodificar(ruta, destino_pcm, al_avanzar=None, cancelado=None):
    """
    Cualquier contenedor -> PCM crudo s16le 16 kHz mono en disco.

    En disco y no en RAM a proposito: un video de 8 horas ocupa ~460 MB de PCM
    pero permite leer cualquier tramo al instante sin cargar nada entero.
    """
    if not FFMPEG:
        raise ErrorMotor("No se encontro ffmpeg. Instalalo y anadelo al PATH "
                         "(https://www.gyan.dev/ffmpeg/builds/).")
    if not os.path.isfile(ruta):
        raise ErrorMotor("El archivo ya no existe: %s" % ruta)

    total = duracion_media(ruta)
    cmd = [FFMPEG, "-nostdin", "-hide_banner", "-loglevel", "error", "-stats",
           "-threads", "0", "-i", ruta,
           "-vn", "-sn", "-dn",                     # fuera video y subtitulos
           "-map", "0:a:0?",                        # primera pista de audio
           "-ac", "1", "-ar", str(SR),
           "-af", "aresample=resampler=soxr",       # remuestreo de calidad
           "-f", "s16le", "-y", destino_pcm]

    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, creationflags=_SIN_VENTANA)
    errores = []
    linea = b""
    while True:
        if cancelado and cancelado():
            proc.kill()
            raise Cancelado()
        ch = proc.stderr.read(1)
        if not ch:
            break
        if ch in (b"\r", b"\n"):
            txt = linea.decode("utf-8", "ignore")
            linea = b""
            if txt.startswith("size=") and al_avanzar and total > 0:
                # size=  123kB time=00:01:02.34 bitrate=...
                pos = txt.find("time=")
                if pos > -1:
                    reloj = txt[pos + 5:pos + 16]
                    try:
                        h, m, s = reloj.split(":")
                        hecho = int(h) * 3600 + int(m) * 60 + float(s)
                        al_avanzar(min(1.0, hecho / total))
                    except Exception:
                        pass
            elif txt.strip():
                errores.append(txt.strip())
        else:
            linea += ch
    proc.wait()

    if (proc.returncode != 0 or not os.path.isfile(destino_pcm)
            or os.path.getsize(destino_pcm) == 0):
        detalle = " | ".join(errores[-3:]) or "el archivo no tiene pista de audio legible"
        raise ErrorMotor("ffmpeg no pudo extraer el audio: %s" % detalle[:240])

    return os.path.getsize(destino_pcm) // BYTES_MUESTRA   # numero de muestras


# --------------------------------------------------- troceado por silencio --

def _perfil_energia(ruta_pcm, n_muestras):
    """Energia media por bloque de 20 ms. Es el mapa de silencios del audio."""
    n_bloques = n_muestras // BLOQUE
    if n_bloques <= 0:
        return np.zeros(0, dtype=np.float32)
    perfil = np.empty(n_bloques, dtype=np.float32)
    por_lote = 4096                                   # ~82 s de audio por vuelta
    with open(ruta_pcm, "rb") as f:
        hecho = 0
        while hecho < n_bloques:
            cuantos = min(por_lote, n_bloques - hecho)
            crudo = f.read(cuantos * BLOQUE * BYTES_MUESTRA)
            if not crudo:
                break
            trozo = np.frombuffer(crudo, dtype="<i2")
            cuantos = len(trozo) // BLOQUE
            if cuantos == 0:
                break
            trozo = trozo[:cuantos * BLOQUE].reshape(cuantos, BLOQUE)
            perfil[hecho:hecho + cuantos] = np.abs(trozo).mean(axis=1)
            hecho += cuantos
    return perfil[:hecho]


def _mejor_silencio(perfil, centro, radio):
    """Bloque mas silencioso de una ventana; ahi es donde conviene cortar."""
    ini = max(1, centro - radio)
    fin = min(len(perfil) - 1, centro + radio)
    if fin - ini < 10:
        return centro
    ventana = perfil[ini:fin]
    ancho = max(5, int(400 / BLOQUE_MS))              # media movil de ~0.4 s
    if len(ventana) <= ancho:
        return centro
    suave = np.convolve(ventana, np.ones(ancho, dtype=np.float32) / ancho, mode="valid")
    return ini + int(np.argmin(suave)) + ancho // 2


def planificar_trozos(ruta_pcm, n_muestras, paralelos):
    """
    Devuelve [(muestra_inicio, muestra_fin), ...].

    Si el audio es corto o solo hay un worker se devuelve un unico trozo. Si es
    largo se parte cortando siempre por el punto mas silencioso cercano al
    limite teorico, para no partir ninguna frase.

    El numero de trozos es siempre multiplo de los que corren a la vez. Eso
    importa: con 6 trozos y 4 en paralelo la ultima tanda solo lleva 2 y media
    maquina se queda parada, y una tanda tarda lo que su trozo mas largo.

    Medido sobre 13 min de audio en 8 nucleos: 4 trozos de 2 hilos tardaron
    92 s y 93 s en dos vueltas; el mismo audio de una pieza con los 8 hilos,
    159 s. O sea 1.7x, no 4x: el codificador de whisper ya reparte bien por
    su cuenta, y lo que se gana aqui es lo que le sobra.
    """
    segundos = n_muestras / SR
    if paralelos <= 1 or segundos < MINIMO_PARA_PARTIR:
        return [(0, n_muestras)]

    tandas = max(1, int(math.ceil(segundos / (paralelos * TROZO_MAXIMO))))
    n_trozos = paralelos * tandas
    objetivo = segundos / n_trozos

    perfil = _perfil_energia(ruta_pcm, n_muestras)
    if len(perfil) < 100:
        return [(0, n_muestras)]

    # La ventana de busqueda del silencio se limita al 15% del trozo: con un
    # margen fijo, los trozos cortos salian de 50 s y 101 s en la misma tanda,
    # y una tanda tarda lo que su trozo mas largo.
    radio = int(min(TROZO_MARGEN, objetivo * 0.15) * 1000 / BLOQUE_MS)
    cortes = [0]
    for i in range(1, n_trozos):
        centro = int(objetivo * i * 1000 / BLOQUE_MS)
        muestra = _mejor_silencio(perfil, centro, radio) * BLOQUE
        if muestra > cortes[-1] + SR * 30:            # nunca trozos de <30 s
            cortes.append(muestra)
    cortes.append(n_muestras)
    return [(cortes[i], cortes[i + 1]) for i in range(len(cortes) - 1)]


def leer_tramo(ruta_pcm, ini, fin):
    """Tramo de PCM -> float32 normalizado, que es lo que come whisper."""
    with open(ruta_pcm, "rb") as f:
        f.seek(ini * BYTES_MUESTRA)
        crudo = f.read((fin - ini) * BYTES_MUESTRA)
    return np.frombuffer(crudo, dtype="<i2").astype(np.float32) / 32768.0


# ------------------------------------------------------------------ modelo --

_modelos = {}
_lock_modelo = threading.Lock()


def capacidades():
    """Que hardware hay debajo: decide GPU/CPU, workers e hilos."""
    nucleos = os.cpu_count() or 4
    try:
        import ctranslate2
        cuda = ctranslate2.get_cuda_device_count()
    except Exception:
        cuda = 0

    if cuda > 0:
        return {"dispositivo": "cuda", "computo": "float16",
                "workers": 2, "hilos": nucleos, "nucleos": nucleos, "gpu": True}

    # En CPU int8 es varias veces mas rapido que float32 y la perdida de
    # calidad es inapreciable. Repartimos los nucleos entre varios workers para
    # que un video muy largo se transcriba en paralelo.
    workers = max(1, min(4, nucleos // 2))
    hilos = max(1, nucleos // workers)
    return {"dispositivo": "cpu", "computo": "int8",
            "workers": workers, "hilos": hilos, "nucleos": nucleos, "gpu": False}


def cargar_modelo(clave, cap, al_avisar=None):
    """Carga (y cachea) el modelo. La primera vez lo descarga; luego, offline."""
    from faster_whisper import WhisperModel

    nombre = MODELOS.get(clave, MODELOS[MODELO_POR_DEFECTO])["id"]
    firma = (nombre, cap["dispositivo"], cap["computo"], cap["workers"], cap["hilos"])
    with _lock_modelo:
        if firma in _modelos:
            return _modelos[firma]
        if al_avisar:
            al_avisar("Preparando el modelo '%s' (la primera vez se descarga; "
                      "despues funciona sin internet)" % nombre)
        modelo = WhisperModel(
            nombre,
            device=cap["dispositivo"],
            compute_type=cap["computo"],
            cpu_threads=cap["hilos"],
            num_workers=cap["workers"],
        )
        _modelos[firma] = modelo
        return modelo


def modelo_descargado(clave):
    """True si el modelo ya esta en la cache local (o sea, ya vale offline)."""
    nombre = MODELOS.get(clave, MODELOS[MODELO_POR_DEFECTO])["id"]
    if os.path.isdir(nombre):
        return True
    base = os.environ.get("HF_HOME") or os.path.join(
        os.path.expanduser("~"), ".cache", "huggingface")
    hub = os.path.join(base, "hub")
    if not os.path.isdir(hub):
        return False
    suelto = nombre.rsplit("/", 1)[-1].lower()
    try:
        carpetas = os.listdir(hub)
    except OSError:
        return False
    for carpeta in carpetas:
        if not carpeta.startswith("models--"):
            continue
        if not carpeta.lower().endswith(suelto):
            continue
        insta = os.path.join(hub, carpeta, "snapshots")
        if os.path.isdir(insta) and os.listdir(insta):
            return True
    return False


# ---------------------------------------------------------------- opciones --

def opciones_whisper(idioma, vocabulario, fiel):
    """
    Parametros pensados para que salga lo que de verdad se dice.

    - condition_on_previous_text=False corta en seco los bucles de alucinacion
      tipicos de los audios largos con silencios.
    - el VAD interno se queda solo con la voz, asi no inventa texto sobre la
      musica o el ruido de fondo.
    - la cascada de temperaturas reintenta el tramo cuando la decodificacion
      sale sospechosa (repetitiva o con probabilidad baja).
    """
    op = {
        "language": idioma or None,
        "task": "transcribe",
        "beam_size": 5 if fiel else 3,
        "best_of": 5 if fiel else 3,
        "patience": 1.0,
        "temperature": [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        "compression_ratio_threshold": 2.4,
        "log_prob_threshold": -1.0,
        "no_speech_threshold": 0.6,
        "condition_on_previous_text": False,
        "repetition_penalty": 1.05,
        "vad_filter": True,
        "vad_parameters": {"min_silence_duration_ms": 500, "speech_pad_ms": 250},
        "word_timestamps": False,
    }
    if vocabulario:
        op["initial_prompt"] = vocabulario
    return op


def detectar_idioma(modelo, ruta_pcm, n_muestras):
    """Detecta el idioma una sola vez, sobre una muestra del centro del audio."""
    ventana = min(n_muestras, SR * 40)
    ini = max(0, (n_muestras - ventana) // 2)
    audio = leer_tramo(ruta_pcm, ini, ini + ventana)
    try:
        _, info = modelo.transcribe(audio, language=None, beam_size=1,
                                    vad_filter=True, without_timestamps=True,
                                    condition_on_previous_text=False)
        return info.language, float(info.language_probability or 0.0)
    except Exception:
        return None, 0.0


# ------------------------------------------------------------ transcripcion --

def transcribir(ruta, ajustes, sucesos):
    """
    Transcribe un archivo completo.

    `sucesos` expone los callbacks:
        fase(texto), progreso(0..1), idioma(cod, prob),
        segmento({ini, fin, texto}), cancelado() -> bool
    Devuelve {"segmentos": [...], "idioma": ..., "duracion": ..., ...}
    """
    arranque = time.time()
    cap = capacidades()
    if ajustes.get("workers"):
        cap = dict(cap)
        cap["workers"] = max(1, min(8, int(ajustes["workers"])))
        cap["hilos"] = max(1, cap["nucleos"] // cap["workers"])

    tmp = tempfile.mkdtemp(prefix="verba_")
    ruta_pcm = os.path.join(tmp, "audio.pcm")
    try:
        sucesos.fase("Extrayendo el audio")
        n_muestras = decodificar(
            ruta, ruta_pcm,
            al_avanzar=lambda p: sucesos.progreso(p * 0.08),
            cancelado=sucesos.cancelado)
        segundos = n_muestras / SR
        if segundos < 0.2:
            raise ErrorMotor("El archivo no contiene audio audible.")

        sucesos.fase("Cargando el modelo")
        modelo = cargar_modelo(ajustes.get("modelo", MODELO_POR_DEFECTO), cap,
                               sucesos.fase)
        if sucesos.cancelado():
            raise Cancelado()

        idioma = (ajustes.get("idioma") or "").strip()
        if idioma:
            sucesos.idioma(idioma, 1.0)
        else:
            sucesos.fase("Detectando idioma")
            detectado, prob = detectar_idioma(modelo, ruta_pcm, n_muestras)
            if detectado:
                idioma = detectado
                sucesos.idioma(detectado, prob)

        trozos = planificar_trozos(ruta_pcm, n_muestras, cap["workers"])
        opciones = opciones_whisper(idioma, ajustes.get("vocabulario", ""),
                                    ajustes.get("fiel", True))

        sucesos.fase("Transcribiendo (%d %s en paralelo)" % (
            len(trozos), "trozo" if len(trozos) == 1 else "trozos"))

        avance = [0.0] * len(trozos)
        recogidos = [[] for _ in trozos]
        lock = threading.Lock()

        def refrescar():
            hecho = sum(a * (t[1] - t[0]) for a, t in zip(avance, trozos))
            sucesos.progreso(0.08 + 0.92 * min(1.0, hecho / max(1, n_muestras)))

        def faena(i):
            ini, fin = trozos[i]
            if sucesos.cancelado():
                raise Cancelado()
            desfase = ini / SR
            largo = (fin - ini) / SR
            audio = leer_tramo(ruta_pcm, ini, fin)
            flujo, _ = modelo.transcribe(audio, **opciones)
            for seg in flujo:
                if sucesos.cancelado():
                    raise Cancelado()
                texto = (seg.text or "").strip()
                if not texto:
                    continue
                dato = {"ini": desfase + seg.start,
                        "fin": desfase + seg.end,
                        "texto": texto}
                with lock:
                    recogidos[i].append(dato)
                    avance[i] = min(1.0, seg.end / largo) if largo else 1.0
                    refrescar()
                sucesos.segmento(dato)
            with lock:
                avance[i] = 1.0
                refrescar()

        if len(trozos) == 1:
            faena(0)
        else:
            with ThreadPoolExecutor(max_workers=cap["workers"]) as pool:
                for f in [pool.submit(faena, i) for i in range(len(trozos))]:
                    f.result()

        segmentos = [s for grupo in recogidos for s in grupo]
        segmentos.sort(key=lambda s: s["ini"])
        sucesos.progreso(1.0)
        return {
            "segmentos": segmentos,
            "idioma": idioma or "?",
            "duracion": segundos,
            "segundos": round(time.time() - arranque, 1),
            "trozos": len(trozos),
            "dispositivo": cap["dispositivo"],
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# --------------------------------------------------------------- formatos --

def _reloj(s, coma=False):
    ms = int(round(max(0.0, s) * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    seg, ms = divmod(ms, 1000)
    return "%02d:%02d:%02d%s%03d" % (h, m, seg, "," if coma else ".", ms)


def como_txt(segs, meta=None):
    return "\n".join(s["texto"] for s in segs) + "\n"


def como_parrafos(segs, meta=None):
    """Texto corrido, con parrafo nuevo cuando hay una pausa larga."""
    bloques, actual, ultimo = [], [], None
    for s in segs:
        if ultimo is not None and s["ini"] - ultimo > 2.0 and actual:
            bloques.append(" ".join(actual))
            actual = []
        actual.append(s["texto"])
        ultimo = s["fin"]
    if actual:
        bloques.append(" ".join(actual))
    return "\n\n".join(bloques) + "\n"


def como_marcas(segs, meta=None):
    return "".join("[%s] %s\n" % (_reloj(s["ini"])[:8], s["texto"]) for s in segs)


def como_srt(segs, meta=None):
    out = []
    for i, s in enumerate(segs, 1):
        out.append("%d\n%s --> %s\n%s\n" % (
            i, _reloj(s["ini"], True), _reloj(s["fin"], True), s["texto"]))
    return "\n".join(out)


def como_vtt(segs, meta=None):
    out = ["WEBVTT\n"]
    for s in segs:
        out.append("%s --> %s\n%s\n" % (_reloj(s["ini"]), _reloj(s["fin"]), s["texto"]))
    return "\n".join(out)


def como_json(segs, meta=None):
    import json
    return json.dumps({"meta": meta or {}, "segmentos": segs},
                      ensure_ascii=False, indent=2)


FORMATOS = {
    "txt":      {"fn": como_txt,      "ext": ".txt",  "etiqueta": "Texto plano (.txt)"},
    "parrafos": {"fn": como_parrafos, "ext": ".txt",  "etiqueta": "Texto en parrafos (.txt)"},
    "marcas":   {"fn": como_marcas,   "ext": ".txt",  "etiqueta": "Con marcas de tiempo (.txt)"},
    "srt":      {"fn": como_srt,      "ext": ".srt",  "etiqueta": "Subtitulos (.srt)"},
    "vtt":      {"fn": como_vtt,      "ext": ".vtt",  "etiqueta": "Subtitulos web (.vtt)"},
    "json":     {"fn": como_json,     "ext": ".json", "etiqueta": "Datos (.json)"},
}


def formatear(clave, segmentos, meta=None):
    f = FORMATOS.get(clave, FORMATOS["txt"])
    return f["fn"](segmentos, meta=meta), f["ext"]
