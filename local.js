/* ==========================================================================
   Tiro — modo escritorio

   Habla con server.py (/api/*). La transcripcion corre en Python con
   faster-whisper troceando por silencios en paralelo, los enlaces se bajan
   con yt-dlp y la IA va por Ollama en tu equipo. Mismo contrato que web.js,
   asi app.js no sabe ni le importa en que modo esta.
   ========================================================================== */
'use strict';

(function (g) {
  async function api(ruta, opciones) {
    const r = await fetch(ruta, opciones);
    const dato = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(dato.error || `error ${r.status}`);
    return dato;
  }
  const post = (ruta, cuerpo) => api(ruta, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo || {}),
  });

  /* Respuesta NDJSON en vivo: cada linea es {t, v}. */
  async function flujo(ruta, cuerpo, alLinea, signal) {
    const r = await fetch(ruta, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo), signal,
    });
    const lector = r.body.getReader(), dec = new TextDecoder();
    let resto = '';
    for (;;) {
      const { value, done } = await lector.read();
      if (done) break;
      resto += dec.decode(value, { stream: true });
      let i;
      while ((i = resto.indexOf('\n')) >= 0) {
        const linea = resto.slice(0, i).trim();
        resto = resto.slice(i + 1);
        if (linea) alLinea(JSON.parse(linea));
      }
    }
  }

  function subir(archivo, alAvanzar) {
    return new Promise((resolver, rechazar) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/subir');
      xhr.setRequestHeader('X-Nombre', encodeURIComponent(archivo.name));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && alAvanzar) alAvanzar(e.loaded / e.total); };
      xhr.onload = () => {
        let d = {};
        try { d = JSON.parse(xhr.responseText); } catch (e) { /* nada */ }
        if (xhr.status >= 200 && xhr.status < 300 && d.ruta) resolver(d);
        else rechazar(new Error(d.error || `error ${xhr.status}`));
      };
      xhr.onerror = () => rechazar(new Error('se corto la subida'));
      xhr.send(archivo);
    });
  }

  const oyentes = [];

  g.TiroLocal = {
    modo: 'local',

    async probar() {
      // server.py solo escucha en este equipo: publicada en internet ni se intenta
      if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname)) return false;
      try { await api('/api/estado'); return true; } catch (e) { return false; }
    },

    async iniciar() {
      const cfg = await api('/api/estado');
      const cap = cfg.cap || {};
      cfg.motor = cap.gpu ? `GPU ${cap.computo}` : `CPU ${cap.computo} · ${cap.workers}×${cap.hilos}`;
      cfg.capHint = `${cap.nucleos} núcleos · hasta ${cap.workers} trozos a la vez`;
      cfg.funciones = { enlaces: !!cfg.ytdlp, carpeta: true, paralelo: true, fiel: true, dialogo: true };
      return cfg;
    },

    escuchar(fn) {
      oyentes.push(fn);
      if (oyentes.length > 1) return;
      const conectar = () => {
        const es = new EventSource('/api/eventos');
        es.onmessage = (ev) => {
          let s;
          try { s = JSON.parse(ev.data); } catch (e) { return; }
          oyentes.forEach((f) => f(s));
        };
        es.onerror = () => oyentes.forEach((f) => f({ tipo: 'conexion', ok: false }));
        es.onopen = () => oyentes.forEach((f) => f({ tipo: 'conexion', ok: true }));
      };
      conectar();
    },

    trabajos: () => api('/api/trabajos').then((d) => d.trabajos),

    /* Dialogo nativo de Windows: rutas reales, sin copiar bytes. */
    elegirArchivos: () => api('/api/elegir').then((d) => d.rutas || []),

    async encolarArchivos(items, ajustes, alSubir) {
      const listos = [];
      for (const it of items) {
        if (it.ruta) { listos.push(it); continue; }
        const d = await subir(it.file, (p) => alSubir && alSubir(it, p));
        listos.push({ ruta: d.ruta, nombre: it.file.name || d.nombre, origen: it.origen });
      }
      return post('/api/encolar', Object.assign({ archivos: listos }, ajustes));
    },

    enlaces: (texto, ajustes) => post('/api/enlaces', Object.assign({ texto }, ajustes)),
    cancelar: (id) => post('/api/cancelar', id ? { id } : {}),
    quitar: (id) => post('/api/borrar', { id }),
    textoTrabajo: (id, formato) => api(`/api/texto?id=${id}&formato=${encodeURIComponent(formato)}`),

    biblioteca: () => api('/api/biblioteca'),
    entrada: (id) => api(`/api/biblioteca/uno?id=${id}`),
    textoEntrada: (id, formato) => api(`/api/biblioteca/texto?id=${id}&formato=${encodeURIComponent(formato)}`),
    buscar: (q, ids, k) => api(`/api/buscar?q=${encodeURIComponent(q)}&ids=${(ids || []).join(',')}&k=${k || 30}`).then((d) => d.resultados),
    borrar: (id) => post('/api/biblioteca/borrar', { id }),
    renombrar: (id, nombre) => post('/api/biblioteca/renombrar', { id, nombre }),

    async exportar(ids, formato, carpeta) {
      const d = await post('/api/exportar', { ids, formato, carpeta });
      return { ok: (d.guardados || []).length, rutas: (d.guardados || []).map((x) => x.ruta), fallos: d.fallos || [] };
    },
    async escribir(nombre, texto, ext, carpeta) {
      const d = await post('/api/escribir', { nombre, texto, ext, carpeta });
      return { ruta: d.ruta };
    },

    ia: () => api('/api/ia'),
    guardarIA: (cambios) => post('/api/ajustes', { ia: cambios }),
    encenderOllama: () => post('/api/ia/encender'),
    guardarAjustes: (cambios) => post('/api/ajustes', cambios),
    elegirCarpeta: () => api('/api/elegir?tipo=carpeta').then((d) => (d.rutas || [])[0] || ''),
    abrir: (ruta) => fetch(`/api/abrir?ruta=${encodeURIComponent(ruta)}`).catch(() => {}),

    preguntar: (cuerpo, alLinea, signal) => flujo('/api/preguntar', cuerpo, alLinea, signal),
    crear: (cuerpo, alLinea, signal) => flujo('/api/crear', cuerpo, alLinea, signal),
  };
})(window);
