// src/modules/queues/index.js
const queuesRoutes = require('./queues.routes');
const { initQueuesTables } = require('./queues.migration');

function initQueuesRoutes(app) {
  app.use('/api/queues', queuesRoutes);
}

module.exports = { initQueuesRoutes, initQueuesTables };
