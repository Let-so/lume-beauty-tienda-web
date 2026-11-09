// Recuperar la contraseña con el código de recuperación.
//
// No hay recuperación por correo porque eso exige contratar un servicio de
// envío, y el proyecto tiene presupuesto cero. El código de recuperación se
// entrega una sola vez al crear la cuenta: es de un solo uso y en la base
// queda nada más que su resumen.

import { ok, error, leerJSON, cookieSesion, cookieCSRF, igualSeguro } from '../../_lib/http.js';
import {
  sha256, hashearPassword, pareceClaveDerivada, codigoDeRecuperacion,
  crearSesion, cerrarTodasLasSesiones, tokenAleatorio, registrar,
  intentosRecientes, anotarIntento, MAX_INTENTOS, VENTANA_MINUTOS, SEGUNDOS_SESION,
} from '../../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const { data, error: errLectura } = await leerJSON(request);
  if (errLectura) return error(errLectura);

  const email = String(data.email || '').trim().toLowerCase();
  const codigo = String(data.codigo || '').trim().toUpperCase();
  const nueva = String(data.password || '');

  if (!email || !codigo || !nueva) {
    return error('Completá tu correo, el código de recuperación y la contraseña nueva.');
  }

  // El mismo freno que el inicio de sesión: si no, el código se podría adivinar.
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const sujeto = 'recuperar:' + ip;
  if (await intentosRecientes(env.DB, sujeto) >= MAX_INTENTOS) {
    return error(`Hubo demasiados intentos. Esperá ${VENTANA_MINUTOS} minutos antes de volver a probar.`, 429);
  }

  if (!pareceClaveDerivada(nueva)) {
    return error('Tu navegador no pudo preparar la contraseña nueva. Actualizá la página e intentá de nuevo.');
  }

  const usuario = await env.DB.prepare(
    'SELECT id,email,name,role,recovery_hash,recovery_used_at FROM admin_user WHERE email = ?'
  ).bind(email).first();

  const mensajeGenerico = 'El correo o el código de recuperación no son correctos.';

  if (!usuario || !usuario.recovery_hash || usuario.recovery_used_at) {
    await anotarIntento(env.DB, sujeto, false);
    return error(mensajeGenerico, 401);
  }

  if (!igualSeguro(await sha256(codigo), usuario.recovery_hash)) {
    await anotarIntento(env.DB, sujeto, false);
    await registrar(env.DB, usuario.id, 'recuperacion_fallida', 'admin_user', String(usuario.id), { ip });
    return error(mensajeGenerico, 401);
  }

  const h = await hashearPassword(nueva);

  // El código que acaba de usar queda quemado, así que se entrega otro en el
  // acto. Si no, recuperar la contraseña una vez la dejaría sin red para la
  // próxima, y tendría que pedirle a alguien con acceso al servidor que le
  // genere uno — justo lo que este panel existe para evitar.
  const codigoNuevo = codigoDeRecuperacion();
  await env.DB.prepare(
    `UPDATE admin_user SET password_hash=?, password_salt=?, password_iterations=?,
            recovery_hash=?, recovery_used_at=NULL WHERE id=?`
  ).bind(h.hash, h.salt, h.iterations, await sha256(codigoNuevo), usuario.id).run();

  // Cualquier sesión abierta queda invalidada: si alguien había entrado, sale.
  await cerrarTodasLasSesiones(env.DB, usuario.id);
  await registrar(env.DB, usuario.id, 'password_recuperada', 'admin_user', String(usuario.id), { ip });

  const token = await crearSesion(env.DB, usuario.id, request.headers.get('User-Agent'));
  const csrf = tokenAleatorio(24);
  const r = ok({
    usuario: { id: usuario.id, email: usuario.email, name: usuario.name, role: usuario.role },
    codigoNuevo,
    mensaje: 'Tu contraseña cambió. El código que usaste ya no sirve: este es el nuevo.',
  });
  r.headers.append('Set-Cookie', cookieSesion(token, request, SEGUNDOS_SESION));
  r.headers.append('Set-Cookie', cookieCSRF(csrf, request));
  return r;
}
