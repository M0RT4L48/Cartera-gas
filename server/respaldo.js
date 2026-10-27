'use strict';
// Respaldo en caliente:  node server/respaldo.js   (conserva los 30 mas recientes)
const { respaldar } = require('./lib');
console.log('Respaldo creado:', respaldar());
