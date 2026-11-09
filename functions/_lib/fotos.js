// Dónde viven las fotos de los productos.
//
// POR QUÉ KV Y NO R2
//
// R2 es el lugar "correcto" para archivos, pero hay que habilitarlo a mano
// desde el panel de Cloudflare y puede pedir un medio de pago. Eso convierte
// una tarea de Camila en un trámite de otra persona, que es exactamente lo
// que este panel existe para evitar.
//
// KV viene encendido con el plan gratuito: no hay que activar nada ni dar una
// tarjeta. Para fotos de catálogo alcanza de sobra — 1 GB, valores de hasta
// 25 MB, y las lecturas se cachean en el borde, así que una foto popular casi
// no consume cuota.
//
// Si algún día R2 está habilitado, se conecta con el nombre FOTOS y este
// módulo lo empieza a usar solo, sin tocar nada más. Las fotos viejas siguen
// saliendo de KV, porque se busca en los dos lados.
//
// Lo que no se hace es guardar fotos en la base: D1 está pensado para datos
// chicos, y las imágenes la vuelven lenta y cara de copiar.

/** ¿Hay algún lugar donde guardar? */
export function hayDondeGuardar(env) {
  return Boolean(env.FOTOS || env.FOTOS_KV);
}

export function porQueNoSePuede() {
  return {
    error: 'El almacenamiento de fotos todavía no está conectado.',
    comoResolverlo: 'Falta conectar KV con el nombre FOTOS_KV. Está explicado en docs/PUBLICAR.md.',
  };
}

/**
 * Guarda la foto y devuelve la ruta pública con la que se la pide después.
 * @param {ArrayBuffer} bytes
 * @param {string} tipo  el tipo MIME real, ya comprobado por quien llama
 */
export async function guardarFoto(env, nombre, bytes, tipo) {
  if (env.FOTOS) {
    await env.FOTOS.put(nombre, bytes, { httpMetadata: { contentType: tipo } });
  } else {
    await env.FOTOS_KV.put(nombre, bytes, { metadata: { contentType: tipo } });
  }
  return `/fotos/${nombre}`;
}

/**
 * Busca la foto en los dos almacenamientos y la devuelve con lo necesario
 * para servirla: el cuerpo, el tipo y una etiqueta de versión.
 *
 * Como cada foto tiene un nombre único que nunca se reescribe, la etiqueta
 * puede ser el propio nombre: dos fotos distintas nunca comparten nombre, y
 * una foto nunca cambia de contenido.
 */
export async function leerFoto(env, clave) {
  if (env.FOTOS) {
    const objeto = await env.FOTOS.get(clave);
    if (objeto) {
      return {
        cuerpo: objeto.body,
        tipo: (objeto.httpMetadata && objeto.httpMetadata.contentType) || 'application/octet-stream',
        etag: objeto.httpEtag,
      };
    }
  }
  if (env.FOTOS_KV) {
    const { value, metadata } = await env.FOTOS_KV.getWithMetadata(clave, { type: 'arrayBuffer' });
    if (value) {
      return {
        cuerpo: value,
        tipo: (metadata && metadata.contentType) || 'application/octet-stream',
        etag: '"' + clave + '"',
      };
    }
  }
  return null;
}

export async function borrarFoto(env, clave) {
  if (env.FOTOS) await env.FOTOS.delete(clave);
  if (env.FOTOS_KV) await env.FOTOS_KV.delete(clave);
}
