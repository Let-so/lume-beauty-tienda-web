// Pruebas del panel de administración.
//
// Corren contra los mismos módulos que usa Cloudflare, sobre una base SQLite
// real en memoria. No hay nada simulado salvo el entorno.
//
//   node tests/correr.mjs

import fs from 'node:fs';
import path from 'node:path';
import { baseConCatalogo, peticion, cookiesDe, RAIZ } from './d1.mjs';

import { onRequest as middleware } from '../functions/api/admin/_middleware.js';
import * as sesionEP from '../functions/api/admin/sesion.js';
import * as mantenimientoEP from '../functions/api/admin/mantenimiento.js';
import * as productosEP from '../functions/api/admin/productos.js';
import * as productoEP from '../functions/api/admin/productos/[id].js';
import * as catalogoEP from '../functions/api/catalog.js';
import * as cuentaEP from '../functions/api/admin/cuenta.js';
import * as recuperarEP from '../functions/api/admin/recuperar.js';
import { construirCatalogo } from '../functions/_lib/catalogo.js';
import { hashearPassword, revisarPassword, sha256, codigoDeRecuperacion } from '../functions/_lib/auth.js';
import { derivarEnCliente } from '../admin/clave.js';
import { validarProducto, hacerSlug } from '../functions/_lib/producto.js';

let bien = 0;
const fallos = [];
const seccionesVistas = new Set();

function seccion(t) {
  if (!seccionesVistas.has(t)) { console.log('\n— ' + t); seccionesVistas.add(t); }
}
function check(nombre, condicion) {
  if (condicion) { bien++; console.log('  OK    ' + nombre); }
  else { fallos.push(nombre); console.log('  FALLA ' + nombre); }
}

const BASE_URL = 'https://tienda.test';

/** Ejecuta el middleware y después el handler, igual que Cloudflare. */
async function llamarAdmin(modulo, ruta, env, opciones = {}) {
  const request = peticion(BASE_URL + ruta, opciones);
  const data = {};
  const metodo = (opciones.method || 'GET').toUpperCase();
  const handler = modulo['onRequest' + metodo[0] + metodo.slice(1).toLowerCase()];
  const params = opciones.params || {};
  return middleware({
    request, env, data, params,
    next: () => handler({ request, env, data, params }),
  });
}

/** Login completo; devuelve las cookies y una función para llamadas autenticadas. */
async function entrar(env, email, password) {
  const r = await llamarAdmin(sesionEP, '/api/admin/sesion', env, {
    method: 'POST', body: { email, password: await derivarEnCliente(email, password) },
    headers: { Origin: BASE_URL },
  });
  const cookies = cookiesDe(r);
  const como = (modulo, ruta, opciones = {}) => llamarAdmin(modulo, ruta, env, {
    ...opciones,
    cookies: { ...cookies, ...(opciones.cookies || {}) },
    headers: {
      Origin: BASE_URL,
      'X-CSRF-Token': cookies.lume_csrf || '',
      ...(opciones.headers || {}),
    },
  });
  return { respuesta: r, cookies, como };
}

const CLAVE = 'una frase larga y facil de recordar';

async function preparar() {
  const { d1, catalogo } = baseConCatalogo();
  const h = await hashearPassword(await derivarEnCliente('camila@lume.test', CLAVE));
  d1.db.prepare(
    `INSERT INTO admin_user (id,email,name,password_hash,password_salt,password_iterations,role,created_at)
     VALUES (1,'camila@lume.test','Camila',?,?,?,'admin',?)`
  ).run(h.hash, h.salt, h.iterations, new Date().toISOString());
  return { env: { DB: d1 }, d1, catalogo };
}

// ══════════════════════════════════════════════════════════════════════
console.log('PRUEBAS DEL PANEL — ' + new Date().toISOString().slice(0, 16).replace('T', ' '));

