// Entrega las fotos de los productos.
//
// Es público a propósito: son las fotos del catálogo. Lo que no se permite es
// listar el almacenamiento ni salirse de él.

import { hayDondeGuardar, leerFoto } from '../_lib/fotos.js';

export async function onRequestGet({ params, env, request }) {
  if (!hayDondeGuardar(env)) {
    return new Response('Almacenamiento de fotos no disponible.', { status: 503 });
  }

  const partes = Array.isArray(params.ruta) ? params.ruta : [params.ruta];
  const clave = partes.filter(Boolean).join('/');
  // Nada de subir de carpeta ni de rutas raras.
  if (!clave || clave.includes('..') || clave.startsWith('/')) {
    return new Response('No encontrado.', { status: 404 });
  }

  const foto = await leerFoto(env, clave);
  if (!foto) return new Response('No encontrado.', { status: 404 });

  const headers = new Headers();
  headers.set('Content-Type', foto.tipo);
  headers.set('ETag', foto.etag);
  // Cada foto tiene un nombre único, así que nunca cambia de contenido: se
  // puede cachear para siempre sin riesgo de servir una versión vieja. Esto
  // además hace que una foto muy vista casi no consuma cuota de lectura.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');

  if (request.headers.get('If-None-Match') === foto.etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(foto.cuerpo, { headers });
}
