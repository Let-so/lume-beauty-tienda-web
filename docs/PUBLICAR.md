# Publicar la tienda y mantenerla

Esta guía es para quien administra la infraestructura. Camila no la necesita:
ella solo usa el panel, y eso está explicado en [USAR-EL-PANEL.md](USAR-EL-PANEL.md).

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

## 3. Las fotos (R2)

```bash
npx wrangler r2 bucket create lume-fotos
```

**Puede pedir un medio de pago aunque el uso quede dentro de la capa gratuita**
(10 GB y sin cargo por descarga). No pude confirmarlo en la documentación, así
que hay que verlo al crear el depósito.

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
node tests/correr.mjs                  # tienen que dar todas en verde
npx wrangler pages deploy
```

La primera vez pregunta el nombre del proyecto: poner `lume-beauty`.

Cloudflare devuelve una dirección `https://lume-beauty.pages.dev`.

### Conectar el dominio

Si hay un dominio propio, se conecta desde el panel de Cloudflare, en
**Workers & Pages → lume-beauty → Custom domains**. HTTPS se configura solo.

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
