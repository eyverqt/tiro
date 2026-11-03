/* ==========================================================================
   Tiro — interfaz

   Una sola interfaz para los dos modos. Al arrancar prueba si hay un
   server.py detras (modo escritorio, local.js); si no, todo corre en el
   navegador (web.js). Las dos piezas cumplen el mismo contrato, asi que
   aqui solo se pinta.
   ========================================================================== */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const E = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let V = null;                                   // TiroLocal o TiroWeb
const BASE = new URL(document.baseURI).pathname.replace(/\/$/, '');
const PAGINAS = ['transcribir', 'biblioteca', 'preguntar', 'crear', 'ajustes'];
const TITULOS = { transcribir: 'Transcribir', biblioteca: 'Biblioteca', preguntar: 'Preguntar', crear: 'Crear', ajustes: 'Ajustes' };
const ORIGEN = { archivo: 'Archivo', enlace: 'Enlace', dictado: 'Dictado' };
const ETIQUETAS = { subiendo: 'Subiendo', descargando: 'Bajando', en_cola: 'En cola', trabajando: 'Transcribiendo', listo: 'Listo ✓', error: 'Error', cancelado: 'Cancelado' };
const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
const ESCRITORIO = 'https://eyverqt.netlify.app/tiro';

const est = {
  cfg: null, pagina: 'transcribir',
  trabajos: new Map(), orden: [], sel: null, nodos: new Map(), segNodos: [],
  lib: [], libSel: null, libEntrada: null,
  chat: [], chatCtl: null, pregSel: null,
  crearSel: null, crearTipo: 'resumen', crearCtl: null, crearTexto: '',
  ia: null,
};

/* ------------------------------------------------------------- opciones */

const CLAVE_OPC = 'tiro.opciones';
const opc = Object.assign({ idioma: '', modelo: '', fiel: 'true', workers: '0', formato: 'txt', alcance: 'todo' },
  (() => { try { return JSON.parse(localStorage.getItem(CLAVE_OPC) || '{}'); } catch (e) { return {}; } })());
function guardarOpc() {
  try { localStorage.setItem(CLAVE_OPC, JSON.stringify(opc)); } catch (e) { /* modo privado */ }
}

/* Selector de opciones: la activa en negrita con punto rojo, las demas en gris. */
function pintarSeg(el, v) {
  $$('button', el).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(v))));
}
function pintarSegs() {
  $$('.seg[data-key]').forEach((el) => pintarSeg(el, opc[el.dataset.key]));
}

/* ------------------------------------------------------------ utilidades */

function toast(texto, malo) {
  const t = $('#toast');
  t.textContent = texto;
  t.classList.toggle('err', !!malo);
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, malo ? 5600 : 2800);
}

function reloj(seg) {
  seg = Math.max(0, Math.round(seg || 0));
  const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = seg % 60;
  const dos = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${dos(m)}:${dos(s)}` : `${m}:${dos(s)}`;
}

function fecha(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]} ${MESES[+m[2] - 1]}` : '';
}

function fechaArchivo() {
  const d = new Date(), dos = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}-${dos(d.getMinutes())}`;
}

const numero = (n) => Math.round(n || 0).toLocaleString('es');

async function copiarTexto(texto) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = texto;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/* Markdown minimo: titulos, listas, casillas, negrita, codigo y citas [n]. */
function md(texto) {
  const lineas = E(texto).split('\n');
  let html = '', lista = null;
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[(\d{1,2})\]/g, '<a class="cita" data-n="$1">[$1]</a>');
  const cerrar = () => { if (lista) { html += `</${lista}>`; lista = null; } };
  const abrir = (t) => { if (lista !== t) { cerrar(); html += `<${t}>`; lista = t; } };
  for (const l of lineas) {
    let m;
    if ((m = l.match(/^(#{1,3})\s+(.*)/))) { cerrar(); html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`; continue; }
    if ((m = l.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)/))) { abrir('ul'); html += `<li class="check${m[1].trim() ? ' hecho' : ''}">${inline(m[2])}</li>`; continue; }
    if ((m = l.match(/^\s*[-*•]\s+(.*)/))) { abrir('ul'); html += `<li>${inline(m[1])}</li>`; continue; }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { abrir('ol'); html += `<li>${inline(m[1])}</li>`; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(l)) { cerrar(); html += '<hr>'; continue; }
    if (!l.trim()) { cerrar(); continue; }
    cerrar();
    html += `<p>${inline(l)}</p>`;
  }
  cerrar();
  return html;
}

