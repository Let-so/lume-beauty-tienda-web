// Validación y guardado de productos.
//
// Toda la validación vive acá y se aplica en el servidor. La que hace el
// navegador es una comodidad para Camila, no una defensa: cualquiera puede
// saltearla mandando la petición a mano.
//
// Los mensajes de error están escritos para que los lea ella, no un
// programador: dicen qué campo está mal y qué hacer.

const ESTADOS = new Set(['published', 'draft', 'out_of_stock']);
const MAX_TEXTO = 5000;
const MAX_LISTA = 40;

export function hacerSlug(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // saca los acentos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function listaDeTextos(v, nombre, errores, maxLargo = MAX_TEXTO) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    errores.push(`El campo ${nombre} no tiene el formato esperado.`);
    return [];
  }
  if (v.length > MAX_LISTA) {
    errores.push(`${nombre}: no se pueden cargar más de ${MAX_LISTA} elementos.`);
    return [];
  }
  return v.map(x => String(x ?? '').trim()).filter(Boolean)
          .map(x => x.slice(0, maxLargo));
}

/** Convierte a entero de pesos. Devuelve undefined si el valor no sirve. */
function aPrecio(v, nombre, errores) {
  if (v === null || v === undefined || v === '') return null;   // "a confirmar"
  let n;
  if (typeof v === 'number') {
    n = v;
  } else {
    // En Argentina el punto separa los miles y la coma los decimales, al revés
    // que en inglés. Si no se tiene en cuenta, "$ 19.900" se lee como 19,9 y
    // se guarda un precio de 20 pesos en lugar de 19.900. Pasó de verdad en
    // una prueba, y es el peor error posible acá: cambiar un precio sin que
    // nadie se entere.
    //
    // Por eso se aceptan solo formas inequívocas y se rechaza todo lo demás,
    // en vez de adivinar. "19.9" no se interpreta: no se sabe si son 19 pesos
    // con 90 centavos o 19.900 mal escrito, así que se pide que lo aclaren.
    const limpio = String(v).replace(/[\s$ ]/g, '');
    if (/^-?\d+$/.test(limpio)) {
      n = Number(limpio);                                   // 19900
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(limpio)) {
      n = Number(limpio.replace(/\./g, ''));                // 19.900
    } else if (/^-?\d+,\d{1,2}$/.test(limpio)) {
      n = Number(limpio.replace(',', '.'));                 // 19900,50
    } else if (/^-?\d{1,3}(\.\d{3})+,\d{1,2}$/.test(limpio)) {
      n = Number(limpio.replace(/\./g, '').replace(',', '.'));  // 19.900,50
    } else {
      errores.push(`${nombre}: escribí solo el número, por ejemplo 19900. No se entendió «${String(v).slice(0, 30)}».`);
      return undefined;
    }
  }
  if (!Number.isFinite(n)) {
    errores.push(`${nombre}: escribí un número, por ejemplo 37100.`);
    return undefined;
  }
  if (n < 0) {
    errores.push(`${nombre}: no puede ser negativo.`);
    return undefined;
  }
  if (n > 1e12) {
    errores.push(`${nombre}: el valor es demasiado grande.`);
    return undefined;
  }
  return Math.round(n);
}

/**
 * Revisa los datos que llegan del panel y los deja listos para guardar.
 * @returns {{valor?: object, errores: string[]}}
 */
