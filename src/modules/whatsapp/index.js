// src/modules/whatsapp/index.js
// Ponto de entrada do módulo WhatsApp

const whatsappRoutes = require('./whatsapp.routes');
const { initWhatsAppTables } = require('./whatsapp.migration');
const conexaoWA = require('./whatsapp.connection');
const { inicializarFilas, enfileirarMensagem } = require('./whatsapp.queue');
const logger = require('../../shared/logger');

function initWhatsAppRoutes(app) {
  app.use('/api/whatsapp', whatsappRoutes);
}

/**
 * Inicializar conexão WhatsApp e wiring de eventos
 * Chamado após todas as migrations rodarem
 */
async function inicializarWhatsApp(wsBroadcast) {
  // Inicializar filas BullMQ
  inicializarFilas();

  // QR code → broadcast via WebSocket para frontend
  conexaoWA.on('qr', (qr) => {
    wsBroadcast('whatsapp:qr', { qr });
  });

  // Conectado → broadcast
  conexaoWA.on('conectado', (info) => {
    wsBroadcast('whatsapp:conectado', {
      nome: info?.name,
      numero: info?.id,
    });
    logger.info('[WhatsApp] Evento conectado emitido via WS');
  });

  // Desconectado → broadcast
  conexaoWA.on('desconectado', (info) => {
    wsBroadcast('whatsapp:desconectado', info);
  });

  // Atualização de status de mensagem (entregue, lida)
  conexaoWA.on('messages.update', async (updates) => {
    const { atualizarStatusEnvio } = require('../messages/messages.service');
    for (const update of updates) {
      try {
        const waId = update.key?.id;
        if (!waId) continue;

        let novoStatus = null;
        if (update.update?.status === 3) novoStatus = 'entregue';
        if (update.update?.status === 4) novoStatus = 'lida';

        if (novoStatus) {
          await atualizarStatusEnvio({ waMessageId: waId, status: novoStatus });
          wsBroadcast('mensagem:status', { waMessageId: waId, status: novoStatus });
        }
      } catch (err) {
        logger.error({ err }, '[WhatsApp] Erro ao atualizar status de mensagem');
      }
    }
  });

  // Mensagem recebida → enfileirar na BullMQ
  conexaoWA.on('mensagem.recebida', async (msg) => {
    try {
      await enfileirarMensagem(msg);
    } catch (err) {
      logger.error({ err, waId: msg.key?.id }, '[WhatsApp] Erro ao enfileirar mensagem');
    }
  });

  // Iniciar conexão
  await conexaoWA.conectar();
}

module.exports = { initWhatsAppRoutes, initWhatsAppTables, inicializarWhatsApp };
