# Publicar la tienda y mantenerla

Esta guía es para quien administra la infraestructura. Camila no la necesita:
ella solo usa el panel, y eso está explicado en [USAR-EL-PANEL.md](USAR-EL-PANEL.md).

---

## Dónde está todo, hoy

| Qué | Dónde |
|---|---|
| Tienda | <https://lume-beauty.pages.dev> |
| Panel | <https://lume-beauty.pages.dev/admin> |
| Cuenta de Cloudflare | licenciaturaiatp@gmail.com |
| Proyecto Pages | `lume-beauty` |
| Base D1 | `lume-beauty` — id `f60c52b8-9b51-4cab-808a-a0c2e88f6f12` |
| Depósito de fotos (R2) | **sin habilitar** — ver sección 3 |
| Tienda vieja en Render | sigue en pie, sin tocar |

El dominio propio todavía **no** apunta acá. Hasta que apunte, la dirección
que usa Camila es la de `pages.dev`.

Los pasos 1 y 2 de abajo ya están hechos. Quedan como referencia para rehacer
todo desde cero, o para montar una copia de prueba.

---

## Antes de empezar

Hace falta una cuenta gratuita de Cloudflare. **No la puedo crear yo:** necesita
un correo y una verificación que solo puede hacer una persona.

1. Entrar a <https://dash.cloudflare.com/sign-up> y crear la cuenta.
2. Confirmar el correo.

Con eso alcanza para todo lo que sigue, salvo las fotos. Ver más abajo.

---

## 1. Crear la base de datos

```bash
npx wrangler login                       # abre el navegador una sola vez
npx wrangler d1 create lume-beauty
```

El comando devuelve un `database_id`. **Copiarlo y pegarlo en `wrangler.toml`**,
reemplazando `PENDIENTE-PEGAR-EL-ID-QUE-DA-CLOUDFLARE`.

Después, cargar la estructura y el catálogo:

```bash
python -I scripts/migrar.py                                        # genera db/seed.sql
npx wrangler d1 execute lume-beauty --remote --file=db/schema.sql
npx wrangler d1 execute lume-beauty --remote --file=db/seed.sql
```

Comprobar que entró bien:

```bash
npx wrangler d1 execute lume-beauty --remote \
  --command "SELECT COUNT(*) AS productos FROM product"
```

Tienen que dar 20 productos.

---

## 2. Crear la cuenta de Camila

```bash
node scripts/crear-admin.mjs camila@sucorreo.com "Camila"
```

Pide la contraseña dos veces, sin mostrarla, y escribe `db/admin.sql`.

El comando imprime **un código de recuperación**. Aparece una sola vez: en la
base queda nada más que su resumen, así que no se puede volver a consultar.
Dárselo a Camila y que lo guarde donde guarda las cosas importantes. Es lo único
que le permite recuperar la contraseña sin ayuda.

```bash
npx wrangler d1 execute lume-beauty --remote --file=db/admin.sql
rm db/admin.sql          # contiene el resumen de una contraseña real
```

---

## 3. Las fotos (R2) — **pendiente**

Hoy R2 **no está habilitado** en la cuenta. Wrangler lo dice así:

```
Please enable R2 through the Cloudflare Dashboard. [code: 10042]
```

No es un problema de permisos: R2 hay que activarlo a mano una vez, desde el
panel web, y eso solo lo puede hacer el dueño de la cuenta.

**Qué significa mientras tanto.** Todo el panel funciona salvo *subir una foto
nueva*. En concreto, Camila puede cambiar precios, stock, textos, categorías,
ocultar y mostrar productos, y usar el modo mantenimiento. Lo que **no** puede
es dar de alta un producto nuevo con su foto, porque publicar exige al menos
una imagen. Puede dejarlo guardado como borrador y completarlo después.

**Para habilitarlo:**

1. Panel de Cloudflare → **R2 Object Storage** → activar.
   **Mirar si pide un medio de pago antes de aceptar nada.** La capa gratuita
   es de 10 GB y sin cargo por descarga, de sobra para un catálogo de fotos,
   pero si exige tarjeta, conviene decidirlo a conciencia y no por inercia.
2. Crear el depósito:
   ```bash
   npx wrangler r2 bucket create lume-fotos
   ```
3. Descomentar las tres líneas de `[[r2_buckets]]` en `wrangler.toml` y
   publicar de nuevo con `npx wrangler pages deploy`.

Si pide tarjeta y no se quiere dar, hay dos caminos, en este orden:

1. **Seguir con las fotos en el repositorio**, como hasta ahora. Camila no las
   puede cargar sola, pero todo lo demás del panel funciona igual. El panel
   avisa con un mensaje claro cuando R2 no está conectado.
