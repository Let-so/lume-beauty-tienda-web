// Entrega las fotos guardadas en R2.
//
// Es público a propósito: son las fotos de los productos de la tienda. Lo que
// no se permite es listar el depósito ni salirse de él.

export async function onRequestGet({ params, env, request }) {
  if (!env.FOTOS) return new Response('Almacenamiento de fotos no disponible.', { status: 503 });

  const partes = Array.isArray(params.ruta) ? params.ruta : [params.ruta];
  const clave = partes.filter(Boolean).join('/');
  // Nada de subir de carpeta ni de rutas raras.
  if (!clave || clave.includes('..') || clave.startsWith('/')) {
    return new Response('No encontrado.', { status: 404 });
  }

  const objeto = await env.FOTOS.get(clave);
  if (!objeto) return new Response('No encontrado.', { status: 404 });

  const headers = new Headers();
  objeto.writeHttpMetadata(headers);
  headers.set('etag', objeto.httpEtag);
  // Cada foto tiene un nombre único, así que nunca cambia de contenido:
  // se puede cachear para siempre sin riesgo de servir una versión vieja.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');

  if (request.headers.get('If-None-Match') === objeto.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(objeto.body, { headers });
}
