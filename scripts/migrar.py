# -*- coding: utf-8 -*-
"""Pasa data/catalog.json a la base de datos y comprueba que no se pierda nada.

La comprobación es de ida y vuelta: carga el catálogo, lo reconstruye desde la
base y compara el resultado con el original. Si algo no vuelve igual, avisa y
corta. Es la única forma honesta de saber que la mudanza no rompió nada, porque
la vitrina va a seguir leyendo exactamente esta misma forma de JSON.

La comparación es por contenido, no byte a byte: una clave ausente y una clave
en null son lo mismo para la vitrina, así que se normalizan antes de comparar.

Uso:  python -I scripts/migrar.py
"""
import collections
import datetime
import io
import json
import os
import sqlite3
import sys

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOGO = os.path.join(RAIZ, 'data', 'catalog.json')
ESQUEMA = os.path.join(RAIZ, 'db', 'schema.sql')
BASE = os.path.join(RAIZ, 'db', 'lume.db')

OD = collections.OrderedDict
AHORA = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')

# Lo del catálogo que no son productos, marcas ni categorías. Va a la tabla
# settings tal cual, para poder devolverlo idéntico.
AJUSTES = ['currency', 'homeBanners', 'instagram', 'announcements', 'benefits',
           'guarantee', 'help', 'reviews', 'instagramPosts', 'whatsapp',
           'specsNote', 'siteUrl']


def cargar(cx, d):
    for i, c in enumerate(d['categories']):
        cx.execute('INSERT INTO category (id,label,sort_order) VALUES (?,?,?)',
                   (c['id'], c['label'], i))

    for i, b in enumerate(d['brands']):
        cx.execute('INSERT INTO brand (id,name,bag,sort_order) VALUES (?,?,?,?)',
                   (b['id'], b['name'], b.get('bag') or None, i))

    for i, p in enumerate(d['products']):
        cx.execute(
            '''INSERT INTO product (id,brand_id,name,title,subtitle,size,price,
                 compare_at_price,stock,status,featured,badge,warning,
                 image_padding,sort_order,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?,?)''',
            (p['id'], p['brand'], p['name'], p.get('title') or '',
             p.get('subtitle') or '', p.get('size') or '', p.get('price'),
             'published', 1 if p.get('featured') else 0, p.get('tag') or None,
             p.get('warning') or None,
             p.get('imagePadding') or '6%', i, AHORA, AHORA))

        for j, cid in enumerate(p.get('categories') or []):
            cx.execute('INSERT INTO product_category (product_id,category_id,sort_order)'
                       ' VALUES (?,?,?)', (p['id'], cid, j))

        # Hoy cada producto tiene una sola foto, y es la principal.
        if p.get('image'):
            alt = '%s %s, %s' % (p.get('brandLabel') or '', p['name'], p.get('size') or '')
            cx.execute('INSERT INTO product_image (product_id,url,alt,sort_order,is_main)'
                       ' VALUES (?,?,?,0,1)', (p['id'], p['image'], alt.strip().strip(',')))

        for clase, clave in (('description', 'description'), ('how_to', 'howTo')):
            for j, parrafo in enumerate(p.get(clave) or []):
                cx.execute('INSERT INTO product_text (product_id,kind,body,sort_order)'
                           ' VALUES (?,?,?,?)', (p['id'], clase, parrafo, j))

        for j, s in enumerate(p.get('specs') or []):
            cx.execute('INSERT INTO product_spec (product_id,label,value,sort_order)'
                       ' VALUES (?,?,?,?)', (p['id'], s['label'], s['value'], j))

    for clave in AJUSTES:
        if clave in d:
            cx.execute('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)',
                       (clave, json.dumps(d[clave], ensure_ascii=False), AHORA))

    # La tienda arranca publicada. Este es el interruptor que pide el encargo:
    # vive en la base, así que sobrevive a cualquier reinicio del servidor.
    cx.execute('INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)',
               ('maintenance', json.dumps(OD([
                   ('active', False),
                   ('title', 'Estamos renovando la tienda'),
                   ('message', 'Volvemos en un rato con el catálogo actualizado. '
                               'Mientras tanto podés escribirnos por WhatsApp.'),
               ]), ensure_ascii=False), AHORA))


