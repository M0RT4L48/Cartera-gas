-- ============================================================
-- Gas_App Financiero · modelo estrella + tablas de aplicacion
-- ============================================================
PRAGMA foreign_keys = OFF;

-- ---------- DIMENSIONES ----------
CREATE TABLE IF NOT EXISTS dim_estacion (
  id      INTEGER PRIMARY KEY,
  nombre  TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS dim_cliente (
  k_cliente   TEXT PRIMARY KEY,          -- ESTACION_CLIENTE (llave del modelo)
  cliente     TEXT NOT NULL,
  estacion_id INTEGER NOT NULL,
  no_cliente  TEXT
);
CREATE INDEX IF NOT EXISTS ix_cliente_est ON dim_cliente(estacion_id);
CREATE TABLE IF NOT EXISTS dim_tiempo (
  fecha      TEXT PRIMARY KEY,           -- YYYY-MM-DD
  anio       INTEGER, trimestre INTEGER, mes INTEGER,
  mes_nombre TEXT,    anio_mes  TEXT,    semana INTEGER,
  dia_semana INTEGER, dia_nombre TEXT
);

-- ---------- METRICAS DE LIMITE ----------
CREATE TABLE IF NOT EXISTS credito (
  k_cliente       TEXT PRIMARY KEY,
  limite          REAL NOT NULL DEFAULT 0,
  dias            INTEGER NOT NULL DEFAULT 0,
  origen          TEXT NOT NULL DEFAULT 'excel',   -- excel | app
  actualizado_por TEXT,
  actualizado     TEXT
);

-- ---------- HECHOS ----------
CREATE TABLE IF NOT EXISTS fact_cxc (          -- una fila por despacho
  id                INTEGER PRIMARY KEY,       -- Indice del Excel
  fecha_despacho    TEXT,
  despacho          TEXT,
  producto          TEXT,
  importe           REAL NOT NULL DEFAULT 0,
  abono             REAL NOT NULL DEFAULT 0,
  k_cliente         TEXT NOT NULL,
  estacion_id       INTEGER NOT NULL,
  estatus           TEXT,                      -- PAGADO | ABONADO | POR PAGAR | POR FACTURAR
  grupo             TEXT,
  fecha_factura     TEXT,
  no_factura        TEXT,
  fecha_pago        TEXT,
  fecha_vencimiento TEXT,
  facturada_desde_pendiente INTEGER NOT NULL DEFAULT 0,
  prev_fecha_factura TEXT,
  prev_no_factura TEXT,
  prev_fecha_vencimiento TEXT
);
CREATE INDEX IF NOT EXISTS ix_cxc_cli ON fact_cxc(k_cliente);
CREATE INDEX IF NOT EXISTS ix_cxc_fac ON fact_cxc(k_cliente, no_factura);
CREATE INDEX IF NOT EXISTS ix_cxc_est ON fact_cxc(estatus);

CREATE TABLE IF NOT EXISTS fact_factura (      -- agregado por factura
  k_cliente         TEXT NOT NULL,
  estacion_id       INTEGER NOT NULL,
  no_factura        TEXT NOT NULL,
  fecha_factura     TEXT,
  fecha_vencimiento TEXT,
  primer_despacho   TEXT,
  ultimo_despacho   TEXT,
  despachos         INTEGER,
  importe           REAL,
  abono             REAL,
  abierta           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k_cliente, estacion_id, no_factura)
);
CREATE INDEX IF NOT EXISTS ix_fac_abierta ON fact_factura(abierta);
CREATE INDEX IF NOT EXISTS ix_fac_venc    ON fact_factura(fecha_vencimiento);

CREATE TABLE IF NOT EXISTS fact_debito (       -- recargas (abono) y consumos (importe)
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha       TEXT,
  folio       TEXT,
  tipo        TEXT NOT NULL,                   -- RECARGA | CONSUMO
  importe     REAL NOT NULL DEFAULT 0,
  abono       REAL NOT NULL DEFAULT 0,
  k_cliente   TEXT NOT NULL,
  estacion_id INTEGER NOT NULL,
  grupo       TEXT
);
CREATE INDEX IF NOT EXISTS ix_deb_cli ON fact_debito(k_cliente);

