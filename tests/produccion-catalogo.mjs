// El recorrido completo de Camila, contra la tienda publicada:
// subir una foto, crear un producto, publicarlo, verlo en la tienda, cambiarle
// el precio y borrarlo.
//
// OJO: esto escribe en la tienda de verdad. Crea un producto llamado
// «Producto de prueba de entrega» y lo borra al final. Si la prueba se corta
// por la mitad, hay que borrarlo a mano desde el panel.
//
//   node tests/produccion-catalogo.mjs camila@ejemplo.com 'la contrasena'
//
// Con LUME_URL se apunta a otra dirección, por ejemplo una vista previa.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { derivarEnCliente } from '../admin/clave.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.LUME_URL || 'https://lume-beauty.pages.dev';
const EMAIL = process.argv[2];
const CLAVE = process.argv[3];

if (!EMAIL || !CLAVE) {
  console.error('Falta la cuenta. Mirá el comentario de arriba.');
  process.exit(1);
}

let bien = 0;
const fallos = [];
const check = (n, ok) => {
  if (ok) { bien++; console.log('  OK    ' + n); }
  else { fallos.push(n); console.log('  FALLA ' + n); }
};

const entrada = await fetch(BASE + '/api/admin/sesion', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: BASE },
  body: JSON.stringify({ email: EMAIL, password: await derivarEnCliente(EMAIL, CLAVE) }),
});
if (entrada.status !== 200) {
  console.error('No pude entrar: ' + (await entrada.text()));
  process.exit(1);
}
const galletas = entrada.headers.getSetCookie().map(c => c.split(';')[0]);
const csrf = (galletas.find(c => c.startsWith('lume_csrf=')) || '=').split('=')[1];
const H = { Cookie: galletas.join('; '), Origin: BASE, 'X-CSRF-Token': csrf };
const pedir = (ruta, metodo, cuerpo) => fetch(BASE + ruta, {
  method: metodo,
  headers: { ...H, 'Content-Type': 'application/json' },
  body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
});
const traer = async id => (await (await fetch(BASE + '/api/admin/productos/' + id, { headers: H })).json()).producto;
const catalogo = () => fetch(BASE + '/api/catalog').then(r => r.json());

console.log('\n— Las fotos');

const bytes = fs.readFileSync(RAIZ + '/assets/productos/skin1004-spot-cover-patch.webp');
const form = new FormData();
form.append('foto', new Blob([bytes], { type: 'image/webp' }), 'prueba.webp');
const subida = await (await fetch(BASE + '/api/admin/fotos', { method: 'POST', headers: H, body: form })).json();
check('la foto se sube', subida.ok === true);
if (!subida.ok) { console.error(JSON.stringify(subida)); process.exit(1); }

const vista = await fetch(BASE + subida.url);
const vuelta = Buffer.from(await vista.arrayBuffer());
check('se puede ver', vista.status === 200);
check('vuelve igual, byte por byte', vuelta.length === bytes.length && vuelta.equals(bytes));
check('se entrega como webp', vista.headers.get('content-type') === 'image/webp');
check('se cachea para siempre', /immutable/.test(vista.headers.get('cache-control') || ''));
check('la segunda vez no se vuelve a descargar',
  (await fetch(BASE + subida.url, { headers: { 'If-None-Match': vista.headers.get('etag') } })).status === 304);

// Un SVG puede llevar JavaScript adentro: sería una puerta de entrada.
const formMalo = new FormData();
formMalo.append('foto', new Blob([Buffer.from('<svg onload=alert(1)></svg>')], { type: 'image/svg+xml' }), 'x.svg');
check('un archivo que no es imagen se rechaza',
  (await fetch(BASE + '/api/admin/fotos', { method: 'POST', headers: H, body: formMalo })).status >= 400);
check('sin sesion no se puede subir',
  (await fetch(BASE + '/api/admin/fotos', { method: 'POST', body: new FormData() })).status === 401);

console.log('\n— De la foto a la vidriera');

const ID = 'prueba-de-entrega-no-tocar';
const alta = await (await pedir('/api/admin/productos', 'POST', {
  id: ID,
  name: 'Producto de prueba de entrega',
  brand: 'skin1004',
  title: 'Producto de prueba',
  size: '1 unidad',
  price: '$ 12.345',
  status: 'draft',
  categories: ['skincare-coreano'],
  images: [subida.url],
  description: ['Esto es una prueba tecnica. Si aparece en la tienda, avisar.'],
})).json();
check('crea el producto como borrador', alta.ok === true);
if (!alta.ok) console.error('   -> ' + JSON.stringify(alta).slice(0, 300));

check('un borrador NO se ve en la tienda',
  !(await catalogo()).products.some(p => p.id === ID));

// El panel manda el producto entero al guardar. Un cuerpo a medias tiene que
// explicar qué falta, no romperse ni guardar a medias.
const aMedias = await (await pedir('/api/admin/productos/' + ID, 'PUT', { status: 'published' })).json();
check('un cuerpo incompleto se rechaza explicando que falta',
  aMedias.ok === false && typeof aMedias.error === 'string' && aMedias.error.length > 10);

const publicar = await (await pedir('/api/admin/productos/' + ID, 'PUT',
  { ...(await traer(ID)), status: 'published' })).json();
check('se publica', publicar.ok === true);

const enTienda = (await catalogo()).products.find(p => p.id === ID);
check('ahora SI se ve en la tienda', Boolean(enTienda));
// "12.345" en Argentina son doce mil trescientos cuarenta y cinco, no 12,345.
check('con el precio bien leido: 12345, no 12', enTienda && enTienda.price === 12345);
check('y con su foto', enTienda && /^\/fotos\/productos\//.test(enTienda.image || ''));
if (enTienda) {
  check('la foto se ve desde la tienda', (await fetch(BASE + enTienda.image)).status === 200);
}

await pedir('/api/admin/productos/' + ID, 'PUT', { ...(await traer(ID)), price: '$ 9.900' });
check('el precio nuevo llega a la tienda al instante',
  ((await catalogo()).products.find(p => p.id === ID) || {}).price === 9900);

const borrado = await (await pedir('/api/admin/productos/' + ID, 'DELETE')).json();
check('se borra', borrado.ok === true);
const final = await catalogo();
check('la tienda queda como estaba', !final.products.some(p => p.id === ID));

await fetch(BASE + '/api/admin/sesion', { method: 'DELETE', headers: H });

console.log('\n' + bien + ' OK, ' + fallos.length + ' fallas');
if (fallos.length) {
  console.log('\nFallaron:');
  for (const f of fallos) console.log('  - ' + f);
  process.exit(1);
}
