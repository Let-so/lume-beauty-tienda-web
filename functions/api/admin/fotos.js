// Subida de fotos desde el celular o la computadora.
//
// Las fotos van a R2, el almacenamiento de archivos de Cloudflare. Si R2
// todavía no está conectado, este endpoint lo dice con todas las letras en
// lugar de fallar de una forma confusa o de guardar la foto en un lugar que
// no corresponde.
//
// No se usa la base de datos para guardar fotos: está pensada para datos
// chicos, y meterle imágenes la vuelve lenta y cara de copiar.

import { ok, error, json } from '../../_lib/http.js';
import { registrar } from '../../_lib/auth.js';

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
  if (!env.FOTOS) {
    return json({
      ok: false,
      error: 'El almacenamiento de fotos todavía no está conectado.',
      comoResolverlo: 'Hay que crear el depósito R2 en Cloudflare y conectarlo con el nombre FOTOS. Está explicado en docs/PUBLICAR.md.',
    }, 503);
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
  await env.FOTOS.put(nombre, bytes, { httpMetadata: { contentType: real } });
  await registrar(env.DB, data.usuario.id, 'foto_subida', 'imagen', nombre, { bytes: archivo.size });

  return ok({ url: `/fotos/${nombre}`, mensaje: 'Foto subida.' });
}