CREATE TABLE IF NOT EXISTS meta (clave TEXT PRIMARY KEY, valor TEXT);

-- ---------- APLICACION (se conservan al reimportar el Excel) ----------
CREATE TABLE IF NOT EXISTS usuarios (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nombre          TEXT NOT NULL,
  email           TEXT,
  rol             TEXT NOT NULL DEFAULT 'consulta',   -- admin | gestor | supervisor | capturista | pagos | consulta
  estacion_id     INTEGER,                            -- Estación heredada/primera asignada; el alcance se calcula con usuario_estaciones
  activo          INTEGER NOT NULL DEFAULT 1,
  must_change     INTEGER NOT NULL DEFAULT 1,
  pass_hash       TEXT NOT NULL,
  intentos        INTEGER NOT NULL DEFAULT 0,
  bloqueado_hasta TEXT,
  ultimo_login    TEXT,
  creado          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS usuario_estaciones (
  usuario_id  INTEGER NOT NULL,
  estacion_id INTEGER NOT NULL,
  PRIMARY KEY (usuario_id, estacion_id),
  FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,
  FOREIGN KEY (estacion_id) REFERENCES dim_estacion(id) ON DELETE CASCADE
  -- Si no hay filas ni estacion_id heredado, el usuario tiene acceso a todas las estaciones.
);
CREATE TABLE IF NOT EXISTS sesiones (
  token_hash TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL,
  expira     TEXT NOT NULL,
  creado     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pagos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  k_cliente   TEXT NOT NULL,
  estacion_id INTEGER NOT NULL,
  no_factura  TEXT NOT NULL,
  fecha       TEXT NOT NULL,
  monto       REAL NOT NULL,
  metodo      TEXT NOT NULL,
  referencia  TEXT,
  notas       TEXT,
  usuario_id  INTEGER,
  creado      TEXT NOT NULL DEFAULT (datetime('now')),
  conciliado  INTEGER NOT NULL DEFAULT 0,   -- 1 = ya viene reflejado en el Excel
  anulado     INTEGER NOT NULL DEFAULT 0,
  sin_aplicar INTEGER NOT NULL DEFAULT 0,
  banco_id    INTEGER,
  banco       TEXT
);
CREATE INDEX IF NOT EXISTS ix_pagos_fac ON pagos(k_cliente, estacion_id, no_factura);

CREATE TABLE IF NOT EXISTS bancos (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE COLLATE NOCASE
);
INSERT OR IGNORE INTO bancos(nombre) VALUES ('BBVA'), ('Santander'), ('Banco Azteca');

CREATE TABLE IF NOT EXISTS metodos_pago (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  requiere_banco  INTEGER NOT NULL DEFAULT 0 CHECK (requiere_banco IN (0, 1))
);
INSERT OR IGNORE INTO metodos_pago(nombre, requiere_banco) VALUES
  ('Transferencia SPEI', 1),
  ('Efectivo', 0),
  ('Cheque', 1),
  ('Tarjeta', 1),
  ('Compensación', 0),
  ('Otro', 0);

CREATE TABLE IF NOT EXISTS productos (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE COLLATE NOCASE
);
INSERT OR IGNORE INTO productos(nombre) VALUES ('Diesel'), ('Premium'), ('Magna');

CREATE TABLE IF NOT EXISTS debito_app (        -- movimientos de debito capturados en la app
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha       TEXT NOT NULL,
  folio       TEXT,
  tipo        TEXT NOT NULL,                   -- RECARGA | CONSUMO
  importe     REAL NOT NULL DEFAULT 0,         -- consumo
  abono       REAL NOT NULL DEFAULT 0,         -- recarga
  k_cliente   TEXT NOT NULL,
  estacion_id INTEGER NOT NULL,
  usuario_id  INTEGER,
  metodo      TEXT,
  banco_id    INTEGER,
  banco       TEXT,
  creado      TEXT NOT NULL DEFAULT (datetime('now')),
  conciliado  INTEGER NOT NULL DEFAULT 0,
  anulado     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_debapp_cli ON debito_app(k_cliente);

CREATE TABLE IF NOT EXISTS fact_cxc_app (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha_despacho    TEXT NOT NULL,
  despacho          TEXT,
  producto          TEXT,
  importe           REAL NOT NULL,
  abono             REAL NOT NULL DEFAULT 0,
  k_cliente         TEXT NOT NULL,
  estacion_id       INTEGER NOT NULL,
  estatus           TEXT NOT NULL DEFAULT 'POR PAGAR',
  grupo             TEXT,
  fecha_factura     TEXT NOT NULL,
  no_factura        TEXT NOT NULL,
  fecha_pago        TEXT,
  fecha_vencimiento TEXT,
  facturada_desde_pendiente INTEGER NOT NULL DEFAULT 0,
  prev_fecha_factura TEXT,
  prev_no_factura TEXT,
  prev_fecha_vencimiento TEXT,
  usuario_id        INTEGER,
  creado            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_cxcapp_cli ON fact_cxc_app(k_cliente, no_factura);

CREATE TABLE IF NOT EXISTS facturas_anticipo (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  k_cliente         TEXT NOT NULL REFERENCES dim_cliente(k_cliente),
  serie             TEXT,
  folio             TEXT NOT NULL,
  uuid_fiscal       TEXT,
  fecha_factura     TEXT NOT NULL,
  importe_original  REAL NOT NULL CHECK (importe_original > 0),
  importe_aplicado  REAL NOT NULL DEFAULT 0 CHECK (importe_aplicado >= 0 AND importe_aplicado <= importe_original),
  saldo_disponible  REAL NOT NULL CHECK (saldo_disponible >= 0 AND saldo_disponible <= importe_original),
  moneda            TEXT NOT NULL DEFAULT 'MXN',
  tipo_cambio       REAL DEFAULT 1 CHECK (tipo_cambio IS NULL OR tipo_cambio > 0),
  referencia        TEXT,
  observaciones     TEXT,
  estado            TEXT NOT NULL DEFAULT 'ABIERTA' CHECK (estado IN ('ABIERTA','PARCIALMENTE_APLICADA','CERRADA','CANCELADA')),
  fecha_cancelacion TEXT,
  motivo_cancelacion TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  created_by        TEXT,
  updated_at        TEXT,
  updated_by        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_anticipo_folio
  ON facturas_anticipo(k_cliente, COALESCE(serie,''), folio COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS ux_anticipo_uuid
  ON facturas_anticipo(uuid_fiscal COLLATE NOCASE) WHERE uuid_fiscal IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_anticipo_cliente_estado
  ON facturas_anticipo(k_cliente, estado, fecha_factura);

CREATE TABLE IF NOT EXISTS aplicaciones_factura_anticipo (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotencia      TEXT NOT NULL UNIQUE,
  k_cliente         TEXT NOT NULL REFERENCES dim_cliente(k_cliente),
  factura_anticipo_id INTEGER NOT NULL REFERENCES facturas_anticipo(id),
  estacion_id       INTEGER NOT NULL REFERENCES dim_estacion(id),
  no_factura        TEXT NOT NULL,
  fecha_aplicacion  TEXT NOT NULL,
  importe_aplicado  REAL NOT NULL CHECK (importe_aplicado > 0),
  moneda            TEXT NOT NULL DEFAULT 'MXN',
  tipo_cambio       REAL CHECK (tipo_cambio IS NULL OR tipo_cambio > 0),
  estado            TEXT NOT NULL DEFAULT 'APLICADA' CHECK (estado IN ('APLICADA','CANCELADA')),
  referencia        TEXT,
  observaciones     TEXT,
  fecha_cancelacion TEXT,
  motivo_cancelacion TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  created_by        TEXT,
  updated_at        TEXT,
  updated_by        TEXT
);
CREATE INDEX IF NOT EXISTS ix_aplicacion_anticipo
  ON aplicaciones_factura_anticipo(factura_anticipo_id, estado);
CREATE INDEX IF NOT EXISTS ix_aplicacion_factura
  ON aplicaciones_factura_anticipo(k_cliente, estacion_id, no_factura, estado);

CREATE TABLE IF NOT EXISTS cliente_extra (     -- RFC y clientes dados de alta desde la app
  k_cliente   TEXT PRIMARY KEY,
  rfc         TEXT,
  creado_app  INTEGER NOT NULL DEFAULT 0,
  cliente     TEXT,
  estacion_id INTEGER,
  no_cliente  TEXT,
  email       TEXT,
  telefono    TEXT,
  modo_carga  TEXT,
  editado_app INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS gestiones (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  k_cliente      TEXT NOT NULL,
  fecha          TEXT NOT NULL,
  tipo           TEXT NOT NULL,
  resultado      TEXT NOT NULL,
  notas          TEXT,
  promesa_fecha  TEXT,
  promesa_monto  REAL,
  estado         TEXT NOT NULL DEFAULT 'Abierta',
  usuario_id     INTEGER,
  creado         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_gest_cli ON gestiones(k_cliente);

CREATE TABLE IF NOT EXISTS bitacora (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha   TEXT NOT NULL DEFAULT (datetime('now')),
  usuario TEXT,
  accion  TEXT NOT NULL,
  detalle TEXT,
  ip      TEXT
);

-- Debito unificado: Excel + movimientos capturados en la app (vigentes)
DROP VIEW IF EXISTS v_debito;
CREATE VIEW v_debito AS
  SELECT id, fecha, folio, tipo, importe, abono, k_cliente, estacion_id, grupo, 'excel' AS origen FROM fact_debito
  UNION ALL
  SELECT 1000000000+id, fecha, folio, tipo, importe, abono, k_cliente, estacion_id, NULL, 'app' FROM debito_app
  WHERE conciliado=0 AND anulado=0;

DROP VIEW IF EXISTS v_fact_factura;
DROP VIEW IF EXISTS v_cxc;
CREATE VIEW v_cxc AS
  SELECT id, fecha_despacho, despacho, producto, importe, abono, k_cliente, estacion_id, estatus, grupo,
         fecha_factura, no_factura, fecha_pago, fecha_vencimiento, 'excel' AS origen, facturada_desde_pendiente
    FROM fact_cxc
  UNION ALL
  SELECT 2000000000+id, fecha_despacho, despacho, producto, importe, abono, k_cliente, estacion_id, estatus, grupo,
         fecha_factura, no_factura, fecha_pago, fecha_vencimiento, 'app', facturada_desde_pendiente
    FROM fact_cxc_app;

CREATE VIEW v_fact_factura AS
  SELECT k_cliente, estacion_id, no_factura, MIN(fecha_factura) fecha_factura,
         MIN(fecha_vencimiento) fecha_vencimiento, MIN(fecha_despacho) primer_despacho,
         MAX(fecha_despacho) ultimo_despacho, COUNT(*) despachos, SUM(importe) importe, SUM(abono) abono,
         MAX(CASE WHEN estatus IN ('POR PAGAR','ABONADO') THEN 1 ELSE 0 END) abierta,
         MIN(CASE WHEN origen='app' THEN 1 ELSE 0 END) editable,
         MIN(CASE WHEN origen='app' THEN id-2000000000 END) app_id
    FROM v_cxc
   WHERE no_factura IS NOT NULL AND estatus<>'POR FACTURAR'
   GROUP BY k_cliente, estacion_id, no_factura;
