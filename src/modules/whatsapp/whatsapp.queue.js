// src/modules/whatsapp/whatsapp.queue.js
// Producer BullMQ — enfileira mensagens recebidas para processamento assíncrono

const { Queue } = require('bullmq');
const { getRedis } = require('../../config/redis');
const logger = require('../../shared/logger');

let filaMensagens = null;
let filaMedia = null;

function inicializarFilas() {
  const connection = getRedis();

  filaMensagens = new Queue('mensagens-recebidas', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });

  filaMedia = new Queue('media-download', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 2000 },
    },
  });

  logger.info('[BullMQ] Filas de mensagens e mídia inicializadas');
}

/**
 * Enfileirar mensagem recebida para processamento
 */
async function enfileirarMensagem(mensagemWA) {
  if (!filaMensagens) {
    logger.error('[BullMQ] Fila de mensagens não inicializada');
    return;
  }

  const waMessageId = mensagemWA.key?.id;

  await filaMensagens.add(
    'processar-mensagem',
    {
      key: mensagemWA.key,
      message: mensagemWA.message,
      messageTimestamp: mensagemWA.messageTimestamp,
      pushName: mensagemWA.pushName,
      waMessageId,
    },
    {
      jobId: `msg_${waMessageId}`, // Deduplicação natural pelo jobId
    }
  );

  logger.debug({ waMessageId }, '[BullMQ] Mensagem enfileirada');
}

/**
 * Enfileirar download de mídia
 */
async function enfileirarMediaDownload({ mensagemId, ticketId, tipoMidia, mensagemWA }) {
  if (!filaMedia) return;

  await filaMedia.add('download-media', {
    mensagemId,
    ticketId,
    tipoMidia,
    key: mensagemWA.key,
    message: mensagemWA.message,
  });

  logger.debug({ mensagemId, tipoMidia }, '[BullMQ] Download de mídia enfileirado');
}

module.exports = { inicializarFilas, enfileirarMensagem, enfileirarMediaDownload };
