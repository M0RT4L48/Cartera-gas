'use strict';
// Respaldo en caliente:  node server/respaldo.js   (conserva los 30 mas recientes)
const { respaldar } = require('./lib');
const { ready, client } = require('./lib');

ready.then(async () => {
  console.log('Respaldo creado:', await respaldar());
  client.close();
}).catch((error) => {
  console.error('[RESPALDO]', error);
  client.close();
  process.exitCode = 1;
});
