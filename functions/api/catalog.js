// Catálogo público. Es el reemplazo exacto de data/catalog.json.
//
// Acá se aplica el modo mantenimiento, y se aplica en el servidor. Si se
// ocultara solo en el navegador, cualquiera podría pedir este mismo endpoint y
// seguir viendo los precios mientras Camila los está cambiando. Cuando el modo
// está activo, esta respuesta no lleva ni un producto ni un precio.
//
// La única excepción es Camila: si tiene sesión abierta, ve el catálogo
// aunque la tienda esté en mantenimiento, para poder revisar cómo quedó antes
// de volver a publicar.

import { json, error } from '../_lib/http.js';
import { usuarioDeLaSesion } from '../_lib/auth.js';
import { construirCatalogo, estadoMantenimiento, leerAjuste } from '../_lib/catalogo.js';

export async function onRequestGet({ request, env }) {
  if (!env.DB) return error('La base de datos no está configurada.', 503);

  const mantenimiento = await estadoMantenimiento(env.DB);

  if (mantenimiento.active) {
    let usuario = null;
    try {
      usuario = await usuarioDeLaSesion(request, env.DB);
    } catch {
      usuario = null;
    }
    if (!usuario) {
      // 503 y nada de información comercial. Retry-After le dice a los
      // buscadores que esto es temporal y que no desindexen la tienda.
      // El contacto sí viaja: el mensaje invita a escribir por WhatsApp, y
      // sin el enlace esa invitación no lleva a ningún lado. No es
      // información comercial, así que no rompe la regla de arriba.
      const whatsapp = await leerAjuste(env.DB, 'whatsapp', null);
      return json({
        maintenance: {
          active: true,
          title: mantenimiento.title,
          message: mantenimiento.message,
          whatsapp: whatsapp || undefined,
        },
      }, 503, { 'Retry-After': '3600' });
    }
  }

  const catalogo = await construirCatalogo(env.DB);
  catalogo.maintenance = { active: mantenimiento.active };
  // Si Camila está mirando con la tienda en mantenimiento, que lo sepa.
  if (mantenimiento.active) catalogo.maintenance.preview = true;
  return json(catalogo);
}
