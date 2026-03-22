// src/modules/supervision/index.js
const supervisionRoutes = require('./supervision.routes');

function initSupervisionRoutes(app) {
  app.use('/api/supervision', supervisionRoutes);
}

module.exports = { initSupervisionRoutes };
