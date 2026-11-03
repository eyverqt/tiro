/* ==========================================================================
   Tiro — Whisper dentro del navegador (worker)

   Corre en un hilo aparte para que la pagina no se congele. Usa
   transformers.js: WebGPU si la tarjeta lo permite, y si no WebAssembly en
   el procesador. El modelo se descarga una vez y queda en la cache del
   navegador; a partir de ahi el audio nunca sale del equipo.
   ========================================================================== */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';

env.allowLocalModels = false;

const MODELOS = {
  rapido: 'onnx-community/whisper-base',
  equilibrado: 'onnx-community/whisper-small',
  turbo: 'onnx-community/whisper-large-v3-turbo',
};

let asr = null;
let firma = '';

async function cargar(clave, device) {
  const id = MODELOS[clave] || MODELOS.rapido;
  const nueva = `${id}|${device}`;
  if (asr && firma === nueva) return;
  if (asr && asr.dispose) await asr.dispose();
  asr = null;
  const descargas = new Map();
  // En GPU el codificador va en fp32 (exactitud) y el decodificador en q4
  // (velocidad); en CPU, q8 es el punto dulce de WebAssembly.
  const dtype = device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8';
  asr = await pipeline('automatic-speech-recognition', id, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status === 'progress' && p.total) {
        descargas.set(p.file, [p.loaded || 0, p.total]);
        let hecho = 0, total = 0;
        for (const [a, b] of descargas.values()) { hecho += a; total += b; }
        postMessage({ tipo: 'descarga', hecho, total });
      }
    },
  });
  firma = nueva;
}

self.onmessage = async ({ data }) => {
  const { tipo, id } = data;
  try {
    if (tipo === 'cargar') {
      await cargar(data.modelo, data.device);
      postMessage({ tipo: 'listo', id });
      return;
    }
    if (tipo === 'trozo') {
      await cargar(data.modelo, data.device);
      const salida = await asr(data.audio, {
        return_timestamps: true,
        language: data.idioma || null,
        task: 'transcribe',
      });
      const largo = data.audio.length / 16000;
      const segs = (salida.chunks || [{ timestamp: [0, largo], text: salida.text }])
        .map((c) => ({
          ini: data.desde + (c.timestamp[0] || 0),
          fin: data.desde + (c.timestamp[1] == null ? largo : c.timestamp[1]),
          texto: (c.text || '').trim(),
        }))
        .filter((s) => s.texto);
      postMessage({ tipo: 'trozo', id, segs });
    }
  } catch (e) {
    postMessage({ tipo: 'error', id, error: String((e && e.message) || e) });
  }
};
