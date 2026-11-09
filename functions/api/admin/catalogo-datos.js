// Categorías, marcas y etiquetas: lo que el panel necesita para armar los
// desplegables, y lo que Camila usa para organizar su catálogo.
//
// Van juntas en un endpoint porque siempre se piden juntas: una sola ida y
// vuelta en lugar de tres.

import { ok, error, json, leerJSON } from '../../_lib/http.js';
import { registrar } from '../../_lib/auth.js';
import { hacerSlug } from '../../_lib/producto.js';

export async function onRequestGet({ env }) {
  const [cats, marcas, etiquetas] = await Promise.all([
    env.DB.prepare(
      `SELECT c.id,c.label,
              (SELECT COUNT(*) FROM product_category pc WHERE pc.category_id=c.id) AS usos
         FROM category c ORDER BY c.sort_order`).all(),
    env.DB.prepare(
      `SELECT b.id,b.name,b.bag,
              (SELECT COUNT(*) FROM product p WHERE p.brand_id=b.id) AS usos
         FROM brand b ORDER BY b.sort_order`).all(),
    env.DB.prepare('SELECT id,name FROM tag ORDER BY name').all(),
  ]);

  return json({
    ok: true,
    categorias: (cats.results || []).map(c => ({ id: c.id, label: c.label, usos: c.usos })),
    marcas: (marcas.results || []).map(b => ({ id: b.id, name: b.name, bag: b.bag || '', usos: b.usos })),
    etiquetas: (etiquetas.results || []).map(t => t.name),
  });
}

/** Crea o renombra una categoría o una marca. */
export async function onRequestPost({ request, env, data }) {
  const { data: cuerpo, error: errLectura } = await leerJSON(request);
  if (errLectura) return error(errLectura);

  const tipo = cuerpo.tipo === 'marca' ? 'brand' : cuerpo.tipo === 'categoria' ? 'category' : null;
  if (!tipo) return error('No se indicó si es una categoría o una marca.');

  const nombre = String(cuerpo.nombre ?? '').trim();
  if (!nombre) return error('Escribí un nombre.');
  if (nombre.length > 80) return error('El nombre es demasiado largo (máximo 80 caracteres).');

  const id = String(cuerpo.id ?? '').trim() || hacerSlug(nombre);
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(id)) {
    return error('Ese nombre no sirve para armar un identificador. Probá con letras y números.');
  }

  const existe = await env.DB.prepare(`SELECT 1 FROM ${tipo} WHERE id = ?`).bind(id).first();
  const columna = tipo === 'brand' ? 'name' : 'label';

  if (existe) {
    await env.DB.prepare(`UPDATE ${tipo} SET ${columna} = ? WHERE id = ?`).bind(nombre, id).run();
    await registrar(env.DB, data.usuario.id, 'renombrada', tipo, id, { nombre });
    return ok({ id, mensaje: 'Nombre actualizado.' });
  }

  const max = await env.DB.prepare(`SELECT COALESCE(MAX(sort_order),-1) AS m FROM ${tipo}`).first();
  if (tipo === 'brand') {
    await env.DB.prepare('INSERT INTO brand (id,name,bag,sort_order) VALUES (?,?,NULL,?)')
      .bind(id, nombre, (max ? max.m : -1) + 1).run();
  } else {
    await env.DB.prepare('INSERT INTO category (id,label,sort_order) VALUES (?,?,?)')
      .bind(id, nombre, (max ? max.m : -1) + 1).run();
  }
  await registrar(env.DB, data.usuario.id, 'creada', tipo, id, { nombre });
  return ok({ id, mensaje: tipo === 'brand' ? 'Marca creada.' : 'Categoría creada.' });
}

/** Borra una categoría o una marca, solo si no la está usando ningún producto. */
export async function onRequestDelete({ request, env, data }) {
  const url = new URL(request.url);
  const tipo = url.searchParams.get('tipo') === 'marca' ? 'brand'
             : url.searchParams.get('tipo') === 'categoria' ? 'category' : null;
  const id = url.searchParams.get('id') || '';
  if (!tipo || !id) return error('Faltan datos para borrar.');

  const usos = tipo === 'brand'
    ? await env.DB.prepare('SELECT COUNT(*) AS n FROM product WHERE brand_id = ?').bind(id).first()
    : await env.DB.prepare('SELECT COUNT(*) AS n FROM product_category WHERE category_id = ?').bind(id).first();

  if (usos && usos.n > 0) {
    return error(
      `No se puede borrar porque ${usos.n} ${usos.n === 1 ? 'producto la está usando' : 'productos la están usando'}. ` +
      'Cambiá esos productos primero.', 409);
  }

  await env.DB.prepare(`DELETE FROM ${tipo} WHERE id = ?`).bind(id).run();
  await registrar(env.DB, data.usuario.id, 'borrada', tipo, id);
  return ok({ mensaje: 'Listo, se borró.' });
}