// ───────────────────── 1. el catálogo no se altera ─────────────────────
{
  seccion('1. El catálogo reconstruido es idéntico al original');
  const { env, catalogo } = await preparar();
  const rehecho = await construirCatalogo(env.DB);

  check('misma cantidad de productos', rehecho.products.length === catalogo.products.length);
  check('mismas marcas', JSON.stringify(rehecho.brands) === JSON.stringify(catalogo.brands));
  check('mismas categorías', JSON.stringify(rehecho.categories) === JSON.stringify(catalogo.categories));

  const normal = x => JSON.parse(JSON.stringify(x, (k, v) => (v === null && k !== 'price' ? undefined : v)));
  const distintos = catalogo.products.filter((p, i) =>
    JSON.stringify(normal(p)) !== JSON.stringify(normal(rehecho.products[i])));
  check('cada producto vuelve igual' + (distintos.length ? ' -> ' + distintos.map(p => p.id).join(', ') : ''),
    distintos.length === 0);

  const conAviso = rehecho.products.find(p => p.id === 'numbuzin-no9-nad-retinol-eye-cream');
  check('el aviso de embarazo del retinol sobrevive',
    conAviso && conAviso.warning === 'No usar durante el embarazo.');
  check('los precios siguen siendo enteros',
    rehecho.products.every(p => p.price === null || Number.isInteger(p.price)));
  check('ningún precio cambió',
    rehecho.products.every((p, i) => p.price === catalogo.products[i].price));
}

// ───────────────────────── 2. entrar y salir ─────────────────────────
{
  seccion('2. Inicio de sesión');
  const { env } = await preparar();

  const mal = await llamarAdmin(sesionEP, '/api/admin/sesion', env, {
    method: 'POST', body: { email: 'camila@lume.test', password: await derivarEnCliente('camila@lume.test', 'equivocada') },
    headers: { Origin: BASE_URL },
  });
  check('rechaza la contraseña incorrecta', mal.status === 401);

  const inexistente = await llamarAdmin(sesionEP, '/api/admin/sesion', env, {
    method: 'POST', body: { email: 'otra@lume.test', password: await derivarEnCliente('otra@lume.test', CLAVE) },
    headers: { Origin: BASE_URL },
  });
  const cuerpoMal = await mal.clone().json();
  const cuerpoInex = await inexistente.json();
  check('no revela si el correo existe o no', cuerpoMal.error === cuerpoInex.error);

  const { respuesta, cookies } = await entrar(env, 'camila@lume.test', CLAVE);
  check('acepta la contraseña correcta', respuesta.status === 200);
  check('entrega una cookie de sesión', Boolean(cookies.lume_sesion));
  check('entrega un testigo contra CSRF', Boolean(cookies.lume_csrf));

  const galletas = respuesta.headers.getSetCookie().join(' ');
  check('la cookie de sesión no se puede leer desde JavaScript', /lume_sesion=[^;]*;[^]*HttpOnly/.test(galletas));
  check('la cookie viaja solo por conexión segura', /lume_sesion=[^;]*;[^]*Secure/.test(galletas));
  check('la cookie no se manda desde otros sitios', /SameSite=Lax/.test(galletas));

  const hash = env.DB.db.prepare('SELECT token_hash FROM session').get();
  check('en la base se guarda el resumen del token, no el token',
    hash && hash.token_hash !== cookies.lume_sesion);

  const yo = await llamarAdmin(sesionEP, '/api/admin/sesion', env, { cookies });
  const datosYo = await yo.json();
  check('la sesión identifica a Camila', datosYo.autenticada === true && datosYo.usuario.name === 'Camila');

  const salida = await llamarAdmin(sesionEP, '/api/admin/sesion', env, {
    method: 'DELETE', cookies, headers: { Origin: BASE_URL, 'X-CSRF-Token': cookies.lume_csrf },
  });
  check('se puede cerrar la sesión', salida.status === 200);
  const trasSalir = await llamarAdmin(sesionEP, '/api/admin/sesion', env, { cookies });
  check('la sesión deja de valer al salir', (await trasSalir.json()).autenticada === false);
}

