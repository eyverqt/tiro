"""
Tiro - biblioteca de transcripciones.

Cada transcripcion terminada se guarda como un JSON en
Documents/Tiro/biblioteca. Asi sobrevive a los reinicios y se puede buscar,
preguntar o convertir en otra cosa mas tarde.

La busqueda es BM25 en Python puro sobre ventanas de ~45 s de audio: no hace
falta ningun modelo de embeddings, funciona sin internet y responde al
instante incluso con cientos de horas transcritas. Cada resultado sabe en que
segundo del audio esta, que es lo que permite citar con marca de tiempo.
"""

import json
import math
import os
import re
import threading
import time
import unicodedata
import uuid

CARPETA = os.path.join(os.path.expanduser("~"), "Documents", "Tiro", "biblioteca")
VENTANA = 45.0            # segundos de audio por fragmento de busqueda
K1, B = 1.5, 0.75         # parametros clasicos de BM25

_lock = threading.Lock()
_indice = {"firma": None, "frags": [], "df": {}, "media": 1.0}

VACIAS = set("""
a al algo algun alguna algunas alguno algunos ante antes aqui asi aun bajo bien cada como con
contra cual cuales cuando de del desde donde dos e el ella ellas ello ellos en entre era eran es esa
esas ese eso esos esta estaba estado estan estar este esto estos fue fueron ha hace hacia han hasta
hay la las le les lo los mas me mi mis mucho muy nada ni no nos nosotros o os otra otro para pero
poco por porque que quien se sea segun ser si sin sobre solo son su sus tambien tan tanto te tener
tiene tienen todo todos tu tus un una unas uno unos usted ya yo
the of and to in is it that for on with as was are be this by at or an from but not have has had
you your we they he she his her its our their them what which who will would can could do does
""".split())


# ------------------------------------------------------------------ texto --

def normalizar(texto):
    t = unicodedata.normalize("NFKD", (texto or "").lower())
    return "".join(c for c in t if not unicodedata.combining(c))


def fichas(texto):
    """Palabras utiles: sin tildes, sin mayusculas, sin palabras vacias."""
    return [w for w in re.findall(r"\w+", normalizar(texto))
            if len(w) > 1 and w not in VACIAS]


def reloj(s):
    s = int(max(0, s or 0))
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return "%d:%02d:%02d" % (h, m, s) if h else "%d:%02d" % (m, s)


# ----------------------------------------------------------------- disco --

def _ruta(eid):
    if not re.fullmatch(r"[0-9a-f]{12}", eid or ""):
        raise ValueError("id no valido")
    return os.path.join(CARPETA, eid + ".json")


def nuevo_id():
    return uuid.uuid4().hex[:12]


def guardar(entrada):
    """Escribe la entrada de forma atomica (archivo temporal + reemplazo)."""
    os.makedirs(CARPETA, exist_ok=True)
    entrada.setdefault("id", nuevo_id())
    entrada.setdefault("creado", time.strftime("%Y-%m-%dT%H:%M:%S"))
    ruta = _ruta(entrada["id"])
    tmp = ruta + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entrada, f, ensure_ascii=False)
    os.replace(tmp, ruta)
    return entrada


