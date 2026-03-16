// src/modules/ai/index.js
const aiRoutes = require('./ai.routes');

function initAiRoutes(app) {
  app.use('/api/ai', aiRoutes);
}

module.exports = { initAiRoutes };
