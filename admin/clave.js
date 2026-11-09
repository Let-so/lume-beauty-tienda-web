// Derivación de la contraseña, del lado de quien entra.
//
// POR QUÉ ESTÁ ACÁ Y NO EN EL SERVIDOR
//
// Lo normal sería estirar la contraseña en el servidor con muchas iteraciones.
// En Cloudflare no se puede: su runtime rechaza PBKDF2 con más de 100.000
// iteraciones, y el plan gratuito corta a los 10 ms de CPU por petición,
// mientras que 100.000 iteraciones cuestan unos 60 ms. O sea que la versión
// "de manual" fallaría en producción, aunque funcione en la computadora.
//
// La solución es hacer el trabajo pesado en el navegador, que no tiene ese
// límite, y que el servidor guarde un resumen barato de ese resultado.
//
// Queda igual de seguro: quien robe la base no encuentra la contraseña, sino
// el resumen de una clave de 256 bits. Para probar contraseñas tiene que
// repetir estas 600.000 iteraciones por cada intento, exactamente el mismo
// costo que tendría si el estirado fuera del lado del servidor.
//
// Lo que viaja por la red es el resultado, no la contraseña, y viaja por
// HTTPS igual que viajaría la contraseña.

export const ITERACIONES_CLIENTE = 600000;

const enc = new TextEncoder();

function aBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * La sal se calcula a partir del correo, no la entrega el servidor.
 *
 * Si hubiera que pedírsela al servidor, esa consulta revelaría qué correos
 * tienen cuenta. La sal no necesita ser secreta: su trabajo es que dos cuentas
 * con la misma contraseña no den el mismo resultado, y eso lo cumple igual.
 */
async function sal(email) {
  const base = 'lume-beauty:v1:' + String(email).trim().toLowerCase();
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(base)));
}

/** Convierte la contraseña en la clave que viaja al servidor. */
export async function derivarEnCliente(email, password) {
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: await sal(email), iterations: ITERACIONES_CLIENTE, hash: 'SHA-256' },
    material, 256);
  return aBase64(bits);
}