/* Resalta las palabras buscadas sin importar tildes ni mayusculas. */
const ACENTOS = { a: '[aáàä]', e: '[eéèë]', i: '[iíìï]', o: '[oóòö]', u: '[uúùü]', n: '[nñ]' };
function resaltar(texto, q) {
  const palabras = q.split(/\s+/).filter((w) => w.length > 2)
    .map((w) => [...w.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')]
      .map((c) => ACENTOS[c] || c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''));
  const seguro = E(texto);
  if (!palabras.length) return seguro;
  return seguro.replace(new RegExp(`(${palabras.join('|')})`, 'gi'), '<mark>$1</mark>');
}

/* Enlace al segundo exacto del video original cuando es de YouTube. */
function enlaceEnSegundo(url, s) {
  if (!url || !/youtu\.?be/.test(url)) return '';
  return `${url}${url.includes('?') ? '&' : '?'}t=${Math.floor(s)}s`;
}

/* ----------------------------------------------------------------- rutas */

function rutaActual() {
  const p = location.pathname.slice(BASE.length).replace(/^\/+|\/+$/g, '');
  return PAGINAS.includes(p) ? p : 'transcribir';
}

function ir(p, empujar = true) {
  est.pagina = p;
  $$('.pagina').forEach((s) => { s.hidden = s.dataset.p !== p; });
  $$('#tabs a').forEach((a) => a.classList.toggle('is-active', a.dataset.ir === p));
  $('#logoSub').textContent = TITULOS[p];
  if (empujar && location.protocol !== 'file:' && rutaActual() !== p) history.pushState(null, '', `${BASE}/${p}`);
  if (p === 'biblioteca') cargarLib();
  if (p === 'preguntar') pintarAlcance();
  if (p === 'crear') pintarCrear();
  if (p === 'ajustes') cargarAjustes();
  window.scrollTo(0, 0);
}

/* =============================================================== ARRANQUE */

async function arrancar() {
  V = (await TiroLocal.probar()) ? TiroLocal : TiroWeb;
  document.body.dataset.modo = V.modo;
  try {
    est.cfg = await V.iniciar();
  } catch (e) {
    toast(`No se pudo arrancar: ${e.message}`, true);
    return;
  }
  const cfg = est.cfg, f = cfg.funciones;

  $('#segModelo').innerHTML = cfg.modelos.map((m) =>
    `<button type="button" data-v="${m.clave}" title="${m.listo ? 'Ya descargado: funciona sin internet' : 'Se descarga la primera vez'}">${E(m.etiqueta)}${m.listo ? '<small>✓</small>' : ''}</button>`).join('');
  if (!cfg.modelos.some((m) => m.clave === opc.modelo)) opc.modelo = cfg.modelo_defecto;

  $('#optFiel').hidden = !f.fiel;
  $('#optWorkers').hidden = !f.paralelo;
  $('#vocabulario').closest('.field').hidden = !f.fiel;
  if (!f.enlaces) {
    $('#urls').disabled = true;
    $('#urls').placeholder = V.modo === 'web' ? 'Enlaces: solo en la versión de escritorio' : 'Falta yt-dlp: vuelve a ejecutar start.bat';
    $('#btnTraer').textContent = V.modo === 'web' ? 'Escritorio ↗' : 'Traer';
  }
  if (V.modo === 'web') {
    $('#archivo').accept = 'audio/*,video/*';
    $('.seg[data-key="idioma"] button[data-v=""]').textContent = `Auto · ${(navigator.language || 'es').slice(0, 2).toUpperCase()}`;
  }
  $('#metaMotor').textContent = cfg.motor;
  $('#capHint').textContent = cfg.capHint;
  $('#tipos').innerHTML = cfg.tipos.map((t) =>
    `<li data-tipo="${t.clave}"><button class="row" type="button"><span class="title">${E(t.etiqueta)}</span><span class="tag">${E(t.detalle)}</span></button></li>`).join('');
  pintarSegs();
  pintarVs();

  if (cfg.ffmpeg === false) toast('Falta ffmpeg en el PATH: sin él no se puede leer el audio de los vídeos.', true);
  else if (cfg.whisper === false) toast('Falta faster-whisper. Cierra y vuelve a ejecutar start.bat.', true);

  V.escuchar(manejar);
  (await V.trabajos()).forEach(absorber);
  if (!est.sel && est.orden.length) seleccionar(est.orden[est.orden.length - 1]);
  enganchar();
  ir(rutaActual(), false);
  cargarLib(true);
  refrescarIA();
}

async function refrescarIA() {
  try { est.ia = await V.ia(); } catch (e) { return; }
  const ia = est.ia;
  let texto = 'IA —';
  if (ia.proveedor === 'claude') texto = `IA · Claude ${(ia.claude.modelos.find((m) => m.id === ia.claude.modelo) || {}).etiqueta || ''}`;
  else if (ia.proveedor === 'ollama') texto = ia.ollama.activo ? `IA · ${ia.ollama.modelo || 'Ollama'}` : 'IA · Ollama apagado';
  else if (ia.proveedor === 'navegador') texto = ia.navegador.webgpu ? 'IA · en tu navegador' : 'IA · elige en ajustes';
  $('#metaIA').textContent = texto;
  refrescarGlobal();
}

/* ============================================================ TRANSCRIBIR */

function ajustesTrabajo() {
  return {
    idioma: opc.idioma, modelo: opc.modelo, fiel: opc.fiel === 'true',
    workers: parseInt(opc.workers, 10) || 0, vocabulario: $('#vocabulario').value,
  };
}

function manejar(s) {
  const t = s.id ? est.trabajos.get(s.id) : null;
  switch (s.tipo) {
    case 'conexion':
      if (!s.ok && V.modo === 'local') { $('#live').textContent = 'Sin servidor'; }
      else refrescarGlobal();
      return;
    case 'trabajo': absorber(s.trabajo); break;
    case 'fase': if (t) { t.fase = s.texto; refrescarFila(t); } break;
    case 'progreso': if (t) { t.progreso = s.valor; refrescarFila(t); } break;
    case 'idioma': if (t) { t.idioma = s.codigo; refrescarFila(t); } break;
    case 'segmento':
      if (t) {
        const pos = insertarOrdenado(t.segmentos, { ini: s.ini, fin: s.fin, texto: s.texto });
        if (est.sel === t.id) pintarSegmento(t.segmentos[pos], pos);
        refrescarFila(t);
      }
      break;
    case 'fin':
      if (t) {
        t.eid = s.eid || t.eid;
        rehidratar(t).then(() => {
          if (est.sel === null || est.sel === t.id) { est.sel = null; seleccionar(t.id); }
          if (t.origen === 'dictado' && t.estado === 'listo') {
            textoDe(t.id, 'parrafos').then((x) => copiarTexto(x.trim())).then(() => toast('Dictado listo y copiado')).catch(() => {});
          }
        });
        cargarLib(true);
      }
      break;
    default: break;
  }
  refrescarGlobal();
}

/* Si la pagina se recarga a media faena faltan segmentos: al terminar se
   piden enteros para no mostrar un texto con agujeros. */
async function rehidratar(t) {
  if (t.estado !== 'listo' || !t.eid) return;
  if (t.segmentos.length && t.segmentos.length >= (t.n_segmentos || 0)) return;
  try { t.segmentos = (await V.entrada(t.eid)).segmentos || t.segmentos; } catch (e) { /* lo que llego en vivo */ }
}

function insertarOrdenado(lista, seg) {
  let bajo = 0, alto = lista.length;
  while (bajo < alto) {
    const medio = (bajo + alto) >> 1;
    if (lista[medio].ini <= seg.ini) bajo = medio + 1; else alto = medio;
  }
  lista.splice(bajo, 0, seg);
  return bajo;
}

function absorber(res) {
  let t = est.trabajos.get(res.id);
  if (!t) {
    t = Object.assign({ segmentos: [] }, res);
    est.trabajos.set(t.id, t);
    est.orden.push(t.id);
    crearFila(t);
  } else {
    const segs = t.segmentos;
    Object.assign(t, res);
    t.segmentos = segs;                          // el resumen no los trae
    refrescarFila(t);
  }
  if (!est.sel && t.estado === 'trabajando') seleccionar(t.id);
  return t;
}

function crearFila(t, provisional) {
  $('#colaVacia').hidden = true;
  const li = document.createElement('li');
  li.className = 'job';
  li.innerHTML = `<div class="job-h"><b></b><span></span></div><div class="bar"><i></i></div>
    <div class="job-f"><span></span><button type="button" class="x">Quitar</button></div>`;
  $('b', li).textContent = t.nombre;
  $('b', li).title = t.nombre;
  $('#cola').appendChild(li);
  const nodos = { li, barra: $('.bar i', li), fase: $('.job-f span', li), est: $('.job-h span', li) };
  if (provisional) return nodos;
  li.dataset.id = t.id;
  li.addEventListener('click', (e) => {
    if (e.target.classList.contains('x')) { e.stopPropagation(); quitar(t.id); return; }
    seleccionar(t.id);
  });
  est.nodos.set(t.id, nodos);
  refrescarFila(t);
  return nodos;
}

function refrescarFila(t) {
  const n = est.nodos.get(t.id);
  if (!n) return;
  n.li.dataset.estado = t.estado;
  n.li.classList.toggle('sel', est.sel === t.id);
  $('b', n.li).textContent = t.nombre;
  n.est.textContent = ETIQUETAS[t.estado] || t.estado;
  n.barra.style.width = `${Math.round((t.progreso || 0) * 100)}%`;
  const partes = [];
  if (t.origen && t.origen !== 'archivo') partes.push(ORIGEN[t.origen]);
  if (t.duracion) partes.push(reloj(t.duracion));
  if (t.idioma) partes.push(t.idioma.toUpperCase());
  if (t.estado === 'trabajando') partes.push(`${Math.round((t.progreso || 0) * 100)}%`);
  const lineas = t.segmentos.length || t.n_segmentos || 0;
  if (lineas) partes.push(`${lineas} líneas`);
  const cola = t.error || t.fase || '';
  n.fase.textContent = (partes.join(' · ') + (cola ? ` · ${cola}` : '')) || '—';
  n.fase.title = t.error || '';
}

function refrescarGlobal() {
  const todos = [...est.trabajos.values()];
  const listos = todos.filter((t) => t.estado === 'listo').length;
  const activos = todos.filter((t) => ['trabajando', 'en_cola', 'descargando'].includes(t.estado)).length;
  $('#colaHint').textContent = `${todos.length} ${todos.length === 1 ? 'archivo' : 'archivos'} · ${listos} ${listos === 1 ? 'listo' : 'listos'}${activos ? ` · ${activos} en marcha` : ''}`;
  const enMarcha = todos.find((t) => t.estado === 'trabajando');
  const p = enMarcha ? enMarcha.progreso || 0 : 0;
  $('#barTop i').style.width = enMarcha ? `${Math.round(p * 100)}%` : '0';
  const live = $('#live');
  if (enMarcha) {
    live.className = 'hot';
    live.textContent = `Transcribiendo ${Math.round(p * 100)}%`;
  } else {
    const nube = est.ia && est.ia.proveedor === 'claude';
    live.className = nube ? 'muted' : 'hot';
    live.textContent = V && V.modo === 'web' ? (nube ? 'En tu navegador · IA en la nube' : 'En tu navegador') : (nube ? 'Local · IA en la nube' : '100% local');
  }
  document.title = enMarcha ? `${Math.round(p * 100)}% · Tiro` : 'Tiro';
}

async function quitar(id) {
  await V.quitar(id).catch(() => {});
  const n = est.nodos.get(id);
  if (n) n.li.remove();
  est.nodos.delete(id);
  est.trabajos.delete(id);
  est.orden = est.orden.filter((x) => x !== id);
  if (est.sel === id) {
    est.sel = null;
    const otro = est.orden[est.orden.length - 1];
    if (otro) seleccionar(otro); else pintarSalida(null);
  }
  $('#colaVacia').hidden = est.trabajos.size > 0;
  refrescarGlobal();
}

function seleccionar(id) {
  if (est.sel === id) return;
  const previo = est.nodos.get(est.sel);
  if (previo) previo.li.classList.remove('sel');
  est.sel = id;
  const n = est.nodos.get(id);
  if (n) n.li.classList.add('sel');
  pintarSalida(id);
  const t = est.trabajos.get(id);
  if (t && t.estado === 'listo' && !t.segmentos.length) rehidratar(t).then(() => { if (est.sel === id) pintarSalida(id); });
}

function pintarSalida(id) {
  const caja = $('#salida');
  caja.innerHTML = '';
  est.segNodos = [];
  const t = id ? est.trabajos.get(id) : null;
  if (!t) {
    caja.innerHTML = '<div class="ghost vacio-g">Tiro<small>El texto aparece aquí mientras el modelo escucha</small></div>';
    $('#salidaTitulo').textContent = '04 · Texto en vivo';
    $('#salidaTag').textContent = '';
    actualizarPie(null);
    return;
  }
  $('#salidaTitulo').textContent = `04 · ${t.nombre}`;
  $('#salidaTag').textContent = t.idioma ? t.idioma.toUpperCase() : '';
  if (t.segmentos.length) {
    const frag = document.createDocumentFragment();
    t.segmentos.forEach((s) => { const nodo = nodoLinea(s); est.segNodos.push(nodo); frag.appendChild(nodo); });
    caja.appendChild(frag);
    caja.scrollTop = caja.scrollHeight;
  } else {
    caja.innerHTML = `<div class="ghost vacio-g">${t.estado === 'error' ? 'Error' : 'Escucha'}<small>${E(t.estado === 'error' ? t.error || 'Falló la transcripción' : t.fase || 'Esperando al modelo')}</small></div>`;
  }
  actualizarPie(t);
}

function nodoLinea(s, url) {
  const p = document.createElement('p');
  p.className = 'ln';
  const enlace = enlaceEnSegundo(url, s.ini);
  p.innerHTML = `${enlace ? `<a class="t" href="${E(enlace)}" target="_blank" rel="noopener" title="Abrir el vídeo en este segundo">${reloj(s.ini)}</a>` : `<span class="t">${reloj(s.ini)}</span>`}<span>${E(s.texto)}</span>`;
  return p;
}

function pintarSegmento(s, pos) {
  const caja = $('#salida');
  if (caja.querySelector('.vacio-g')) { caja.innerHTML = ''; est.segNodos = []; }
  const nodo = nodoLinea(s);
  const ref = est.segNodos[pos] || null;
  const abajo = caja.scrollHeight - caja.scrollTop - caja.clientHeight < 60;
  caja.insertBefore(nodo, ref);
  est.segNodos.splice(pos, 0, nodo);
  if (abajo && !ref) caja.scrollTop = caja.scrollHeight;
  const t = est.trabajos.get(est.sel);
  if (t) actualizarPie(t);
}

function actualizarPie(t) {
  if (!t) { $('#stLineas').textContent = '0'; $('#stPalabras').textContent = '0'; $('#stVeloz').textContent = '—'; return; }
  $('#stLineas').textContent = numero(t.segmentos.length);
  $('#stPalabras').textContent = numero(t.segmentos.reduce((n, s) => n + s.texto.split(/\s+/).filter(Boolean).length, 0));
  $('#stVeloz').textContent = t.segundos && t.duracion ? `${(t.duracion / t.segundos).toFixed(1)}` : '—';
}

/* --- entrada ----------------------------------------------------------- */

function extensionValida(nombre) {
  if (V.modo === 'web') return true;           // el navegador dira si sabe leerlo
  const p = nombre.lastIndexOf('.');
  return p >= 0 && (est.cfg.extensiones || []).includes(nombre.slice(p).toLowerCase());
}

async function recibirArchivos(archivos, origen = 'archivo') {
  const buenos = [...archivos].filter((f) => {
    if (extensionValida(f.name)) return true;
    toast(`${f.name}: formato no reconocido`, true);
    return false;
  });
  if (!buenos.length) return;
  const aj = ajustesTrabajo();
  if (V.modo === 'web') {
    const r = await V.encolarArchivos(buenos.map((file) => ({ file, origen })), aj);
    (r.rechazados || []).forEach((x) => toast(`${x.nombre}: ${x.motivo}`, true));
    return;
  }
  // En escritorio los bytes viajan al servidor local de uno en uno: el
  // primero empieza a transcribirse mientras el siguiente todavia sube.
  for (const file of buenos) {
    const fantasma = crearFila({ nombre: file.name }, true);
    fantasma.li.dataset.estado = 'subiendo';
    fantasma.est.textContent = 'Subiendo';
    try {
      const r = await V.encolarArchivos([{ file, origen }], aj, (it, p) => {
        fantasma.barra.style.width = `${Math.round(p * 100)}%`;
        fantasma.fase.textContent = `${(file.size / 1048576).toFixed(1)} MB · ${Math.round(p * 100)}%`;
      });
      fantasma.li.remove();
      (r.encolados || []).forEach(absorber);
      (r.rechazados || []).forEach((x) => toast(`${x.nombre}: ${x.motivo}`, true));
    } catch (e) {
      fantasma.li.dataset.estado = 'error';
      fantasma.est.textContent = 'Error';
      fantasma.fase.textContent = e.message;
      toast(`${file.name}: ${e.message}`, true);
    }
  }
}

async function anadir() {
  if (!est.cfg.funciones.dialogo) { $('#archivo').click(); return; }
  const b = $('#btnAdd');
  b.disabled = true;
  b.textContent = 'Eligiendo…';
  try {
    const rutas = await V.elegirArchivos();
    if (rutas && rutas.length) {
      const r = await V.encolarArchivos(rutas.map((ruta) => ({ ruta })), ajustesTrabajo());
      (r.encolados || []).forEach(absorber);
      (r.rechazados || []).forEach((x) => toast(`${x.nombre}: ${x.motivo}`, true));
    }
  } catch (e) {
    $('#archivo').click();
  } finally {
    b.disabled = false;
    b.textContent = 'Añadir archivos';
  }
}

async function traer() {
  if (!est.cfg.funciones.enlaces) {
    if (V.modo === 'web') window.open(ESCRITORIO, '_blank', 'noopener');
    return;
  }
  const texto = $('#urls').value.trim();
  if (!texto) { $('#urls').focus(); return; }
  const b = $('#btnTraer');
  b.disabled = true;
  b.textContent = 'Leyendo…';
  try {
    const r = await V.enlaces(texto, ajustesTrabajo());
    (r.encolados || []).forEach(absorber);
    (r.rechazados || []).forEach((x) => toast(`${x.nombre}: ${x.motivo}`, true));
    if ((r.encolados || []).length) {
      $('#urls').value = '';
      toast(`${r.encolados.length} ${r.encolados.length === 1 ? 'vídeo en cola' : 'vídeos en cola'}`);
    }
  } catch (e) {
    toast(e.message, true);
  } finally {
    b.disabled = false;
    b.textContent = 'Traer';
  }
}

/* --- dictado ----------------------------------------------------------- */

const grab = { rec: null, t0: 0, reloj: null, trozos: [] };

async function dictar() {
  const b = $('#btnDictar');
  if (grab.rec) { grab.rec.stop(); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    toast('Sin permiso para usar el micrófono', true);
    return;
  }
  const tipo = window.MediaRecorder && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
  const rec = new MediaRecorder(stream, tipo ? { mimeType: tipo } : undefined);
  grab.rec = rec;
  grab.trozos = [];
  rec.ondataavailable = (e) => { if (e.data.size) grab.trozos.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(grab.reloj);
    b.classList.remove('rec');
    b.textContent = 'Dictar';
    const blob = new Blob(grab.trozos, { type: rec.mimeType || 'audio/webm' });
    grab.rec = null;
    if (blob.size < 2000) { toast('Grabación demasiado corta', true); return; }
    recibirArchivos([new File([blob], `Dictado ${fechaArchivo()}.webm`, { type: blob.type })], 'dictado');
  };
  rec.start(1000);
  grab.t0 = Date.now();
  b.classList.add('rec');
  const tic = () => { b.textContent = `Parar · ${reloj((Date.now() - grab.t0) / 1000)}`; };
  tic();
  grab.reloj = setInterval(tic, 500);
}

/* --- salida ------------------------------------------------------------ */

async function textoDe(id, formato) {
  const t = est.trabajos.get(id);
  if (!t) return '';
  if (t.estado === 'listo' && t.eid) return (await V.textoEntrada(t.eid, formato)).texto;
  return (await V.textoTrabajo(id, formato)).texto;
}

async function copiar() {
  if (!est.sel) { toast('No hay nada seleccionado', true); return; }
  const texto = await textoDe(est.sel, opc.formato).catch(() => '');
  if (!texto.trim()) { toast('Todavía no hay texto', true); return; }
  await copiarTexto(texto);
  toast(`Copiado · ${numero(texto.length)} caracteres`);
}

async function exportar(ids) {
  if (!ids.length) { toast('Todavía no está en la biblioteca', true); return; }
  try {
    const r = await V.exportar(ids, opc.formato, $('#carpeta').value);
    (r.fallos || []).forEach((f) => toast(f.motivo, true));
    if (r.ok) toast(r.rutas.length ? (r.ok === 1 ? `Guardado · ${r.rutas[0].split(/[\\/]/).pop()}` : `${r.ok} archivos guardados`) : 'Descargado');
  } catch (e) {
    toast(e.message, true);
  }
}

function eidSeleccionado() {
  const t = est.trabajos.get(est.sel);
  return t && t.eid ? t.eid : null;
}

/* ============================================================= BIBLIOTECA */

function etiquetaEntrada(r) {
  return [ORIGEN[r.origen] || 'Archivo', reloj(r.duracion), fecha(r.creado)].filter(Boolean).join(' · ');
}

async function cargarLib(silencioso) {
  let d;
  try { d = await V.biblioteca(); } catch (e) { if (!silencioso) toast(e.message, true); return; }
  est.lib = d.entradas;
  const s = d.stats;
  $('#nLib').textContent = est.lib.length || '';
  $('#lsN').textContent = numero(s.transcripciones);
  const horas = s.segundos >= 3600;
  $('#lsH').textContent = horas ? (s.segundos / 3600).toFixed(s.segundos >= 36000 ? 0 : 1) : numero(s.segundos / 60);
  $('#lsHt').textContent = horas ? 'Horas de audio' : 'Minutos de audio';
  $('#lsP').textContent = s.palabras >= 100000 ? `${Math.round(s.palabras / 1000)}K` : numero(s.palabras);
  if (!$('#libQ').value.trim()) pintarLista();
  if (est.pagina === 'biblioteca' && !est.libEntrada && est.lib[0] && !silencioso) abrirEntrada(est.libSel || est.lib[0].id);
  if (est.pagina === 'preguntar') pintarAlcance();
  if (est.pagina === 'crear') pintarCrear();
}

function pintarLista() {
  $('#libVacia').hidden = est.lib.length > 0;
  $('#libHint').textContent = 'Ctrl+K';
  $('#libLista').innerHTML = est.lib.map((r) =>
    `<li data-id="${r.id}"${r.id === est.libSel ? ' class="sel"' : ''}><button class="row" type="button"><span class="title">${E(r.nombre)}</span><span class="tag">${etiquetaEntrada(r)}</span></button></li>`).join('');
}

async function buscarLib() {
  const q = $('#libQ').value.trim();
  if (!q) { pintarLista(); return; }
  const res = await V.buscar(q, null, 30).catch(() => []);
  if ($('#libQ').value.trim() !== q) return;          // ya escribieron otra cosa
  $('#libVacia').hidden = true;
  $('#libHint').textContent = `${res.length} ${res.length === 1 ? 'resultado' : 'resultados'}`;
  $('#libLista').innerHTML = res.length ? res.map((h) =>
    `<li><button class="hit" type="button" data-id="${h.id}" data-ini="${h.ini}"><b>${E(h.nombre)}<span>${reloj(h.ini)}</span></b><p>${resaltar(h.texto, q)}</p></button></li>`).join('')
    : '<li><p class="vacio muted up">Nada. Prueba con otra palabra.</p></li>';
}

async function abrirEntrada(id, ini) {
  est.libSel = id;
  if (est.pagina !== 'biblioteca') ir('biblioteca');
  let e;
  try { e = await V.entrada(id); } catch (err) { toast('Esa transcripción ya no existe', true); cargarLib(true); return; }
  est.libEntrada = e;
  $$('#libLista li[data-id]').forEach((li) => li.classList.toggle('sel', li.dataset.id === id));
  $('#libDet').hidden = false;
  $('#libNada').hidden = true;
  $('#detTitulo').textContent = e.nombre;
  const palabras = (e.segmentos || []).reduce((n, s) => n + s.texto.split(/\s+/).filter(Boolean).length, 0);
  $('#detMeta').textContent = `${etiquetaEntrada(e)} · ${numero(palabras)} palabras`;
  const a = $('#detEnlace');
  a.hidden = !e.url;
  if (e.url) a.href = e.url;
  const caja = $('#detTexto');
  caja.innerHTML = '';
  const frag = document.createDocumentFragment();
  let foco = null;
  (e.segmentos || []).forEach((s) => {
    const n = nodoLinea(s, e.url);
    if (ini != null && s.ini <= ini + 0.5) foco = n;
    frag.appendChild(n);
  });
  caja.appendChild(frag);
  caja.scrollTop = 0;
  if (foco) {
    foco.classList.add('foco');
    caja.scrollTop = foco.offsetTop - caja.offsetTop - 60;
  }
  pintarRecursos($('#detRecursos'), e);
}

function pintarRecursos(cont, e) {
  const rec = e.recursos || [];
  if (!rec.length) { cont.innerHTML = ''; return; }
  const nombre = (k) => ((est.cfg.tipos.find((t) => t.clave === k) || {}).etiqueta || k);
  cont.innerHTML = `<div class="recursos"><h4>Creado con IA<span>${rec.length}</span></h4><ul class="list rec">${rec.map((r, i) =>
    `<li data-i="${i}"><button class="row" type="button" aria-expanded="false"><span class="title">${E(nombre(r.tipo))}</span><span class="tag">${fecha(r.creado)} · ${E(r.modelo || '')}</span></button><div class="panel"><div class="inner"><div class="md">${md(r.texto)}</div><div class="links"><button type="button" class="link" data-copiar="${i}">Copiar</button></div></div></div></li>`).join('')}</ul></div>`;
  cont.onclick = async (ev) => {
    const c = ev.target.closest('[data-copiar]');
    if (c) { await copiarTexto(rec[+c.dataset.copiar].texto); toast('Copiado'); return; }
    const fila = ev.target.closest('.row');
    if (!fila) return;
    const li = fila.closest('li');
    const abierto = li.classList.toggle('open');
    fila.setAttribute('aria-expanded', String(abierto));
  };
}

function renombrar() {
  const h = $('#detTitulo');
  if (!est.libEntrada) return;
  const original = est.libEntrada.nombre;
  h.contentEditable = 'true';
  h.focus();
  document.getSelection().selectAllChildren(h);
  const fin = async (guardar) => {
    h.contentEditable = 'false';
    h.removeEventListener('keydown', teclas);
    h.removeEventListener('blur', alSalir);
    const nuevo = h.textContent.trim();
    if (!guardar || !nuevo || nuevo === original) { h.textContent = original; return; }
    await V.renombrar(est.libEntrada.id, nuevo);
    est.libEntrada.nombre = nuevo;
    toast('Renombrada');
    cargarLib(true);
  };
  const teclas = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); fin(true); }
    if (e.key === 'Escape') { e.preventDefault(); fin(false); }
  };
  const alSalir = () => fin(true);
  h.addEventListener('keydown', teclas);
  h.addEventListener('blur', alSalir);
}

