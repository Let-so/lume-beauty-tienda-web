-- Modelo de datos del panel de administración de LUMÉ BEAUTY.
--
-- Corre sobre SQLite (Cloudflare D1 en producción, SQLite local para pruebas).
--
-- Dos criterios que explican casi todas las decisiones de acá abajo:
--
-- 1. La API pública tiene que poder reconstruir data/catalog.json con la forma
--    exacta que tiene hoy. Así la vitrina y sus 156 pruebas siguen andando sin
--    tocar una línea. Por eso hay columnas que parecen raras: existen porque el
--    archivo las tiene.
-- 2. Los precios se guardan como enteros en pesos. El catálogo nunca usó
--    centavos y un entero no sufre los redondeos de los decimales flotantes.
--    price NULL significa "a confirmar", que es un caso real de esta tienda.

PRAGMA foreign_keys = ON;

-- ───────────────────────────── acceso ─────────────────────────────

CREATE TABLE IF NOT EXISTS admin_user (
  id                  INTEGER PRIMARY KEY,
  email               TEXT    NOT NULL UNIQUE,
  name                TEXT    NOT NULL,
  -- PBKDF2-HMAC-SHA256. Se guarda el hash y la sal por separado, en base64,
  -- junto con las iteraciones usadas, para poder subirlas en el futuro sin
  -- invalidar las contraseñas ya guardadas.
  password_hash       TEXT    NOT NULL,
  password_salt       TEXT    NOT NULL,
  password_iterations INTEGER NOT NULL,
  role                TEXT    NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
  created_at          TEXT    NOT NULL,
  last_login_at       TEXT
);

-- De la sesión se guarda el SHA-256 del token, nunca el token. Si alguien
-- llegara a leer la tabla, no podría hacerse pasar por nadie.
CREATE TABLE IF NOT EXISTS session (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES admin_user(id) ON DELETE CASCADE,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_vence ON session(expires_at);

-- Para frenar los intentos de adivinar la contraseña.
CREATE TABLE IF NOT EXISTS login_attempt (
  id      INTEGER PRIMARY KEY,
  subject TEXT    NOT NULL,            -- ip o correo
  at      TEXT    NOT NULL,
  ok      INTEGER NOT NULL CHECK (ok IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_intento ON login_attempt(subject, at);

-- ──────────────────────────── catálogo ────────────────────────────

CREATE TABLE IF NOT EXISTS brand (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  bag        TEXT,                     -- foto de la bolsa; puede no tener
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS category (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product (
  id               TEXT PRIMARY KEY,
  brand_id         TEXT REFERENCES brand(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  title            TEXT NOT NULL DEFAULT '',
  subtitle         TEXT NOT NULL DEFAULT '',
  size             TEXT NOT NULL DEFAULT '',
  price            INTEGER,            -- pesos enteros. NULL = a confirmar
  compare_at_price INTEGER,            -- precio anterior, para ofertas
  stock            INTEGER,            -- NULL = no se lleva control de stock
  status           TEXT NOT NULL DEFAULT 'published'
                   CHECK (status IN ('published','draft','out_of_stock')),
  featured         INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  -- Cartelito de la tarjeta, por ejemplo NUEVO. En el JSON se llama "tag".
  -- Se llama badge acá para no confundirlo con las etiquetas de la tabla tag,
  -- que son otra cosa: las que Camila crea para organizar su catálogo.
  badge            TEXT,
  -- Advertencia de seguridad del producto, por ejemplo que el retinol no
  -- se usa durante el embarazo. Se muestra destacada en la ficha.
  warning          TEXT,
  image_padding    TEXT NOT NULL DEFAULT '6%',
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_producto_estado ON product(status, sort_order);
CREATE INDEX IF NOT EXISTS idx_producto_marca  ON product(brand_id);

CREATE TABLE IF NOT EXISTS product_category (
  product_id  TEXT NOT NULL REFERENCES product(id)  ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, category_id)
);

-- Varias fotos por producto, con una marcada como principal.
CREATE TABLE IF NOT EXISTS product_image (
  id         INTEGER PRIMARY KEY,
  product_id TEXT    NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  url        TEXT    NOT NULL,
  alt        TEXT    NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_main    INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_foto_producto ON product_image(product_id, sort_order);

-- Los párrafos de "descripción" y de "cómo se usa" viven juntos acá porque
-- son lo mismo: una lista ordenada de párrafos.
CREATE TABLE IF NOT EXISTS product_text (
  id         INTEGER PRIMARY KEY,
  product_id TEXT    NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  kind       TEXT    NOT NULL CHECK (kind IN ('description','how_to')),
  body       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_texto_producto ON product_text(product_id, kind, sort_order);

CREATE TABLE IF NOT EXISTS product_spec (
  id         INTEGER PRIMARY KEY,
  product_id TEXT    NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  label      TEXT    NOT NULL,
  value      TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_spec_producto ON product_spec(product_id, sort_order);

-- Etiquetas libres que crea Camila para organizarse.
CREATE TABLE IF NOT EXISTS tag (
  id   INTEGER PRIMARY KEY,
  name TEXT    NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS product_tag (
  product_id TEXT    NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tag(id)     ON DELETE CASCADE,
  PRIMARY KEY (product_id, tag_id)
);

-- ──────────────────── ajustes y registro de cambios ────────────────────

-- Todo lo del catálogo que no son productos: textos de la portada, banners,
-- datos de contacto, y el interruptor de mantenimiento. Clave y valor JSON,
-- porque son formas muy distintas entre sí y cambian seguido.
-- Al vivir en la base, el estado de mantenimiento sobrevive a cualquier
-- reinicio del servidor, que es lo que pide el encargo.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Quién hizo qué. Sirve para entender un cambio raro y para poder volver atrás.
CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY,
  user_id   INTEGER,
  action    TEXT NOT NULL,
  entity    TEXT,
  entity_id TEXT,
  detail    TEXT,
  at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_registro_fecha ON audit_log(at);
