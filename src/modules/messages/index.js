// src/modules/messages/index.js
const messagesRoutes = require('./messages.routes');
const { initMessagesTables } = require('./messages.migration');

function initMessagesRoutes(app) {
  app.use('/api/messages', messagesRoutes);
}

module.exports = { initMessagesRoutes, initMessagesTables };
