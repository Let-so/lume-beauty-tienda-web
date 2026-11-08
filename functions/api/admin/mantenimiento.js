// El interruptor que oculta la tienda al público.
//
// El estado vive en la tabla settings, no en memoria, así que sobrevive a
// cualquier reinicio del servidor. Apagar y encender la tienda no toca ni un
// producto: lo único que cambia es si el catálogo se entrega o no.

import { ok, error, json, leerJSON } from '../../_lib/http.js';
import { registrar } from '../../_lib/auth.js';
import { estadoMantenimiento, guardarAjuste } from '../../_lib/catalogo.js';

export async function onRequestGet({ env }) {
  return json({ ok: true, mantenimiento: await estadoMantenimiento(env.DB) });
}

export async function onRequestPost({ request, env, data }) {
  const { data: cuerpo, error: errLectura } = await leerJSON(request);
  if (errLectura) return error(errLectura);

  const actual = await estadoMantenimiento(env.DB);
  const activo = typeof cuerpo.active === 'boolean' ? cuerpo.active : actual.active;

  const titulo = cuerpo.title === undefined ? actual.title : String(cuerpo.title).trim();
  const mensaje = cuerpo.message === undefined ? actual.message : String(cuerpo.message).trim();
  if (titulo.length > 120) return error('El título es demasiado largo (máximo 120 caracteres).');
  if (mensaje.length > 600) return error('El mensaje es demasiado largo (máximo 600 caracteres).');
  if (activo && !titulo) return error('Escribí un título para la pantalla de mantenimiento.');

  const nuevo = { active: activo, title: titulo, message: mensaje };
  await guardarAjuste(env.DB, 'maintenance', nuevo);
  await registrar(env.DB, data.usuario.id,
                  activo ? 'tienda_en_mantenimiento' : 'tienda_publicada', 'settings', 'maintenance');

  return ok({
    mantenimiento: nuevo,
    mensaje: activo
      ? 'La tienda quedó oculta para los visitantes. Vos seguís trabajando normalmente.'
      : 'La tienda volvió a estar visible con el catálogo actualizado.',
  });
}
