/* ==========================================================================
   Tiro — piezas comunes del modo navegador

   Los mismos formatos de salida que motor.py y la misma busqueda BM25 que
   biblioteca.py, en JavaScript, para que la version web funcione sin
   servidor y devuelva exactamente lo mismo.
   ========================================================================== */
'use strict';

(function (g) {
  const dos = (n) => String(n).padStart(2, '0');

  function reloj(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? `${h}:${dos(m)}:${dos(x)}` : `${m}:${dos(x)}`;
  }

  function relojLargo(s, coma) {
    let ms = Math.round(Math.max(0, s || 0) * 1000);
    const h = Math.floor(ms / 3600000); ms -= h * 3600000;
    const m = Math.floor(ms / 60000); ms -= m * 60000;
    const x = Math.floor(ms / 1000); ms -= x * 1000;
    return `${dos(h)}:${dos(m)}:${dos(x)}${coma ? ',' : '.'}${String(ms).padStart(3, '0')}`;
  }

  /* ------------------------------------------------------------ formatos */

  function parrafos(segs) {
    const bloques = []; let actual = [], ultimo = null;
    for (const s of segs) {
      if (ultimo !== null && s.ini - ultimo > 2 && actual.length) { bloques.push(actual.join(' ')); actual = []; }
      actual.push(s.texto); ultimo = s.fin;
    }
    if (actual.length) bloques.push(actual.join(' '));
    return bloques.join('\n\n') + '\n';
  }

  const FORMATOS = {
    txt:      { ext: '.txt',  etiqueta: 'Texto plano (.txt)',          fn: (s) => s.map((x) => x.texto).join('\n') + '\n' },
    parrafos: { ext: '.txt',  etiqueta: 'Texto en parrafos (.txt)',    fn: parrafos },
    marcas:   { ext: '.txt',  etiqueta: 'Con marcas de tiempo (.txt)', fn: (s) => s.map((x) => `[${relojLargo(x.ini).slice(0, 8)}] ${x.texto}\n`).join('') },
    srt:      { ext: '.srt',  etiqueta: 'Subtitulos (.srt)',           fn: (s) => s.map((x, i) => `${i + 1}\n${relojLargo(x.ini, true)} --> ${relojLargo(x.fin, true)}\n${x.texto}\n`).join('\n') },
    vtt:      { ext: '.vtt',  etiqueta: 'Subtitulos web (.vtt)',       fn: (s) => ['WEBVTT\n', ...s.map((x) => `${relojLargo(x.ini)} --> ${relojLargo(x.fin)}\n${x.texto}\n`)].join('\n') },
    json:     { ext: '.json', etiqueta: 'Datos (.json)',               fn: (s, meta) => JSON.stringify({ meta: meta || {}, segmentos: s }, null, 2) },
  };

  function formatear(clave, segs, meta) {
    const f = FORMATOS[clave] || FORMATOS.txt;
    return { texto: f.fn(segs || [], meta), ext: f.ext };
  }

  /* ---------------------------------------------------------- busqueda */

  const VACIAS = new Set(`a al algo algun alguna algunas alguno algunos ante antes aqui asi aun bajo bien cada como con
contra cual cuales cuando de del desde donde dos e el ella ellas ello ellos en entre era eran es esa
esas ese eso esos esta estaba estado estan estar este esto estos fue fueron ha hace hacia han hasta
hay la las le les lo los mas me mi mis mucho muy nada ni no nos nosotros o os otra otro para pero
poco por porque que quien se sea segun ser si sin sobre solo son su sus tambien tan tanto te tener
tiene tienen todo todos tu tus un una unas uno unos usted ya yo
the of and to in is it that for on with as was are be this by at or an from but not have has had
you your we they he she his her its our their them what which who will would can could do does`.split(/\s+/));

  const normalizar = (t) => (t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const fichas = (t) => (normalizar(t).match(/[\p{L}\p{N}_]+/gu) || []).filter((w) => w.length > 1 && !VACIAS.has(w));

  const VENTANA = 45, K1 = 1.5, B = 0.75;

  /* Ventanas de ~45 s de audio que recuerdan en que segundo empiezan. */
  function fragmentar(e) {
    const segs = e.segmentos || [], frags = [];
    let actual = [], ini = null;
    for (const s of segs) {
      if (ini === null) ini = s.ini;
      actual.push(s.texto);
      if (s.fin - ini >= VENTANA) { frags.push([ini, s.fin, actual.join(' ')]); actual = []; ini = null; }
    }
    if (actual.length) frags.push([ini || 0, segs[segs.length - 1].fin, actual.join(' ')]);
    return frags.map(([a, b, t]) => ({ id: e.id, nombre: e.nombre || '', ini: a, fin: b, texto: t }));
  }

  class Indice {
    constructor(entradas) {
      this.frags = [];
      this.df = new Map();
      for (const e of entradas) {
        for (const f of fragmentar(e)) {
          const tf = new Map(); let n = 0;
          for (const w of fichas(f.texto)) { tf.set(w, (tf.get(w) || 0) + 1); n++; }
          f.tf = tf; f.n = n;
          for (const w of tf.keys()) this.df.set(w, (this.df.get(w) || 0) + 1);
          this.frags.push(f);
        }
      }
      this.media = this.frags.length ? this.frags.reduce((a, f) => a + f.n, 0) / this.frags.length || 1 : 1;
    }

    buscar(consulta, ids, k = 8) {
      const q = fichas(consulta);
      if (!q.length || !this.frags.length) return [];
      const N = this.frags.length, filtro = ids && ids.length ? new Set(ids) : null, out = [];
      for (const f of this.frags) {
        if (filtro && !filtro.has(f.id)) continue;
        let p = 0;
        for (const w of q) {
          const tf = f.tf.get(w);
          if (!tf) continue;
          const df = this.df.get(w) || 0;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          p += idf * tf * (K1 + 1) / (tf + K1 * (1 - B + B * f.n / this.media));
        }
        if (p > 0) out.push([p, f]);
      }
      out.sort((a, b) => b[0] - a[0]);
      return out.slice(0, k).map(([p, f]) => ({ id: f.id, nombre: f.nombre, ini: f.ini, fin: f.fin, texto: f.texto, puntos: +p.toFixed(3) }));
    }
  }

  function textoPlano(e, marcas) {
    const segs = e.segmentos || [];
    return marcas ? segs.map((s) => `[${reloj(s.ini)}] ${s.texto}`).join('\n') : segs.map((s) => s.texto).join(' ');
  }

  function resumen(e) {
    const segs = e.segmentos || [];
    return {
      id: e.id, nombre: e.nombre || '', origen: e.origen || 'archivo', url: e.url || '',
      idioma: e.idioma || '', duracion: e.duracion || 0, modelo: e.modelo || '',
      creado: e.creado || '', lineas: segs.length,
      palabras: segs.reduce((n, s) => n + s.texto.split(/\s+/).filter(Boolean).length, 0),
    };
  }

  function ahoraIso() {
    const d = new Date();
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}T${dos(d.getHours())}:${dos(d.getMinutes())}:${dos(d.getSeconds())}`;
  }

  g.TiroComun = { reloj, FORMATOS, formatear, fichas, fragmentar, Indice, textoPlano, resumen, ahoraIso };
})(typeof window !== 'undefined' ? window : self);
