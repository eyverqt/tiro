"""
Tiro - exporta la version web (sin servidor) a una carpeta.

La misma interfaz funciona sin Python: Whisper corre en el navegador y la
biblioteca vive en IndexedDB. Este script copia solo lo que necesita la web
y ajusta <base href> a la ruta donde se va a publicar.

    python exportar_web.py ../portfolio/tiro/app /tiro/app/
"""

import os
import shutil
import sys

RAIZ = os.path.dirname(os.path.abspath(__file__))
ARCHIVOS = ["index.html", "app.css", "eyverqt.css", "comun.js", "local.js", "web.js",
            "worker.js", "app.js", "icono.svg"]
CARPETAS = ["fonts"]


def exportar(destino, base):
    base = "/" + base.strip("/") + "/" if base.strip("/") else "/"
    destino = os.path.abspath(destino)
    os.makedirs(destino, exist_ok=True)
    for nombre in ARCHIVOS:
        shutil.copy2(os.path.join(RAIZ, nombre), os.path.join(destino, nombre))
    for nombre in CARPETAS:
        shutil.copytree(os.path.join(RAIZ, nombre), os.path.join(destino, nombre), dirs_exist_ok=True)
    indice = os.path.join(destino, "index.html")
    with open(indice, "r", encoding="utf-8") as f:
        html = f.read()
    if '<base href="/">' not in html:
        raise SystemExit("index.html no tiene <base href=\"/\">: no se puede ajustar la ruta")
    with open(indice, "w", encoding="utf-8", newline="\n") as f:
        f.write(html.replace('<base href="/">', '<base href="%s">' % base, 1))
    print("Tiro web exportada en %s (base %s)" % (destino, base))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    exportar(sys.argv[1], sys.argv[2])