// ────────────────────── 3. freno a la fuerza bruta ──────────────────────
{
  seccion('3. Protección contra adivinar la contraseña');
  const { env } = await preparar();
  let ultima;
  for (let i = 0; i < 9; i++) {
    ultima = await llamarAdmin(sesionEP, '/api/admin/sesion', env, {
      method: 'POST', body: { email: 'camila@lume.test', password: await derivarEnCliente('camila@lume.test', 'probando' + i) },
      headers: { Origin: BASE_URL },
    });
  }
  check('frena después de varios intentos fallidos', ultima.status === 429);

  const conLaBuena = await llamarAdmin(sesionEP, '/api/admin/sesion', env, {
    method: 'POST', body: { email: 'camila@lume.test', password: await derivarEnCliente('camila@lume.test', CLAVE) },
    headers: { Origin: BASE_URL },
  });
  check('el freno vale incluso con la contraseña correcta', conLaBuena.status === 429);
}

// ─────────────────────────── 4. permisos ───────────────────────────
{
  seccion('4. Nadie entra al panel sin sesión');
  const { env } = await preparar();

  const rutas = [
    [productosEP, '/api/admin/productos', 'GET'],
    [productosEP, '/api/admin/productos', 'POST'],
    [mantenimientoEP, '/api/admin/mantenimiento', 'GET'],
    [mantenimientoEP, '/api/admin/mantenimiento', 'POST'],
    [productoEP, '/api/admin/productos/x', 'GET'],
    [productoEP, '/api/admin/productos/x', 'DELETE'],
  ];
  for (const [modulo, ruta, metodo] of rutas) {
    const r = await llamarAdmin(modulo, ruta, env, {
      method: metodo, body: metodo === 'POST' ? {} : undefined,
      headers: { Origin: BASE_URL }, params: { id: 'x' },
    });
    check(`${metodo} ${ruta} responde 401 sin sesión`, r.status === 401);
  }

  const inventada = await llamarAdmin(productosEP, '/api/admin/productos', env, {
    cookies: { lume_sesion: 'token-inventado-que-no-existe' },
  });
  check('una cookie inventada no sirve', inventada.status === 401);
}

// ───────────────────────────── 5. CSRF ─────────────────────────────
{
  seccion('5. Protección contra peticiones de otros sitios');
  const { env } = await preparar();
  const { cookies } = await entrar(env, 'camila@lume.test', CLAVE);

  const sinTestigo = await llamarAdmin(mantenimientoEP, '/api/admin/mantenimiento', env, {
    method: 'POST', body: { active: true }, cookies, headers: { Origin: BASE_URL },
  });
  check('rechaza modificar sin el testigo CSRF', sinTestigo.status === 403);

  const testigoMal = await llamarAdmin(mantenimientoEP, '/api/admin/mantenimiento', env, {
    method: 'POST', body: { active: true }, cookies,
    headers: { Origin: BASE_URL, 'X-CSRF-Token': 'otro-valor' },
  });
  check('rechaza un testigo CSRF que no coincide', testigoMal.status === 403);

  const otroSitio = await llamarAdmin(mantenimientoEP, '/api/admin/mantenimiento', env, {
    method: 'POST', body: { active: true }, cookies,
    headers: { Origin: 'https://sitio-malicioso.test', 'X-CSRF-Token': cookies.lume_csrf },
  });
  check('rechaza peticiones que vienen de otro dominio', otroSitio.status === 403);
}

