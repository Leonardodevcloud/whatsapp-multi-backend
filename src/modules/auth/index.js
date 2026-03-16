// src/modules/auth/index.js
// Ponto de entrada do módulo auth

const authRoutes = require('./auth.routes');
const { initAuthTables } = require('./auth.migration');

function initAuthRoutes(app) {
  app.use('/api/auth', authRoutes);
}

module.exports = { initAuthRoutes, initAuthTables };