def exportar(cx):
    """Reconstruye el catálogo con la forma exacta que espera la vitrina."""
    aj = {k: json.loads(v) for k, v in cx.execute('SELECT key,value FROM settings')}
    d = OD()
    d['currency'] = aj.get('currency')
    d['categories'] = [OD([('id', r[0]), ('label', r[1])]) for r in
                       cx.execute('SELECT id,label FROM category ORDER BY sort_order')]
    d['homeBanners'] = aj.get('homeBanners')
    d['brands'] = [OD([('id', r[0]), ('name', r[1]), ('bag', r[2] or '')]) for r in
                   cx.execute('SELECT id,name,bag FROM brand ORDER BY sort_order')]

    productos = []
    filas = cx.execute(
        '''SELECT p.id,p.brand_id,b.name,p.name,p.title,p.subtitle,p.size,p.price,
                  p.featured,p.badge,p.warning,p.image_padding
           FROM product p LEFT JOIN brand b ON b.id = p.brand_id
           WHERE p.status = 'published' ORDER BY p.sort_order''')
    for (pid, marca, marca_label, nombre, titulo, subtitulo, tam, precio,
         destacado, badge, aviso, padding) in filas.fetchall():
        p = OD()
        p['id'] = pid
        p['brand'] = marca
        p['brandLabel'] = marca_label
        p['name'] = nombre
        p['title'] = titulo
        p['subtitle'] = subtitulo
        p['size'] = tam
        p['categories'] = [r[0] for r in cx.execute(
            'SELECT category_id FROM product_category WHERE product_id=? ORDER BY sort_order', (pid,))]
        foto = cx.execute('SELECT url FROM product_image WHERE product_id=?'
                          ' ORDER BY is_main DESC, sort_order LIMIT 1', (pid,)).fetchone()
        p['image'] = foto[0] if foto else ''
        p['imagePadding'] = padding
        p['price'] = precio
        p['featured'] = bool(destacado)
        if badge:
            p['tag'] = badge
        p['description'] = [r[0] for r in cx.execute(
            "SELECT body FROM product_text WHERE product_id=? AND kind='description'"
            ' ORDER BY sort_order', (pid,))]
        p['specs'] = [OD([('label', r[0]), ('value', r[1])]) for r in cx.execute(
            'SELECT label,value FROM product_spec WHERE product_id=? ORDER BY sort_order', (pid,))]
        como = [r[0] for r in cx.execute(
            "SELECT body FROM product_text WHERE product_id=? AND kind='how_to'"
            ' ORDER BY sort_order', (pid,))]
        if como:
            p['howTo'] = como
        if aviso:
            p['warning'] = aviso
        productos.append(p)
    d['products'] = productos

    for clave in AJUSTES:
        if clave in aj and clave not in d:
            d[clave] = aj[clave]
    return d


def normalizar(x):
    """Quita las diferencias que a la vitrina le dan igual: una clave ausente
    y una en null son lo mismo, y una lista vacía equivale a no estar."""
    if isinstance(x, dict):
        return {k: normalizar(v) for k, v in x.items()
                if v is not None and v != [] or k == 'price'}
    if isinstance(x, list):
        return [normalizar(v) for v in x]
    return x


def diferencias(a, b, ruta=''):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a:
                yield '%s.%s sobra en la reconstruccion' % (ruta, k)
            elif k not in b:
                yield '%s.%s falta en la reconstruccion' % (ruta, k)
            else:
                yield from diferencias(a[k], b[k], '%s.%s' % (ruta, k))
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            yield '%s: %d elementos contra %d' % (ruta, len(a), len(b))
        for i, (x, y) in enumerate(zip(a, b)):
            yield from diferencias(x, y, '%s[%d]' % (ruta, i))
    elif a != b:
        yield '%s: %r contra %r' % (ruta, a, b)


def main():
    original = json.load(io.open(CATALOGO, encoding='utf-8'), object_pairs_hook=OD)

    if os.path.exists(BASE):
        os.remove(BASE)
    cx = sqlite3.connect(BASE)
    cx.executescript(io.open(ESQUEMA, encoding='utf-8').read())
    cargar(cx, original)
    cx.commit()

    rehecho = exportar(cx)
    fallos = list(diferencias(normalizar(original), normalizar(rehecho)))

    cuenta = lambda t: cx.execute('SELECT COUNT(*) FROM ' + t).fetchone()[0]
    print('cargado en %s' % os.path.relpath(BASE, RAIZ))
    for t in ('brand', 'category', 'product', 'product_category', 'product_image',
              'product_text', 'product_spec', 'settings'):
        print('  %-18s %3d' % (t, cuenta(t)))

    # Volcado en SQL, que es lo que consume wrangler para cargar la base de
    # Cloudflare. El esquema se aplica aparte desde db/schema.sql.
    semilla = os.path.join(RAIZ, 'db', 'seed.sql')
    omitir = ('CREATE TABLE', 'CREATE INDEX', 'BEGIN', 'COMMIT')
    with io.open(semilla, 'w', encoding='utf-8', newline=chr(10)) as f:
        f.write('-- Generado por scripts/migrar.py. No editar a mano.' + chr(10))
        for linea in cx.iterdump():
            if not linea.startswith(omitir):
                f.write(linea + chr(10))
    cx.close()
    print('  semilla            %s' % os.path.relpath(semilla, RAIZ))

    print()
    if fallos:
        print('LA IDA Y VUELTA NO DA IGUAL (%d diferencias):' % len(fallos))
        for f in fallos[:25]:
            print('  ' + f)
        sys.exit(1)
    print('ida y vuelta exacta: el catalogo reconstruido es identico al original')


if __name__ == '__main__':
    main()
