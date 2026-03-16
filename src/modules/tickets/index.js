// src/modules/tickets/index.js
const ticketsRoutes = require('./tickets.routes');
const { initTicketsTables } = require('./tickets.migration');

function initTicketsRoutes(app) {
  app.use('/api/tickets', ticketsRoutes);
}

module.exports = { initTicketsRoutes, initTicketsTables };
