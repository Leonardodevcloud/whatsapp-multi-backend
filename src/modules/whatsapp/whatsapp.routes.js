// src/modules/whatsapp/whatsapp.routes.js
// Rotas WhatsApp — Z-API + Webhook (CORRIGIDO)

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

// GET /api/whatsapp/qr
router.get('/qr', verificarToken, (req, res) => {
  res.json({ qr: null, mensagem: 'Z-API gerencia o QR Code pelo painel em z-api.io.' });
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
    res.json({ sucesso: true, status: whatsappService.obterStatus() });
  } catch (err) { next(err); }
});

// POST /api/whatsapp/logout
router.post('/logout', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await whatsappService.forcarLogout();
    res.json({ sucesso: true });
  } catch (err) { next(err); }
});

// ============================================================
// WEBHOOK Z-API — recebe TUDO (mensagens, status, conexão)
// ============================================================
router.post('/webhook', async (req, res) => {
  res.status(200).json({ status: 'ok' });

  try {
    const body = req.body;
    if (!body) return;

    // Log completo pra debug (remover depois de estável)
    logger.info({ tipo: body.type || body.status || 'desconhecido', phone: body.phone, fromMe: body.fromMe, hasText: !!body.text, hasImage: !!body.image, hasAudio: !!body.audio }, '[Webhook] Payload recebido');

    // ---- CONEXÃO/DESCONEXÃO ----
    if (body.connected !== undefined) {
      if (body.connected) {
        conexaoWA.status = 'conectado';
        conexaoWA.inicioConexao = new Date();
        broadcast('whatsapp:conectado', {});
        logger.info('[Webhook] Z-API conectada');
      } else {
        conexaoWA.status = 'desconectado';
        broadcast('whatsapp:desconectado', {});
        logger.warn('[Webhook] Z-API desconectada');
      }
      return;
    }

    // ---- STATUS DE MENSAGEM ----
    if (body.status && !body.phone) {
      const statusMap = { 'SENT': 'enviada', 'RECEIVED': 'entregue', 'READ': 'lida', 'PLAYED': 'lida' };
      const novoStatus = statusMap[body.status];
      const msgId = body.id?.id || body.messageId;
      if (novoStatus && msgId) {
        const { atualizarStatusEnvio } = require('../messages/messages.service');
        await atualizarStatusEnvio({ waMessageId: msgId, status: novoStatus });
        broadcast('mensagem:status', { waMessageId: msgId, status: novoStatus });
      }
      return;
    }

    // ---- IGNORAR notificações e status reply ----
    if (body.isStatusReply || body.isNotification || body.isReaction) return;

    // ---- MENSAGEM (texto, mídia, localização, contato, sticker) ----
    if (body.phone) {
      // Limpar telefone — Z-API pode mandar com @c.us ou ID interno
      let telefone = String(body.phone).replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
      
      // Validar telefone — números brasileiros tem 12-13 dígitos (55 + DDD + 8-9 dígitos)
      // Se o telefone tem mais de 15 dígitos, provavelmente é um ID interno — ignorar
      if (telefone.length > 15) {
        logger.warn({ telefone, nome: body.senderName }, '[Webhook] Telefone parece ser ID interno — ignorando');
        return;
      }

      const nome = body.senderName || body.chatName || body.pushName || telefone;
      const waMessageId = body.messageId || body.id?.id || body.zapiMessageId;
      const isGroup = body.isGroup || false;
      const fromMe = body.fromMe || false;

      if (!waMessageId) {
        logger.warn({ bodyKeys: Object.keys(body) }, '[Webhook] Sem messageId');
        return;
      }

      // Detectar tipo e corpo da mensagem
      let tipo = 'texto';
      let corpo = '';
      let mediaUrl = null;

      if (body.image) {
        tipo = 'imagem';
        corpo = body.image.caption || '📷 Imagem';
        mediaUrl = body.image.imageUrl || body.image.url || null;
      } else if (body.audio) {
        tipo = 'audio';
        corpo = '🎵 Áudio';
        mediaUrl = body.audio.audioUrl || body.audio.url || null;
      } else if (body.video) {
        tipo = 'video';
        corpo = body.video.caption || '🎥 Vídeo';
        mediaUrl = body.video.videoUrl || body.video.url || null;
      } else if (body.document) {
        tipo = 'documento';
        corpo = body.document.fileName || '📄 Documento';
        mediaUrl = body.document.documentUrl || body.document.url || null;
      } else if (body.sticker) {
        tipo = 'sticker';
        corpo = '🎭 Sticker';
        mediaUrl = body.sticker.stickerUrl || body.sticker.url || null;
      } else if (body.location) {
        tipo = 'localizacao';
        corpo = `📍 ${body.location.latitude || ''}, ${body.location.longitude || ''}`;
      } else if (body.contactMessage || body.contact) {
        tipo = 'contato';
        const c = body.contactMessage || body.contact;
        corpo = `👤 ${c.displayName || c.name || 'Contato'}`;
      } else if (body.text) {
        tipo = 'texto';
        corpo = typeof body.text === 'string' ? body.text : (body.text.message || body.text.body || '');
      } else if (body.listResponseMessage) {
        tipo = 'texto';
        corpo = body.listResponseMessage.title || body.listResponseMessage.singleSelectReply?.selectedRowId || '';
      } else if (body.buttonsResponseMessage) {
        tipo = 'texto';
        corpo = body.buttonsResponseMessage.selectedButtonId || body.buttonsResponseMessage.selectedDisplayText || '';
      }

      // Se não conseguiu extrair nada, logar e ignorar
      if (!corpo && !mediaUrl) {
        logger.warn({ bodyKeys: Object.keys(body), waMessageId }, '[Webhook] Mensagem sem corpo detectável');
        return;
      }

      // Processar
      const resultado = await whatsappService.processarMensagemRecebida({
        telefone,
        nome,
        corpo,
        tipo,
        waMessageId,
        isGroup,
        fromMe,
        mediaUrl,
      });

      if (resultado) {
        broadcast('mensagem:nova', resultado);

        if (resultado.ticketNovo) {
          broadcast('ticket:novo', {
            id: resultado.ticket_id,
            contato: resultado.contato,
            status: 'pendente',
            ultimaMensagemPreview: (corpo || '📎 Mídia').substring(0, 200),
          });
        }
      }
    }
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, '[Webhook] Erro ao processar');
  }
});

module.exports = router;