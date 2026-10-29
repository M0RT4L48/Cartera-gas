'use strict';

const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const L = require('./lib');

async function main() {
  if (!L.remote) throw new Error('Configura TURSO_DATABASE_URL y TURSO_AUTH_TOKEN antes de ejecutar la migración.');
  if (!process.argv.includes('--confirmar-sobrescritura')) {
    throw new Error('Este proceso reemplaza los datos de Turso con la base local. Repite con --confirmar-sobrescritura para confirmar.');
  }
  await L.ready;
  if (!fs.existsSync(L.DB_PATH)) throw new Error(`No se encontró la base SQLite local: ${L.DB_PATH}`);
  const sqlite = new DatabaseSync(L.DB_PATH, { readOnly: true });
  try {
    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    if (!tables.length) throw new Error('La base SQLite local no contiene tablas para migrar.');
    await L.importarSqliteAlmacenado(sqlite);
    console.log(`Migración completada: ${tables.length} tablas copiadas a Turso desde ${L.DB_PATH}.`);
  } finally {
    sqlite.close();
    await L.client.close();
  }
}

main().catch(async (error) => {
  console.error('[MIGRAR_TURSO]', error.message);
  try { await L.client.close(); } catch (closeError) { console.error('[DATABASE_CLOSE]', closeError); }
  process.exitCode = 1;
});
