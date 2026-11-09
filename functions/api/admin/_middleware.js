// Guardián de todo lo que cuelga de /api/admin.
//
// Está acá a propósito, y no repetido dentro de cada endpoint: un control que
// hay que acordarse de escribir veinte veces es un control que algún día se
// olvida en el endpoint número veintiuno. Acá se aplica por defecto y hay que
// pedir permiso explícito para saltearlo.

import { error, verificarOrigen } from '../../_lib/http.js';
import { usuarioDeLaSesion, verificarCSRF } from '../../_lib/auth.js';

// Lo único que se puede tocar sin haber iniciado sesión: la propia pantalla de
// ingreso y la recuperación de contraseña.
const SIN_SESION = new Set(['/api/admin/sesion', '/api/admin/recuperar']);

const METODOS_QUE_MODIFICAN = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function onRequest(context) {
  const { request, env, next, data } = context;
  const url = new URL(request.url);
  const ruta = url.pathname.replace(/\/+$/, '');

  if (!env.DB) return error('La base de datos no está configurada.', 503);

  // Las peticiones que modifican algo tienen que venir de la propia tienda.
  if (METODOS_QUE_MODIFICAN.has(request.method)) {
    if (!verificarOrigen(request)) {
      return error('La solicitud no proviene de la tienda. Por seguridad no se ejecutó.', 403);
    }
  }

  const usuario = await usuarioDeLaSesion(request, env.DB);

  if (!SIN_SESION.has(ruta)) {
    if (!usuario) {
      return error('Necesitás iniciar sesión para hacer esto.', 401);
    }
    // El testigo CSRF se exige solo con sesión abierta: sin sesión no hay nada
    // que un tercero pueda aprovechar.
    if (METODOS_QUE_MODIFICAN.has(request.method) && !verificarCSRF(request)) {
      return error('La sesión expiró o la solicitud no es válida. Actualizá la página e intentá de nuevo.', 403);
    }
  }

  data.usuario = usuario;
  const respuesta = await next();
  // Nada de lo que pase por acá se guarda en ninguna caché intermedia.
  const r = new Response(respuesta.body, respuesta);
  r.headers.set('Cache-Control', 'no-store');
  r.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return r;
}
