// Contraseñas, sesiones y freno a los intentos de adivinar la clave.
//
// Todo con WebCrypto, que es lo que hay en Cloudflare Workers. No se usa
// ninguna librería de terceros: menos dependencias que auditar y nada que se
// desactualice sin aviso.

import { igualSeguro, leerCookies, COOKIE_SESION, COOKIE_CSRF, ahora } from './http.js';

// El estirado fuerte de la contraseña ocurre en el navegador, en
// admin/clave.js, y ahí está explicado por qué. Lo que llega acá ya es una
// clave de 256 bits derivada con 600.000 iteraciones.
//
// Por eso acá alcanza con pocas iteraciones: no están estirando una
// contraseña débil, están volviendo a mezclar algo que ya es fuerte, con una
// sal propia del servidor para que dos instalaciones no compartan resultados.
// 2.000 iteraciones cuestan alrededor de 1 ms y entran holgadas en los 10 ms
// de CPU que da el plan gratuito de Cloudflare.
export const ITERACIONES = 2000;
const LARGO_CLAVE = 32;
const LARGO_SAL = 16;

const DIAS_SESION = 30;
export const SEGUNDOS_SESION = DIAS_SESION * 24 * 60 * 60;

// Tras 8 intentos fallidos en 15 minutos, se frena durante 15 minutos.
export const MAX_INTENTOS = 8;
export const VENTANA_MINUTOS = 15;

const enc = new TextEncoder();

function aBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function deBase64(txt) {
  const bin = atob(txt);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function tokenAleatorio(bytes = 32) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  // base64url: entra en una cookie sin necesidad de escaparlo
  return aBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(texto) {
  return aBase64(await crypto.subtle.digest('SHA-256', enc.encode(texto)));
}

export async function derivarClave(password, salBase64, iteraciones) {
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: deBase64(salBase64), iterations: iteraciones, hash: 'SHA-256' },
    material, LARGO_CLAVE * 8);
  return aBase64(bits);
}

export async function hashearPassword(password) {
  const sal = new Uint8Array(LARGO_SAL);
  crypto.getRandomValues(sal);
  const salBase64 = aBase64(sal);
  return {
    hash: await derivarClave(password, salBase64, ITERACIONES),
    salt: salBase64,
    iterations: ITERACIONES,
  };
}

export async function verificarPassword(password, usuario) {
  const calculado = await derivarClave(password, usuario.password_salt, usuario.password_iterations);
  return igualSeguro(calculado, usuario.password_hash);
}

/**
 * Reglas mínimas de contraseña. Se pide longitud antes que símbolos raros:
 * una frase larga es más fuerte y mucho más fácil de recordar que "Xk3$a".
 */
/**
 * Comprueba que lo que llegó tenga forma de clave derivada y no de contraseña
 * en crudo. No es una defensa: es para detectar enseguida si el navegador no
 * hizo su parte, en vez de dar un "contraseña incorrecta" que despiste.
 */
export function pareceClaveDerivada(valor) {
  return typeof valor === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(valor);
}

/**
 * Reglas de la contraseña. Se usa en el navegador y al crear la cuenta, nunca
 * en el servidor: ahí ya no se ve la contraseña, solo su derivación.
 */
export function revisarPassword(password) {
  if (typeof password !== 'string' || password.length < 10) {
    return 'La contraseña tiene que tener al menos 10 caracteres. Una frase que recuerdes es mejor que algo corto y complicado.';
  }
  if (password.length > 200) return 'La contraseña es demasiado larga.';
  const comunes = ['contrasena1', 'contraseña1', '1234567890', 'password123', 'qwertyuiop'];
  if (comunes.includes(password.toLowerCase())) {
    return 'Esa contraseña es demasiado fácil de adivinar. Probá con otra.';
  }
  return null;
}

// ─────────────────────────────── sesiones ───────────────────────────────

export async function crearSesion(db, userId, userAgent) {
  const token = tokenAleatorio(32);
  const vence = new Date(Date.now() + SEGUNDOS_SESION * 1000).toISOString();
  await db.prepare(
    'INSERT INTO session (token_hash,user_id,created_at,expires_at,user_agent) VALUES (?,?,?,?,?)'
  ).bind(await sha256(token), userId, ahora(), vence, (userAgent || '').slice(0, 200)).run();
  return token;
}

/** Devuelve el usuario de la sesión, o null. Limpia de paso las vencidas. */
export async function usuarioDeLaSesion(request, db) {
  const token = leerCookies(request)[COOKIE_SESION];
  if (!token) return null;
  const fila = await db.prepare(
    `SELECT u.id, u.email, u.name, u.role, s.expires_at
       FROM session s JOIN admin_user u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).bind(await sha256(token)).first();
  if (!fila) return null;
  if (new Date(fila.expires_at).getTime() < Date.now()) {
    await db.prepare('DELETE FROM session WHERE token_hash = ?').bind(await sha256(token)).run();
    return null;
  }
  return { id: fila.id, email: fila.email, name: fila.name, role: fila.role };
}

export async function cerrarSesion(request, db) {
  const token = leerCookies(request)[COOKIE_SESION];
  if (token) {
    await db.prepare('DELETE FROM session WHERE token_hash = ?').bind(await sha256(token)).run();
  }
}

export async function cerrarTodasLasSesiones(db, userId) {
  await db.prepare('DELETE FROM session WHERE user_id = ?').bind(userId).run();
}

// ───────────────────────────────── CSRF ─────────────────────────────────

/**
 * Doble envío: el mismo testigo viaja en una cookie legible y en una cabecera.
 * Otro sitio puede lograr que el navegador mande la cookie, pero no puede
 * leerla para repetirla en la cabecera.
 */
export function verificarCSRF(request) {
  const cookie = leerCookies(request)[COOKIE_CSRF];
  const cabecera = request.headers.get('X-CSRF-Token');
  return Boolean(cookie) && igualSeguro(cookie, cabecera || '');
}

// ──────────────────────────── freno a la fuerza bruta ────────────────────────────

export async function intentosRecientes(db, subject) {
  const desde = new Date(Date.now() - VENTANA_MINUTOS * 60 * 1000).toISOString();
  const r = await db.prepare(
    'SELECT COUNT(*) AS n FROM login_attempt WHERE subject = ? AND ok = 0 AND at > ?'
  ).bind(subject, desde).first();
  return r ? r.n : 0;
}

export async function anotarIntento(db, subject, bien) {
  await db.prepare('INSERT INTO login_attempt (subject,at,ok) VALUES (?,?,?)')
    .bind(subject, ahora(), bien ? 1 : 0).run();
  // No dejar crecer la tabla para siempre.
  const viejo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await db.prepare('DELETE FROM login_attempt WHERE at < ?').bind(viejo).run();
}

export async function limpiarIntentos(db, subject) {
  await db.prepare('DELETE FROM login_attempt WHERE subject = ?').bind(subject).run();
}

// ──────────────────────────── registro de actividad ────────────────────────────

export async function registrar(db, userId, action, entity, entityId, detail) {
  await db.prepare(
    'INSERT INTO audit_log (user_id,action,entity,entity_id,detail,at) VALUES (?,?,?,?,?,?)'
  ).bind(userId || null, action, entity || null, entityId || null,
         detail ? JSON.stringify(detail).slice(0, 2000) : null, ahora()).run();
}
