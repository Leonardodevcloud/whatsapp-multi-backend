// src/modules/whatsapp/whatsapp.routes.js
// Rotas WhatsApp — Z-API + Webhook (CORRIGIDO — revoke pago + stickers galeria)

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
    const { ticket_id, texto, quoted_message_id } = req.body;
    if (!ticket_id || !texto?.trim()) {
      return res.status(400).json({ erro: 'ticket_id e texto são obrigatórios' });
    }

    const mensagem = await whatsappService.enviarMensagemTexto({
      ticketId: ticket_id,
      texto: texto.trim(),
      usuarioId: req.usuario.id,
      quotedMessageId: quoted_message_id || null,
    });

    broadcast('mensagem:nova', { ...mensagem, ticket_id: parseInt(ticket_id) });

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
    broadcast('mensagem:nova', { ...mensagem, ticket_id: parseInt(ticket_id) });
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
    broadcast('mensagem:nova', { ...mensagem, ticket_id: parseInt(ticket_id) });
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
    broadcast('mensagem:nova', { ...mensagem, ticket_id: parseInt(ticket_id) });
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
    broadcast('mensagem:nova', { ...mensagem, ticket_id: parseInt(ticket_id) });
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
    if (resultado.ticket) {
      broadcast('ticket:atualizado', { id: resultado.ticket.id, status: resultado.ticket.status, acao: 'iniciar-conversa' });
    }
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
    broadcast('mensagem:nova', { ticket_id: parseInt(ticketId), tipo: 'sticker', media_url: stickerUrl, is_from_me: true });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// GET /api/whatsapp/stickers-galeria — listar stickers RECEBIDOS (das mensagens)
router.get('/stickers-galeria', verificarToken, async (req, res, next) => {
  try {
    const stickers = await whatsappService.listarStickersRecebidos({ limite: parseInt(req.query.limite) || 50 });
    res.json({ stickers });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/favoritar-sticker — salvar sticker como favorito
router.post('/favoritar-sticker', verificarToken, async (req, res, next) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ erro: 'url do sticker é obrigatória' });

    const { query: dbQuery } = require('../../config/database');
    await dbQuery(
      `INSERT INTO stickers_galeria (url) VALUES ($1) ON CONFLICT (url) DO UPDATE SET usado_em = NOW()`,
      [url]
    );
    res.json({ sucesso: true });
  } catch (err) { next(err); }
});

// DELETE /api/whatsapp/favoritar-sticker — remover sticker dos favoritos
router.delete('/favoritar-sticker', verificarToken, async (req, res, next) => {
  try {
    const url = req.query.url || req.body?.url;
    if (!url) return res.status(400).json({ erro: 'url do sticker é obrigatória' });

    const { query: dbQuery } = require('../../config/database');
    await dbQuery(`DELETE FROM stickers_galeria WHERE url = $1`, [url]);
    res.json({ sucesso: true });
  } catch (err) { next(err); }
});