// ──────────────────────── 6. modo mantenimiento ────────────────────────
{
  seccion('6. Modo mantenimiento');
  const { env } = await preparar();
  const { cookies, como } = await entrar(env, 'camila@lume.test', CLAVE);

  const antes = await catalogoEP.onRequestGet({ request: peticion(BASE_URL + '/api/catalog'), env });
  check('con la tienda abierta el catálogo se entrega', antes.status === 200);

  const encender = await como(mantenimientoEP, '/api/admin/mantenimiento', {
    method: 'POST', body: { active: true, title: 'Volvemos pronto', message: 'Estamos actualizando precios.' },
  });
  check('Camila puede poner la tienda en mantenimiento', encender.status === 200);

  const publico = await catalogoEP.onRequestGet({ request: peticion(BASE_URL + '/api/catalog'), env });
  const cuerpoPublico = await publico.json();
  check('el visitante recibe 503, no el catálogo', publico.status === 503);
  check('la respuesta pública no trae productos', cuerpoPublico.products === undefined);
  check('la respuesta pública no trae ni un precio',
    !JSON.stringify(cuerpoPublico).match(/\b(37100|32500|55000|46000)\b/));
  check('el visitante ve el mensaje que escribió Camila',
    cuerpoPublico.maintenance.title === 'Volvemos pronto');
  check('se le pide al buscador que no desindexe', publico.headers.get('Retry-After') === '3600');
  // El mensaje invita a escribir por WhatsApp: si el enlace no viaja, la
  // pantalla de mantenimiento deja al cliente sin forma de contactar.
  check('el contacto de WhatsApp sí viaja, para que el mensaje no sea un callejón sin salida',
    typeof (cuerpoPublico.maintenance.whatsapp || {}).url === 'string'
    && cuerpoPublico.maintenance.whatsapp.url.includes('wa.me'));

  const comoCamila = await catalogoEP.onRequestGet({
    request: peticion(BASE_URL + '/api/catalog', { cookies }), env,
  });
  const cuerpoCamila = await comoCamila.json();
  check('Camila sí ve el catálogo durante el mantenimiento', comoCamila.status === 200);
  check('y se le avisa que es una vista previa', cuerpoCamila.maintenance.preview === true);

  const sigueTrabajando = await como(productosEP, '/api/admin/productos');
  check('el panel sigue funcionando en mantenimiento', sigueTrabajando.status === 200);

  const n = env.DB.db.prepare('SELECT COUNT(*) AS n FROM product').get().n;
  check('no se perdió ningún producto al apagar la tienda', n === 20);

  const apagar = await como(mantenimientoEP, '/api/admin/mantenimiento', {
    method: 'POST', body: { active: false },
  });
  check('se puede volver a publicar', apagar.status === 200);
  const despues = await catalogoEP.onRequestGet({ request: peticion(BASE_URL + '/api/catalog'), env });
  check('el catálogo vuelve completo', despues.status === 200 && (await despues.json()).products.length === 20);

  const guardado = env.DB.db.prepare("SELECT value FROM settings WHERE key='maintenance'").get();
  check('el estado queda guardado en la base, no en memoria', JSON.parse(guardado.value).active === false);
}

// ───────────────────────── 7. alta de productos ─────────────────────────
{
  seccion('7. Cargar productos');
  const { env } = await preparar();
  const { como } = await entrar(env, 'camila@lume.test', CLAVE);

  const nuevo = {
    name: 'Crema de prueba', brand: 'medicube', size: '50 ml', price: 25000,
    categories: ['skincare-coreano'], images: ['assets/productos/prueba.webp'],
    description: ['Una crema.'], status: 'published',
  };
  const alta = await como(productosEP, '/api/admin/productos', { method: 'POST', body: nuevo });
  const cuerpoAlta = await alta.json();
  check('se crea un producto nuevo', alta.status === 200 && cuerpoAlta.ok);
  check('se le arma un identificador legible', cuerpoAlta.id === 'medicube-crema-de-prueba');

  const repetido = await como(productosEP, '/api/admin/productos', { method: 'POST', body: nuevo });
  check('no deja crear dos con el mismo identificador', repetido.status === 409);

  const sinNombre = await como(productosEP, '/api/admin/productos', {
    method: 'POST', body: { ...nuevo, name: '' },
  });
  check('exige el nombre', sinNombre.status === 422);

  const sinFoto = await como(productosEP, '/api/admin/productos', {
    method: 'POST', body: { ...nuevo, name: 'Sin foto', images: [], status: 'published' },
  });
  const cuerpoSinFoto = await sinFoto.json();
  check('no deja publicar sin foto', sinFoto.status === 422);
  check('y lo explica en castellano claro', /al menos una foto/.test(cuerpoSinFoto.error));

  const borrador = await como(productosEP, '/api/admin/productos', {
    method: 'POST', body: { ...nuevo, name: 'Borrador sin foto', images: [], status: 'draft' },
  });
  check('pero sí deja guardarlo como borrador', borrador.status === 200);

  const marcaFalsa = await como(productosEP, '/api/admin/productos', {
    method: 'POST', body: { ...nuevo, name: 'Marca inventada', brand: 'no-existe' },
  });
  check('rechaza una marca que no existe', marcaFalsa.status === 422);

  const precioTexto = await como(productosEP, '/api/admin/productos', {
    method: 'POST', body: { ...nuevo, name: 'Precio raro', price: 'carísimo' },
  });
  check('rechaza un precio que no es un número', precioTexto.status === 422);

  const sinPrecio = await como(productosEP, '/api/admin/productos', {
    method: 'POST', body: { ...nuevo, name: 'A confirmar', price: null },
  });
  check('acepta un producto con el precio a confirmar', sinPrecio.status === 200);
  const guardadoSinPrecio = env.DB.db.prepare("SELECT price FROM product WHERE id='medicube-a-confirmar'").get();
  check('y lo guarda como sin precio, no como cero', guardadoSinPrecio.price === null);
}

