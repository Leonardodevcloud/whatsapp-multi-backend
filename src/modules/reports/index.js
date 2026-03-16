// src/modules/reports/index.js
const reportsRoutes = require('./reports.routes');

function initReportsRoutes(app) {
  app.use('/api/reports', reportsRoutes);
}

module.exports = { initReportsRoutes };
