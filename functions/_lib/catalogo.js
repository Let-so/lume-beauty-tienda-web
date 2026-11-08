// Arma el catálogo desde la base con la forma exacta que hoy tiene
// data/catalog.json.
//
// Esta igualdad no es un capricho: es lo que permite que la vitrina y sus
// pruebas sigan funcionando sin tocar una línea durante toda la mudanza. Si
// algún día hay que cambiar la forma, se cambia acá y en la vitrina a la vez,
// nunca por separado.

const AJUSTES = ['currency', 'homeBanners', 'instagram', 'announcements', 'benefits',
                 'guarantee', 'help', 'reviews', 'instagramPosts', 'whatsapp',
                 'specsNote', 'siteUrl'];

export async function leerAjuste(db, clave, porDefecto = null) {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(clave).first();
  if (!r) return porDefecto;
  try {
    return JSON.parse(r.value);
  } catch {
    return porDefecto;
  }
}

export async function guardarAjuste(db, clave, valor) {
  await db.prepare(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(clave, JSON.stringify(valor), new Date().toISOString()).run();
}

export async function estadoMantenimiento(db) {
  const m = await leerAjuste(db, 'maintenance', null);
  return {
    active: Boolean(m && m.active),
    title: (m && m.title) || 'Estamos renovando la tienda',
    message: (m && m.message) ||
      'Volvemos en un rato con el catálogo actualizado. Mientras tanto podés escribirnos por WhatsApp.',
  };
}

/**
 * @param {boolean} incluirNoPublicados  true solo para el panel: en la tienda
 *   pública jamás se entregan borradores.
 */
export async function construirCatalogo(db, { incluirNoPublicados = false } = {}) {
  const ajustes = {};
  const filasAjustes = await db.prepare('SELECT key,value FROM settings').all();
  for (const f of filasAjustes.results || []) {
    try {
      ajustes[f.key] = JSON.parse(f.value);
    } catch {
      ajustes[f.key] = null;
    }
  }

  const [cats, marcas, prods, pcats, fotos, textos, specs] = await Promise.all([
    db.prepare('SELECT id,label FROM category ORDER BY sort_order').all(),
    db.prepare('SELECT id,name,bag FROM brand ORDER BY sort_order').all(),
    db.prepare(
      `SELECT p.id,p.brand_id,b.name AS brand_name,p.name,p.title,p.subtitle,p.size,
              p.price,p.compare_at_price,p.stock,p.status,p.featured,p.badge,p.warning,
              p.image_padding
         FROM product p LEFT JOIN brand b ON b.id = p.brand_id
        ${incluirNoPublicados ? '' : "WHERE p.status = 'published'"}
        ORDER BY p.sort_order`).all(),
    db.prepare('SELECT product_id,category_id FROM product_category ORDER BY sort_order').all(),
    db.prepare('SELECT product_id,url,alt,is_main FROM product_image ORDER BY is_main DESC, sort_order').all(),
    db.prepare('SELECT product_id,kind,body FROM product_text ORDER BY sort_order').all(),
    db.prepare('SELECT product_id,label,value FROM product_spec ORDER BY sort_order').all(),
  ]);

  const porProducto = (filas, fn) => {
    const m = new Map();
    for (const f of filas.results || []) {
      if (!m.has(f.product_id)) m.set(f.product_id, []);
      m.get(f.product_id).push(fn(f));
    }
    return m;
  };

  const mCats = porProducto(pcats, f => f.category_id);
  const mFotos = porProducto(fotos, f => f.url);
  const mSpecs = porProducto(specs, f => ({ label: f.label, value: f.value }));
  const mDesc = new Map();
  const mComo = new Map();
  for (const f of textos.results || []) {
    const destino = f.kind === 'how_to' ? mComo : mDesc;
    if (!destino.has(f.product_id)) destino.set(f.product_id, []);
    destino.get(f.product_id).push(f.body);
  }

  const products = (prods.results || []).map(r => {
    const p = {
      id: r.id,
      brand: r.brand_id,
      brandLabel: r.brand_name,
      name: r.name,
      title: r.title,
      subtitle: r.subtitle,
      size: r.size,
      categories: mCats.get(r.id) || [],
      image: (mFotos.get(r.id) || [])[0] || '',
      imagePadding: r.image_padding,
      price: r.price === null || r.price === undefined ? null : Number(r.price),
      featured: Boolean(r.featured),
    };
    if (r.badge) p.tag = r.badge;
    p.description = mDesc.get(r.id) || [];
    p.specs = mSpecs.get(r.id) || [];
    const como = mComo.get(r.id);
    if (como && como.length) p.howTo = como;
    if (r.warning) p.warning = r.warning;
    // Solo para el panel: la vitrina no necesita esto y no se le manda.
    if (incluirNoPublicados) {
      p.status = r.status;
      p.stock = r.stock;
      p.compareAtPrice = r.compare_at_price;
      p.images = mFotos.get(r.id) || [];
    }
    return p;
  });

  const d = {};
  d.currency = ajustes.currency ?? 'ARS';
  d.categories = (cats.results || []).map(c => ({ id: c.id, label: c.label }));
  d.homeBanners = ajustes.homeBanners ?? [];
  d.brands = (marcas.results || []).map(b => ({ id: b.id, name: b.name, bag: b.bag || '' }));
  d.products = products;
  for (const clave of AJUSTES) {
    if (clave in ajustes && !(clave in d)) d[clave] = ajustes[clave];
  }
  return d;
}