async function borrarEntrada() {
  const b = $('#detBorrar');
  if (!est.libEntrada) return;
  if (!b.classList.contains('armado')) {
    b.classList.add('armado');
    b.textContent = '¿Seguro? Borrar';
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.classList.remove('armado'); b.textContent = 'Borrar'; }, 3500);
    return;
  }
  b.classList.remove('armado');
  b.textContent = 'Borrar';
  await V.borrar(est.libEntrada.id);
  est.libEntrada = null;
  est.libSel = null;
  $('#libDet').hidden = true;
  $('#libNada').hidden = false;
  toast('Borrada');
  cargarLib(true);
}

/* Selector de transcripcion reutilizable (preguntar y crear). */
function picker(cont, sel, alElegir) {
  if (!cont._ok) {
    cont.innerHTML = '<div class="picker"><label class="field"><input spellcheck="false" autocomplete="off" placeholder="Filtrar transcripciones"></label><ul></ul></div>';
    $('input', cont).addEventListener('input', () => picker(cont, cont._sel, cont._fn));
    $('ul', cont).addEventListener('click', (e) => {
      const li = e.target.closest('li[data-id]');
      if (li) cont._fn(li.dataset.id);
    });
    cont._ok = true;
  }
  cont._sel = sel;
  cont._fn = alElegir;
  const f = $('input', cont).value.trim().toLowerCase();
  const lista = est.lib.filter((r) => !f || r.nombre.toLowerCase().includes(f));
  $('ul', cont).innerHTML = lista.length ? lista.map((r) =>
    `<li data-id="${r.id}"${r.id === sel ? ' class="sel"' : ''}><button class="row" type="button"><span class="title">${E(r.nombre)}</span><span class="tag">${etiquetaEntrada(r)}</span></button></li>`).join('')
    : `<li><p class="muted up">${est.lib.length ? 'Nada con ese nombre' : 'La biblioteca está vacía: transcribe algo primero'}</p></li>`;
}