// GET /api/whatsapp/stickers-favoritos — listar stickers favoritados pelo atendente
router.get('/stickers-favoritos', verificarToken, async (req, res, next) => {
  try {
    const stickers = await whatsappService.listarStickersGaleria({ limite: 50 });
    res.json({ stickers });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/mapear-lids — mapear LIDs de contatos via Z-API phone-exists
// Chama phone-exists pra cada contato sem lid (rate limited: 1/segundo)
router.post('/mapear-lids', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const limite = parseInt(req.query.limite) || parseInt(req.body.limite) || 50;
    const resultado = await whatsappService.mapearLidsContatos({ limite });
    res.json(resultado);
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

// PUT /api/whatsapp/editar-mensagem — editar mensagem enviada (até 15min)
router.put('/editar-mensagem', verificarToken, async (req, res, next) => {
  try {
    const { mensagem_id, novo_texto } = req.body;
    if (!mensagem_id || !novo_texto?.trim()) {
      return res.status(400).json({ erro: 'mensagem_id e novo_texto são obrigatórios' });
    }

    const resultado = await whatsappService.editarMensagem({
      mensagemId: mensagem_id,
      novoTexto: novo_texto.trim(),
      usuarioId: req.usuario.id,
    });

    broadcast('mensagem:editada', {
      mensagemId: resultado.id,
      ticketId: resultado.ticket_id,
      novoCorpo: resultado.corpo,
    });

    res.json({ sucesso: true, mensagem: resultado });
  } catch (err) {
    next(err);
  }
});

// GET /api/whatsapp/buscar-mensagens/:ticketId — busca texto no chat
router.get('/buscar-mensagens/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ erro: 'Busca precisa ter pelo menos 2 caracteres' });
    }

    const { query: dbQuery } = require('../../config/database');
    const resultado = await dbQuery(
      `SELECT m.id, m.corpo, m.tipo, m.is_from_me, m.criado_em, m.nome_participante,
              c.nome as contato_nome, u.nome as usuario_nome
       FROM mensagens m
       LEFT JOIN contatos c ON c.id = m.contato_id
       LEFT JOIN usuarios u ON u.id = m.usuario_id
       WHERE m.ticket_id = $1 AND m.corpo ILIKE $2 AND m.deletada = FALSE
       ORDER BY m.id DESC LIMIT 50`,
      [ticketId, `%${q.trim()}%`]
    );

    res.json({ resultados: resultado.rows, total: resultado.rows.length });
  } catch (err) {
    next(err);
  }
});

// GET /api/whatsapp/link-preview — busca Open Graph de uma URL
router.get('/link-preview', verificarToken, async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ erro: 'url é obrigatória' });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SynapseBot/1.0)' },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!resp.ok) return res.json({});

    const html = await resp.text();
    const getOg = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${prop}["']`, 'i'));
      return m ? m[1] : null;
    };
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);

    const result = {
      url,
      title: getOg('title') || (titleMatch ? titleMatch[1].trim() : null),
      description: getOg('description'),
      image: getOg('image'),
      siteName: getOg('site_name'),
    };

    if (!result.title) return res.json({});
    res.json(result);
  } catch {
    res.json({});
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

      // ---- MENSAGEM EDITADA PELO CONTATO ----
      // Z-API pode enviar isEdit como boolean, string, ou campo editedMessage
      const isEditEvent = body.isEdit === true || body.isEdit === 'true' || body.type === 'editedMessage' || !!body.editedMessage;
      if (isEditEvent && body.phone) {
        const msgId = body.messageId || body.id?.id || body.editedMessage?.id;
        const novoTexto = body.text?.message || body.text?.body || (typeof body.text === 'string' ? body.text : '') || body.message || body.editedMessage?.message || body.body;

        logger.info({ isEdit: body.isEdit, type: body.type, msgId, novoTexto: novoTexto?.substring(0, 50), bodyKeys: Object.keys(body) }, '[Webhook] Evento de edição detectado');

        if (msgId && novoTexto) {
          const { query: dbQuery } = require('../../config/database');
          const result = await dbQuery(
            `UPDATE mensagens SET corpo = $1, atualizado_em = NOW()
             WHERE wa_message_id = $2 RETURNING id, ticket_id`,
            [novoTexto, msgId]
          );
          if (result.rows.length > 0) {
            // Invalidar cache Redis
            const { invalidarCacheMensagens } = require('../messages/messages.service');
            await invalidarCacheMensagens(result.rows[0].ticket_id);

            broadcast('mensagem:editada', {
              mensagemId: result.rows[0].id,
              ticketId: result.rows[0].ticket_id,
              novoCorpo: novoTexto,
            });
            logger.info({ msgId, dbId: result.rows[0].id }, '[Webhook] Mensagem editada pelo contato');
          }
        }
        return;
      }

      // ---- MENSAGEM APAGADA COM PHONE (revoke pode vir junto com phone) ----
      // IMPORTANTE: isRevoked=true tem prioridade sobre temConteudoReal
      const isRevokeComPhone = (
        body.isRevoked === true ||
        body.type === 'revoked' ||
        body.type === 'delete' ||
        body.type === 'protocolMessage' ||
        (body.protocolMessage && body.protocolMessage.type === 0)
      );

      // waitingMessage SEM conteúdo real também é revoke
      const isWaitingRevoke = (body.waitingMessage === true && !body.text && !body.image && !body.audio && !body.video && !body.document && !body.sticker);

      if ((isRevokeComPhone || isWaitingRevoke) && !body.isEdit) {
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

        // Nome do participante — Z-API envia senderName como nome do perfil WhatsApp
        // Mas queremos o nome SALVO NA BASE DE CONTATOS (importados)
        let nomeDoZapi = body.senderName || body.pushName || body.participantName || body.notifyName || null;

        // Tentar buscar nome real na base de contatos pelo participantPhone ou participantLid
        const partPhone = body.participantPhone ? String(body.participantPhone).replace(/\D/g, '') : null;
        const partLid = body.participantLid ? String(body.participantLid).replace('@lid', '').replace(/\D/g, '') : null;

        if (partPhone || partLid) {
          try {
            const { query: dbQuery } = require('../../config/database');
            let contatoParticipante = null;

            // Buscar por telefone primeiro
            if (partPhone) {
              const r = await dbQuery(`SELECT nome FROM contatos WHERE telefone = $1 LIMIT 1`, [partPhone]);
              if (r.rows.length > 0) contatoParticipante = r.rows[0].nome;
            }

            // Se não achou, buscar por lid
            if (!contatoParticipante && partLid) {
              const r = await dbQuery(`SELECT nome FROM contatos WHERE lid = $1 LIMIT 1`, [partLid]);
              if (r.rows.length > 0) contatoParticipante = r.rows[0].nome;
            }

            if (contatoParticipante) {
              nomeDoZapi = contatoParticipante;
              logger.info(`[Webhook] Participante encontrado na base: ${partPhone || partLid} → ${contatoParticipante}`);
            }
          } catch { /* não crítico */ }
        }

        nomeParticipante = nomeDoZapi || 'Participante';

        // Log debug
        logger.info({
          chatName: body.chatName,
          senderName: body.senderName,
          pushName: body.pushName,
          participantPhone: body.participantPhone,
          participantLid: body.participantLid,
          nomeResolvido: nomeParticipante,
        }, '[Webhook] Grupo — participante');
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

      // Se não conseguiu extrair nada, tentar capturar como edit/revoke
      if (!corpo && !mediaUrl) {
        // DEBUG: logar body COMPLETO pra diagnosticar formato Z-API
        logger.warn({
          bodyKeys: Object.keys(body),
          waMessageId: waMessageIdFinal,
          isGroup,
          waitingMessage: body.waitingMessage,
          isRevoked: body.isRevoked,
          isEdit: body.isEdit,
          type: body.type,
          fromMe: body.fromMe,
          editedMessage: body.editedMessage ? JSON.stringify(body.editedMessage).substring(0, 200) : null,
          protocolMessage: body.protocolMessage ? JSON.stringify(body.protocolMessage).substring(0, 200) : null,
          referenceMessageId: body.referenceMessageId,
          bodyFull: JSON.stringify(body).substring(0, 500),
        }, '[Webhook] Mensagem sem corpo detectável — DEBUG COMPLETO');

        // LAST RESORT: se tem referenceMessageId + nenhum conteúdo, é revoke
        const refMsgId = body.referenceMessageId || body.protocolMessage?.key?.id;
        if (refMsgId) {
          const { query: dbQuery } = require('../../config/database');
          const result = await dbQuery(
            `UPDATE mensagens SET deletada = TRUE, deletada_por = $1
             WHERE wa_message_id = $2 AND deletada = FALSE RETURNING id, ticket_id`,
            [fromMe ? 'atendente' : 'contato', refMsgId]
          );
          if (result.rows.length > 0) {
            broadcast('mensagem:deletada', { mensagemId: result.rows[0].id, ticketId: result.rows[0].ticket_id });
            logger.info({ refMsgId, dbId: result.rows[0].id }, '[Webhook] Revoke capturado via last-resort');
          }
        }
        return;
      }

      // ============================================================
      // BROADCAST ANTECIPADO — mensagem aparece INSTANTANEAMENTE
      // Quick lookup: 2 queries rápidas pra achar contato + ticket
      // Broadcast preview → frontend mostra na hora
      // Processamento pesado (LID, merge, avatar) roda DEPOIS
      // ============================================================
      if (!fromMe && corpo) {
        try {
          const { query: dbQuery } = require('../../config/database');
          const telefoneBusca = telefone.replace('@c.us', '').replace('@lid', '').replace('@s.whatsapp.net', '').replace(/\D/g, '');

          // 1 query: achar contato por chatLid, lid ou telefone
          const contatoRapido = await dbQuery(
            `SELECT c.id, c.nome, c.telefone, c.avatar_url FROM contatos c
             WHERE c.lid = $1 OR c.telefone = $1 OR c.telefone = $2 OR c.lid = $2
             LIMIT 1`,
            [chatLidRaw || telefoneBusca, telefoneBusca]
          );

          if (contatoRapido.rows.length > 0) {
            const ct = contatoRapido.rows[0];
            // 2 query: achar ticket aberto/pendente desse contato
            const ticketRapido = await dbQuery(
              `SELECT id FROM tickets WHERE contato_id = $1 AND status NOT IN ('fechado') ORDER BY id DESC LIMIT 1`,
              [ct.id]
            );
            if (ticketRapido.rows.length > 0) {
              // Broadcast INSTANTÂNEO — frontend mostra a mensagem agora
              broadcast('mensagem:nova', {
                id: `preview_${Date.now()}`,
                ticket_id: ticketRapido.rows[0].id,
                corpo,
                tipo,
                media_url: mediaUrl,
                is_from_me: false,
                is_internal: false,
                status_envio: 'entregue',
                criado_em: new Date().toISOString(),
                contato: { id: ct.id, nome: ct.nome || nome || telefoneBusca, telefone: ct.telefone },
                nome_participante: isGroup ? nomeParticipante : null,
                _preview: true, // Flag pra safety refetch substituir
              });
              logger.info({ ticketId: ticketRapido.rows[0].id, telefone: telefoneBusca }, '[Webhook] Preview broadcast instantâneo');
            }
          }
        } catch (previewErr) {
          // Preview falhou — não crítico, o processamento normal vai broadcastar depois
          logger.warn({ err: previewErr.message }, '[Webhook] Preview broadcast falhou');
        }
      }

      // Processar (pesado — LID, merge, avatar, etc)
      const resultado = await whatsappService.processarMensagemRecebida({
        telefone, nome, corpo, tipo, waMessageId: waMessageIdFinal,
        isGroup, fromMe, mediaUrl, nomeParticipante, isLidRaw, chatLid: chatLidRaw,
      });

      if (resultado) {
        broadcast('mensagem:nova', resultado);

        // Invalidar cache Redis das listagens (preview do ticket mudou)
        try {
          const { invalidarCacheListagens } = require('../tickets/tickets.service');
          const { invalidarCacheMensagens } = require('../messages/messages.service');
          await invalidarCacheListagens();
          await invalidarCacheMensagens(resultado.ticket_id);
        } catch (_) {}

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