// ──────────────── 8. editar, borrar y el borrador oculto ────────────────
{
  seccion('8. Editar y borrar');
  const { env } = await preparar();
  const { como } = await entrar(env, 'camila@lume.test', CLAVE);
  const id = 'medicube-deep-vita-c';

  const ficha = await como(productoEP, `/api/admin/productos/${id}`, { params: { id } });
  const p = (await ficha.json()).producto;
  check('se puede abrir un producto existente', ficha.status === 200 && p.id === id);
  check('trae su precio actual', p.price === 55000);

  const edicion = await como(productoEP, `/api/admin/productos/${id}`, {
    method: 'PUT', params: { id },
    body: { ...p, price: 60000, status: 'published' },
  });
  check('se guarda un cambio de precio', edicion.status === 200);
  const trasEditar = env.DB.db.prepare('SELECT price FROM product WHERE id=?').get(id);
  check('el precio nuevo quedó guardado', trasEditar.price === 60000);

  const historial = env.DB.db.prepare('SELECT old_price,new_price FROM price_history WHERE product_id=?').all(id);
  check('queda registrado el precio anterior',
    historial.some(h => h.old_price === 55000 && h.new_price === 60000));

  const aBorrador = await como(productoEP, `/api/admin/productos/${id}`, {
    method: 'PUT', params: { id }, body: { ...p, status: 'draft' },
  });
  check('se puede pasar a borrador', aBorrador.status === 200);
  const publico = await construirCatalogo(env.DB);
  check('un borrador desaparece de la tienda pública',
    !publico.products.some(x => x.id === id));
  check('pero sigue existiendo en la base',
    env.DB.db.prepare('SELECT 1 FROM product WHERE id=?').get(id) !== undefined);

  const borrado = await como(productoEP, `/api/admin/productos/${id}`, {
    method: 'DELETE', params: { id },
  });
  check('se puede borrar', borrado.status === 200);
  check('ya no está', env.DB.db.prepare('SELECT 1 FROM product WHERE id=?').get(id) === undefined);
  const copia = env.DB.db.prepare("SELECT detail FROM audit_log WHERE action='producto_borrado'").get();
  check('antes de borrar se guarda una copia completa por si fue un error',
    copia && JSON.parse(copia.detail).id === id && JSON.parse(copia.detail).images.length > 0);
  check('se limpian sus fotos y textos',
    env.DB.db.prepare('SELECT COUNT(*) AS n FROM product_image WHERE product_id=?').get(id).n === 0);
}

