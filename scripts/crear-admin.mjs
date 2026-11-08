// Crea la cuenta de Camila, o le cambia la contraseña.
//
// No escribe en ninguna base: genera el SQL y lo deja en un archivo, que
// después se aplica con wrangler. Así el mismo comando sirve para la copia
// local y para la tienda publicada, y queda a la vista qué se va a ejecutar
// antes de ejecutarlo.
//
//   node scripts/crear-admin.mjs camila@ejemplo.com "Camila"
//
// La contraseña se pide por teclado y no queda en el historial de comandos.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { hashearPassword, revisarPassword, sha256, tokenAleatorio } from '../functions/_lib/auth.js';
import { derivarEnCliente } from '../admin/clave.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function preguntar(texto, oculto = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise(resolver => {
    if (!oculto) return rl.question(texto, r => { rl.close(); resolver(r); });
    // Con la contraseña no se muestra nada mientras se escribe.
    const alEscribir = rl._writeToOutput.bind(rl);
    rl._writeToOutput = s => alEscribir(s.includes(texto) ? s : '');
    rl.question(texto, r => { rl.close(); process.stdout.write('\n'); resolver(r); });
  });
}

const email = (process.argv[2] || '').trim().toLowerCase();
const nombre = (process.argv[3] || 'Camila').trim();

if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Falta el correo.\n\n  node scripts/crear-admin.mjs camila@ejemplo.com "Camila"\n');
  process.exit(1);
}

// En una prueba automática no hay teclado. LUME_PASSWORD existe solo para eso.
// Para una cuenta real conviene escribirla, así no queda en el entorno ni en
// el historial de comandos.
const desdeEntorno = process.env.LUME_PASSWORD;
const clave = desdeEntorno
  || await preguntar('Contraseña nueva (no se va a ver mientras escribís): ', true);

const problema = revisarPassword(clave);
if (problema) { console.error('\n' + problema + '\n'); process.exit(1); }

if (!desdeEntorno) {
  const repetida = await preguntar('Escribila otra vez: ', true);
  if (clave !== repetida) { console.error('\nLas dos contraseñas no coinciden.\n'); process.exit(1); }
}

// Se deriva igual que lo haría el navegador, si no la contraseña no coincidiría.
const h = await hashearPassword(await derivarEnCliente(email, clave));

// Código de recuperación: cuatro grupos de cuatro, fácil de copiar a mano.
const crudo = tokenAleatorio(16).replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 16);
const codigo = crudo.match(/.{1,4}/g).join('-');
const codigoHash = await sha256(codigo);

const ahora = new Date().toISOString();
const q = s => "'" + String(s).replace(/'/g, "''") + "'";

const sql = `-- Cuenta de administración de ${email}
-- Generado el ${ahora}
-- Este archivo contiene el resumen de una contraseña real: borralo cuando lo apliques.
INSERT INTO admin_user (email,name,password_hash,password_salt,password_iterations,recovery_hash,role,created_at)
VALUES (${q(email)},${q(nombre)},${q(h.hash)},${q(h.salt)},${h.iterations},${q(codigoHash)},'admin',${q(ahora)})
ON CONFLICT(email) DO UPDATE SET
  name = excluded.name,
  password_hash = excluded.password_hash,
  password_salt = excluded.password_salt,
  password_iterations = excluded.password_iterations,
  recovery_hash = excluded.recovery_hash,
  recovery_used_at = NULL;

-- Cambiar la contraseña cierra todas las sesiones abiertas.
DELETE FROM session WHERE user_id IN (SELECT id FROM admin_user WHERE email = ${q(email)});
`;

const destino = path.join(RAIZ, 'db', 'admin.sql');
fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.writeFileSync(destino, sql, 'utf8');

console.log(`
  Cuenta preparada para ${email}

  CÓDIGO DE RECUPERACIÓN:   ${codigo}

  Anotalo y guardalo en un lugar seguro. Es lo único que le permite a Camila
  recuperar su contraseña sin ayuda, y no se puede volver a ver: en la base
  solo queda su resumen.

  Ahora aplicá el archivo db/admin.sql:

    En tu computadora:   npx wrangler d1 execute lume-beauty --local  --file=db/admin.sql
    En la tienda:        npx wrangler d1 execute lume-beauty --remote --file=db/admin.sql

  Y después borrá db/admin.sql.
`);