2. Usar otro servicio de imágenes con capa gratuita y cambiar el endpoint
   `functions/api/admin/fotos.js`, que está aislado justamente para eso.

**No usar la base de datos para guardar fotos.** D1 está pensado para datos
chicos: las imágenes la vuelven lenta y pesada de copiar.

---

## 4. Publicar

```bash
node tests/correr.mjs                                   # todas en verde
npx wrangler pages deploy --project-name lume-beauty --branch main
```

**`--branch main` no es opcional.** Sin eso, wrangler usa el nombre de la rama
de git en la que estés, y cualquier nombre que no sea `main` publica una
*vista previa* en una dirección aparte en lugar de actualizar la tienda. Es un
error silencioso: el despliegue dice «Success» y la tienda sigue igual.

Cada despliegue imprime dos direcciones: una con un prefijo único, que es esa
versión sola y queda guardada para siempre, y <https://lume-beauty.pages.dev>,
que es la que ve la gente.

### Conectar el dominio

Si hay un dominio propio, se conecta desde el panel de Cloudflare, en
**Workers & Pages → lume-beauty → Custom domains**. HTTPS se configura solo.

### De dónde saca el catálogo la vitrina

La tienda pide `/api/catalog`, que lee la base. Eso es lo que hace que los
cambios del panel se vean al instante, sin publicar de nuevo.

`data/catalog.json` sigue en el repositorio como respaldo, pero **solo se usa
cuando la API no existe** — una copia estática del sitio, o el archivo abierto
a mano. Si la API existe y falla, la tienda muestra un aviso de que no pudo
cargar, y no cae al archivo: un catálogo viejo mostraría precios que ya no son
los que puso Camila, y es peor vender a un precio equivocado que avisar que la
tienda no carga.

Consecuencia práctica: `data/catalog.json` queda congelado en el estado que
tenía al migrar. No hay que mantenerlo al día ni editarlo a mano. La base es
la fuente de verdad.

### Mientras tanto, la tienda vieja sigue en pie

El sitio de Render no se toca hasta que la versión nueva esté probada en su
propia dirección. Recién entonces se cambia el dominio. Si algo sale mal, se
vuelve a apuntar a Render y listo.

---

## 5. Copias de seguridad

**Hacer una antes de cualquier cambio importante.**

```bash
npx wrangler d1 export lume-beauty --remote --output=respaldos/$(date +%F).sql
```

Conviene guardar esos archivos fuera de la computadora: un disco externa, o un
repositorio privado aparte. Una copia que vive en el mismo lugar que el original
no es una copia.

Cloudflare además guarda puntos de restauración automáticos de D1 durante los
últimos días, pero no conviene depender solo de eso.

### Restaurar

```bash
npx wrangler d1 execute lume-beauty --remote --file=respaldos/2026-11-08.sql
```

Si la base quedó inconsistente, es más seguro crear una base nueva, cargarle el
respaldo, cambiar el `database_id` en `wrangler.toml` y volver a publicar. Así
la base rota queda intacta por si hay que mirarla.

---

## 6. Volver a una versión anterior

**La página:** en Cloudflare, **Workers & Pages → lume-beauty → Deployments**,
cada publicación tiene un botón *Rollback*. Es inmediato y no toca la base.

**El código:**

```bash
git log --oneline            # buscar el commit que funcionaba
git revert <commit>          # revertir sin borrar historia
npx wrangler pages deploy
```

**Los datos:** restaurar desde un respaldo, como arriba.

Son tres cosas independientes a propósito: volver atrás la página no deshace un
cambio de precios, y restaurar la base no deshace un cambio de código.

---

## 7. Si Camila pierde la contraseña

Con el código de recuperación lo resuelve sola desde la pantalla de ingreso.

Si también perdió el código:

```bash
node scripts/crear-admin.mjs camila@sucorreo.com "Camila"
npx wrangler d1 execute lume-beauty --remote --file=db/admin.sql
rm db/admin.sql
```

Eso le pone una contraseña nueva, genera un código nuevo y cierra todas las
sesiones abiertas.

---

## 8. Qué vigilar

Los límites gratuitos de Cloudflare son holgados para esta tienda, pero conviene
saber cuáles son:

| | Límite gratuito | Uso esperado |
|---|---|---|
| Pedidos a la API | 100.000 por día | Muy lejos del límite |
| Escrituras en la base | 100.000 por día | Decenas por día |
| Lecturas en la base | 5.000.000 por día | Muy lejos del límite |
| Fotos en R2 | 10 GB | Unos pocos MB |

Si se superan, Cloudflare devuelve errores hasta la medianoche UTC; no cobra sin
aviso. Se ve en **Workers & Pages → lume-beauty → Metrics**.
