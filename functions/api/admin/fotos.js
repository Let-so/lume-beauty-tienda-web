// Subida de fotos desde el celular o la computadora.
//
// Dónde terminan guardadas lo decide _lib/fotos.js. Acá solo se comprueba
// que lo que sube sea de verdad una imagen y que no sea desmedida.

import { ok, error, json } from '../../_lib/http.js';
import { registrar } from '../../_lib/auth.js';
import { hayDondeGuardar, porQueNoSePuede, guardarFoto } from '../../_lib/fotos.js';

const MAX_BYTES = 6 * 1024 * 1024;        // 6 MB: una foto de celular entra de sobra

// Solo formatos de imagen que el navegador muestra. Nada de SVG: puede llevar
// JavaScript adentro y se convertiría en una puerta de entrada.
const TIPOS = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/avif': 'avif',
};

// Primeros bytes de cada formato. Se comprueba el contenido real y no solo lo
// que dice el nombre del archivo, porque el nombre lo elige quien sube.
function formatoReal(bytes) {
  const b = new Uint8Array(bytes);
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'image/avif';
  return null;
}

export async function onRequestPost({ request, env, data }) {
  if (!hayDondeGuardar(env)) {
    return json({ ok: false, ...porQueNoSePuede() }, 503);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return error('No se pudo leer la foto enviada. Probá de nuevo.');
  }

  const archivo = form.get('foto');
  if (!archivo || typeof archivo === 'string') return error('Elegí una foto para subir.');
  if (archivo.size === 0) return error('El archivo está vacío.');
  if (archivo.size > MAX_BYTES) {
    return error(`La foto pesa ${(archivo.size / 1024 / 1024).toFixed(1)} MB y el máximo son 6 MB. Sacale peso o elegí otra.`);
  }

  const bytes = await archivo.arrayBuffer();
  const real = formatoReal(bytes);
  if (!real || !TIPOS[real]) {
    return error('Ese archivo no es una imagen válida. Se aceptan JPG, PNG, WebP y AVIF.');
  }

  const extension = TIPOS[real];
  const nombre = `productos/${crypto.randomUUID()}.${extension}`;
  const url = await guardarFoto(env, nombre, bytes, real);
  await registrar(env.DB, data.usuario.id, 'foto_subida', 'imagen', nombre, { bytes: archivo.size });

  return ok({ url, mensaje: 'Foto subida.' });
}
