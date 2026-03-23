// src/modules/reports/index.js
const reportsRoutes = require('./reports.routes');
const { initTicketCiclosTables } = require('./ticket-ciclos.migration');

function initReportsRoutes(app) {
  app.use('/api/reports', reportsRoutes);
}

module.exports = { initReportsRoutes, initTicketCiclosTables };
