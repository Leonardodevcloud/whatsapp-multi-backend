// src/modules/config/index.js
const configRoutes = require('./config.routes');

function initConfigRoutes(app) {
  app.use('/api/config', configRoutes);
}

module.exports = { initConfigRoutes };
