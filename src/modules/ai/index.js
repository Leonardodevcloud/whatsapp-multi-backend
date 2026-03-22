// Módulo AI — inteligência artificial com aprendizado
const aiRoutes = require('./ai.routes');
const { initIATables } = require('./ai.migration');

function initAiRoutes(app) {
  app.use('/api/ia', aiRoutes);
}

module.exports = { initAiRoutes, initIaTables: initIATables };