/* ============================================================== PREGUNTAR */

function pintarAlcance() {
  const una = opc.alcance === 'una';
  if (una && !est.pregSel && est.lib[0]) est.pregSel = est.lib[0].id;
  $('#pregPicker').hidden = !una;
  const elegida = est.lib.find((r) => r.id === est.pregSel);
  $('#alcanceHint').textContent = una ? (elegida ? elegida.nombre : 'Elige una') : `${est.lib.length} ${est.lib.length === 1 ? 'transcripción' : 'transcripciones'}`;
  if (una) picker($('#pregPicker'), est.pregSel, (id) => { est.pregSel = id; pintarAlcance(); });
}

function pintarChat() {
  const caja = $('#chat');
  if (!est.chat.length) {
    caja.innerHTML = '<div class="ghost vacio-g">Pregunta<small>¿Qué dijo sobre el déficit calórico? · Resume la parte de la banca · ¿En qué minuto habla de precios?</small></div>';
    return;
  }
  caja.innerHTML = est.chat.map((m, i) => (m.role === 'user'
    ? `<div class="msg yo"><span class="who">Tú</span><p>${E(m.content)}</p></div>`
    : `<div class="msg ia${m.error ? ' err' : ''}" data-m="${i}"><span class="who${m.vivo ? ' vivo' : ''}">${E(m.vivo ? m.fase || 'Pensando' : `Tiro${m.modelo ? ` · ${m.modelo}` : ''}`)}</span><div class="md${m.vivo ? ' cursor' : ''}">${m.error ? E(m.error) : md(m.content)}</div>${fuentesHtml(m)}</div>`)).join('');
  caja.scrollTop = caja.scrollHeight;
}

