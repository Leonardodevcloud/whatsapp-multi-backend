// src/modules/tags/index.js
const tagsRoutes = require('./tags.routes');

function initTagsRoutes(app) {
  app.use('/api/tags', tagsRoutes);
}

module.exports = { initTagsRoutes };
