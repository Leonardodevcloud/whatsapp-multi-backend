// src/modules/whatsapp/whatsapp.routes.js
// Rotas WhatsApp — Z-API + Webhook

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

// GET /api/whatsapp/qr — Z-API gerencia QR pelo painel próprio
router.get('/qr', verificarToken, (req, res) => {
  res.json({
    qr: null,
    mensagem: 'Z-API gerencia o QR Code pelo painel em z-api.io. Acesse sua instância lá para escanear.',
  });
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
// WEBHOOK Z-API — recebe mensagens e status
// ============================================================

// POST /api/whatsapp/webhook — webhook principal da Z-API
router.post('/webhook', async (req, res) => {
  // Responder 200 imediatamente
  res.status(200).json({ status: 'ok' });

  try {
    const body = req.body;

    // Validar security token se configurado
    const securityToken = conexaoWA.securityToken || process.env.ZAPI_SECURITY_TOKEN;
    if (securityToken) {
      const headerToken = req.headers['x-security-token'] || req.headers['security-token'];
      if (headerToken && headerToken !== securityToken) {
        logger.warn('[Webhook] Security token inválido');
        return;
      }
    }

    // Ignorar se não tem dados relevantes
    if (!body || body.isStatusReply) return;

    // ---- MENSAGEM RECEBIDA ----
    if (body.phone && body.text && !body.fromMe) {
      const telefone = body.phone;
      const nome = body.senderName || body.chatName || telefone;
      const waMessageId = body.messageId || body.id?.id;
      const isGroup = body.isGroup || false;

      // Mapear tipo
      let tipo = 'texto';
      let corpo = '';

      if (body.text?.message) {
        tipo = 'texto';
        corpo = body.text.message;
      } else if (body.image) {
        tipo = 'imagem';
        corpo = body.image.caption || '📷 Imagem';
      } else if (body.audio) {
        tipo = 'audio';
        corpo = '🎵 Áudio';
      } else if (body.video) {
        tipo = 'video';
        corpo = body.video.caption || '🎥 Vídeo';
      } else if (body.document) {
        tipo = 'documento';
        corpo = body.document.fileName || '📄 Documento';
      } else if (body.location) {
        tipo = 'localizacao';
        corpo = `📍 ${body.location.latitude}, ${body.location.longitude}`;
      } else if (body.contact) {
        tipo = 'contato';
        corpo = `👤 ${body.contact.displayName || 'Contato'}`;
      } else if (body.sticker) {
        tipo = 'sticker';
        corpo = '🎭 Sticker';
      } else if (typeof body.text === 'string') {
        tipo = 'texto';
        corpo = body.text;
      }

      if (!waMessageId) {
        logger.warn({ body: JSON.stringify(body).substring(0, 200) }, '[Webhook] Mensagem sem ID');
        return;
      }

      const resultado = await whatsappService.processarMensagemRecebida({
        telefone,
        nome,
        corpo,
        tipo,
        waMessageId,
        isGroup,
      });

      if (resultado) {
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
      return;
    }

    // ---- STATUS DE MENSAGEM (enviada, entregue, lida) ----
    if (body.status && body.id?.id) {
      const { atualizarStatusEnvio } = require('../messages/messages.service');
      const statusMap = {
        'SENT': 'enviada',
        'RECEIVED': 'entregue',
        'READ': 'lida',
        'PLAYED': 'lida',
      };
      const novoStatus = statusMap[body.status];
      if (novoStatus) {
        await atualizarStatusEnvio({ waMessageId: body.id.id, status: novoStatus });
        broadcast('mensagem:status', { waMessageId: body.id.id, status: novoStatus });
      }
      return;
    }

    // ---- CONEXÃO/DESCONEXÃO ----
    if (body.connected !== undefined) {
      if (body.connected) {
        conexaoWA.status = 'conectado';
        conexaoWA.inicioConexao = new Date();
        logger.info('[Webhook] Z-API conectada via webhook');
        broadcast('whatsapp:conectado', { nome: 'WhatsApp', numero: '' });
      } else {
        conexaoWA.status = 'desconectado';
        logger.warn('[Webhook] Z-API desconectada via webhook');
        broadcast('whatsapp:desconectado', {});
      }
      return;
    }

  } catch (err) {
    logger.error({ err: err.message }, '[Webhook] Erro ao processar');
  }
});

module.exports = router;