// ───────────────────── 9. stock y coherencia ─────────────────────
{
  seccion('9. Stock');
  const { env } = await preparar();
  const { como } = await entrar(env, 'camila@lume.test', CLAVE);
  const id = 'numbuzin-no9-nad-retinol-eye-cream';
  const p = (await (await como(productoEP, `/api/admin/productos/${id}`, { params: { id } })).json()).producto;

  await como(productoEP, `/api/admin/productos/${id}`, {
    method: 'PUT', params: { id }, body: { ...p, stock: 5, status: 'published' },
  });
  check('se puede cargar stock', env.DB.db.prepare('SELECT stock FROM product WHERE id=?').get(id).stock === 5);
  check('queda registrado el movimiento',
    env.DB.db.prepare('SELECT COUNT(*) AS n FROM stock_movement WHERE product_id=?').get(id).n >= 1);

  await como(productoEP, `/api/admin/productos/${id}`, {
    method: 'PUT', params: { id }, body: { ...p, stock: 0, status: 'published' },
  });
  const sinStock = env.DB.db.prepare('SELECT status FROM product WHERE id=?').get(id);
  check('con stock en cero el producto deja de figurar como disponible',
    sinStock.status === 'out_of_stock');
  const publico = await construirCatalogo(env.DB);
  check('y desaparece de la tienda pública', !publico.products.some(x => x.id === id));

  const negativo = await como(productoEP, `/api/admin/productos/${id}`, {
    method: 'PUT', params: { id }, body: { ...p, stock: -3 },
  });
  check('rechaza un stock negativo', negativo.status === 422);

  const lista = await (await como(productosEP, '/api/admin/productos?estado=out_of_stock')).json();
  check('se pueden filtrar los productos sin stock',
    lista.productos.length === 1 && lista.productos[0].id === id);
}

// ──────────────────── 10. validación de datos sueltos ────────────────────
{
  seccion('10. Validación');
  check('el identificador se arma sin acentos ni símbolos',
    hacerSlug('Crema Hidratante Ñandú 50% +') === 'crema-hidratante-nandu-50');
  check('una contraseña corta se rechaza', revisarPassword('corta') !== null);
  check('una frase larga se acepta', revisarPassword('mi perro se llama rodolfo') === null);

  const conOferta = validarProducto({
    name: 'X', brand: 'medicube', price: 10000, compareAtPrice: 8000,
    images: ['a.webp'], status: 'published',
  }, { esNuevo: true });
  check('rechaza una oferta donde el precio anterior es menor',
    conOferta.errores.some(e => /precio anterior/.test(e)));

  const ofertaBien = validarProducto({
    name: 'X', brand: 'medicube', price: 8000, compareAtPrice: 10000,
    images: ['a.webp'], status: 'published',
  }, { esNuevo: true });
  check('acepta una oferta bien armada', ofertaBien.errores.length === 0);

  // Los puntos de los miles son la trampa: en Argentina "19.900" son
  // diecinueve mil novecientos, no diecinueve con nueve.
  const precio = x => {
    const r = validarProducto({ name: 'P', brand: 'medicube', price: x,
                                images: ['a.webp'], status: 'draft' }, { esNuevo: true });
    return r.valor ? r.valor.price : 'ERROR';
  };
  check('un numero pelado se guarda igual', precio('19900') === 19900);
  check('"$ 19.900" son 19900 pesos, no 20', precio('$ 19.900') === 19900);
  check('"1.234.567" se lee completo', precio('1.234.567') === 1234567);
  check('la coma son los centavos', precio('19900,50') === 19901);
  check('punto de miles y coma de centavos juntos', precio('19.900,50') === 19901);
  check('un precio que no se entiende se rechaza en vez de adivinarse', precio('19.9') === 'ERROR');
  check('un texto cualquiera se rechaza', precio('carisimo') === 'ERROR');
  check('vacio sigue significando a confirmar', precio('') === null);

  const textoLargo = validarProducto({
    name: 'Y'.repeat(500), brand: 'medicube', images: ['a.webp'], status: 'draft',
  }, { esNuevo: true });
  check('recorta un nombre desmedido en lugar de romperse',
    textoLargo.valor && textoLargo.valor.name.length === 300);

  const inyeccion = validarProducto({
    name: "Robar'; DROP TABLE product; --", brand: 'medicube',
    images: ['a.webp'], status: 'draft',
  }, { esNuevo: true });
  check('un intento de inyección SQL queda como texto común',
    inyeccion.valor && inyeccion.valor.name.includes('DROP TABLE'));
}