export function validarProducto(entrada, { esNuevo }) {
  const errores = [];
  const v = {};

  v.name = String(entrada.name ?? '').trim().slice(0, 300);
  if (!v.name) errores.push('El producto necesita un nombre.');

  v.id = String(entrada.id ?? '').trim() || hacerSlug(
    `${entrada.brand ?? ''} ${v.name}`);
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(v.id)) {
    errores.push('El identificador del producto solo puede llevar letras sin acento, números y guiones.');
  }

  v.brand_id = String(entrada.brand ?? '').trim() || null;
  v.title = String(entrada.title ?? '').trim().slice(0, 300);
  v.subtitle = String(entrada.subtitle ?? '').trim().slice(0, 300);
  v.size = String(entrada.size ?? '').trim().slice(0, 120);

  const precio = aPrecio(entrada.price, 'El precio', errores);
  if (precio !== undefined) v.price = precio;
  const anterior = aPrecio(entrada.compareAtPrice, 'El precio anterior', errores);
  if (anterior !== undefined) v.compare_at_price = anterior;

  if (v.price !== null && v.price !== undefined &&
      v.compare_at_price !== null && v.compare_at_price !== undefined &&
      v.compare_at_price <= v.price) {
    errores.push('El precio anterior tiene que ser mayor que el precio actual, si no no es una oferta.');
  }

  if (entrada.stock === null || entrada.stock === undefined || entrada.stock === '') {
    v.stock = null;                                   // no se lleva control
  } else {
    const n = Number(entrada.stock);
    if (!Number.isInteger(n) || n < 0) {
      errores.push('El stock tiene que ser un número entero de 0 o más.');
    } else {
      v.stock = n;
    }
  }

  v.status = String(entrada.status ?? 'draft');
  if (!ESTADOS.has(v.status)) {
    errores.push('El estado del producto no es válido.');
    v.status = 'draft';
  }
  // Coherencia: si el stock llegó a cero, el producto no puede quedar como
  // publicado y disponible. Se marca sin stock en lugar de mentirle al cliente.
  if (v.stock === 0 && v.status === 'published') v.status = 'out_of_stock';

  v.featured = entrada.featured ? 1 : 0;
  v.badge = String(entrada.tag ?? entrada.badge ?? '').trim().slice(0, 40) || null;
  v.warning = String(entrada.warning ?? '').trim().slice(0, 500) || null;
  v.image_padding = String(entrada.imagePadding ?? '6%').trim().slice(0, 24) || '6%';

  v.categories = Array.isArray(entrada.categories)
    ? [...new Set(entrada.categories.map(c => String(c).trim()).filter(Boolean))].slice(0, MAX_LISTA)
    : [];

  v.images = listaDeTextos(entrada.images, 'Las fotos', errores, 500);
  if (!v.images.length && entrada.image) v.images = [String(entrada.image).trim()];
  if (v.status === 'published' && !v.images.length) {
    errores.push('Para publicar un producto hace falta al menos una foto.');
  }

  v.description = listaDeTextos(entrada.description, 'La descripción', errores);
  v.howTo = listaDeTextos(entrada.howTo, 'El modo de uso', errores);

  if (entrada.specs === undefined || entrada.specs === null) {
    v.specs = [];
  } else if (!Array.isArray(entrada.specs)) {
    errores.push('Las especificaciones no tienen el formato esperado.');
    v.specs = [];
  } else {
    v.specs = entrada.specs
      .map(s => ({
        label: String((s && s.label) ?? '').trim().slice(0, 200),
        value: String((s && s.value) ?? '').trim().slice(0, MAX_TEXTO),
      }))
      .filter(s => s.label && s.value)
      .slice(0, MAX_LISTA);
  }

  v.tags = Array.isArray(entrada.tags)
    ? [...new Set(entrada.tags.map(t => String(t).trim().slice(0, 60)).filter(Boolean))].slice(0, MAX_LISTA)
    : [];

  if (esNuevo && v.price === undefined) v.price = null;

  return { valor: errores.length ? undefined : v, errores };
}

/** Comprueba que las categorías y la marca existan de verdad. */
export async function revisarReferencias(db, v) {
  const errores = [];
  if (v.brand_id) {
    const m = await db.prepare('SELECT 1 FROM brand WHERE id = ?').bind(v.brand_id).first();
    if (!m) errores.push('La marca elegida ya no existe. Actualizá la página y probá de nuevo.');
  }
  for (const c of v.categories) {
    const r = await db.prepare('SELECT 1 FROM category WHERE id = ?').bind(c).first();
    if (!r) errores.push(`La categoría «${c}» ya no existe. Actualizá la página y probá de nuevo.`);
  }
  return errores;
}

