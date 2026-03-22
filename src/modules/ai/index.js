// Módulo AI — inteligência artificial com aprendizado
const aiRoutes = require('./ai.routes');
const { initIATables } = require('./ai.migration');

function initAiRoutes(app) {
  app.use('/api/ai', aiRoutes);
  app.use('/api/ia', aiRoutes); // alias
}

module.exports = { initAiRoutes, initIaTables: initIATables };
