// Un D1 de mentira, con SQLite de verdad.
//
// Cloudflare D1 es SQLite con otra fachada. Node 22 trae SQLite incorporado,
// así que se puede probar toda la API contra una base real, en memoria, sin
// levantar nada ni depender de internet. Las pruebas corren en un segundo y
// dan el mismo resultado siempre.
//
// Esto NO reemplaza probar sobre Cloudflare: comprueba la lógica, no el
// entorno. Por eso además se verifica con wrangler antes de publicar.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
export const RAIZ = path.resolve(AQUI, '..');

class Sentencia {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }
  bind(...params) {
    const s = new Sentencia(this.db, this.sql);
    // SQLite de Node no acepta booleanos ni undefined.
    s.params = params.map(p => {
      if (typeof p === 'boolean') return p ? 1 : 0;
      if (p === undefined) return null;
      return p;
    });
    return s;
  }
  async first() {
    const r = this.db.prepare(this.sql).get(...this.params);
    return r === undefined ? null : r;
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.params), success: true };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: r.changes, last_row_id: r.lastInsertRowid } };
  }
}

export class D1Falso {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON');
  }
  prepare(sql) { return new Sentencia(this.db, sql); }
  exec(sql) { this.db.exec(sql); return { count: 0 }; }
  async batch(sentencias) {
    const out = [];
    for (const s of sentencias) out.push(await s.run());
    return out;
  }
}

/** Base nueva con el esquema aplicado y el catálogo real cargado. */
export function baseConCatalogo() {
  const d1 = new D1Falso();
  d1.exec(fs.readFileSync(path.join(RAIZ, 'db', 'schema.sql'), 'utf8'));

  const catalogo = JSON.parse(fs.readFileSync(path.join(RAIZ, 'data', 'catalog.json'), 'utf8'));
  const ahora = new Date().toISOString();
  const db = d1.db;

  catalogo.categories.forEach((c, i) =>
    db.prepare('INSERT INTO category (id,label,sort_order) VALUES (?,?,?)').run(c.id, c.label, i));
  catalogo.brands.forEach((b, i) =>
    db.prepare('INSERT INTO brand (id,name,bag,sort_order) VALUES (?,?,?,?)').run(b.id, b.name, b.bag || null, i));

  catalogo.products.forEach((p, i) => {
    db.prepare(`INSERT INTO product (id,brand_id,name,title,subtitle,size,price,
        compare_at_price,stock,status,featured,badge,warning,image_padding,
        sort_order,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,NULL,NULL,'published',?,?,?,?,?,?,?)`).run(
      p.id, p.brand, p.name, p.title || '', p.subtitle || '', p.size || '',
      p.price ?? null, p.featured ? 1 : 0, p.tag || null, p.warning || null,
      p.imagePadding || '6%', i, ahora, ahora);

    (p.categories || []).forEach((c, j) =>
      db.prepare('INSERT INTO product_category (product_id,category_id,sort_order) VALUES (?,?,?)').run(p.id, c, j));
    if (p.image) {
      db.prepare('INSERT INTO product_image (product_id,url,alt,sort_order,is_main) VALUES (?,?,?,0,1)')
        .run(p.id, p.image, `${p.brandLabel} ${p.name}, ${p.size}`);
    }
    (p.description || []).forEach((t, j) =>
      db.prepare("INSERT INTO product_text (product_id,kind,body,sort_order) VALUES (?,'description',?,?)").run(p.id, t, j));
    (p.howTo || []).forEach((t, j) =>
      db.prepare("INSERT INTO product_text (product_id,kind,body,sort_order) VALUES (?,'how_to',?,?)").run(p.id, t, j));
    (p.specs || []).forEach((s, j) =>
      db.prepare('INSERT INTO product_spec (product_id,label,value,sort_order) VALUES (?,?,?,?)').run(p.id, s.label, s.value, j));
  });

  const ajustes = ['currency', 'homeBanners', 'instagram', 'announcements', 'benefits',
                   'guarantee', 'help', 'reviews', 'instagramPosts', 'whatsapp',
                   'specsNote', 'siteUrl'];
  for (const k of ajustes) {
    if (k in catalogo) {
      db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)')
        .run(k, JSON.stringify(catalogo[k]), ahora);
    }
  }
  db.prepare('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)').run(
    'maintenance', JSON.stringify({ active: false, title: 'Estamos renovando la tienda', message: 'Volvemos pronto.' }), ahora);

  return { d1, catalogo };
}

/** Construye una petición como la que llegaría de verdad. */
export function peticion(url, { method = 'GET', body, cookies = {}, headers = {} } = {}) {
  const h = new Headers(headers);
  const galletas = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
  if (galletas) h.set('Cookie', galletas);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  return new Request(url, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Saca las cookies de una respuesta. */
export function cookiesDe(respuesta) {
  const out = {};
  for (const c of respuesta.headers.getSetCookie()) {
    const [par] = c.split(';');
    const i = par.indexOf('=');
    out[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  }
  return out;
}