// ───────────────── 11. la inyección no funciona de verdad ─────────────────
{
  seccion('11. Inyección SQL');
  const { env } = await preparar();
  const { como } = await entrar(env, 'camila@lume.test', CLAVE);

  await como(productosEP, '/api/admin/productos', {
    method: 'POST',
    body: {
      name: "Peligro'; DROP TABLE product; --", brand: 'medicube',
      images: ['a.webp'], status: 'draft', price: 100,
    },
  });
  check('la tabla de productos sigue existiendo después del intento',
    env.DB.db.prepare('SELECT COUNT(*) AS n FROM product').get().n === 21);

  const busqueda = await como(productosEP, "/api/admin/productos?q=%27%20OR%201%3D1%20--");
  check('una búsqueda con comillas no rompe la consulta', busqueda.status === 200);
}

// ───────────────────── 12. registro de actividad ─────────────────────
{
  seccion('12. Registro de actividad');
  const { env } = await preparar();
  const { como } = await entrar(env, 'camila@lume.test', CLAVE);
  await como(mantenimientoEP, '/api/admin/mantenimiento', { method: 'POST', body: { active: true } });
  await como(mantenimientoEP, '/api/admin/mantenimiento', { method: 'POST', body: { active: false } });

  const acciones = env.DB.db.prepare('SELECT action FROM audit_log ORDER BY id').all().map(a => a.action);
  check('queda registrado el ingreso', acciones.includes('login'));
  check('queda registrado el apagado de la tienda', acciones.includes('tienda_en_mantenimiento'));
  check('queda registrado el encendido', acciones.includes('tienda_publicada'));
}

// ────────── 13. el login entra en los límites del plan gratuito ──────────
{
  seccion('13. El login entra en los límites de Cloudflare');
  const { ITERACIONES, hashearPassword } = await import('../functions/_lib/auth.js');
  const { ITERACIONES_CLIENTE, derivarEnCliente } = await import('../admin/clave.js');

  // Cloudflare rechaza PBKDF2 con más de 100.000 iteraciones, y el plan
  // gratuito corta a los 10 ms de CPU por petición. Si alguien sube este
  // número "por seguridad", el login deja de funcionar en producción aunque
  // ande perfecto en la computadora. Pasó: por eso existe esta prueba.
  check('el servidor no pasa el tope de iteraciones de Cloudflare', ITERACIONES <= 100000);

  const t = Date.now();
  await hashearPassword('clave-derivada-de-prueba');
  const ms = Date.now() - t;
  check(`el servidor resuelve el hash en ${ms} ms, dentro de los 10 ms de CPU`, ms < 10);

  check('el navegador sí estira fuerte la contraseña', ITERACIONES_CLIENTE >= 600000);

  const a1 = await derivarEnCliente('una@lume.test', 'la misma contrasena');
  const a2 = await derivarEnCliente('otra@lume.test', 'la misma contrasena');
  check('dos cuentas con la misma contraseña derivan distinto', a1 !== a2);
  check('la misma cuenta siempre deriva igual',
    a1 === await derivarEnCliente('una@lume.test', 'la misma contrasena'));
  check('lo que viaja por la red no es la contraseña',
    !a1.includes('contrasena') && a1.length === 44);
}

