/* ==========================================================================
   Tiro — modo navegador (sin instalar nada)

   Todo pasa dentro del navegador:
   - Whisper corre en worker.js (WebGPU o WebAssembly). El audio se trocea
     por silencios, igual que en escritorio, y el texto sale trozo a trozo.
   - La biblioteca vive en IndexedDB y se busca con el mismo BM25.
   - La IA puede ir en el propio navegador (WebLLM + WebGPU), en tu Ollama
     o en Claude con tu clave. La clave no sale de este navegador.
   Lo unico que no puede hacer la web es bajar enlaces de YouTube y otros
   sitios: eso necesita yt-dlp y lo hace la version de escritorio.
   ========================================================================== */
'use strict';

(function (g) {
  const C = g.TiroComun;
  const SR = 16000;
  const CLAVE_AJ = 'tiro.web';

  /* ------------------------------------------------------------ ajustes */

  function leerAj() {
    try { return JSON.parse(localStorage.getItem(CLAVE_AJ) || '{}') || {}; } catch (e) { return {}; }
  }
  function mezclarAj(cambios) {
    const d = leerAj();
    for (const [k, v] of Object.entries(cambios || {})) {
      d[k] = (v && typeof v === 'object' && d[k] && typeof d[k] === 'object') ? Object.assign(d[k], v) : v;
    }
    try { localStorage.setItem(CLAVE_AJ, JSON.stringify(d)); } catch (e) { /* modo privado */ }
    return d;
  }

  /* ---------------------------------------------------------- IndexedDB */

  let dbp = null;
  function db() {
    dbp = dbp || new Promise((res, rej) => {
      const r = indexedDB.open('tiro', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('entradas', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(modo, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('entradas', modo);
      const req = fn(t.objectStore('entradas'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  }
  const idb = {
    todas: () => tx('readonly', (s) => s.getAll()),
    una: (id) => tx('readonly', (s) => s.get(id)),
    poner: (e) => { indice = null; return tx('readwrite', (s) => s.put(e)); },
    quitar: (id) => { indice = null; return tx('readwrite', (s) => s.delete(id)); },
  };
  let indice = null;
  async function elIndice() {
    if (!indice) indice = new C.Indice(await idb.todas());
    return indice;
  }
  const nuevoId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');

  /* ------------------------------------------------------------ equipo */

  let device = 'wasm';
  let f16 = false;
  async function detectar() {
    try {
      if (!navigator.gpu) return;
      const a = await navigator.gpu.requestAdapter();
      if (!a) return;
      device = 'webgpu';
      f16 = a.features.has('shader-f16');
    } catch (e) { /* sin WebGPU */ }
  }

  /* ------------------------------------------------------------ worker */

  let worker = null, seq = 0, alDescarga = null;
  const pendientes = new Map();
  function elWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('worker.js', document.baseURI), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.tipo === 'descarga') { if (alDescarga) alDescarga(data); return; }
      const p = pendientes.get(data.id);
      if (!p) return;
      pendientes.delete(data.id);
      if (data.tipo === 'error') p.rej(new Error(data.error)); else p.res(data);
    };
    worker.onerror = (e) => {
      pendientes.forEach((p) => p.rej(new Error(e.message || 'el motor del navegador fallo')));
      pendientes.clear();
      worker = null;
    };
    return worker;
  }
  function pedir(msg, transfer) {
    const id = ++seq;
    return new Promise((res, rej) => {
      pendientes.set(id, { res, rej });
      elWorker().postMessage(Object.assign({ id }, msg), transfer || []);
    });
  }

  /* ------------------------------------------------------------- audio */

  async function decodificar(file) {
    const buf = await file.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx({ sampleRate: SR });            // el navegador ya remuestrea a 16 kHz
    try {
      const audio = await ctx.decodeAudioData(buf);
      const n = audio.length, canales = audio.numberOfChannels, out = new Float32Array(n);
      for (let c = 0; c < canales; c++) {
        const d = audio.getChannelData(c);
        for (let i = 0; i < n; i++) out[i] += d[i] / canales;
      }
      return out;
    } catch (e) {
      throw new Error('El navegador no sabe leer este formato. Prueba con MP3, WAV, M4A, MP4 o WEBM, o usa la versión de escritorio.');
    } finally {
      ctx.close();
    }
  }

  /* Whisper mira ventanas de 30 s. Cada corte cae en el punto mas silencioso
     entre los segundos 20 y 29, asi ninguna frase queda partida. */
  function planificar(pcm) {
    const BL = 320, nb = Math.floor(pcm.length / BL);
    const en = new Float32Array(nb);
    for (let b = 0; b < nb; b++) {
      let s = 0;
      for (let i = b * BL, f = i + BL; i < f; i++) s += Math.abs(pcm[i]);
      en[b] = s / BL;
    }
    const maxB = Math.floor(29 * SR / BL), minB = Math.floor(20 * SR / BL), cortes = [];
    let ini = 0;
    while (ini < nb) {
      if (nb - ini <= maxB) { cortes.push([ini, nb]); break; }
      let mejor = ini + maxB, v = Infinity;
      for (let b = ini + minB; b < ini + maxB; b++) {
        let s = 0;
        for (let k = -5; k < 5; k++) s += en[Math.min(nb - 1, Math.max(0, b + k))];
        if (s < v) { v = s; mejor = b; }
      }
      cortes.push([ini, mejor]);
      ini = mejor;
    }
    return cortes.map(([a, b]) => {
      let s = 0;
      for (let i = a; i < b; i++) s += en[i];
      return { a: a * BL, b: b === nb ? pcm.length : b * BL, energia: s / Math.max(1, b - a) };
    });
  }

  /* -------------------------------------------------------------- cola */

  const trabajos = new Map(), orden = [], cola = [], oyentes = [];
  let ocupado = false;
  const emitir = (s) => oyentes.forEach((f) => f(s));

  function resumenT(t) {
    return {
      id: t.id, nombre: t.nombre, base: t.base, origen: t.origen, url: '', estado: t.estado, fase: t.fase,
      progreso: t.progreso, idioma: t.idioma, duracion: t.duracion, segundos: t.segundos, trozos: t.trozos,
      error: t.error, n_segmentos: t.segmentos.length, eid: t.eid, modelo: t.ajustes.modelo,
    };
  }
  const aviso = (t) => emitir({ tipo: 'trabajo', trabajo: resumenT(t) });
  const fase = (t, texto) => { t.fase = texto; emitir({ tipo: 'fase', id: t.id, texto }); };

  class Cancelado extends Error {}

  async function transcribir(t) {
    const t0 = performance.now();
    t.estado = 'trabajando';
    fase(t, 'Leyendo el audio');
    aviso(t);
    try {
      const pcm = await decodificar(t.file);
      t.duracion = pcm.length / SR;
      aviso(t);
      fase(t, 'Preparando el modelo');
      alDescarga = (d) => {
        if (d.total) fase(t, `Bajando el modelo ${Math.round(d.hecho / d.total * 100)}% · solo la primera vez`);
      };
      await pedir({ tipo: 'cargar', modelo: t.ajustes.modelo, device });
      alDescarga = null;

      const trozos = planificar(pcm);
      t.trozos = trozos.length;
      fase(t, `Transcribiendo · ${trozos.length} ${trozos.length === 1 ? 'trozo' : 'trozos'} · ${device === 'webgpu' ? 'GPU' : 'CPU'}`);
      let previo = '';
      for (let i = 0; i < trozos.length; i++) {
        if (t.cancelar) throw new Cancelado();
        const z = trozos[i];
        if (z.energia > 0.002) {                       // los tramos mudos no se mandan: whisper inventaria texto
          const audio = pcm.slice(z.a, z.b);
          const r = await pedir({ tipo: 'trozo', audio, desde: z.a / SR, modelo: t.ajustes.modelo, idioma: t.ajustes.idioma, device }, [audio.buffer]);
          for (const s of r.segs) {
            if (s.texto === previo) continue;            // corta los bucles de repeticion
            previo = s.texto;
            t.segmentos.push(s);
            emitir({ tipo: 'segmento', id: t.id, ini: s.ini, fin: s.fin, texto: s.texto });
          }
        }
        t.progreso = (i + 1) / trozos.length;
        emitir({ tipo: 'progreso', id: t.id, valor: t.progreso });
      }
      t.segundos = +((performance.now() - t0) / 1000).toFixed(1);
      if (t.segmentos.length) {
        const e = {
          id: nuevoId(), nombre: t.base, origen: t.origen, url: '', idioma: t.ajustes.idioma || '',
          duracion: +t.duracion.toFixed(2), modelo: t.ajustes.modelo, segundos: t.segundos,
          creado: C.ahoraIso(), segmentos: t.segmentos.map((s) => ({ ini: +s.ini.toFixed(2), fin: +s.fin.toFixed(2), texto: s.texto })),
        };
        await idb.poner(e);
        t.eid = e.id;
      }
      t.estado = 'listo';
      t.fase = `Listo en ${t.segundos}s · ${(t.duracion / t.segundos).toFixed(1)}x tiempo real`;
    } catch (e) {
      alDescarga = null;
      if (e instanceof Cancelado) { t.estado = 'cancelado'; t.fase = 'Cancelado'; } else { t.estado = 'error'; t.fase = 'Error'; t.error = String(e.message || e).slice(0, 400); }
    } finally {
      t.file = null;
      aviso(t);
      emitir({ tipo: 'fin', id: t.id, estado: t.estado, eid: t.eid });
    }
  }

  async function procesar() {
    if (ocupado) return;
    ocupado = true;
    while (cola.length) {
      const t = trabajos.get(cola.shift());
      if (!t) continue;
      if (t.cancelar) { t.estado = 'cancelado'; t.fase = 'Cancelado'; aviso(t); continue; }
      await transcribir(t);
    }
    ocupado = false;
  }

  /* ---------------------------------------------------------- descargas */

  function descargar(nombre, texto) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([texto], { type: 'text/plain;charset=utf-8' }));
    a.download = nombre.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150);
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  /* ----------------------------------------------------------------- IA */

  const MODELOS_NAV = [
    { id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC', etiqueta: 'Qwen 2.5 · 3B', gb: 2.5 },
    { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', etiqueta: 'Qwen 2.5 · 1.5B', gb: 1.2 },
  ];
  const MODELOS_CLAUDE = [
    { id: 'claude-opus-5-5', etiqueta: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', etiqueta: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', etiqueta: 'Haiku 5.5' },
  ];
  const CON_FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
  const OLLAMA = 'http://127.0.0.1:11434';
  const LIMITE = { navegador: 14000, ollama: 48000, claude: 600000 };

  function cfgIA() {
    const ia = Object.assign({ proveedor: '', modelo_nav: MODELOS_NAV[0].id, modelo_ollama: '', modelo_claude: 'claude-opus-5-5', clave_claude: '' }, leerAj().ia || {});
    if (!ia.proveedor) ia.proveedor = device === 'webgpu' ? 'navegador' : (ia.clave_claude ? 'claude' : 'navegador');
    return ia;
  }

  async function ollamaModelos() {
    try {
      const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return null;
      const d = await r.json();
      return (d.models || []).filter((m) => !/embed/.test(m.name)).map((m) => ({ id: m.name, gb: +((m.size || 0) / 1e9).toFixed(1) }));
    } catch (e) { return null; }
  }

  let motorLLM = null, motorId = '';
  async function webllm(id, alFase) {
    if (!f16) id = id.replace('q4f16_1', 'q4f32_1');
    if (motorLLM && motorId === id) return motorLLM;
    if (device !== 'webgpu') throw new Error('La IA en el navegador necesita WebGPU (Chrome o Edge recientes). Usa Claude u Ollama en AJUSTES.');
    const m = await import('https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm');
    if (motorLLM) { try { await motorLLM.unload(); } catch (e) { /* nada */ } }
    motorLLM = await m.CreateMLCEngine(id, {
      initProgressCallback: (r) => alFase(`Preparando la IA del navegador ${Math.round((r.progress || 0) * 100)}% · solo la primera vez`),
    }, { context_window_size: 8192 });
    motorId = id;
    return motorLLM;
  }

  async function generar(sistema, mensajes, alTexto, alFase, signal) {
    const ia = cfgIA();
    const partes = [];
    const sumar = (t) => { if (t) { partes.push(t); alTexto(t); } };

    if (ia.proveedor === 'claude') {
      if (!ia.clave_claude) throw new Error('Falta la clave de Claude: ponla en AJUSTES.');
      const { default: Anthropic } = await import('https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.135.0/+esm');
      const cliente = new Anthropic({ apiKey: ia.clave_claude, dangerouslyAllowBrowser: true });
      const params = { model: ia.modelo_claude, max_tokens: 32000, system: sistema, messages: mensajes };
      // Si un filtro de seguridad rechaza la peticion, la API la repite sola con otro modelo.
      const flujo = CON_FALLBACK.has(ia.modelo_claude)
        ? cliente.beta.messages.stream(Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }), { signal })
        : cliente.messages.stream(params, { signal });
      flujo.on('text', sumar);
      let final;
      try {
        final = await flujo.finalMessage();
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) throw new Error('La clave de Claude no es válida.');
        if (e instanceof Anthropic.RateLimitError) throw new Error('Claude: límite de uso alcanzado, prueba en un momento.');
        if (e instanceof Anthropic.APIConnectionError) throw new Error('No hay conexión con Claude.');
        throw e;
      }
      if (final.stop_reason === 'refusal') throw new Error('Claude rechazó esta petición.');
      return partes.join('');
    }

    if (ia.proveedor === 'ollama') {
      const locales = await ollamaModelos();
      if (!locales) throw new Error('No llego a tu Ollama. Ábrelo con la variable OLLAMA_ORIGINS=' + location.origin + ' (mira AJUSTES).');
      if (!locales.length) throw new Error('Ollama no tiene modelos. En una terminal: ollama pull gemma3');
      const modelo = locales.some((m) => m.id === ia.modelo_ollama) ? ia.modelo_ollama : locales[0].id;
      const largo = sistema.length + mensajes.reduce((n, m) => n + m.content.length, 0);
      let ctx = 4096;
      while (ctx < largo / 3.2 + 3072 && ctx < 65536) ctx *= 2;
      const r = await fetch(`${OLLAMA}/api/chat`, {
        method: 'POST', signal,
        body: JSON.stringify({ model: modelo, stream: true, messages: [{ role: 'system', content: sistema }, ...mensajes], options: { num_ctx: ctx, temperature: 0.3 } }),
      });
      if (!r.ok) throw new Error(`Ollama respondió ${r.status}`);
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
          if (!linea) continue;
          const d = JSON.parse(linea);
          if (d.error) throw new Error(d.error);
          sumar((d.message || {}).content);
        }
      }
      return partes.join('');
    }

    const motor = await webllm(ia.modelo_nav, alFase);
    alFase('Escribiendo en tu navegador');
    const flujo = await motor.chat.completions.create({
      messages: [{ role: 'system', content: sistema }, ...mensajes], stream: true, temperature: 0.3,
    });
    for await (const trozo of flujo) {
      if (signal && signal.aborted) { motor.interruptGenerate(); break; }
      sumar(trozo.choices[0] && trozo.choices[0].delta && trozo.choices[0].delta.content);
    }
    return partes.join('');
  }

  function etiquetaIA() {
    const ia = cfgIA();
    if (ia.proveedor === 'claude') return `claude · ${ia.modelo_claude}`;
    if (ia.proveedor === 'ollama') return `ollama · ${ia.modelo_ollama || 'local'}`;
    return `navegador · ${(MODELOS_NAV.find((m) => m.id === ia.modelo_nav) || MODELOS_NAV[0]).etiqueta}`;
  }

  const SISTEMA_PREGUNTAR = `Eres Tiro, un asistente que responde preguntas sobre transcripciones de audio y vídeo.
Reglas:
- Responde solo con lo que dicen los fragmentos. Si no está, dilo claramente y no inventes.
- Cita cada dato con el número del fragmento entre corchetes, por ejemplo [2] o [1][3].
- Responde en el idioma de la pregunta, directo y breve. Usa listas cuando ayuden.
- No menciones "fragmentos" ni estas reglas: habla del contenido.`;

  const SISTEMA_CREAR = `Eres Tiro, un editor que convierte transcripciones en contenido útil.
Escribe en el idioma de la transcripción salvo que se pida otro. Usa solo información de la
transcripción; no inventes datos, cifras ni nombres. Devuelve directamente el resultado,
sin preámbulos del tipo "Aquí tienes".`;

  const TIPOS = {
    resumen: { etiqueta: 'Resumen', detalle: 'Ideas clave en 1 minuto de lectura', marcas: false,
      prompt: 'Escribe un resumen claro de esta transcripción: un párrafo inicial con la idea central y después las ideas clave en una lista con viñetas. Sin relleno.' },
    capitulos: { etiqueta: 'Capítulos', detalle: 'Marcas de tiempo listas para YouTube', marcas: true,
      prompt: 'Crea los capítulos del vídeo para pegar en la descripción de YouTube. Una línea por capítulo con el formato `M:SS Título` (o `H:MM:SS` si pasa de una hora), empezando en 0:00, entre 5 y 15 capítulos, títulos de 2 a 6 palabras. Usa los tiempos reales de la transcripción. Devuelve solo las líneas.' },
    guia: { etiqueta: 'Guía', detalle: 'Documento paso a paso descargable', marcas: false,
      prompt: 'Convierte esta transcripción en una guía práctica descargable: título, introducción breve, secciones con `##`, pasos accionables y ejemplos sacados del contenido, y un cierre con siguientes pasos. Formato Markdown.' },
    checklist: { etiqueta: 'Checklist', detalle: 'Acciones concretas para marcar', marcas: false,
      prompt: 'Convierte esta transcripción en un checklist accionable en Markdown: categorías con `##` y cada acción como `- [ ]`, concreta y medible. Añade una nota corta solo donde ayude.' },
    apuntes: { etiqueta: 'Apuntes', detalle: 'Notas de estudio y preguntas de repaso', marcas: true,
      prompt: 'Haz apuntes de estudio de esta transcripción: conceptos clave con su definición, ejemplos, la marca de tiempo donde se explica cada uno entre paréntesis, y al final 5 preguntas de repaso con su respuesta. Formato Markdown.' },
    reel: { etiqueta: 'Guion de reel', detalle: '30-60 s con gancho, cuerpo y llamada', marcas: false,
      prompt: 'Escribe un guion de reel de 30 a 60 segundos basado en la idea más potente de esta transcripción. Estructura: GANCHO (menos de 2 segundos, habla de tú, dolor o contraste), DESARROLLO (3 a 5 frases cortas), CTA. Añade debajo 3 titulares alternativos de máximo 7 palabras.' },
    post: { etiqueta: 'Post / hilo', detalle: 'Texto para redes o newsletter', marcas: false,
      prompt: 'Escribe un post para redes (o un hilo de 5 a 8 partes numeradas) con lo más útil de esta transcripción. Frases cortas, una idea por línea, sin emojis de relleno y con una pregunta final para comentarios.' },
    citas: { etiqueta: 'Citas', detalle: 'Frases textuales con su minuto', marcas: true,
      prompt: 'Extrae las 8 a 12 frases más memorables, TEXTUALES, de esta transcripción. Una por línea con el formato `M:SS - "frase"`. No las reescribas.' },
  };

  function partir(texto, limite, porLineas) {
    const sep = porLineas ? '\n' : '. ', partes = [];
    let actual = '';
    for (const t of texto.split(sep)) {
      if (actual.length + t.length > limite && actual) { partes.push(actual); actual = ''; }
      actual += t + sep;
    }
    if (actual) partes.push(actual);
    return partes;
  }

  /* ---------------------------------------------------------- contrato */

  g.TiroWeb = {
    modo: 'web',

    async iniciar() {
      await detectar();
      let enCache = new Set();
      try {
        const c = await caches.open('transformers-cache');
        enCache = new Set((await c.keys()).map((r) => r.url));
      } catch (e) { /* sin Cache API */ }
      const listo = (id) => [...enCache].some((u) => u.includes(id + '/'));
      const gpu = device === 'webgpu';
      return {
        modelos: [
          { clave: 'rapido', etiqueta: 'Rápido', listo: listo('onnx-community/whisper-base') },
          { clave: 'equilibrado', etiqueta: 'Equilibrado', listo: listo('onnx-community/whisper-small') },
          { clave: 'turbo', etiqueta: gpu ? 'Turbo' : 'Turbo · solo GPU', listo: listo('onnx-community/whisper-large-v3-turbo') },
        ],
        modelo_defecto: gpu ? 'turbo' : 'rapido',
        formatos: Object.entries(C.FORMATOS).map(([clave, f]) => ({ clave, etiqueta: f.etiqueta })),
        tipos: Object.entries(TIPOS).map(([clave, t]) => ({ clave, etiqueta: t.etiqueta, detalle: t.detalle })),
        motor: gpu ? 'Navegador · WebGPU' : 'Navegador · CPU',
        capHint: gpu ? 'Whisper en tu tarjeta gráfica' : 'Whisper en tu procesador · sin GPU',
        funciones: { enlaces: false, carpeta: false, paralelo: false, fiel: false, dialogo: false },
        carpeta_defecto: '', carpeta_biblioteca: 'Este navegador · IndexedDB',
        ajustes: {}, ffmpeg: true, whisper: true,
      };
    },

    escuchar(fn) { oyentes.push(fn); setTimeout(() => fn({ tipo: 'conexion', ok: true }), 0); },
    trabajos: async () => orden.map((id) => trabajos.get(id)).filter(Boolean).map(resumenT),
    elegirArchivos: async () => null,

    async encolarArchivos(items, ajustes) {
      const encolados = [], rechazados = [];
      for (const it of items) {
        if (!it.file) { rechazados.push({ nombre: it.nombre || '?', motivo: 'archivo no disponible' }); continue; }
        if (it.file.size > 1.5e9) { rechazados.push({ nombre: it.file.name, motivo: 'demasiado grande para el navegador: usa la versión de escritorio' }); continue; }
        const nombre = it.file.name || 'audio';
        // Whisper en el navegador no detecta el idioma (sin decirselo traduce
        // al ingles): «Auto» usa el idioma del navegador.
        const idioma = ajustes.idioma || (navigator.language || 'es').slice(0, 2).toLowerCase();
        const t = {
          id: nuevoId(), nombre, base: nombre.replace(/\.[^.]+$/, ''), origen: it.origen || 'archivo',
          file: it.file, ajustes: { modelo: ajustes.modelo === 'turbo' && device !== 'webgpu' ? 'rapido' : (ajustes.modelo || 'rapido'), idioma },
          estado: 'en_cola', fase: 'En cola', progreso: 0, idioma, duracion: 0, segundos: 0,
          trozos: 0, error: '', segmentos: [], eid: '', cancelar: false,
        };
        trabajos.set(t.id, t);
        orden.push(t.id);
        cola.push(t.id);
        aviso(t);
        encolados.push(resumenT(t));
      }
      procesar();
      return { encolados, rechazados };
    },

    async enlaces() {
      throw new Error('Los enlaces necesitan la versión de escritorio (yt-dlp). En la web: suelta el archivo o dicta.');
    },

    async cancelar(id) {
      for (const t of trabajos.values()) {
        if (id && t.id !== id) continue;
        if (['en_cola', 'trabajando'].includes(t.estado)) {
          t.cancelar = true;
          if (t.estado === 'en_cola') { t.estado = 'cancelado'; t.fase = 'Cancelado'; aviso(t); }
        }
      }
      return { ok: true };
    },
    async quitar(id) {
      const t = trabajos.get(id);
      if (t) t.cancelar = true;
      trabajos.delete(id);
      const i = orden.indexOf(id);
      if (i >= 0) orden.splice(i, 1);
      return { ok: true };
    },
    async textoTrabajo(id, formato) {
      const t = trabajos.get(id);
      if (!t) throw new Error('no existe');
      return { texto: C.formatear(formato, t.segmentos, { archivo: t.nombre }).texto, nombre: t.base };
    },

    async biblioteca() {
      const todas = (await idb.todas()).map(C.resumen).sort((a, b) => (a.creado < b.creado ? 1 : -1));
      return {
        entradas: todas,
        stats: {
          transcripciones: todas.length,
          segundos: todas.reduce((n, r) => n + (r.duracion || 0), 0),
          palabras: todas.reduce((n, r) => n + r.palabras, 0),
        },
      };
    },
    async entrada(id) {
      const e = await idb.una(id);
      if (!e) throw new Error('no existe');
      return e;
    },
    async textoEntrada(id, formato) {
      const e = await idb.una(id);
      if (!e) throw new Error('no existe');
      const meta = { archivo: e.nombre, idioma: e.idioma, duracion: e.duracion, modelo: e.modelo, origen: e.origen, generado: e.creado };
      const r = C.formatear(formato, e.segmentos, meta);
      return { texto: r.texto, ext: r.ext, nombre: e.nombre };
    },
    buscar: async (q, ids, k) => (await elIndice()).buscar(q, ids, k || 30),
    borrar: async (id) => { await idb.quitar(id); return { ok: true }; },
    async renombrar(id, nombre) {
      const e = await idb.una(id);
      if (!e) throw new Error('no existe');
      e.nombre = (nombre || '').trim().slice(0, 200) || e.nombre;
      await idb.poner(e);
      return { entrada: C.resumen(e) };
    },

    async exportar(ids, formato) {
      let ok = 0;
      for (const id of ids) {
        const r = await this.textoEntrada(id, formato);
        descargar(r.nombre + r.ext, r.texto);
        ok++;
        if (ids.length > 1) await new Promise((res) => setTimeout(res, 350));
      }
      return { ok, rutas: [], fallos: [] };
    },
    async escribir(nombre, texto, ext) {
      descargar(nombre + (ext || '.md'), texto);
      return { ruta: '' };
    },

    async ia() {
      const ia = cfgIA();
      // Solo se busca tu Ollama si lo elegiste: probar 127.0.0.1 en cada visita
      // ensucia la consola y el navegador puede pedir permiso de red local.
      const locales = ia.proveedor === 'ollama' ? await ollamaModelos() : null;
      return {
        proveedor: ia.proveedor,
        navegador: { webgpu: device === 'webgpu', modelo: ia.modelo_nav, modelos: MODELOS_NAV },
        ollama: { instalado: !!locales, activo: !!locales, modelos: locales || [], modelo: ia.modelo_ollama || (locales && locales[0] ? locales[0].id : ''), origen: location.origin },
        claude: { configurado: !!ia.clave_claude, modelo: ia.modelo_claude, modelos: MODELOS_CLAUDE },
      };
    },
    async guardarIA(cambios) {
      const c = Object.assign({}, cambios);
      if (c.clave_claude === 'guardada') delete c.clave_claude;
      mezclarAj({ ia: c });
      return { ok: true };
    },
    encenderOllama: async () => ({ ok: !!(await ollamaModelos()) }),
    guardarAjustes: async (cambios) => ({ ajustes: mezclarAj(cambios) }),
    elegirCarpeta: async () => '',
    abrir: async () => {},

    async preguntar(cuerpo, alLinea, signal) {
      const pregunta = (cuerpo.pregunta || '').trim();
      try {
        if (!pregunta) throw new Error('Escribe una pregunta.');
        alLinea({ t: 'fase', v: 'Buscando en la biblioteca' });
        const ids = (cuerpo.ids || []).filter(Boolean);
        let fuentes = [];
        const limite = LIMITE[cfgIA().proveedor] || LIMITE.navegador;
        if (ids.length === 1) {
          const e = await idb.una(ids[0]);
          if (e && C.textoPlano(e).length < limite * 0.8) fuentes = C.fragmentar(e);
        }
        if (!fuentes.length) {
          const hist = (cuerpo.historial || []).filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ');
          fuentes = (await elIndice()).buscar(pregunta + ' ' + hist, ids, cfgIA().proveedor === 'navegador' ? 5 : 8);
        }
        if (!fuentes.length) throw new Error('No encontré nada relacionado en la biblioteca. Prueba con otras palabras o transcribe primero el audio.');
        const bloques = fuentes.map((f, i) => `[${i + 1}] ${f.nombre} · ${C.reloj(f.ini)}-${C.reloj(f.fin)}\n${f.texto}`);
        const mensajes = (cuerpo.historial || []).slice(-6).filter((m) => m.content);
        mensajes.push({ role: 'user', content: `Fragmentos:\n\n${bloques.join('\n\n')}\n\nPregunta: ${pregunta}` });
        alLinea({ t: 'fase', v: `Pensando con ${etiquetaIA()}` });
        await generar(SISTEMA_PREGUNTAR, mensajes, (t) => alLinea({ t: 'texto', v: t }), (f) => alLinea({ t: 'fase', v: f }), signal);
        alLinea({ t: 'fuentes', v: fuentes.map((f, i) => ({ n: i + 1, id: f.id, nombre: f.nombre, ini: f.ini, fin: f.fin })) });
        alLinea({ t: 'fin' });
      } catch (e) {
        if (signal && signal.aborted) return;
        alLinea({ t: 'error', v: String(e.message || e) });
      }
    },

    async crear(cuerpo, alLinea, signal) {
      try {
        const t = TIPOS[cuerpo.tipo];
        if (!t) throw new Error('Elige qué crear.');
        const e = await idb.una(cuerpo.id);
        if (!e) throw new Error('Esa transcripción ya no está en la biblioteca.');
        let texto = C.textoPlano(e, t.marcas);
        const limite = LIMITE[cfgIA().proveedor] || LIMITE.navegador;
        let pedido = t.prompt;
        if ((cuerpo.instrucciones || '').trim()) pedido += '\n\nIndicaciones del usuario: ' + cuerpo.instrucciones.trim().slice(0, 1500);
        const fase = (f) => alLinea({ t: 'fase', v: f });
        if (texto.length > limite) {
          // Dos pasadas: notas fieles de cada parte y despues el resultado. Nada se recorta en silencio.
          const partes = partir(texto, limite, t.marcas), notas = [];
          for (let i = 0; i < partes.length; i++) {
            fase(`Leyendo parte ${i + 1} de ${partes.length}`);
            notas.push(await generar(SISTEMA_CREAR, [{ role: 'user', content: 'Toma notas detalladas y fieles de esta parte de una transcripción, conservando datos, ejemplos, nombres y las marcas de tiempo [M:SS] si las hay:\n\n' + partes[i] }], () => {}, fase, signal));
          }
          texto = notas.map((n, i) => `NOTAS PARTE ${i + 1}:\n${n}`).join('\n\n');
        }
        fase(`Escribiendo con ${etiquetaIA()}`);
        const resultado = await generar(SISTEMA_CREAR, [{ role: 'user', content: `Transcripción de "${e.nombre}":\n\n${texto}\n\n---\n${pedido}` }], (x) => alLinea({ t: 'texto', v: x }), fase, signal);
        const fresca = (await idb.una(cuerpo.id)) || e;
        fresca.recursos = [{ tipo: cuerpo.tipo, creado: C.ahoraIso(), modelo: etiquetaIA(), texto: resultado }, ...(fresca.recursos || [])].slice(0, 30);
        await idb.poner(fresca);
        alLinea({ t: 'fin' });
      } catch (err) {
        if (signal && signal.aborted) return;
        alLinea({ t: 'error', v: String(err.message || err) });
      }
    },
  };
})(window);
