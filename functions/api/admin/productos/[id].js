// Ver, modificar y borrar un producto.

import { ok, error, json, leerJSON } from '../../../_lib/http.js';
import { registrar } from '../../../_lib/auth.js';
import { validarProducto, revisarReferencias, guardarProducto, anotarPrecio } from '../../../_lib/producto.js';

async function traer(db, id) {
  const p = await db.prepare(
    `SELECT p.*, b.name AS brand_name FROM product p
       LEFT JOIN brand b ON b.id = p.brand_id WHERE p.id = ?`).bind(id).first();
  if (!p) return null;

  const [cats, fotos, textos, specs, etiquetas] = await Promise.all([
    db.prepare('SELECT category_id FROM product_category WHERE product_id=? ORDER BY sort_order').bind(id).all(),
    db.prepare('SELECT url FROM product_image WHERE product_id=? ORDER BY is_main DESC, sort_order').bind(id).all(),
    db.prepare('SELECT kind,body FROM product_text WHERE product_id=? ORDER BY sort_order').bind(id).all(),
    db.prepare('SELECT label,value FROM product_spec WHERE product_id=? ORDER BY sort_order').bind(id).all(),
    db.prepare('SELECT t.name FROM tag t JOIN product_tag pt ON pt.tag_id=t.id WHERE pt.product_id=?').bind(id).all(),
  ]);

  const textosDe = clase => (textos.results || []).filter(t => t.kind === clase).map(t => t.body);

  return {
    id: p.id,
    brand: p.brand_id,
    brandLabel: p.brand_name,
    name: p.name,
    title: p.title,
    subtitle: p.subtitle,
    size: p.size,
    price: p.price === null ? null : Number(p.price),
    compareAtPrice: p.compare_at_price === null ? null : Number(p.compare_at_price),
    stock: p.stock === null ? null : Number(p.stock),
    status: p.status,
    featured: Boolean(p.featured),
    tag: p.badge || '',
    warning: p.warning || '',
    imagePadding: p.image_padding,
    categories: (cats.results || []).map(c => c.category_id),
    images: (fotos.results || []).map(f => f.url),
    description: textosDe('description'),
    howTo: textosDe('how_to'),
    specs: (specs.results || []).map(s => ({ label: s.label, value: s.value })),
    tags: (etiquetas.results || []).map(t => t.name),
    updatedAt: p.updated_at,
  };
}

export async function onRequestGet({ params, env }) {
  const p = await traer(env.DB, params.id);
  if (!p) return error('Ese producto no existe o ya fue borrado.', 404);

  const precios = await env.DB.prepare(
    'SELECT old_price,new_price,reason,at FROM price_history WHERE product_id=? ORDER BY at DESC LIMIT 20'
  ).bind(params.id).all();
  p.historialPrecios = (precios.results || []).map(h => ({
    antes: h.old_price === null ? null : Number(h.old_price),
    despues: h.new_price === null ? null : Number(h.new_price),
    motivo: h.reason, fecha: h.at,
  }));

  return json({ ok: true, producto: p });
}

export async function onRequestPut({ request, params, env, data }) {
  const anterior = await traer(env.DB, params.id);
  if (!anterior) return error('Ese producto no existe o ya fue borrado.', 404);

  const { data: cuerpo, error: errLectura } = await leerJSON(request);
  if (errLectura) return error(errLectura);

  // El identificador no se cambia al editar: es la dirección pública del
  // producto y los enlaces que ya compartió Camila dejarían de funcionar.
  const { valor, errores } = validarProducto({ ...cuerpo, id: params.id }, { esNuevo: false });
  if (errores.length) return json({ ok: false, error: errores[0], errores }, 422);

  const errRef = await revisarReferencias(env.DB, valor);
  if (errRef.length) return json({ ok: false, error: errRef[0], errores: errRef }, 422);

  await guardarProducto(env.DB, valor, { esNuevo: false });
  await anotarPrecio(env.DB, params.id, anterior.price, valor.price ?? null,
                     data.usuario.id, 'edición del producto');

  if (anterior.stock !== (valor.stock ?? null)) {
    const antes = anterior.stock ?? 0;
    const despues = valor.stock ?? 0;
    await env.DB.prepare(
      'INSERT INTO stock_movement (product_id,delta,resulting_stock,user_id,reason,at) VALUES (?,?,?,?,?,?)'
    ).bind(params.id, despues - antes, valor.stock ?? null, data.usuario.id,
           'ajuste manual', new Date().toISOString()).run();
  }

  await registrar(env.DB, data.usuario.id, 'producto_editado', 'product', params.id, { name: valor.name });
  return ok({ mensaje: 'Cambios guardados.' });
}

export async function onRequestDelete({ params, env, data }) {
  const p = await env.DB.prepare('SELECT id,name FROM product WHERE id = ?').bind(params.id).first();
  if (!p) return error('Ese producto no existe o ya fue borrado.', 404);

  // Se guarda una copia completa en el registro antes de borrar: si fue un
  // error, los datos siguen estando y se pueden volver a cargar.
  const completo = await traer(env.DB, params.id);
  await registrar(env.DB, data.usuario.id, 'producto_borrado', 'product', params.id, completo);
  await env.DB.prepare('DELETE FROM product WHERE id = ?').bind(params.id).run();

  return ok({ mensaje: `Se borró «${p.name}».` });
}