def obtener(eid):
    try:
        with open(_ruta(eid), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def resumen(e):
    segs = e.get("segmentos") or []
    return {
        "id": e["id"], "nombre": e.get("nombre", ""), "origen": e.get("origen", "archivo"),
        "url": e.get("url", ""), "idioma": e.get("idioma", ""),
        "duracion": e.get("duracion", 0), "modelo": e.get("modelo", ""),
        "creado": e.get("creado", ""), "lineas": len(segs),
        "palabras": sum(len(s["texto"].split()) for s in segs),
    }


def listar():
    if not os.path.isdir(CARPETA):
        return []
    salida = []
    for nombre in os.listdir(CARPETA):
        if nombre.endswith(".json"):
            e = obtener(nombre[:-5])
            if e:
                salida.append(resumen(e))
    salida.sort(key=lambda r: r["creado"], reverse=True)
    return salida


def borrar(eid):
    try:
        os.remove(_ruta(eid))
        return True
    except (OSError, ValueError):
        return False


def renombrar(eid, nombre):
    e = obtener(eid)
    if not e:
        return None
    e["nombre"] = (nombre or "").strip()[:200] or e.get("nombre", "")
    return resumen(guardar(e))


def texto_plano(e, marcas=False):
    segs = e.get("segmentos") or []
    if marcas:
        return "\n".join("[%s] %s" % (reloj(s["ini"]), s["texto"]) for s in segs)
    return " ".join(s["texto"] for s in segs)


# ---------------------------------------------------------------- indice --

def _firma():
    """Cambia cuando se anade, borra o reescribe cualquier entrada."""
    if not os.path.isdir(CARPETA):
        return ()
    try:
        return tuple(sorted(
            (n, os.path.getmtime(os.path.join(CARPETA, n)))
            for n in os.listdir(CARPETA) if n.endswith(".json")))
    except OSError:
        return ()


def _conteo(palabras):
    c = {}
    for w in palabras:
        c[w] = c.get(w, 0) + 1
    c["__n"] = len(palabras)
    return c


def _fragmentar(e):
    """Agrupa los segmentos en ventanas de ~45 s que recuerdan donde empiezan."""
    segs = e.get("segmentos") or []
    frags, actual, ini = [], [], None
    for s in segs:
        if ini is None:
            ini = s["ini"]
        actual.append(s["texto"])
        if s["fin"] - ini >= VENTANA:
            frags.append((ini, s["fin"], " ".join(actual)))
            actual, ini = [], None
    if actual:
        frags.append((ini or 0.0, segs[-1]["fin"], " ".join(actual)))
    return [{"id": e["id"], "nombre": e.get("nombre", ""), "ini": a, "fin": b,
             "texto": t, "tf": _conteo(fichas(t))} for a, b, t in frags]


def _indice_actual():
    firma = _firma()
    with _lock:
        if _indice["firma"] == firma:
            return _indice
        frags = []
        for r in listar():
            e = obtener(r["id"])
            if e:
                frags.extend(_fragmentar(e))
        df = {}
        for f in frags:
            for w in f["tf"]:
                if w != "__n":
                    df[w] = df.get(w, 0) + 1
        media = (sum(f["tf"]["__n"] for f in frags) / len(frags)) if frags else 1.0
        _indice.update(firma=firma, frags=frags, df=df, media=media or 1.0)
        return _indice


def buscar(consulta, ids=None, k=8):
    """
    Los k fragmentos mas relevantes para la consulta, con su segundo de inicio.
    `ids` limita la busqueda a ciertas transcripciones.
    """
    idx = _indice_actual()
    q = fichas(consulta)
    if not q or not idx["frags"]:
        return []
    n = len(idx["frags"])
    filtro = set(ids) if ids else None
    puntuados = []
    for f in idx["frags"]:
        if filtro and f["id"] not in filtro:
            continue
        tf, largo, puntos = f["tf"], f["tf"]["__n"], 0.0
        for w in q:
            if w not in tf:
                continue
            df = idx["df"].get(w, 0)
            idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
            puntos += idf * tf[w] * (K1 + 1) / (
                tf[w] + K1 * (1 - B + B * largo / idx["media"]))
        if puntos > 0:
            puntuados.append((puntos, f))
    puntuados.sort(key=lambda p: p[0], reverse=True)
    return [{"id": f["id"], "nombre": f["nombre"], "ini": f["ini"], "fin": f["fin"],
             "texto": f["texto"], "puntos": round(p, 3)} for p, f in puntuados[:k]]


def estadisticas():
    todas = listar()
    return {
        "transcripciones": len(todas),
        "segundos": sum(r["duracion"] or 0 for r in todas),
        "palabras": sum(r["palabras"] for r in todas),
    }
