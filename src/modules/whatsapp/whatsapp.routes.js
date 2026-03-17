// src/modules/whatsapp/whatsapp.routes.js
// Rotas WhatsApp — Cloud API + Webhook

const { Router } = require('express');
const whatsappService = require('./whatsapp.service');
const conexaoWA = require('./whatsapp.connection');
const { verificarToken, verificarAdmin } = require('../../middleware/auth');
const { limiteSensivel } = require('../../middleware/rateLimiter');
const { broadcast } = require('../../websocket');
const logger = require('../../shared/logger');

const router = Router();

// GET /api/whatsapp/status
router.get('/status', verificarToken, (req, res) => {
  res.json(whatsappService.obterStatus());
});

// GET /api/whatsapp/qr — Cloud API não usa QR
router.get('/qr', verificarToken, (req, res) => {
  res.json({ qr: null, mensagem: 'Cloud API não usa QR Code. Configure WA_PHONE_NUMBER_ID e WA_ACCESS_TOKEN nas variáveis de ambiente.' });
});

// POST /api/whatsapp/enviar
router.post('/enviar', verificarToken, limiteSensivel, async (req, res, next) => {
  try {
    const { ticket_id, texto } = req.body;
    if (!ticket_id || !texto?.trim()) {
      return res.status(400).json({ erro: 'ticket_id e texto são obrigatórios' });
    }
    const mensagem = await whatsappService.enviarMensagemTexto({
      ticketId: ticket_id,
      texto: texto.trim(),
      usuarioId: req.usuario.id,
    });
    res.json({ sucesso: true, mensagem });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/reconectar
router.post('/reconectar', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await whatsappService.reconectar();
    res.json({ sucesso: true, mensagem: 'Reconexão realizada', status: whatsappService.obterStatus() });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/logout
router.post('/logout', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await whatsappService.forcarLogout();
    res.json({ sucesso: true, mensagem: 'Desconectado' });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// WEBHOOK da Meta — recebe mensagens do WhatsApp
// ============================================================

// GET /api/whatsapp/webhook — verificação do webhook pela Meta
router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = conexaoWA.webhookVerifyToken || process.env.WA_WEBHOOK_VERIFY_TOKEN || 'centraltutts_webhook_2026';

  if (mode === 'subscribe' && token === verifyToken) {
    logger.info('[Webhook] Verificação da Meta aceita');
    return res.status(200).send(challenge);
  }

  logger.warn({ mode, token }, '[Webhook] Verificação falhou');
  return res.status(403).json({ erro: 'Verificação falhou' });
});

// POST /api/whatsapp/webhook — recebe mensagens
router.post('/webhook', async (req, res) => {
  // Sempre responder 200 imediatamente (Meta exige)
  res.status(200).json({ status: 'ok' });

  try {
    const body = req.body;

    if (body.object !== 'whatsapp_business_account') return;

    const entries = body.entry || [];

    for (const entry of entries) {
      const changes = entry.changes || [];

      for (const change of changes) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        if (!value?.messages) continue;

        const contatos = value.contacts || [];
        const mensagens = value.messages || [];

        for (const msg of mensagens) {
          const telefone = msg.from;
          const contatoInfo = contatos.find((c) => c.wa_id === telefone);
          const nome = contatoInfo?.profile?.name || telefone;
          const waMessageId = msg.id;
          const timestamp = msg.timestamp;

          // Mapear tipo
          let tipo = 'texto';
          let corpo = '';

          switch (msg.type) {
            case 'text':
              tipo = 'texto';
              corpo = msg.text?.body || '';
              break;
            case 'image':
              tipo = 'imagem';
              corpo = msg.image?.caption || '📷 Imagem';
              break;
            case 'audio':
              tipo = 'audio';
              corpo = '🎵 Áudio';
              break;
            case 'video':
              tipo = 'video';
              corpo = msg.video?.caption || '🎥 Vídeo';
              break;
            case 'document':
              tipo = 'documento';
              corpo = msg.document?.filename || '📄 Documento';
              break;
            case 'location':
              tipo = 'localizacao';
              corpo = `📍 Localização: ${msg.location?.latitude}, ${msg.location?.longitude}`;
              break;
            case 'contacts':
              tipo = 'contato';
              corpo = `👤 Contato: ${msg.contacts?.[0]?.name?.formatted_name || 'Contato'}`;
              break;
            case 'sticker':
              tipo = 'sticker';
              corpo = '🎭 Sticker';
              break;
            case 'reaction':
              // Ignorar reações
              continue;
            default:
              tipo = 'texto';
              corpo = `[${msg.type}]`;
          }

          // Processar
          const resultado = await whatsappService.processarMensagemRecebida({
            telefone,
            nome,
            corpo,
            tipo,
            waMessageId,
            timestamp,
          });

          if (resultado) {
            // Broadcast via WebSocket pros atendentes
            broadcast('mensagem:nova', resultado);

            if (resultado.ticketNovo) {
              broadcast('ticket:novo', {
                id: resultado.ticket_id,
                contato: resultado.contato,
                status: 'pendente',
                ultimaMensagemPreview: corpo.substring(0, 200),
              });
            }
          }
        }

        // Status updates (entregue, lida)
        const statuses = value.statuses || [];
        for (const status of statuses) {
          const { atualizarStatusEnvio } = require('../messages/messages.service');
          let novoStatus = null;
          if (status.status === 'delivered') novoStatus = 'entregue';
          if (status.status === 'read') novoStatus = 'lida';
          if (status.status === 'sent') novoStatus = 'enviada';

          if (novoStatus) {
            await atualizarStatusEnvio({ waMessageId: status.id, status: novoStatus });
            broadcast('mensagem:status', { waMessageId: status.id, status: novoStatus });
          }
        }
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, '[Webhook] Erro ao processar');
  }
});

module.exports = router;