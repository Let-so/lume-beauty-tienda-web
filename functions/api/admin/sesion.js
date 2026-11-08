// Entrar, saber quién soy y salir.

import {
  ok, error, json, leerJSON, cookieSesion, cookieCSRF, cookieBorrada,
  COOKIE_SESION, COOKIE_CSRF,
} from '../../_lib/http.js';
import {
  verificarPassword, crearSesion, cerrarSesion, tokenAleatorio,
  intentosRecientes, anotarIntento, limpiarIntentos, registrar,
  MAX_INTENTOS, VENTANA_MINUTOS, SEGUNDOS_SESION,
} from '../../_lib/auth.js';

/** Quién tiene la sesión abierta. Lo usa el panel al cargar. */
export async function onRequestGet({ data }) {
  if (!data.usuario) return json({ ok: true, autenticada: false });
  return json({ ok: true, autenticada: true, usuario: data.usuario });
}

export async function onRequestPost({ request, env }) {
  const { data, error: errLectura } = await leerJSON(request);
  if (errLectura) return error(errLectura);

  const email = String(data.email || '').trim().toLowerCase();
  const password = String(data.password || '');
  if (!email || !password) return error('Escribí tu correo y tu contraseña.');

  // Se frena por correo y por dirección de internet a la vez: así no alcanza
  // con cambiar de red para seguir probando contraseñas de la misma cuenta.
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const sujetos = ['correo:' + email, 'ip:' + ip];
  for (const s of sujetos) {
    if (await intentosRecientes(env.DB, s) >= MAX_INTENTOS) {
      return error(
        `Hubo demasiados intentos fallidos. Por seguridad hay que esperar ${VENTANA_MINUTOS} minutos antes de volver a probar.`,
        429);
    }
  }

  const usuario = await env.DB.prepare(
    'SELECT id,email,name,role,password_hash,password_salt,password_iterations FROM admin_user WHERE email = ?'
  ).bind(email).first();

  // Mismo mensaje exista o no la cuenta: si fueran distintos, se podría
  // averiguar qué correos están registrados probando uno por uno.
  const credencialesMal = 'El correo o la contraseña no son correctos.';

  if (!usuario) {
    for (const s of sujetos) await anotarIntento(env.DB, s, false);
    return error(credencialesMal, 401);
  }

  if (!(await verificarPassword(password, usuario))) {
    for (const s of sujetos) await anotarIntento(env.DB, s, false);
    await registrar(env.DB, usuario.id, 'login_fallido', 'admin_user', String(usuario.id), { ip });
    return error(credencialesMal, 401);
  }

  for (const s of sujetos) await limpiarIntentos(env.DB, s);

  const token = await crearSesion(env.DB, usuario.id, request.headers.get('User-Agent'));
  const csrf = tokenAleatorio(24);
  await env.DB.prepare('UPDATE admin_user SET last_login_at = ? WHERE id = ?')
    .bind(new Date().toISOString(), usuario.id).run();
  await registrar(env.DB, usuario.id, 'login', 'admin_user', String(usuario.id), { ip });

  const r = ok({ usuario: { id: usuario.id, email: usuario.email, name: usuario.name, role: usuario.role } });
  r.headers.append('Set-Cookie', cookieSesion(token, request, SEGUNDOS_SESION));
  r.headers.append('Set-Cookie', cookieCSRF(csrf, request));
  return r;
}

export async function onRequestDelete({ request, env, data }) {
  await cerrarSesion(request, env.DB);
  if (data.usuario) await registrar(env.DB, data.usuario.id, 'logout', 'admin_user', String(data.usuario.id));
  const r = ok({ mensaje: 'Cerraste la sesión.' });
  r.headers.append('Set-Cookie', cookieBorrada(COOKIE_SESION, request));
  r.headers.append('Set-Cookie', cookieBorrada(COOKIE_CSRF, request));
  return r;
}