function fuentesHtml(m) {
  if (!m.fuentes || !m.fuentes.length) return '';
  const usadas = new Set([...m.content.matchAll(/\[(\d{1,2})\]/g)].map((x) => +x[1]));
  const lista = m.fuentes.filter((f) => !usadas.size || usadas.has(f.n));
  return `<div class="fuentes">${lista.map((f) => `<button type="button" data-n="${f.n}"><b>[${f.n}]</b>${E(f.nombre)} · ${reloj(f.ini)}</button>`).join('')}</div>`;
}

async function preguntar() {
  if (est.chatCtl) { est.chatCtl.abort(); return; }
  const q = $('#pregunta').value.trim();
  if (!q) { $('#pregunta').focus(); return; }
  if (opc.alcance === 'una' && !est.pregSel) { toast('Elige la transcripción a la derecha', true); return; }
  const historial = est.chat.filter((m) => !m.error && m.content).map((m) => ({ role: m.role, content: m.content }));
  est.chat.push({ role: 'user', content: q });
  const msg = { role: 'assistant', content: '', vivo: true, fase: 'Buscando', fuentes: null };
  est.chat.push(msg);
  $('#pregunta').value = '';
  pintarChat();
  const ctl = new AbortController();
  est.chatCtl = ctl;
  $('#btnPreguntar').textContent = 'Parar';
  let pendiente = false;
  const repintar = () => {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(() => { pendiente = false; pintarChat(); });
  };
  try {
    await V.preguntar({ pregunta: q, ids: opc.alcance === 'una' ? [est.pregSel] : [], historial }, (l) => {
      if (l.t === 'fase') { msg.fase = l.v; const m = /con (.+)$/.exec(l.v); if (m) msg.modelo = m[1]; }
      else if (l.t === 'texto') msg.content += l.v;
      else if (l.t === 'fuentes') msg.fuentes = l.v;
      else if (l.t === 'error') msg.error = l.v;
      repintar();
    }, ctl.signal);
  } catch (e) {
    if (e.name !== 'AbortError') msg.error = e.message;
  } finally {
    msg.vivo = false;
    if (!msg.content && !msg.error) msg.error = 'Detenido.';
    est.chatCtl = null;
    $('#btnPreguntar').textContent = 'Preguntar';
    pintarChat();
  }
}

