// Listado y alta de productos.

import { ok, error, json, leerJSON } from '../../_lib/http.js';
import { registrar } from '../../_lib/auth.js';
import { validarProducto, revisarReferencias, guardarProducto, anotarPrecio } from '../../_lib/producto.js';

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const busqueda = (url.searchParams.get('q') || '').trim().toLowerCase();
  const estado = url.searchParams.get('estado') || '';
  const marca = url.searchParams.get('marca') || '';
  const categoria = url.searchParams.get('categoria') || '';

  // Parámetros atados: nunca se arma SQL pegando texto del usuario.
  const condiciones = [];
  const valores = [];
  if (estado) { condiciones.push('p.status = ?'); valores.push(estado); }
  if (marca) { condiciones.push('p.brand_id = ?'); valores.push(marca); }
  if (categoria) {
    condiciones.push('EXISTS (SELECT 1 FROM product_category pc WHERE pc.product_id = p.id AND pc.category_id = ?)');
    valores.push(categoria);
  }
  if (busqueda) {
    condiciones.push('(lower(p.name) LIKE ? OR lower(p.id) LIKE ? OR lower(COALESCE(b.name,\'\')) LIKE ?)');
    const like = `%${busqueda}%`;
    valores.push(like, like, like);
  }
  const where = condiciones.length ? 'WHERE ' + condiciones.join(' AND ') : '';

  const filas = await env.DB.prepare(
    `SELECT p.id,p.name,p.size,p.price,p.compare_at_price,p.stock,p.status,p.featured,
            p.brand_id,b.name AS brand_name,p.updated_at,
            (SELECT url FROM product_image i WHERE i.product_id = p.id
              ORDER BY i.is_main DESC, i.sort_order LIMIT 1) AS image
       FROM product p LEFT JOIN brand b ON b.id = p.brand_id
       ${where} ORDER BY p.sort_order`
  ).bind(...valores).all();

  const umbral = await env.DB.prepare("SELECT value FROM settings WHERE key = 'low_stock_threshold'").first();
  const limite = umbral ? Number(JSON.parse(umbral.value)) || 3 : 3;

  const productos = (filas.results || []).map(r => ({
    id: r.id, name: r.name, size: r.size,
    price: r.price === null ? null : Number(r.price),
    compareAtPrice: r.compare_at_price === null ? null : Number(r.compare_at_price),
    stock: r.stock === null ? null : Number(r.stock),
    status: r.status, featured: Boolean(r.featured),
    brand: r.brand_id, brandLabel: r.brand_name, image: r.image || '',
    updatedAt: r.updated_at,
    stockBajo: r.stock !== null && r.stock <= limite,
  }));

  return json({
    ok: true,
    productos,
    resumen: {
      total: productos.length,
      publicados: productos.filter(p => p.status === 'published').length,
      borradores: productos.filter(p => p.status === 'draft').length,
      sinStock: productos.filter(p => p.status === 'out_of_stock').length,
      stockBajo: productos.filter(p => p.stockBajo).length,
      sinPrecio: productos.filter(p => p.price === null).length,
    },
  });
}

export async function onRequestPost({ request, env, data }) {
  const { data: cuerpo, error: errLectura } = await leerJSON(request);
  if (errLectura) return error(errLectura);

  const { valor, errores } = validarProducto(cuerpo, { esNuevo: true });
  if (errores.length) return json({ ok: false, error: errores[0], errores }, 422);

  const existe = await env.DB.prepare('SELECT 1 FROM product WHERE id = ?').bind(valor.id).first();
  if (existe) {
    return error(`Ya existe un producto con el identificador «${valor.id}». Cambiale el nombre o el identificador.`, 409);
  }

  const errRef = await revisarReferencias(env.DB, valor);
  if (errRef.length) return json({ ok: false, error: errRef[0], errores: errRef }, 422);

  const max = await env.DB.prepare('SELECT COALESCE(MAX(sort_order),-1) AS m FROM product').first();
  await guardarProducto(env.DB, valor, { esNuevo: true, orden: (max ? max.m : -1) + 1 });
  await anotarPrecio(env.DB, valor.id, null, valor.price ?? null, data.usuario.id, 'alta del producto');
  if (valor.stock !== null && valor.stock !== undefined) {
    await env.DB.prepare(
      'INSERT INTO stock_movement (product_id,delta,resulting_stock,user_id,reason,at) VALUES (?,?,?,?,?,?)'
    ).bind(valor.id, valor.stock, valor.stock, data.usuario.id, 'carga inicial', new Date().toISOString()).run();
  }
  await registrar(env.DB, data.usuario.id, 'producto_creado', 'product', valor.id, { name: valor.name });

  return ok({
    id: valor.id,
    mensaje: valor.status === 'published'
      ? 'Producto creado y publicado.'
      : 'Producto guardado como borrador. No lo ven los clientes hasta que lo publiques.',
  });
}
