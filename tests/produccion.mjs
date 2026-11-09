// Comprueba contra la tienda publicada, no contra la copia local.
//
// Hace falta una cuenta de prueba, porque esto entra de verdad al panel. Se
// crea, se usa y se borra:
//
//   LUME_PASSWORD='una frase larga' node scripts/crear-admin.mjs prueba@lume.test Prueba
//   npx wrangler d1 execute lume-beauty --remote -y --file=db/admin.sql && rm db/admin.sql
//   node tests/produccion.mjs prueba@lume.test 'una frase larga'
//   npx wrangler d1 execute lume-beauty --remote -y --command "DELETE FROM admin_user WHERE email='prueba@lume.test'"
//
// Nunca con la cuenta de Camila: esto apaga y prende la tienda, y le cerraría
// la sesión.

import { derivarEnCliente } from '../admin/clave.js';

const BASE = process.env.LUME_URL || 'https://lume-beauty.pages.dev';
const EMAIL = process.argv[2];
const CLAVE = process.argv[3];

if (!EMAIL || !CLAVE) {
  console.error('Falta la cuenta de prueba. Mirá el comentario de arriba.');
  process.exit(1);
}

let bien = 0;
const fallos = [];
const check = (nombre, ok) => {
  if (ok) { bien++; console.log('  OK    ' + nombre); }
  else { fallos.push(nombre); console.log('  FALLA ' + nombre); }
};

// ── sin sesion ──
const anon = await fetch(BASE + '/api/admin/productos');
check('sin sesion el panel no entrega nada', anon.status === 401);

const malaClave = await fetch(BASE + '/api/admin/sesion', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
  body: JSON.stringify({ email: EMAIL, password: await derivarEnCliente(EMAIL, 'no es la clave') }),
});
check('una contrasena equivocada no entra', malaClave.status === 401);

// ── entrar ──
const entrada = await fetch(BASE + '/api/admin/sesion', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE },
  body: JSON.stringify({ email: EMAIL, password: await derivarEnCliente(EMAIL, CLAVE) }),
});
check('la contrasena correcta entra', entrada.status === 200);

const galletas = entrada.headers.getSetCookie().map(c => c.split(';')[0]);
const csrf = (galletas.find(c => c.startsWith('lume_csrf=')) || '=').split('=')[1];
check('la cookie de sesion es HttpOnly y Secure',
  entrada.headers.getSetCookie().some(c => /lume_sesion=/.test(c) && /HttpOnly/i.test(c) && /Secure/i.test(c)));

const como = (ruta, opciones = {}) => fetch(BASE + ruta, {
  ...opciones,
  headers: {
    Cookie: galletas.join('; '),
    Origin: BASE,
    'X-CSRF-Token': csrf,
    ...(opciones.body ? { 'Content-Type': 'application/json' } : {}),
    ...(opciones.headers || {}),
  },
});

// ── el panel trabaja ──
const prods = await (await como('/api/admin/productos')).json();
check('el panel ve los 20 productos', (prods.productos || []).length === 20);
check('y el resumen cuenta bien', prods.resumen && prods.resumen.total === 20);

const cuenta = await (await como('/api/admin/cuenta')).json();
check('la pantalla Mi cuenta responde', cuenta.ok === true);
check('sabe que la cuenta tiene codigo de recuperacion', cuenta.tieneCodigo === true);

// ── CSRF ──
const sinTestigo = await fetch(BASE + '/api/admin/mantenimiento', {
  method: 'POST',
  headers: { Cookie: galletas.join('; '), Origin: BASE, 'Content-Type': 'application/json' },
  body: JSON.stringify({ active: true }),
});
check('sin el testigo CSRF no se puede cambiar nada', sinTestigo.status === 403);

const otroOrigen = await fetch(BASE + '/api/admin/mantenimiento', {
  method: 'POST',
  headers: {
    Cookie: galletas.join('; '), Origin: 'https://sitio-ajeno.test',
    'X-CSRF-Token': csrf, 'Content-Type': 'application/json',
  },
  body: JSON.stringify({ active: true }),
});
check('una peticion desde otro sitio se rechaza', otroOrigen.status === 403);

// ── mantenimiento de verdad ──
const encender = await como('/api/admin/mantenimiento', {
  method: 'POST', body: JSON.stringify({ active: true, title: 'Prueba', message: 'Prueba tecnica.' }),
});
check('se puede ocultar la tienda', encender.status === 200);

const publico = await fetch(BASE + '/api/catalog');
const cuerpo = await publico.text();
check('el visitante recibe 503', publico.status === 503);
check('y no ve ni un producto', !cuerpo.includes('"products"'));
check('ni un solo precio', !/\b(37100|32500|55000|46000|19900)\b/.test(cuerpo));
check('el buscador sabe que es temporal', publico.headers.get('Retry-After') === '3600');

const conSesion = await (await como('/api/catalog')).json();
check('con la sesion abierta se ve el catalogo completo', (conSesion.products || []).length === 20);
check('y avisa que es una vista previa', conSesion.maintenance && conSesion.maintenance.preview === true);

const apagar = await como('/api/admin/mantenimiento', {
  method: 'POST', body: JSON.stringify({ active: false }),
});
check('se puede volver a publicar', apagar.status === 200);

const devuelta = await (await fetch(BASE + '/api/catalog')).json();
check('la tienda vuelve con sus 20 productos', (devuelta.products || []).length === 20);

// ── fotos: tiene que avisar claro, no romperse ──
const foto = await como('/api/admin/fotos', { method: 'POST', body: JSON.stringify({}) });
const textoFoto = await foto.text();
check('subir fotos avisa con un mensaje claro en vez de fallar raro',
  foto.status === 503 && /dep[oó]sito|R2|foto/i.test(textoFoto));

// ── salir ──
const salir = await como('/api/admin/sesion', { method: 'DELETE' });
check('se puede cerrar la sesion', salir.status === 200);
const despues = await fetch(BASE + '/api/admin/productos', { headers: { Cookie: galletas.join('; ') } });
check('y la sesion cerrada ya no sirve', despues.status === 401);

console.log('\n' + bien + ' OK, ' + fallos.length + ' fallas');
if (fallos.length) { console.log('Fallaron:'); for (const f of fallos) console.log('  - ' + f); process.exit(1); }