/* ================================================================== CREAR */

function pintarCrear() {
  if (!est.crearSel && est.lib[0]) est.crearSel = est.lib[0].id;
  const r = est.lib.find((x) => x.id === est.crearSel);
  $('#crearDe').textContent = r ? r.nombre : '';
  picker($('#crearPicker'), est.crearSel, (id) => { est.crearSel = id; pintarCrear(); pintarPrevios(); });
  $$('#tipos li').forEach((li) => li.classList.toggle('sel', li.dataset.tipo === est.crearTipo));
  pintarPrevios();
}

async function pintarPrevios() {
  const cont = $('#crearPrevios');
  if (!est.crearSel) { cont.innerHTML = ''; return; }
  try { pintarRecursos(cont, await V.entrada(est.crearSel)); } catch (e) { cont.innerHTML = ''; }
}

async function crear() {
  if (est.crearCtl) { est.crearCtl.abort(); return; }
  if (!est.crearSel) { toast('Elige una transcripción', true); return; }
  const tipo = est.cfg.tipos.find((t) => t.clave === est.crearTipo);
  const entrada = est.lib.find((r) => r.id === est.crearSel);
  const caja = $('#crearSalida');
  est.crearTexto = '';
  $('#crearTitulo').textContent = `${tipo.etiqueta} · ${entrada ? entrada.nombre : ''}`;
  caja.innerHTML = '<div class="md cursor"></div>';
  const nodo = $('.md', caja);
  const ctl = new AbortController();
  est.crearCtl = ctl;
  $('#btnCrear').textContent = 'Parar';
  let pendiente = false, error = '';
  try {
    await V.crear({ tipo: est.crearTipo, id: est.crearSel, instrucciones: $('#indicaciones').value }, (l) => {
      if (l.t === 'fase') $('#crearFase').textContent = l.v;
      else if (l.t === 'texto') {
        est.crearTexto += l.v;
        if (!pendiente) {
          pendiente = true;
          requestAnimationFrame(() => { pendiente = false; nodo.innerHTML = md(est.crearTexto); caja.scrollTop = caja.scrollHeight; });
        }
      } else if (l.t === 'error') error = l.v;
    }, ctl.signal);
  } catch (e) {
    if (e.name !== 'AbortError') error = e.message;
  } finally {
    est.crearCtl = null;
    $('#btnCrear').textContent = 'Crear';
    nodo.classList.remove('cursor');
    nodo.innerHTML = md(est.crearTexto);
    if (error) { $('#crearFase').textContent = 'Error'; toast(error, true); if (!est.crearTexto) caja.innerHTML = `<div class="ghost vacio-g">Error<small>${E(error)}</small></div>`; }
    else { $('#crearFase').textContent = est.crearTexto ? 'Listo · guardado en la biblioteca' : 'Detenido'; pintarPrevios(); }
  }
}

