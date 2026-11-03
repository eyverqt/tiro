"""
Tiro - enlaces.

Pega un enlace de YouTube, TikTok, Instagram, X, Vimeo, un podcast... (todo lo
que entiende yt-dlp, mas de mil sitios) y Tiro baja SOLO el audio para
transcribirlo en local. Las playlists y los canales se expanden en un trabajo
por video.
"""

import os
import tempfile

TEMP = os.path.join(tempfile.gettempdir(), "verba_enlaces")
MAX_ENTRADAS = 100


class Cancelado(Exception):
    pass


def disponible():
    try:
        import yt_dlp  # noqa: F401
        return True
    except Exception:
        return False


def _base_opciones():
    return {"quiet": True, "no_warnings": True, "noprogress": True,
            "socket_timeout": 20, "retries": 3}


def expandir(url):
    """
    [(url_video, titulo, duracion), ...]. Una playlist o un canal devuelven
    cada video por separado, sin descargar nada todavia.
    """
    import yt_dlp
    op = dict(_base_opciones(), extract_flat="in_playlist", playlistend=MAX_ENTRADAS,
              skip_download=True)
    with yt_dlp.YoutubeDL(op) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info:
        return []
    entradas = info.get("entries")
    if entradas is None:
        return [(info.get("webpage_url") or url, info.get("title") or url,
                 info.get("duration") or 0)]
    salida = []
    for e in list(entradas)[:MAX_ENTRADAS]:
        if not e:
            continue
        enlace = e.get("url") or e.get("webpage_url") or ""
        if enlace and not enlace.startswith("http") and e.get("ie_key") == "Youtube":
            enlace = "https://www.youtube.com/watch?v=" + enlace
        if enlace:
            salida.append((enlace, e.get("title") or enlace, e.get("duration") or 0))
    return salida


def descargar(url, al_avanzar=None, cancelado=None):
    """Baja el mejor audio disponible. Devuelve (ruta, titulo, duracion)."""
    import yt_dlp
    os.makedirs(TEMP, exist_ok=True)

    def gancho(d):
        if cancelado and cancelado():
            raise Cancelado()
        if d.get("status") == "downloading" and al_avanzar:
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                al_avanzar(min(1.0, (d.get("downloaded_bytes") or 0) / total))

    op = dict(_base_opciones(),
              format="bestaudio/best",
              outtmpl=os.path.join(TEMP, "%(id)s.%(ext)s"),
              noplaylist=True,
              progress_hooks=[gancho])
    with yt_dlp.YoutubeDL(op) as ydl:
        info = ydl.extract_info(url, download=True)
        ruta = (info.get("requested_downloads") or [{}])[0].get("filepath") \
            or ydl.prepare_filename(info)
    if not ruta or not os.path.isfile(ruta):
        raise RuntimeError("yt-dlp no dejo ningun archivo")
    return ruta, info.get("title") or url, info.get("duration") or 0