/**
 * Guarda el producto y todo lo que cuelga de él.
 *
 * Las tablas hijas se borran y se vuelven a escribir en lugar de ir
 * comparando qué cambió: con listas de pocos elementos es más simple, y más
 * simple significa menos lugares donde esconder un error.
 */
export async function guardarProducto(db, v, { esNuevo, orden }) {
  const ahora = new Date().toISOString();

  if (esNuevo) {
    await db.prepare(
      `INSERT INTO product (id,brand_id,name,title,subtitle,size,price,compare_at_price,
         stock,status,featured,badge,warning,image_padding,sort_order,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(v.id, v.brand_id, v.name, v.title, v.subtitle, v.size,
           v.price ?? null, v.compare_at_price ?? null, v.stock ?? null,
           v.status, v.featured, v.badge, v.warning, v.image_padding,
           orden, ahora, ahora).run();
  } else {
    await db.prepare(
      `UPDATE product SET brand_id=?,name=?,title=?,subtitle=?,size=?,price=?,
         compare_at_price=?,stock=?,status=?,featured=?,badge=?,warning=?,
         image_padding=?,updated_at=? WHERE id=?`
    ).bind(v.brand_id, v.name, v.title, v.subtitle, v.size,
           v.price ?? null, v.compare_at_price ?? null, v.stock ?? null,
           v.status, v.featured, v.badge, v.warning, v.image_padding,
           ahora, v.id).run();
  }

  for (const tabla of ['product_category', 'product_image', 'product_text', 'product_spec', 'product_tag']) {
    await db.prepare(`DELETE FROM ${tabla} WHERE product_id = ?`).bind(v.id).run();
  }

  let i = 0;
  for (const c of v.categories) {
    await db.prepare('INSERT INTO product_category (product_id,category_id,sort_order) VALUES (?,?,?)')
      .bind(v.id, c, i++).run();
  }

  i = 0;
  for (const url of v.images) {
    await db.prepare('INSERT INTO product_image (product_id,url,alt,sort_order,is_main) VALUES (?,?,?,?,?)')
      .bind(v.id, url, `${v.name}${v.size ? ', ' + v.size : ''}`, i, i === 0 ? 1 : 0).run();
    i++;
  }

  for (const [clase, lista] of [['description', v.description], ['how_to', v.howTo]]) {
    let j = 0;
    for (const parrafo of lista) {
      await db.prepare('INSERT INTO product_text (product_id,kind,body,sort_order) VALUES (?,?,?,?)')
        .bind(v.id, clase, parrafo, j++).run();
    }
  }

  i = 0;
  for (const s of v.specs) {
    await db.prepare('INSERT INTO product_spec (product_id,label,value,sort_order) VALUES (?,?,?,?)')
      .bind(v.id, s.label, s.value, i++).run();
  }

  for (const nombre of v.tags) {
    await db.prepare('INSERT OR IGNORE INTO tag (name) VALUES (?)').bind(nombre).run();
    const t = await db.prepare('SELECT id FROM tag WHERE name = ?').bind(nombre).first();
    if (t) {
      await db.prepare('INSERT OR IGNORE INTO product_tag (product_id,tag_id) VALUES (?,?)')
        .bind(v.id, t.id).run();
    }
  }
}

/** Deja constancia de todo cambio de precio, para poder reconstruir la historia. */
export async function anotarPrecio(db, productId, antes, despues, userId, motivo) {
  if (antes === despues) return;
  await db.prepare(
    `INSERT INTO price_history (product_id,old_price,new_price,user_id,reason,at)
     VALUES (?,?,?,?,?,?)`
  ).bind(productId, antes ?? null, despues ?? null, userId ?? null,
         motivo || null, new Date().toISOString()).run();
}
