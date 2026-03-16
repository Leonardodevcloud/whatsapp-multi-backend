// src/modules/quick-replies/index.js
const quickRepliesRoutes = require('./quick-replies.routes');

function initQuickRepliesRoutes(app) {
  app.use('/api/quick-replies', quickRepliesRoutes);
}

module.exports = { initQuickRepliesRoutes };
