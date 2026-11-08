// Utilidades de respuesta y de seguridad compartidas por toda la API.

export const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  // La API nunca se cachea: si se cacheara, el modo mantenimiento podría
  // seguir sirviendo el catálogo viejo desde la CDN después de activarse.
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

/** Error con un mensaje pensado para que lo lea una persona, no un programador. */
export function error(mensaje, status = 400, extra = {}) {
  return json({ ok: false, error: mensaje, ...extra }, status);
}

export function ok(data = {}) {
  return json({ ok: true, ...data });
}

/** Lee el cuerpo JSON sin confiar en que venga bien formado. */
export async function leerJSON(request, maxBytes = 512 * 1024) {
  const largo = Number(request.headers.get('content-length') || 0);
  if (largo > maxBytes) return { error: 'El contenido enviado es demasiado grande.' };
  let texto;
  try {
    texto = await request.text();
  } catch {
    return { error: 'No se pudo leer el contenido enviado.' };
  }
  if (texto.length > maxBytes) return { error: 'El contenido enviado es demasiado grande.' };
  if (!texto.trim()) return { data: {} };
  try {
    const data = JSON.parse(texto);
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { error: 'El formato de los datos no es el esperado.' };
    }
    return { data };
  } catch {
    return { error: 'El formato de los datos no es el esperado.' };
  }
}

/**
 * Comprueba que una petición que modifica datos venga de la propia tienda.
 *
 * Son dos cerrojos independientes. El primero es el origen: un formulario
 * alojado en otro sitio manda un Origin distinto. El segundo es el testigo
 * CSRF, que viaja en una cookie legible y tiene que repetirse en una cabecera;
 * otro sitio puede hacer que el navegador mande la cookie, pero no puede leerla
 * para copiarla en la cabecera.
 */
export function verificarOrigen(request) {
  const origen = request.headers.get('Origin');
  if (!origen) return true;              // navegación directa o misma página
  try {
    return new URL(origen).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export function leerCookies(request) {
  const crudo = request.headers.get('Cookie') || '';
  const out = {};
  for (const parte of crudo.split(';')) {
    const i = parte.indexOf('=');
    if (i < 0) continue;
    out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}

/** Comparación en tiempo constante, para no filtrar información por la demora. */
export function igualSeguro(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}

export const COOKIE_SESION = 'lume_sesion';
export const COOKIE_CSRF = 'lume_csrf';

export function cookieSesion(token, request, maxEdadSegundos) {
  const seguro = new URL(request.url).protocol === 'https:';
  const partes = [
    `${COOKIE_SESION}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxEdadSegundos}`,
  ];
  if (seguro) partes.push('Secure');
  return partes.join('; ');
}

/** El testigo CSRF se lee desde JavaScript a propósito: el panel lo copia a una cabecera. */
export function cookieCSRF(token, request) {
  const seguro = new URL(request.url).protocol === 'https:';
  const partes = [`${COOKIE_CSRF}=${token}`, 'Path=/', 'SameSite=Lax'];
  if (seguro) partes.push('Secure');
  return partes.join('; ');
}

export function cookieBorrada(nombre, request) {
  const seguro = new URL(request.url).protocol === 'https:';
  const partes = [`${nombre}=`, 'Path=/', 'Max-Age=0', 'SameSite=Lax'];
  if (nombre === COOKIE_SESION) partes.push('HttpOnly');
  if (seguro) partes.push('Secure');
  return partes.join('; ');
}

export function ahora() {
  return new Date().toISOString();
}