// ───────── 14. Camila administra su propia cuenta ─────────
{
  seccion('14. Camila administra su propia cuenta');
  const { env, d1 } = await preparar();
  const { como } = await entrar(env, 'camila@lume.test', CLAVE);
  const derivada = c => derivarEnCliente('camila@lume.test', c);

  const sinCodigo = await (await como(cuentaEP, '/api/admin/cuenta')).json();
  check('al principio no hay código de recuperación', sinCodigo.tieneCodigo === false);

  const mal = await como(cuentaEP, '/api/admin/cuenta', {
    method: 'POST', body: { accion: 'nuevo-codigo', actual: await derivada('no es mi contrasena') },
  });
  check('sin la contraseña actual no se puede pedir un código', mal.status === 401);

  const pedido = await (await como(cuentaEP, '/api/admin/cuenta', {
    method: 'POST', body: { accion: 'nuevo-codigo', actual: await derivada(CLAVE) },
  })).json();
  check('con la contraseña sí', pedido.ok === true);
  check('el código son cuatro grupos de cuatro',
    /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(pedido.codigo || ''));
  // Si el código se copia a mano, un 0 y una O son el mismo garabato.
  check('el código no trae caracteres que se confunden al copiarlo',
    !/[ILOU01]/.test(pedido.codigo));

  const guardado = d1.db.prepare('SELECT recovery_hash FROM admin_user WHERE id = 1').get();
  check('en la base queda el resumen, no el código',
    guardado.recovery_hash !== pedido.codigo && guardado.recovery_hash === await sha256(pedido.codigo));

  const ahoraSi = await (await como(cuentaEP, '/api/admin/cuenta')).json();
  check('el panel sabe que ya hay un código sin usar', ahoraSi.tieneCodigo === true);

  const NUEVA = 'otra frase igual de larga';
  const cambioMal = await como(cuentaEP, '/api/admin/cuenta', {
    method: 'POST',
    body: { accion: 'cambiar-clave', actual: await derivada('cualquier cosa'), nueva: await derivada(NUEVA) },
  });
  check('no se cambia la contraseña sin saber la de ahora', cambioMal.status === 401);

  const cambio = await como(cuentaEP, '/api/admin/cuenta', {
    method: 'POST',
    body: { accion: 'cambiar-clave', actual: await derivada(CLAVE), nueva: await derivada(NUEVA) },
  });
  check('con la de ahora sí se cambia', cambio.status === 200);

  const vieja = await entrar(env, 'camila@lume.test', CLAVE);
  check('la contraseña vieja deja de servir', vieja.respuesta.status === 401);
  const nuevaSesion = await entrar(env, 'camila@lume.test', NUEVA);
  check('la nueva sirve', nuevaSesion.respuesta.status === 200);
}

// ───────── 15. Recuperar el acceso sin ayuda de nadie ─────────
{
  seccion('15. Recuperar el acceso sin ayuda de nadie');
  const { env, d1 } = await preparar();
  const codigo = codigoDeRecuperacion();
  d1.db.prepare('UPDATE admin_user SET recovery_hash = ? WHERE id = 1').run(await sha256(codigo));

  const NUEVA = 'la frase que me voy a acordar';
  const pedir = cuerpo => llamarAdmin(recuperarEP, '/api/admin/recuperar', env, {
    method: 'POST', body: cuerpo, headers: { Origin: BASE_URL },
  });

  const codigoMal = await pedir({
    email: 'camila@lume.test', codigo: 'AAAA-BBBB-CCCC-DDDD',
    password: await derivarEnCliente('camila@lume.test', NUEVA),
  });
  check('un código inventado no sirve', codigoMal.status === 401);

  const r = await pedir({
    email: 'camila@lume.test', codigo,
    password: await derivarEnCliente('camila@lume.test', NUEVA),
  });
  const cuerpo = await r.json();
  check('con el código correcto se cambia la contraseña', r.status === 200);
  check('y queda la sesión abierta, sin tener que entrar de nuevo',
    cookiesDe(r).lume_sesion !== undefined);

  // Si recuperar gastara el único código, la próxima vez que olvide la
  // contraseña quedaría encerrada afuera y necesitaría a un técnico.
  check('se entrega un código nuevo en el acto',
    /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/.test(cuerpo.codigoNuevo || ''));
  check('y es distinto del que acaba de usar', cuerpo.codigoNuevo !== codigo);

  const reintento = await pedir({
    email: 'camila@lume.test', codigo,
    password: await derivarEnCliente('camila@lume.test', 'una tercera frase larga'),
  });
  check('el código usado ya no sirve una segunda vez', reintento.status === 401);

  const conElNuevo = await pedir({
    email: 'camila@lume.test', codigo: cuerpo.codigoNuevo,
    password: await derivarEnCliente('camila@lume.test', 'una cuarta frase bien larga'),
  });
  check('el código nuevo sí sirve', conElNuevo.status === 200);

  const entra = await entrar(env, 'camila@lume.test', 'una cuarta frase bien larga');
  check('y se puede entrar con esa contraseña', entra.respuesta.status === 200);
}

// ══════════════════════════════════════════════════════════════════════
console.log(`\n${bien} OK, ${fallos.length} fallas`);
if (fallos.length) {
  console.log('\nFallaron:');
  for (const f of fallos) console.log('  - ' + f);
  process.exit(1);
}
