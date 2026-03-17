// src/modules/whatsapp/index.js
// Ponto de entrada do módulo WhatsApp (Cloud API)

const whatsappRoutes = require('./whatsapp.routes');
const { initWhatsAppTables } = require('./whatsapp.migration');
const conexaoWA = require('./whatsapp.connection');
const logger = require('../../shared/logger');

function initWhatsAppRoutes(app) {
  app.use('/api/whatsapp', whatsappRoutes);
}

/**
 * Inicializar conexão WhatsApp Cloud API
 */
async function inicializarWhatsApp(wsBroadcast) {
  conexaoWA.on('conectado', (info) => {
    wsBroadcast('whatsapp:conectado', {
      nome: info?.name,
      numero: info?.id,
    });
    logger.info('[WhatsApp] Evento conectado emitido via WS');
  });

  // Conectar (verifica credenciais)
  await conexaoWA.conectar();
}

module.exports = { initWhatsAppRoutes, initWhatsAppTables, inicializarWhatsApp };