/* ================================================================ AJUSTES */

async function cargarAjustes() {
  const cfg = est.cfg;
  $('#carpeta').value = (cfg.ajustes && cfg.ajustes.carpeta) || cfg.carpeta_defecto || '';
  $('#cfgCarpeta').hidden = !cfg.funciones.carpeta;
  $('#notaDescargas').hidden = cfg.funciones.carpeta;
  $('#rutaLib').textContent = cfg.carpeta_biblioteca;
  $('#btnAbrirLib').hidden = !cfg.funciones.carpeta;
  await refrescarIA();
  pintarIA();
}

function pintarIA() {
  const ia = est.ia;
  if (!ia) return;
  const provs = V.modo === 'web'
    ? [['navegador', 'Navegador · sin instalar'], ['ollama', 'Tu Ollama'], ['claude', 'Claude · nube']]
    : [['ollama', 'Ollama · local'], ['claude', 'Claude · nube']];
  $('#segProv').innerHTML = provs.map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join('');
  pintarSeg($('#segProv'), ia.proveedor);
  $('#cfgNav').hidden = ia.proveedor !== 'navegador';
  $('#cfgOllama').hidden = ia.proveedor !== 'ollama';
  $('#cfgClaude').hidden = ia.proveedor !== 'claude';

  if (ia.navegador) {
    $('#segNav').innerHTML = ia.navegador.modelos.map((m) => `<button type="button" data-v="${m.id}">${E(m.etiqueta)}<small>${m.gb} GB</small></button>`).join('');
    pintarSeg($('#segNav'), ia.navegador.modelo);
    $('#navEstado').textContent = ia.navegador.webgpu ? 'WebGPU ✓ · funciona sin instalar' : 'Sin WebGPU · usa Chrome o Edge recientes, o Claude';
  }
  const ol = ia.ollama;
  $('#olEstado').textContent = ol.activo ? `Activo · ${ol.modelos.length} ${ol.modelos.length === 1 ? 'modelo' : 'modelos'}` : (V.modo === 'web' ? 'No conectado' : (ol.instalado ? 'Apagado' : 'No instalado'));
  $('#btnEncender').textContent = V.modo === 'web' ? 'Probar' : 'Encender';
  $('#btnEncender').hidden = ol.activo;
  $('#segOllama').innerHTML = ol.modelos.length
    ? ol.modelos.map((m) => `<button type="button" data-v="${E(m.id)}">${E(m.id)}<small>${m.gb} GB</small></button>`).join('')
    : '<span class="muted">—</span>';
  pintarSeg($('#segOllama'), ol.modelo);
  $('#notaOllama').innerHTML = V.modo === 'web'
    ? `Para usar tu Ollama desde esta web, ábrelo con <code>OLLAMA_ORIGINS=${E(ol.origen || location.origin)}</code> y pulsa probar.`
    : 'Todo se queda en tu equipo. ¿Sin modelos? En una terminal: <code>ollama pull gemma3</code>';
  $('#segClaude').innerHTML = ia.claude.modelos.map((m) => `<button type="button" data-v="${m.id}">${E(m.etiqueta)}</button>`).join('');
  pintarSeg($('#segClaude'), ia.claude.modelo);
  $('#claveClaude').value = '';
  $('#claveClaude').placeholder = ia.claude.configurado ? 'Clave guardada ✓ · escribe otra para cambiarla' : 'Clave de la API de Claude (sk-ant-…)';
  $('#notaClaude').textContent = V.modo === 'web'
    ? 'Solo para preguntar y crear: el audio se transcribe siempre en tu navegador. La clave se queda en este navegador y va directa a Anthropic.'
    : 'Solo para preguntar y crear: el audio se transcribe siempre en local. La clave se guarda en Documents\\Tiro, fuera del proyecto.';
}

async function cambiarIA(cambios) {
  await V.guardarIA(cambios);
  await refrescarIA();
  pintarIA();
}

const VS = [
  ['Tiro', 'En tu equipo o en tu navegador. <em>Sin minutos contados, sin cuentas, sin subir tu audio.</em> Archivos, enlaces y dictado en una cola; luego preguntas con citas al minuto y creas guías, capítulos o reels. Gratis y de código abierto.', true],
  ['TurboScribe', 'En la nube. Gratis: 3 archivos al día de hasta 30 min; lo ilimitado cuesta unos 10 USD al mes. <em>Tu audio se sube a sus servidores.</em>'],
  ['Otter.ai', 'En la nube y pensado para reuniones. Gratis: 300 min al mes y 30 min por conversación. <em>No convierte el texto en guías, capítulos ni reels.</em>'],
  ['MacWhisper', 'Local y muy bueno, pero <em>solo en Mac</em> y con licencia de pago. Nada para Windows ni para el navegador.'],
  ['NotebookLM', 'Pregunta a tus fuentes, pero <em>en la nube de Google</em> y con cuenta. No transcribe en tu equipo ni da el minuto exacto de cada dato.'],
  ['Wispr Flow', 'Dictado por unos 15 USD al mes <em>que solo funciona en la nube</em>, sin modo sin conexión. Dicta, pero no transcribe archivos ni enlaces.'],
];
function pintarVs() {
  $('#vs').innerHTML = VS.map(([n, t, yo]) => `<li${yo ? ' class="yo"' : ''}><b>${n}</b><span>${t}</span></li>`).join('');
}

/* ============================================================== LISTENERS */

