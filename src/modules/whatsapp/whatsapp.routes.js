// src/modules/whatsapp/whatsapp.routes.js
// Rotas WhatsApp — Z-API + Webhook (CORRIGIDO — revoke pago + stickers galeeeeeria)

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

// POST /api/whatsapp/enviar-audio — enviar áudio base64
router.post('/enviar-audio', verificarToken, limiteSensivel, async (req, res, next) => {
  try {
    const { ticket_id, audio_base64 } = req.body;
    if (!ticket_id || !audio_base64) return res.status(400).json({ erro: 'ticket_id e audio_base64 são obrigatórios' });

    const mensagem = await whatsappService.enviarAudio({ ticketId: ticket_id, audioBase64: audio_base64, usuarioId: req.usuario.id });
    res.json({ sucesso: true, mensagem });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/enviar-imagem
router.post('/enviar-imagem', verificarToken, limiteSensivel, async (req, res, next) => {
  try {
    const { ticket_id, imagem_base64, caption } = req.body;
    if (!ticket_id || !imagem_base64) return res.status(400).json({ erro: 'ticket_id e imagem_base64 são obrigatórios' });

    const mensagem = await whatsappService.enviarImagem({ ticketId: ticket_id, imagemBase64: imagem_base64, caption, usuarioId: req.usuario.id });
    res.json({ sucesso: true, mensagem });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/enviar-video
router.post('/enviar-video', verificarToken, limiteSensivel, async (req, res, next) => {
  try {
    const { ticket_id, video_base64, caption } = req.body;
    if (!ticket_id || !video_base64) return res.status(400).json({ erro: 'ticket_id e video_base64 são obrigatórios' });

    const mensagem = await whatsappService.enviarVideo({ ticketId: ticket_id, videoBase64: video_base64, caption, usuarioId: req.usuario.id });
    res.json({ sucesso: true, mensagem });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/enviar-documento
router.post('/enviar-documento', verificarToken, limiteSensivel, async (req, res, next) => {
  try {
    const { ticket_id, documento_base64, file_name } = req.body;
    if (!ticket_id || !documento_base64) return res.status(400).json({ erro: 'ticket_id e documento_base64 são obrigatórios' });

    const mensagem = await whatsappService.enviarDocumento({ ticketId: ticket_id, documentoBase64: documento_base64, fileName: file_name, usuarioId: req.usuario.id });
    res.json({ sucesso: true, mensagem });
  } catch (err) {
    next(err);
  }
});

// GET /api/whatsapp/foto-perfil/:telefone
router.get('/foto-perfil/:telefone', verificarToken, async (req, res) => {
  const url = await whatsappService.buscarFotoPerfil(req.params.telefone);
  res.json({ url });
});

// POST /api/whatsapp/atualizar-fotos — busca foto de perfil de todos os contatos sem avatar
router.post('/atualizar-fotos', verificarToken, verificarAdmin, async (req, res) => {
  const { query: dbQuery } = require('../../config/database');
  const contatos = await dbQuery(`SELECT id, telefone FROM contatos WHERE avatar_url IS NULL LIMIT 50`);
  let atualizados = 0;
  for (const contato of contatos.rows) {
    try {
      const url = await whatsappService.buscarFotoPerfil(contato.telefone);
      if (url) {
        await dbQuery(`UPDATE contatos SET avatar_url = $1, atualizado_em = NOW() WHERE id = $2`, [url, contato.id]);
        atualizados++;
      }
      await new Promise(r => setTimeout(r, 500));
    } catch { /* ignorar */ }
  }
  res.json({ sucesso: true, total: contatos.rows.length, atualizados });
});

// POST /api/whatsapp/iniciar-conversa
router.post('/iniciar-conversa', verificarToken, async (req, res, next) => {
  try {
    const { telefone, mensagem, contato_id } = req.body;
    if (!telefone || !mensagem) return res.status(400).json({ erro: 'telefone e mensagem são obrigatórios' });

    const resultado = await whatsappService.iniciarConversa({ telefone, mensagem, contatoId: contato_id, usuarioId: req.usuario.id });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/reagir
router.post('/reagir', verificarToken, async (req, res, next) => {
  try {
    const { mensagem_id, emoji } = req.body;
    if (!mensagem_id || !emoji) return res.status(400).json({ erro: 'mensagem_id e emoji são obrigatórios' });

    const resultado = await whatsappService.reagirMensagem(mensagem_id, emoji);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/whatsapp/deletar-mensagem/:id
router.delete('/deletar-mensagem/:id', verificarToken, async (req, res, next) => {
  try {
    const resultado = await whatsappService.deletarMensagem(req.params.id);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/encaminhar
router.post('/encaminhar', verificarToken, async (req, res, next) => {
  try {
    const { mensagem_id, telefone_destino } = req.body;
    if (!mensagem_id || !telefone_destino) return res.status(400).json({ erro: 'mensagem_id e telefone_destino são obrigatórios' });

    const resultado = await whatsappService.encaminharMensagem(mensagem_id, telefone_destino);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/enviar-sticker
router.post('/enviar-sticker', verificarToken, async (req, res, next) => {
  try {
    const { ticketId, stickerUrl } = req.body;
    if (!ticketId || !stickerUrl) return res.status(400).json({ erro: 'ticketId e stickerUrl são obrigatórios' });

    const resultado = await whatsappService.enviarSticker(ticketId, stickerUrl);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// GET /api/whatsapp/stickers-galeria — listar stickers recebidos
router.get('/stickers-galeria', verificarToken, async (req, res, next) => {
  try {
    const stickers = await whatsappService.listarStickersGaleria({ limite: parseInt(req.query.limite) || 30 });
    res.json({ stickers });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/reconectar
router.post('/reconectar', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await whatsappService.reconectar();
    res.json({ sucesso: true, status: whatsappService.obterStatus() });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/logout
router.post('/logout', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await whatsappService.forcarLogout();
    res.json({ sucesso: true });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// WEBHOOK Z-API — recebe TUDO (mensagens, status, conexão)
// MELHORADO: revoke robusto para plano pago Z-API
// ============================================================
router.post('/webhook', async (req, res) => {
  res.status(200).json({ status: 'ok' });

  try {
    const body = req.body;
    if (!body) return;

    // Log completo pra debug
    logger.info({
      tipo: body.type || body.status || 'desconhecido',
      phone: body.phone,
      chatLid: body.chatLid || null,
      fromMe: body.fromMe,
      hasText: !!body.text,
      hasImage: !!body.image,
      hasAudio: !!body.audio,
      hasSticker: !!body.sticker,
      isRevoked: body.isRevoked,
      isReaction: body.isReaction,
      isEdit: body.isEdit,
      waitingMessage: body.waitingMessage,
    }, '[Webhook] Payload recebido');

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

    // ---- PRESENÇA / DIGITANDO ----
    if (body.type === 'presence' || body.presence || body.act === 'composing' || body.act === 'paused' || body.act === 'recording') {
      const phone = body.phone || body.from || body.chatId;
      const act = body.act || body.presence || body.type;
      if (phone) {
        const telefoneLimpo = String(phone).replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
        broadcast('contato:digitando', { telefone: telefoneLimpo, acao: act });
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
    if (body.isStatusReply || body.isNotification) return;

    // ---- REAÇÃO RECEBIDA ----
    if (body.isReaction || body.type === 'reaction') {
      const msgId = body.messageId || body.referenceMessageId || body.reactionMessage?.messageId || body.reactionBy?.messageId;
      const emoji = body.reaction || body.reactionMessage?.reaction || body.reactionBy?.reaction || body.text;
      if (msgId && emoji) {
        const { query: dbQuery } = require('../../config/database');
        const result = await dbQuery(`UPDATE mensagens SET reacao = $1 WHERE wa_message_id = $2 RETURNING id`, [emoji, msgId]);
        if (result.rows.length > 0) {
          broadcast('mensagem:reacao', { mensagemId: result.rows[0].id, reacao: emoji });
          logger.info({ msgId, emoji, dbId: result.rows[0].id }, '[Webhook] Reação salva');
        } else {
          logger.warn({ msgId, emoji }, '[Webhook] Reação recebida mas mensagem não encontrada no banco');
        }
      }
      return;
    }

    // ============================================================
    // MENSAGEM APAGADA (REVOKED) — suporte completo Z-API pago
    // Z-API pode mandar como:
    //   - type=revoked
    //   - isRevoked=true
    //   - type=delete
    //   - waitingMessage=true (mensagem auto-destruição)
    //   - type=protocolMessage com subtype=REVOKE
    //   - body.protocolMessage?.type === 0 (REVOKE no protocolo interno)
    // ============================================================
    const isRevokeEvent = (
      body.type === 'revoked' ||
      body.isRevoked === true ||
      body.type === 'delete' ||
      (body.waitingMessage === true && !body.text && !body.image && !body.audio && !body.video && !body.document && !body.sticker) ||
      body.type === 'protocolMessage' ||
      (body.protocolMessage && body.protocolMessage.type === 0)
    );

    if (isRevokeEvent && !body.phone) {
      // Revoke SEM phone (evento global)
      const msgId = body.messageId || body.id?.id || body.referenceMessageId || body.ids?.[0]?.id
        || body.protocolMessage?.key?.id;

      logger.info({
        msgId,
        type: body.type,
        isRevoked: body.isRevoked,
        waitingMessage: body.waitingMessage,
        hasProtocolMessage: !!body.protocolMessage,
        bodyKeys: Object.keys(body),
      }, '[Webhook] Evento de mensagem apagada (sem phone)');

      if (msgId) {
        const { query: dbQuery } = require('../../config/database');
        const result = await dbQuery(
          `UPDATE mensagens SET deletada = TRUE, deletada_por = 'contato'
           WHERE wa_message_id = $1 AND deletada = FALSE RETURNING id, ticket_id`,
          [msgId]
        );
        if (result.rows.length > 0) {
          broadcast('mensagem:deletada', { mensagemId: result.rows[0].id, ticketId: result.rows[0].ticket_id });
          logger.info({ msgId, dbId: result.rows[0].id }, '[Webhook] Mensagem marcada como apagada');
        }
      }
      return;
    }

    // ---- MENSAGEM (texto, mídia, localização, contato, sticker) ----
    if (body.phone) {
      // Limpar telefone — detectar @lid ANTES de limpar
      let telefoneRaw = String(body.phone);
      const isLidRaw = telefoneRaw.includes('@lid');
      let telefone = telefoneRaw.replace('@c.us', '').replace('@s.whatsapp.net', '').replace('@g.us', '').replace('@lid', '').replace(/\D/g, '');

      // ===== CHAVE DO FIX: extrair chatLid do webhook =====
      // Z-API envia chatLid como campo separado — é o LID ESTÁVEL da conversa
      // Quando fromMe=true: chatLid = "7443250466429@lid", phone = "7443250466429@lid"
      // Quando fromMe=false (resposta): chatLid = "7443250466429@lid", phone = "557193908345" (REAL!)
      const chatLidRaw = body.chatLid ? String(body.chatLid).replace('@lid', '').replace(/\D/g, '') : null;

      const isGroup = body.isGroup || false;
      const fromMe = body.fromMe || false;

      // ---- MENSAGEM APAGADA COM PHONE (revoke pode vir junto com phone) ----
      const isRevokeComPhone = (
        body.waitingMessage === true ||
        body.isRevoked === true ||
        body.type === 'revoked' ||
        body.type === 'delete' ||
        body.type === 'protocolMessage' ||
        (body.protocolMessage && body.protocolMessage.type === 0)
      );

      // Só tratar como revoke se NÃO tem conteúdo de mensagem real
      const temConteudoReal = body.text || body.image || body.audio || body.video || body.document || body.sticker || body.location || body.contactMessage || body.contact;

      if (isRevokeComPhone && !temConteudoReal) {
        const msgId = body.messageId || body.id?.id || body.referenceMessageId
          || body.protocolMessage?.key?.id || body.ids?.[0]?.id;

        logger.info({
          msgId,
          telefone,
          waitingMessage: body.waitingMessage,
          isRevoked: body.isRevoked,
          type: body.type,
          hasProtocolMessage: !!body.protocolMessage,
        }, '[Webhook] Mensagem apagada (com phone)');

        if (msgId) {
          const { query: dbQuery } = require('../../config/database');
          const result = await dbQuery(
            `UPDATE mensagens SET deletada = TRUE, deletada_por = $1
             WHERE wa_message_id = $2 AND deletada = FALSE RETURNING id, ticket_id`,
            [fromMe ? 'atendente' : 'contato', msgId]
          );
          if (result.rows.length > 0) {
            broadcast('mensagem:deletada', { mensagemId: result.rows[0].id, ticketId: result.rows[0].ticket_id });
            logger.info({ msgId, dbId: result.rows[0].id, deletadaPor: fromMe ? 'atendente' : 'contato' }, '[Webhook] Mensagem marcada como apagada');
          }
        }
        return;
      }

      // DEBUG: Quando fromMe, logar campos pra encontrar telefone real
      if (fromMe) {
        logger.info({
          phone: body.phone, chatId: body.chatId, chat: body.chat,
          from: body.from, to: body.to, participant: body.participant,
          senderPhone: body.senderPhone, chatPhone: body.chatPhone,
          chatName: body.chatName, senderName: body.senderName,
          connectedPhone: body.connectedPhone,
        }, '[Webhook] fromMe DEBUG — campos disponíveis');
      }

      // Nome do contato/grupo
      let nome;
      let nomeParticipante = null;
      if (isGroup) {
        nome = body.chatName || body.groupName || `Grupo ${telefone}`;
        nomeParticipante = body.senderName || body.pushName || body.participantName || 'Participante';
      } else {
        nome = body.chatName || body.senderName || body.pushName || body.name || telefone;
      }

      logger.info(`[Webhook] tel=${telefone} fromMe=${fromMe} isGroup=${isGroup} nome=${nome} isLidRaw=${isLidRaw} chatLid=${chatLidRaw}`);

      // messageId
      const waMessageId = body.messageId || body.id?.id || body.zapiMessageId || body.id?._serialized || body.ids?.[0]?.id;

      let waMessageIdFinal;
      if (!waMessageId) {
        waMessageIdFinal = `zapi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        logger.warn({ bodyKeys: Object.keys(body), phone: telefone, isGroup }, '[Webhook] Sem messageId — usando fallback');
      } else {
        waMessageIdFinal = waMessageId;
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
        mediaUrl = body.sticker.stickerUrl || body.sticker.url || body.sticker.pngUrl || null;
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

      // Se não conseguiu extrair nada, logar detalhes
      if (!corpo && !mediaUrl) {
        logger.warn({
          bodyKeys: Object.keys(body),
          waMessageId: waMessageIdFinal,
          isGroup,
          waitingMessage: body.waitingMessage,
          isRevoked: body.isRevoked,
          isEdit: body.isEdit,
          type: body.type,
          fromMe: body.fromMe,
        }, '[Webhook] Mensagem sem corpo detectável');
        return;
      }

      // Processar
      const resultado = await whatsappService.processarMensagemRecebida({
        telefone, nome, corpo, tipo, waMessageId: waMessageIdFinal,
        isGroup, fromMe, mediaUrl, nomeParticipante, isLidRaw, chatLid: chatLidRaw,
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
