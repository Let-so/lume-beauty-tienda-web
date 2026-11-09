// La cuenta de Camila, administrada por ella misma.
//
// Dos cosas: cambiar la contraseña y pedir un código de recuperación nuevo.
// Las dos piden la contraseña actual, porque si alguien se sienta frente a una
// sesión abierta no tiene que poder quedarse con la cuenta.
//
// El código nuevo importa más de lo que parece: el de recuperación es de un
// solo uso, así que sin una forma de pedir otro, Camila gasta el suyo una vez
// y queda sin red de seguridad hasta que alguien con acceso al servidor le
// genere uno. Eso es justo lo que este panel existe para evitar.

import {
  ok, error, json, leerJSON, cookieSesion, cookieCSRF,
} from '../../_lib/http.js';
import {
  verificarPassword, pareceClaveDerivada, hashearPassword, sha256, tokenAleatorio,
  codigoDeRecuperacion, cerrarTodasLasSesiones, crearSesion, registrar,
  intentosRecientes, anotarIntento, limpiarIntentos,
  MAX_INTENTOS, VENTANA_MINUTOS, SEGUNDOS_SESION,
} from '../../_lib/auth.js';

export async function onRequestGet({ env, data }) {
  const fila = await env.DB.prepare(
    'SELECT recovery_hash, recovery_used_at, last_login_at FROM admin_user WHERE id = ?'
  ).bind(data.usuario.id).first();

  return json({
    ok: true,
    usuario: data.usuario,
    // No se puede mostrar el código: en la base está solo su resumen. Lo único
    // que se puede decir es si todavía sirve.
    tieneCodigo: Boolean(fila && fila.recovery_hash && !fila.recovery_used_at),
    ultimoIngreso: (fila && fila.last_login_at) || null,
  });
}

export async function onRequestPost({ request, env, data }) {
  const { data: cuerpo, error: errLectura } = await leerJSON(request);
  if (errLectura) return error(errLectura);

  const accion = String(cuerpo.accion || '');
  const actual = String(cuerpo.actual || '');

  if (!pareceClaveDerivada(actual)) {
    return error('Escribí tu contraseña de ahora para confirmar que sos vos.');
  }

  // Aunque haga falta una sesión abierta para llegar hasta acá, el freno vale:
  // sin él, una sesión robada permite probar contraseñas sin límite.
  const sujeto = 'cuenta:' + data.usuario.id;
  if (await intentosRecientes(env.DB, sujeto) >= MAX_INTENTOS) {
    return error(
      `Hubo demasiados intentos fallidos. Esperá ${VENTANA_MINUTOS} minutos antes de volver a probar.`,
      429);
  }

  const usuario = await env.DB.prepare(
    'SELECT id,email,name,role,password_hash,password_salt,password_iterations FROM admin_user WHERE id = ?'
  ).bind(data.usuario.id).first();

  if (!usuario || !(await verificarPassword(actual, usuario))) {
    await anotarIntento(env.DB, sujeto, false);
    await registrar(env.DB, data.usuario.id, 'cuenta_clave_mal', 'admin_user', String(data.usuario.id));
    return error('Esa no es tu contraseña de ahora.', 401);
  }
  await limpiarIntentos(env.DB, sujeto);

  if (accion === 'nuevo-codigo') {
    const codigo = codigoDeRecuperacion();
    await env.DB.prepare(
      'UPDATE admin_user SET recovery_hash = ?, recovery_used_at = NULL WHERE id = ?'
    ).bind(await sha256(codigo), usuario.id).run();
    await registrar(env.DB, usuario.id, 'codigo_recuperacion_nuevo', 'admin_user', String(usuario.id));
    return ok({
      codigo,
      mensaje: 'Este es tu código nuevo. El anterior ya no sirve.',
    });
  }

  if (accion === 'cambiar-clave') {
    const nueva = String(cuerpo.nueva || '');
    if (!pareceClaveDerivada(nueva)) {
      return error('Tu navegador no pudo preparar la contraseña nueva. Actualizá la página e intentá de nuevo.');
    }
    if (nueva === actual) {
      return error('La contraseña nueva es la misma que tenías. Elegí otra.');
    }

    const h = await hashearPassword(nueva);
    await env.DB.prepare(
      `UPDATE admin_user SET password_hash = ?, password_salt = ?, password_iterations = ?
       WHERE id = ?`
    ).bind(h.hash, h.salt, h.iterations, usuario.id).run();

    // Si la contraseña se cambió porque alguien más la sabía, de nada sirve
    // cambiarla y dejarle la sesión abierta.
    await cerrarTodasLasSesiones(env.DB, usuario.id);
    await registrar(env.DB, usuario.id, 'password_cambiada', 'admin_user', String(usuario.id));

    // Menos la de acá: sería raro que cambiar la contraseña te eche a vos.
    const token = await crearSesion(env.DB, usuario.id, request.headers.get('User-Agent'));
    const csrf = tokenAleatorio(24);
    const r = ok({
      mensaje: 'Listo, tu contraseña cambió. Si habías entrado en otro teléfono o computadora, ahí se cerró la sesión.',
    });
    r.headers.append('Set-Cookie', cookieSesion(token, request, SEGUNDOS_SESION));
    r.headers.append('Set-Cookie', cookieCSRF(csrf, request));
    return r;
  }

  return error('No entendí qué querés hacer con tu cuenta.');
}