function enganchar() {
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-ir]');
    if (a && !e.ctrlKey && !e.metaKey && !e.shiftKey) { e.preventDefault(); ir(a.dataset.ir); }
  });
  window.addEventListener('popstate', () => ir(rutaActual(), false));

  // opciones con data-key: se recuerdan
  $$('.seg[data-key]').forEach((el) => el.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    opc[el.dataset.key] = b.dataset.v;
    guardarOpc();
    pintarSegs();
    if (el.dataset.key === 'alcance') pintarAlcance();
  }));

  // arrastrar y soltar sobre toda la ventana (solo en transcribir)
  let dentro = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++dentro === 1) $('#drop').classList.add('over'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dentro <= 0) { dentro = 0; $('#drop').classList.remove('over'); } });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dentro = 0;
    $('#drop').classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files.length) {
      if (est.pagina !== 'transcribir') ir('transcribir');
      recibirArchivos(e.dataTransfer.files);
    }
  });
  $('#drop').addEventListener('click', anadir);
  $('#drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); anadir(); } });
  $('#btnAdd').addEventListener('click', anadir);
  $('#archivo').addEventListener('change', (e) => { if (e.target.files.length) recibirArchivos(e.target.files); e.target.value = ''; });
  $('#btnDictar').addEventListener('click', dictar);
  $('#btnTraer').addEventListener('click', traer);
  $('#urls').addEventListener('keydown', (e) => { if (e.key === 'Enter') traer(); });

  $('#btnDetener').addEventListener('click', async () => { await V.cancelar(); toast('Detenido'); });
  $('#btnLimpiar').addEventListener('click', () => {
    [...est.trabajos.values()].filter((t) => ['listo', 'error', 'cancelado'].includes(t.estado)).forEach((t) => quitar(t.id));
  });
  $('#btnCopiar').addEventListener('click', copiar);
  $('#btnGuardar').addEventListener('click', () => exportar(eidSeleccionado() ? [eidSeleccionado()] : []));
  $('#btnIrPreguntar').addEventListener('click', () => {
    const id = eidSeleccionado();
    if (id) { est.pregSel = id; opc.alcance = 'una'; guardarOpc(); pintarSegs(); }
    ir('preguntar');
    $('#pregunta').focus();
  });
  $('#btnIrCrear').addEventListener('click', () => { const id = eidSeleccionado(); if (id) est.crearSel = id; ir('crear'); });

  // biblioteca
  let tBuscar = null;
  $('#libQ').addEventListener('input', () => { clearTimeout(tBuscar); tBuscar = setTimeout(buscarLib, 180); });
  $('#libLista').addEventListener('click', (e) => {
    const hit = e.target.closest('.hit');
    if (hit) { abrirEntrada(hit.dataset.id, +hit.dataset.ini); return; }
    const li = e.target.closest('li[data-id]');
    if (li) abrirEntrada(li.dataset.id);
  });
  $('#detCopiar').addEventListener('click', async () => {
    if (!est.libEntrada) return;
    const r = await V.textoEntrada(est.libEntrada.id, opc.formato);
    await copiarTexto(r.texto);
    toast(`Copiado · ${numero(r.texto.length)} caracteres`);
  });
  $('#detExportar').addEventListener('click', () => est.libEntrada && exportar([est.libEntrada.id]));
  $('#detPreguntar').addEventListener('click', () => {
    if (!est.libEntrada) return;
    est.pregSel = est.libEntrada.id; opc.alcance = 'una'; guardarOpc(); pintarSegs();
    ir('preguntar');
    $('#pregunta').focus();
  });
  $('#detCrear').addEventListener('click', () => { if (est.libEntrada) { est.crearSel = est.libEntrada.id; ir('crear'); } });
  $('#detRenombrar').addEventListener('click', renombrar);
  $('#detBorrar').addEventListener('click', borrarEntrada);

  // preguntar
  $('#btnPreguntar').addEventListener('click', preguntar);
  $('#pregunta').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.shiftKey)) { e.preventDefault(); preguntar(); } });
  $('#btnNuevaCharla').addEventListener('click', () => { if (est.chatCtl) est.chatCtl.abort(); est.chat = []; pintarChat(); });
  $('#chat').addEventListener('click', (e) => {
    const c = e.target.closest('.cita, .fuentes button');
    if (!c) return;
    const m = est.chat[+c.closest('.msg').dataset.m];
    const f = m && m.fuentes && m.fuentes.find((x) => x.n === +c.dataset.n);
    if (f) abrirEntrada(f.id, f.ini);
  });

  // crear
  $('#tipos').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-tipo]');
    if (!li) return;
    est.crearTipo = li.dataset.tipo;
    $$('#tipos li').forEach((x) => x.classList.toggle('sel', x === li));
  });
  $('#btnCrear').addEventListener('click', crear);
  $('#crearCopiar').addEventListener('click', async () => {
    if (!est.crearTexto) { toast('Todavía no hay nada creado', true); return; }
    await copiarTexto(est.crearTexto);
    toast('Copiado');
  });
  $('#crearGuardar').addEventListener('click', async () => {
    if (!est.crearTexto) { toast('Todavía no hay nada creado', true); return; }
    const r = est.lib.find((x) => x.id === est.crearSel);
    const tipo = est.cfg.tipos.find((t) => t.clave === est.crearTipo);
    try {
      const d = await V.escribir(`${r ? r.nombre : 'tiro'} - ${tipo.etiqueta}`, est.crearTexto, '.md', $('#carpeta').value);
      toast(d.ruta ? `Guardado · ${d.ruta.split(/[\\/]/).pop()}` : 'Descargado');
    } catch (e) { toast(e.message, true); }
  });

  // ajustes
  $('#segProv').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) cambiarIA({ proveedor: b.dataset.v }); });
  $('#segNav').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) cambiarIA({ modelo_nav: b.dataset.v }); });
  $('#segOllama').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) cambiarIA({ modelo_ollama: b.dataset.v }); });
  $('#segClaude').addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (b) cambiarIA({ modelo_claude: b.dataset.v }); });
  $('#btnClave').addEventListener('click', async () => {
    const v = $('#claveClaude').value.trim();
    if (!v) { $('#claveClaude').focus(); return; }
    await cambiarIA({ clave_claude: v, proveedor: 'claude' });
    toast('Clave guardada');
  });
  $('#btnEncender').addEventListener('click', async () => {
    const b = $('#btnEncender');
    b.textContent = V.modo === 'web' ? 'Probando…' : 'Encendiendo…';
    const r = await V.encenderOllama().catch(() => ({ ok: false }));
    if (!r.ok) toast(V.modo === 'web' ? 'No responde: revisa OLLAMA_ORIGINS' : 'Ollama no arranca: ¿está instalado?', true);
    await refrescarIA();
    pintarIA();
  });
  $('#btnCarpeta').addEventListener('click', async () => {
    const c = await V.elegirCarpeta().catch(() => '');
    if (c) { $('#carpeta').value = c; V.guardarAjustes({ carpeta: c }); est.cfg.ajustes.carpeta = c; }
  });
  $('#carpeta').addEventListener('change', () => { V.guardarAjustes({ carpeta: $('#carpeta').value }); est.cfg.ajustes.carpeta = $('#carpeta').value; });
  $('#btnAbrirCarpeta').addEventListener('click', () => { const c = $('#carpeta').value; if (c) V.abrir(c); });
  $('#btnAbrirLib').addEventListener('click', () => V.abrir(est.cfg.carpeta_biblioteca));

  // atajos
  document.addEventListener('keydown', (e) => {
    const enCampo = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName || '') || e.target.isContentEditable;
    if (e.altKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); if (est.pagina !== 'transcribir') ir('transcribir'); dictar(); return; }
    if (!e.ctrlKey && !e.metaKey) return;
    if (e.key === 'k') { e.preventDefault(); if (est.pagina !== 'biblioteca') ir('biblioteca'); $('#libQ').focus(); }
    if (est.pagina !== 'transcribir') return;
    if (e.key === 's') { e.preventDefault(); exportar(eidSeleccionado() ? [eidSeleccionado()] : []); }
    if (e.key === 'c' && !enCampo && !String(window.getSelection())) { e.preventDefault(); copiar(); }
  });
}

arrancar();
