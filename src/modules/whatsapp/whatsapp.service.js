// src/modules/whatsapp/whatsapp.service.js
// FIX DEFINITIVO: chatLid como CHAVE PRINCIPAL, phone como secundário
// Baseado na documentação oficial Z-API e boas práticas de tratamento @lid

const conexaoWA = require('./whatsapp.connection');
const { query, getClient } = require('../../config/database');
const AppError = require('../../shared/AppError');
const logger = require('../../shared/logger');
const { uploadMidia } = require('../../shared/mediaUpload');

// ============================================================
// ENVIAR MENSAGEM DE TEXTO
// ============================================================
async function enviarMensagemTexto({ ticketId, texto, usuarioId, quotedMessageId, mentioned }) {
  if (conexaoWA.status !== 'conectado' && conexaoWA.instanceId && conexaoWA.token) {
    conexaoWA.status = 'conectado';
  }
  if (conexaoWA.status !== 'conectado') {
    throw new AppError('WhatsApp não está conectado.', 503);
  }

  const resultado = await query(
    `SELECT c.telefone, c.lid FROM tickets t JOIN contatos c ON c.id = t.contato_id WHERE t.id = $1`,
    [ticketId]
  );
  if (resultado.rows.length === 0) throw new AppError('Ticket não encontrado', 404);

  const { telefone, lid } = resultado.rows[0];
  // Z-API: grupos precisam do sufixo -group no phone
  const ehGrupo = telefone && (telefone.startsWith('120363') || telefone.includes('-'));
  const destino = ehGrupo 
    ? (telefone.includes('-group') ? telefone : `${telefone}-group`)
    : (lid ? `${lid}@lid` : telefone);

  logger.info(`[WA] Destino: tel=${telefone} ehGrupo=${ehGrupo} destino=${destino}`);

  try {
    const ticketCheck = await query(`SELECT status, usuario_id FROM tickets WHERE id = $1`, [ticketId]);
    const ticketData = ticketCheck.rows[0];

    if (ticketData?.status === 'pendente') {
      await query(
        `UPDATE tickets SET status = 'aberto', usuario_id = $1, atualizado_em = NOW() WHERE id = $2`,
        [usuarioId, ticketId]
      );
      const { registrarMensagemSistema } = require('../messages/messages.service');
      const nomeResult = await query(`SELECT nome FROM usuarios WHERE id = $1`, [usuarioId]);
      const nomeAtendente = nomeResult.rows[0]?.nome || 'Atendente';
      const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' });
      await registrarMensagemSistema({ ticketId, corpo: `${nomeAtendente} iniciou o atendimento às ${hora}`, usuarioId });
      logger.info({ ticketId, usuarioId }, '[WA] Chamado auto-aceito');
    } else if (ticketData?.usuario_id && ticketData.usuario_id !== usuarioId) {
      // Reatribuir ticket se outro usuário envia mensagem
      await query(`UPDATE tickets SET usuario_id = $1, atualizado_em = NOW() WHERE id = $2`, [usuarioId, ticketId]);
      logger.info({ ticketId, de: ticketData.usuario_id, para: usuarioId }, '[WA] Chamado reatribuído ao remetente');
    }

    // Buscar wa_message_id da mensagem citada pra enviar pro Z-API
    let waQuotedId = null;
    if (quotedMessageId) {
      const qResult = await query(`SELECT wa_message_id FROM mensagens WHERE id = $1`, [quotedMessageId]);
      waQuotedId = qResult.rows[0]?.wa_message_id || null;
    }

    // Prefixo com nome do atendente
    const nomeResult2 = await query(`SELECT nome FROM usuarios WHERE id = $1`, [usuarioId]);
    const nomeAtendente2 = nomeResult2.rows[0]?.nome || 'Atendente';
    const textoComPrefixo = `*${nomeAtendente2}:*\n${texto}`;

    // Enviar com fallback: LID → telefone
    let sent;
    try {
      sent = await conexaoWA.enviarTexto(destino, textoComPrefixo, { quotedMessageId: waQuotedId, mentioned: mentioned || [] });
    } catch (errEnvio) {
      // Se falhou com LID, tentar com telefone direto
      if (lid && destino !== telefone) {
        logger.warn({ destino, telefone }, '[WA] Falha com LID, tentando com telefone');
        sent = await conexaoWA.enviarTexto(telefone, textoComPrefixo, { quotedMessageId: waQuotedId, mentioned: mentioned || [] });
      } else {
        throw errEnvio;
      }
    }

    const msgResult = await query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio, quoted_message_id)
       VALUES ($1, $2, $3, 'texto', $4, TRUE, 'enviada', $5)
       RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em, quoted_message_id`,
      [ticketId, usuarioId, textoComPrefixo, sent.key.id, quotedMessageId || null]
    );

    await query(
      `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW() WHERE id = $2`,
      [textoComPrefixo.substring(0, 200), ticketId]
    );

    await _calcularTempoRespostaSeNecessario(ticketId);
    return msgResult.rows[0];
  } catch (err) {
    logger.error({ err: err.message, ticketId, destino }, '[WA] ERRO AO ENVIAR');
    throw new AppError(`Falha ao enviar: ${err.message}`, 500);
  }
}

async function _calcularTempoRespostaSeNecessario(ticketId) {
  try {
    const ticket = await query(`SELECT tempo_primeira_resposta_seg, criado_em FROM tickets WHERE id = $1`, [ticketId]);
    if (ticket.rows[0]?.tempo_primeira_resposta_seg !== null) return;
    const diffSeg = Math.floor((Date.now() - new Date(ticket.rows[0].criado_em).getTime()) / 1000);
    await query(`UPDATE tickets SET tempo_primeira_resposta_seg = $1 WHERE id = $2`, [diffSeg, ticketId]);
  } catch (err) {
    logger.error({ err, ticketId }, '[WA] Erro TPR');
  }
}

// ============================================================
// PROCESSAR MENSAGEM RECEBIDA — FIX DEFINITIVO
//
// REGRA DE NEGÓCIO:
//   🔑 chatLid = chave principal (SEMPRE)
//   📱 phone = campo variável (pode mudar / pode vir criptografado)
//   🔄 Sempre atualizar o phone quando real disponível
//   🔒 Nunca depender do phone para identificar o usuário
//   🚫 Grupos NÃO interferem com contatos 1:1
// ============================================================
async function processarMensagemRecebida({ telefone, nome, corpo, tipo, waMessageId, isGroup, fromMe, mediaUrl, nomeParticipante, isLidRaw, chatLid }) {
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // Deduplicação por waMessageId
    const duplicada = await client.query(`SELECT id FROM mensagens WHERE wa_message_id = $1`, [waMessageId]);
    if (duplicada.rows.length > 0) {
      await client.query('COMMIT');
      return null;
    }

    // Deduplicação por conteúdo (fix: iniciar conversa salva com ID sistema, webhook vem com ID real)
    // Se é fromMe e o mesmo texto foi enviado nos últimos 30 segundos, é duplicata
    if (fromMe && corpo) {
      const dupConteudo = await client.query(
        `SELECT id FROM mensagens
         WHERE corpo = $1 AND is_from_me = TRUE AND criado_em > NOW() - INTERVAL '30 seconds'
         LIMIT 1`,
        [corpo]
      );
      if (dupConteudo.rows.length > 0) {
        // Atualizar o waMessageId da mensagem existente pro ID real da Z-API
        await client.query(`UPDATE mensagens SET wa_message_id = $1 WHERE id = $2`, [waMessageId, dupConteudo.rows[0].id]);
        await client.query('COMMIT');
        logger.info({ waMessageId, existingId: dupConteudo.rows[0].id }, '[WA] Dedup por conteúdo — atualizado waMessageId');
        return null;
      }
    }

    const telefoneLimpo = telefone.replace('@c.us', '').replace('@lid', '').replace('@s.whatsapp.net', '').replace(/\D/g, '');

    // O phone é LID quando:
    // 1. O raw veio com @lid (nem sempre acontece!)
    // 2. O telefone limpo é igual ao chatLid
    // 3. HEURÍSTICA: telefone com >13 dígitos e não é grupo (Z-API às vezes manda LID sem @lid)
    // 4. HEURÍSTICA: telefone não começa com código de país válido (55=BR) e tem 12+ dígitos
    const isPhoneLid = (isLidRaw === true) ||
      (chatLid && telefoneLimpo === chatLid) ||
      (telefoneLimpo.length > 13 && !isGroup) ||
      (telefoneLimpo.length >= 12 && !telefoneLimpo.startsWith('55') && !isGroup);

    // O phone é REAL quando NÃO é LID
    const isPhoneReal = !isPhoneLid;

    logger.info({
      tel: telefoneLimpo,
      chatLid: chatLid || 'null',
      fromMe,
      isGroup,
      isPhoneLid,
      isPhoneReal,
      nome,
    }, '[WA] Processando mensagem');

    let contatoId;
    let contatoExistente = null;

    // ============================================================
    // BUSCA DE CONTATO — chatLid PRIMEIRO, phone DEPOIS
    // ============================================================

    // 1️⃣ BUSCAR POR chatLid (chave principal)
    if (chatLid && !isGroup) {
      const r = await client.query(
        `SELECT id, nome, telefone, avatar_url, lid FROM contatos WHERE lid = $1`,
        [chatLid]
      );
      if (r.rows.length > 0) {
        contatoExistente = r.rows[0];
        logger.info(`[WA] ✅ Contato encontrado por chatLid=${chatLid} → id=${contatoExistente.id} nome=${contatoExistente.nome}`);
      }
    }

    // 2️⃣ Se não achou por chatLid, buscar por telefone exato (pode ser real)
    if (!contatoExistente && isPhoneReal) {
      const r = await client.query(
        `SELECT id, nome, telefone, avatar_url, lid FROM contatos WHERE telefone = $1`,
        [telefoneLimpo]
      );
      if (r.rows.length > 0) {
        contatoExistente = r.rows[0];
        logger.info(`[WA] Contato encontrado por telefone real=${telefoneLimpo} → id=${contatoExistente.id}`);

        // 2️⃣.B AUTO-MERGE: Se NÃO é fromMe, verificar se existe contato LID recente
        // que deveria ser o mesmo (você mandou pelo celular → criou LID → pessoa respondeu)
        // CUIDADO: SÓ mergear quando temos CERTEZA (nomes batem). Sem chatLid é arriscado.
        if (!fromMe && !isGroup && nome && !/^\d+$/.test(nome)) {
          const lidRecente = await client.query(
            `SELECT c.id, c.nome, c.telefone, c.lid
             FROM contatos c
             JOIN tickets t ON t.contato_id = c.id
             WHERE c.id != $1
               AND (LENGTH(c.telefone) > 13 OR (c.lid IS NOT NULL AND c.telefone != c.lid))
               AND t.status IN ('pendente', 'aberto', 'aguardando')
               AND t.ultima_mensagem_em > NOW() - INTERVAL '4 hours'
               AND LOWER(c.nome) = LOWER($2)
             ORDER BY t.ultima_mensagem_em DESC
             LIMIT 1`,
            [contatoExistente.id, nome]
          );

          if (lidRecente.rows.length === 1) {
            const contatoLid = lidRecente.rows[0];
            logger.info(`[WA] 🔀 AUTO-MERGE: LID contato ${contatoLid.id} (${contatoLid.telefone}) → real contato ${contatoExistente.id} (${telefoneLimpo}) [nome=${nome}]`);

            await client.query(`UPDATE tickets SET contato_id = $1 WHERE contato_id = $2`, [contatoExistente.id, contatoLid.id]);
            await client.query(`UPDATE mensagens SET contato_id = $1 WHERE contato_id = $2`, [contatoExistente.id, contatoLid.id]);

            const lidValue = contatoLid.lid || contatoLid.telefone;
            if (!contatoExistente.lid) {
              await client.query(`UPDATE contatos SET lid = $1, atualizado_em = NOW() WHERE id = $2`, [lidValue, contatoExistente.id]);
            }

            await client.query(`DELETE FROM contato_tags WHERE contato_id = $1`, [contatoLid.id]);
            await client.query(`DELETE FROM contatos WHERE id = $1`, [contatoLid.id]);
            logger.info(`[WA] 🔀 AUTO-MERGE concluído: contato LID ${contatoLid.id} deletado`);
          }
        }
      }
    }

    // 3️⃣ Se é LID no phone e não achou por chatLid, buscar pelo telefone=LID
    if (!contatoExistente && isPhoneLid) {
      const r = await client.query(
        `SELECT id, nome, telefone, avatar_url, lid FROM contatos WHERE telefone = $1 OR lid = $1`,
        [telefoneLimpo]
      );
      if (r.rows.length > 0) {
        contatoExistente = r.rows[0];
        logger.info(`[WA] Contato encontrado por telefone/lid LID=${telefoneLimpo} → id=${contatoExistente.id}`);
      }
    }

    // 4️⃣ fromMe com LID: buscar por nome pra mapear chatLid
    if (!contatoExistente && isPhoneLid && fromMe && nome && !/^\d+$/.test(nome)) {
      const r = await client.query(
        `SELECT id, nome, telefone, avatar_url, lid FROM contatos
         WHERE LOWER(nome) = LOWER($1) AND lid IS NULL
         ORDER BY id DESC LIMIT 1`,
        [nome]
      );
      if (r.rows.length > 0) {
        contatoExistente = r.rows[0];
        logger.info(`[WA] Contato encontrado por nome="${nome}" → id=${contatoExistente.id}, mapeando chatLid`);
      }
    }

    // ============================================================
    // CRIAR OU ATUALIZAR CONTATO
    // ============================================================

    if (contatoExistente) {
      contatoId = contatoExistente.id;

      // --- ATUALIZAR chatLid se não tinha ---
      if (chatLid && !contatoExistente.lid && !isGroup) {
        await client.query(`UPDATE contatos SET lid = $1, atualizado_em = NOW() WHERE id = $2`, [chatLid, contatoId]);
        logger.info(`[WA] 🔗 chatLid salvo: ${chatLid} → contato ${contatoId}`);
      }

      // --- ATUALIZAR telefone quando temos número REAL ---
      // Só atualiza se: phone é real E não é grupo
      if (isPhoneReal && !isGroup) {
        const telAtual = contatoExistente.telefone;
        const telAtualEhLid = telAtual && (telAtual.length > 13 || telAtual === contatoExistente.lid);

        if (telAtual !== telefoneLimpo && (telAtualEhLid || !telAtual)) {
          // VERIFICAR se já existe OUTRO contato com esse telefone real
          const contatoComTelReal = await client.query(
            `SELECT id FROM contatos WHERE telefone = $1 AND id != $2`,
            [telefoneLimpo, contatoId]
          );

          if (contatoComTelReal.rows.length > 0) {
            // MERGE: mover tickets e mensagens do contato duplicado pro atual
            const outroId = contatoComTelReal.rows[0].id;
            logger.info(`[WA] 🔀 MERGE: contato ${outroId} (tel=${telefoneLimpo}) será absorvido por ${contatoId}`);

            await client.query(`UPDATE tickets SET contato_id = $1 WHERE contato_id = $2`, [contatoId, outroId]);
            await client.query(`UPDATE mensagens SET contato_id = $1 WHERE contato_id = $2`, [contatoId, outroId]);
            await client.query(`DELETE FROM contato_tags WHERE contato_id = $1`, [outroId]);
            await client.query(`DELETE FROM contatos WHERE id = $1`, [outroId]);
            logger.info(`[WA] 🔀 MERGE concluído: contato ${outroId} deletado`);
          }

          // Agora sim atualizar o telefone (sem conflito)
          await client.query(
            `UPDATE contatos SET telefone = $1, atualizado_em = NOW() WHERE id = $2`,
            [telefoneLimpo, contatoId]
          );
          logger.info(`[WA] 📱 Telefone real atualizado: ${telAtual} → ${telefoneLimpo} (contato ${contatoId})`);
        }
      }

      // --- ATUALIZAR nome (só se veio nome real, não número) ---
      if (nome && !/^\d+$/.test(nome) && nome !== contatoExistente.nome) {
        await client.query(`UPDATE contatos SET nome = $1, atualizado_em = NOW() WHERE id = $2`, [nome, contatoId]);
      }

      // --- Buscar foto se não tem ---
      if (!contatoExistente.avatar_url && isPhoneReal) {
        buscarFotoPerfil(telefoneLimpo).then(url => {
          if (url) query(`UPDATE contatos SET avatar_url = $1 WHERE id = $2`, [url, contatoId]).catch(() => {});
        }).catch(() => {});
      }

    } else {
      // --- CRIAR NOVO CONTATO (com proteção contra duplicata) ---
      let avatarUrl = null;
      if (isPhoneReal) {
        try { avatarUrl = await buscarFotoPerfil(telefoneLimpo); } catch { }
      }

      const lidValue = chatLid || (isPhoneLid ? telefoneLimpo : null);

      // ON CONFLICT: se telefone já existe, retorna o existente em vez de crashar
      const novo = await client.query(
        `INSERT INTO contatos (nome, telefone, avatar_url, lid, is_group)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (telefone) DO UPDATE SET
           lid = COALESCE(contatos.lid, EXCLUDED.lid),
           nome = CASE WHEN EXCLUDED.nome ~ '^\d+$' THEN contatos.nome ELSE COALESCE(EXCLUDED.nome, contatos.nome) END,
           avatar_url = COALESCE(contatos.avatar_url, EXCLUDED.avatar_url),
           is_group = COALESCE(EXCLUDED.is_group, contatos.is_group),
           atualizado_em = NOW()
         RETURNING id`,
        [nome || telefoneLimpo, telefoneLimpo, avatarUrl, isGroup ? null : lidValue, !!isGroup]
      );
      contatoId = novo.rows[0].id;
      logger.info({ contatoId, telefone: telefoneLimpo, nome, lid: lidValue, isGroup }, '[WA] 🆕 Contato criado/encontrado');
    }

    // ============================================================
    // TICKET
    // ============================================================
    let ticketResult = await client.query(
      `SELECT id, status, usuario_id FROM tickets
       WHERE contato_id = $1 AND status NOT IN ('fechado')
       ORDER BY id DESC LIMIT 1`,
      [contatoId]
    );

    let ticketId;
    let ticketNovo = false;

    if (ticketResult.rows.length > 0) {
      ticketId = ticketResult.rows[0].id;
      if (ticketResult.rows[0].status === 'resolvido' && !fromMe) {
        await client.query(
          `UPDATE tickets SET status = 'pendente', usuario_id = NULL, assunto = NULL, assunto_cor = NULL, prioridade = NULL, criado_em = NOW(), atualizado_em = NOW(), tempo_primeira_resposta_seg = NULL, tempo_resolucao_seg = NULL WHERE id = $1`,
          [ticketId]
        );
      }
    } else {
      const protocolo = _gerarProtocolo();
      let filaId = null;
      // Só jogar pra Dispositivo Externo se fromMe=true E o telefone é real (não LID)
      // Z-API com LID às vezes marca fromMe=true incorretamente em mensagens recebidas
      if (fromMe && isPhoneReal && !isGroup) {
        const filaResult = await client.query(
          `SELECT id FROM filas WHERE nome = 'Dispositivo Externo' AND ativo = TRUE LIMIT 1`
        );
        if (filaResult.rows.length > 0) filaId = filaResult.rows[0].id;
        logger.info({ telefone: telefoneLimpo, chatLid }, '[WA] Ticket novo fromMe → Dispositivo Externo');
      } else if (fromMe) {
        logger.info({ telefone: telefoneLimpo, chatLid, isPhoneLid, isPhoneReal }, '[WA] fromMe=true mas telefone é LID — NÃO atribuindo a Dispositivo Externo');
      }

      const novo = await client.query(
        `INSERT INTO tickets (contato_id, status, protocolo, fila_id, ultima_mensagem_em)
         VALUES ($1, 'pendente', $2, $3, NOW()) RETURNING id`,
        [contatoId, protocolo, filaId]
      );
      ticketId = novo.rows[0].id;
      ticketNovo = true;
      logger.info({ ticketId, protocolo, fromMe, filaId }, '[WA] 🎫 Novo ticket');
    }

    // ============================================================
    // SALVAR MENSAGEM
    // ============================================================
    let corpoFinal = corpo || '';

    // Resolver menções @lid no texto (grupos: quando alguém marca outra pessoa)
    if (isGroup && corpoFinal && corpoFinal.includes('@')) {
      corpoFinal = await _resolverMencoesLid(client, corpoFinal);
    }

    const msgResult = await client.query(
      `INSERT INTO mensagens (ticket_id, contato_id, corpo, tipo, wa_message_id, is_from_me, status_envio, media_url, nome_participante)
       VALUES ($1, $2, $3, $4, $5, $6, 'entregue', $7, $8)
       RETURNING id, ticket_id, corpo, tipo, is_from_me, criado_em, media_url, nome_participante`,
      [ticketId, fromMe ? null : contatoId, corpoFinal, tipo, waMessageId, fromMe || false, mediaUrl || null, (isGroup && nomeParticipante) ? nomeParticipante : null]
    );

    await client.query(
      `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW() WHERE id = $2`,
      [(corpo || '📎 Mídia').substring(0, 200), ticketId]
    );

    // Stickers NÃO são mais salvos automaticamente — apenas quando usuário favoritar

    await client.query('COMMIT');

    // Invalidar cache de tickets (sidebar) — preview e badge mudaram
    try {
      const { invalidarCacheListagens } = require('../tickets/tickets.service');
      await invalidarCacheListagens();
    } catch (_) {}

    // ============================================================
    // UPLOAD MÍDIA PARA R2 (em background — não bloqueia a entrega)
    // Converte URL temporária Z-API → URL permanente R2
    // ============================================================
    if (mediaUrl && !fromMe) {
      const { uploadFromUrl } = require('../../shared/mediaUpload');
      // Executar sem await — background
      uploadFromUrl(mediaUrl, tipo).then(async (resultado) => {
        try {
          const novaUrl = typeof resultado === 'object' ? resultado.url : resultado;
          if (novaUrl && novaUrl !== mediaUrl) {
            await query(`UPDATE mensagens SET media_url = $1 WHERE id = $2`, [novaUrl, msgResult.rows[0].id]);
            logger.info({ msgId: msgResult.rows[0].id, tipo }, '[WA] Mídia recebida → R2');
          }
        } catch (err) {
          logger.warn({ err: err.message }, '[WA] Erro ao atualizar media_url pro R2');
        }
      }).catch(() => {});
    }

    if (!fromMe) {
      conexaoWA.marcarComoLida(waMessageId, telefoneLimpo);
    }

    const mensagemCompleta = {
      ...msgResult.rows[0],
      contato: { id: contatoId, nome: nome || telefoneLimpo, telefone: telefoneLimpo },
      ticketNovo,
      isGroup,
      nomeParticipante: isGroup ? nomeParticipante : null,
    };

    logger.info({ ticketId, waMessageId, tipo, fromMe, isGroup, contatoId }, '[WA] ✅ Mensagem processada');

    // Auto-classificação em background (não bloqueia)
    if (!fromMe && corpo) {
      _classificarTicketAuto(ticketId, corpo).catch(() => {});
      // Resposta automática fora do horário (com IA se possível)
      _respostaForaDoHorario(ticketId, corpo, contatoId, isGroup).catch(() => {});
      // Detecção de urgência
      _detectarUrgenciaIA(ticketId, corpo).catch(() => {});
      // Resposta automática inteligente
      _respostaAutoInteligente(ticketId, corpo, isGroup).catch(() => {});
    }

    return mensagemCompleta;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[WA] ERRO DETALHADO:', err);
    logger.error({ erro: err.message, stack: err.stack, waMessageId, telefone, isGroup }, '[WA] Erro ao processar');
    throw err;
  } finally {
    client.release();
  }
}

function _gerarProtocolo() {
  const data = new Date();
  const yyyymmdd = data.toISOString().slice(0, 10).replace(/-/g, '');
  const random = Math.floor(10000 + Math.random() * 90000);
  return `${yyyymmdd}-${random}`;
}

// ============================================================
// ENVIO DE MÍDIA
// ============================================================

async function enviarAudio({ ticketId, audioBase64, usuarioId }) {
  const telefone = await _obterDestinoDoTicket(ticketId);
  try {
    const response = await fetch(`${conexaoWA.baseUrl}/send-audio`, {
      method: 'POST', headers: conexaoWA.headers,
      body: JSON.stringify({ phone: telefone, audio: audioBase64 }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);

    // Upload para R2 (ou fallback base64)
    const mediaUrl = await uploadMidia(audioBase64, 'audio', { ticketId });

    const msgResult = await query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio, media_url)
       VALUES ($1, $2, '🎵 Áudio', 'audio', $3, TRUE, 'enviada', $4)
       RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em, media_url`,
      [ticketId, usuarioId, data.zapiMessageId || data.messageId || 'sent', mediaUrl]
    );
    await _atualizarPreviewTicket(ticketId, '🎵 Áudio');
    return msgResult.rows[0];
  } catch (err) {
    logger.error({ err: err.message, ticketId }, '[WA] Erro ao enviar áudio');
    throw new AppError(`Falha ao enviar áudio: ${err.message}`, 500);
  }
}

async function enviarImagem({ ticketId, imagemBase64, caption, usuarioId }) {
  const telefone = await _obterDestinoDoTicket(ticketId);
  try {
    const response = await fetch(`${conexaoWA.baseUrl}/send-image`, {
      method: 'POST', headers: conexaoWA.headers,
      body: JSON.stringify({ phone: telefone, image: imagemBase64, caption: caption || '' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);

    // Upload para R2 (ou fallback base64)
    const mediaUrl = await uploadMidia(imagemBase64, 'imagem', { ticketId });

    const msgResult = await query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio, media_url)
       VALUES ($1, $2, $3, 'imagem', $4, TRUE, 'enviada', $5)
       RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em, media_url`,
      [ticketId, usuarioId, caption || '📷 Imagem', data.zapiMessageId || data.messageId || 'sent', mediaUrl]
    );
    await _atualizarPreviewTicket(ticketId, caption || '📷 Imagem');
    return msgResult.rows[0];
  } catch (err) {
    logger.error({ err: err.message, ticketId }, '[WA] Erro ao enviar imagem');
    throw new AppError(`Falha ao enviar imagem: ${err.message}`, 500);
  }
}

async function enviarVideo({ ticketId, videoBase64, caption, usuarioId }) {
  const telefone = await _obterDestinoDoTicket(ticketId);
  try {
    const response = await fetch(`${conexaoWA.baseUrl}/send-video`, {
      method: 'POST', headers: conexaoWA.headers,
      body: JSON.stringify({ phone: telefone, video: videoBase64, caption: caption || '' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);

    // Upload para R2 (ou fallback base64)
    const mediaUrl = await uploadMidia(videoBase64, 'video', { ticketId });

    const msgResult = await query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio, media_url)
       VALUES ($1, $2, $3, 'video', $4, TRUE, 'enviada', $5)
       RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em, media_url`,
      [ticketId, usuarioId, caption || '🎥 Vídeo', data.zapiMessageId || data.messageId || 'sent', mediaUrl]
    );
    await _atualizarPreviewTicket(ticketId, caption || '🎥 Vídeo');
    return msgResult.rows[0];
  } catch (err) {
    logger.error({ err: err.message, ticketId }, '[WA] Erro ao enviar vídeo');
    throw new AppError(`Falha ao enviar vídeo: ${err.message}`, 500);
  }
}

async function enviarDocumento({ ticketId, documentoBase64, fileName, usuarioId }) {
  const telefone = await _obterDestinoDoTicket(ticketId);
  const ext = fileName?.split('.').pop() || 'pdf';
  try {
    const response = await fetch(`${conexaoWA.baseUrl}/send-document/${ext}`, {
      method: 'POST', headers: conexaoWA.headers,
      body: JSON.stringify({ phone: telefone, document: documentoBase64, fileName: fileName || 'arquivo' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);

    // Upload para R2 (ou fallback: sem media_url)
    const mediaUrl = await uploadMidia(documentoBase64, 'documento', { ticketId, fileName });

    const msgResult = await query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio, media_url, media_nome)
       VALUES ($1, $2, $3, 'documento', $4, TRUE, 'enviada', $5, $6)
       RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em, media_url, media_nome`,
      [ticketId, usuarioId, fileName || '📄 Documento', data.zapiMessageId || data.messageId || 'sent', mediaUrl, fileName]
    );
    await _atualizarPreviewTicket(ticketId, `📄 ${fileName || 'Documento'}`);
    return msgResult.rows[0];
  } catch (err) {
    logger.error({ err: err.message, ticketId }, '[WA] Erro ao enviar documento');
    throw new AppError(`Falha ao enviar documento: ${err.message}`, 500);
  }
}

async function buscarFotoPerfil(telefone) {
  if (!conexaoWA.instanceId || !conexaoWA.token || !telefone) return null;
  try {
    const response = await fetch(`${conexaoWA.baseUrl}/profile-picture?phone=${telefone}`, { headers: conexaoWA.headers });
    if (!response.ok) return null;
    const data = await response.json();
    return data.link || data.imgUrl || data.profilePicThumbObj?.imgFull || data.profilePictureUrl || data.eurl || data.url || null;
  } catch { return null; }
}

// ============================================================
// HELPERS
// ============================================================

// Obter destino pra envio — prioriza lid (Z-API aceita @lid)
/**
 * Auto-classificar ticket — APENAS por palavras-chave. Sem IA.
 * Rápido, previsível, zero falso positivo.
 */
/**
 * Resposta automática fora do horário de atendimento
 * Se tiver base de conhecimento relevante, responde com IA + aviso de fora do horário
 * Se não, manda só o aviso. Ticket fica na fila.
 */
async function _respostaForaDoHorario(ticketId, textoMensagem, contatoId, isGroup) {
  try {
    // Garantir tabela existe
    await query(`CREATE TABLE IF NOT EXISTS configuracao_horario (
      id SERIAL PRIMARY KEY,
      dia_semana INTEGER NOT NULL UNIQUE,
      ativo BOOLEAN DEFAULT FALSE,
      hora_abertura VARCHAR(5) DEFAULT '08:00',
      hora_fechamento VARCHAR(5) DEFAULT '18:00'
    )`);
    // Garantir coluna bloquear_grupos
    await query(`ALTER TABLE configuracao_horario ADD COLUMN IF NOT EXISTS bloquear_grupos BOOLEAN DEFAULT TRUE`).catch(() => {});

    // Seed dias se vazio
    const count = await query(`SELECT COUNT(*) as total FROM configuracao_horario`);
    if (parseInt(count.rows[0].total) === 0) {
      for (let d = 0; d <= 6; d++) {
        const ativo = d >= 1 && d <= 5;
        await query(`INSERT INTO configuracao_horario (dia_semana, ativo, hora_abertura, hora_fechamento) VALUES ($1, $2, '08:00', '18:00')`, [d, ativo]);
      }
    }

    // Se for grupo, verificar se deve bloquear
    if (isGroup) {
      const configGrupo = await query(`SELECT bloquear_grupos FROM configuracao_horario LIMIT 1`);
      if (configGrupo.rows[0]?.bloquear_grupos !== false) return; // Default: bloqueia grupos
    }

    // Checar se tem horário configurado
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bahia' }));
    const diaSemana = agora.getDay(); // 0=dom, 6=sab
    const horaAtual = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;

    const config = await query(`SELECT * FROM configuracao_horario WHERE dia_semana = $1`, [diaSemana]);
    if (config.rows.length === 0) return;

    const dia = config.rows[0];

    // Se o dia tá ativo e dentro do horário, não faz nada
    if (dia.ativo && horaAtual >= dia.hora_abertura && horaAtual < dia.hora_fechamento) return;

    // Estamos FORA do horário! Verificar se já mandou resposta automática pro ticket
    const jaRespondeu = await query(
      `SELECT id FROM mensagens WHERE ticket_id = $1 AND is_from_me = TRUE AND corpo LIKE '%fora do horário%' AND criado_em > NOW() - INTERVAL '4 hours'`,
      [ticketId]
    );
    if (jaRespondeu.rows.length > 0) return; // Já mandou

    // Tentar responder com IA usando base de conhecimento
    let respostaIA = '';
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey && textoMensagem.length > 5) {
      const conhecimento = await query(`SELECT pergunta, resposta, categoria FROM ia_conhecimento WHERE ativo = TRUE`);
      if (conhecimento.rows.length > 0) {
        const baseTexto = conhecimento.rows.map(r => `[${r.categoria || 'Geral'}] P: ${r.pergunta}\nR: ${r.resposta}`).join('\n\n');

        const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
        try {
          const resp = await fetch(`${GEMINI_API}?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              system_instruction: { parts: [{ text: `Você é um assistente de atendimento da empresa. O atendimento está FORA DO HORÁRIO.
Analise a pergunta do contato e veja se a base de conhecimento abaixo tem informação relevante.
Se tiver, responda de forma curta e direta (máximo 3 frases). Interprete o SENTIDO, não as palavras exatas.
Se NÃO tiver informação relevante, responda APENAS: {"tem_resposta": false}
Se tiver, responda: {"tem_resposta": true, "resposta": "texto da resposta"}

Base de conhecimento:
${baseTexto}` }] },
              contents: [{ parts: [{ text: `Pergunta do contato: "${textoMensagem}"` }] }],
              generationConfig: { temperature: 0.2, maxOutputTokens: 300, responseMimeType: 'application/json' },
            }),
          });

          if (resp.ok) {
            const data = await resp.json();
            const texto = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            const match = texto.match(/\{[\s\S]*\}/);
            if (match) {
              const resultado = JSON.parse(match[0]);
              if (resultado.tem_resposta && resultado.resposta) {
                respostaIA = resultado.resposta;
              }
            }
          }
        } catch (e) {
          logger.error({ err: e.message }, '[Horário] Erro ao chamar IA');
        }
      }
    }

    // Montar mensagem final
    let mensagemAuto = '';
    if (respostaIA) {
      mensagemAuto = `🤖 *Atendimento automático:*\n${respostaIA}\n\n⏰ _Nosso horário de atendimento já encerrou. Amanhã um atendente dará continuidade ao seu chamado. Obrigado pela compreensão!_`;
    } else {
      mensagemAuto = `⏰ _Olá! Nosso horário de atendimento já encerrou. Amanhã um atendente entrará em contato. Obrigado pela compreensão!_`;
    }

    // Enviar via Z-API
    const destResult = await query(
      `SELECT c.telefone, c.lid FROM tickets t JOIN contatos c ON c.id = t.contato_id WHERE t.id = $1`,
      [ticketId]
    );
    if (destResult.rows.length === 0) return;

    const { telefone, lid } = destResult.rows[0];
    const destino = lid ? `${lid}@lid` : telefone;

    const sent = await conexaoWA.enviarTexto(destino, mensagemAuto);

    // Salvar no banco
    await query(
      `INSERT INTO mensagens (ticket_id, corpo, tipo, wa_message_id, is_from_me, status_envio)
       VALUES ($1, $2, 'texto', $3, TRUE, 'enviada')`,
      [ticketId, mensagemAuto, sent?.key?.id || null]
    );

    await query(
      `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW() WHERE id = $2`,
      [mensagemAuto.substring(0, 200), ticketId]
    );

    // Invalidar cache
    try {
      const { invalidarCacheListagens } = require('../tickets/tickets.service');
      await invalidarCacheListagens();
      const { invalidarCacheMensagens } = require('../messages/messages.service');
      await invalidarCacheMensagens(ticketId);
    } catch (_) {}

    const { broadcast } = require('../../websocket');
    broadcast('mensagem:nova', { ticket_id: ticketId });

    logger.info({ ticketId, temIA: !!respostaIA }, '[Horário] Resposta automática fora do horário enviada');
  } catch (err) {
    logger.error({ err: err.message, ticketId }, '[Horário] Erro na resposta fora do horário');
  }
}

/**
 * Detectar urgência via IA
 */
async function _detectarUrgenciaIA(ticketId, textoMensagem) {
  try {
    const { detectarUrgencia } = require('../ai/ai.service');
    await detectarUrgencia(ticketId, textoMensagem);
  } catch {}
}

/**
 * Resposta automática inteligente via IA
 */
async function _respostaAutoInteligente(ticketId, textoMensagem, isGroup) {
  try {
    const { respostaAutomaticaInteligente } = require('../ai/ai.service');
    const resposta = await respostaAutomaticaInteligente(ticketId, textoMensagem, isGroup);
    if (!resposta) return;

    // Enviar via Z-API
    const destResult = await query(
      `SELECT c.telefone, c.lid FROM tickets t JOIN contatos c ON c.id = t.contato_id WHERE t.id = $1`,
      [ticketId]
    );
    if (destResult.rows.length === 0) return;

    const { telefone, lid } = destResult.rows[0];
    const destino = lid ? `${lid}@lid` : telefone;

    const sent = await conexaoWA.enviarTexto(destino, resposta);

    await query(
      `INSERT INTO mensagens (ticket_id, corpo, tipo, wa_message_id, is_from_me, status_envio)
       VALUES ($1, $2, 'texto', $3, TRUE, 'enviada')`,
      [ticketId, resposta, sent?.key?.id || null]
    );

    await query(
      `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW() WHERE id = $2`,
      [resposta.substring(0, 200), ticketId]
    );

    const { broadcast } = require('../../websocket');
    broadcast('mensagem:nova', { ticket_id: ticketId });

    logger.info({ ticketId }, '[IA] Resposta automática inteligente enviada');
  } catch (err) {
    logger.error({ err: err.message }, '[IA] Erro na resposta auto inteligente');
  }
}

async function _classificarTicketAuto(ticketId, textoMensagem) {
  try {
    const textoLimpo = (textoMensagem || '').trim().toLowerCase();
    if (textoLimpo.length < 4) return;

    // Se o ticket JÁ tem tag, não sobrescrever até finalizar
    const ticketAtual = await query(`SELECT assunto FROM tickets WHERE id = $1`, [ticketId]);
    if (ticketAtual.rows[0]?.assunto) return;

    // Buscar regras ativas
    const regras = await query(`SELECT id, tag, palavras_chave, cor FROM ia_tags_regras WHERE ativo = TRUE`);
    if (regras.rows.length === 0) return;

    // Tokenizar texto (palavras individuais)
    const palavrasTexto = textoLimpo.replace(/[^a-záàâãéèêíïóôõöúçñ\s]/gi, '').split(/\s+/).filter(p => p.length >= 3);

    let melhorMatch = null;
    let maxHits = 0;

    for (const regra of regras.rows) {
      const keywords = regra.palavras_chave.split(',').map(p => p.trim().toLowerCase()).filter(Boolean);
      // Contar quantas keywords aparecem como palavras inteiras no texto
      const hits = keywords.filter(kw => palavrasTexto.includes(kw) || textoLimpo.includes(kw)).length;
      if (hits > maxHits) {
        maxHits = hits;
        melhorMatch = regra;
      }
    }

    if (!melhorMatch || maxHits === 0) return;

    // Aplicar tag + cor
    // Garantir coluna assunto_cor existe
    await query(`ALTER TABLE tickets ADD COLUMN IF NOT EXISTS assunto_cor VARCHAR(20)`).catch(() => {});

    await query(`UPDATE tickets SET assunto = $1, assunto_cor = $2, atualizado_em = NOW() WHERE id = $3`,
      [melhorMatch.tag, melhorMatch.cor || '#7c3aed', ticketId]);
    await query(`UPDATE ia_tags_regras SET acertos = acertos + 1 WHERE id = $1`, [melhorMatch.id]);

    try {
      const { invalidarCacheListagens } = require('../tickets/tickets.service');
      await invalidarCacheListagens();
    } catch (_) {}

    const { broadcast } = require('../../websocket');
    broadcast('ticket:atualizado', { ticketId, assunto: melhorMatch.tag, assunto_cor: melhorMatch.cor || '#7c3aed' });

    logger.info({ ticketId, tag: melhorMatch.tag, hits: maxHits }, '[IA Auto] Ticket classificado por keyword');
  } catch (err) {
    logger.error({ err: err.message, ticketId }, '[IA Auto] Erro na classificação');
  }
}

async function _obterDestinoDoTicket(ticketId) {
  if (conexaoWA.status !== 'conectado' && conexaoWA.instanceId && conexaoWA.token) {
    conexaoWA.status = 'conectado';
  }
  if (conexaoWA.status !== 'conectado') throw new AppError('WhatsApp não conectado', 503);

  const resultado = await query(
    `SELECT c.telefone, c.lid FROM tickets t JOIN contatos c ON c.id = t.contato_id WHERE t.id = $1`,
    [ticketId]
  );
  if (resultado.rows.length === 0) throw new AppError('Ticket não encontrado', 404);

  const { telefone, lid } = resultado.rows[0];

  // Pra GRUPOS: usar telefone com sufixo -group (padrão Z-API)
  const ehGrupo = telefone && (telefone.startsWith('120363') || telefone.includes('-'));
  if (ehGrupo) return telefone.includes('-group') ? telefone : `${telefone}-group`;

  // Pra 1:1: priorizar lid (mais estável segundo Z-API)
  return lid ? `${lid}@lid` : telefone;
}

async function _atualizarPreviewTicket(ticketId, preview) {
  await query(
    `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW() WHERE id = $2`,
    [preview.substring(0, 200), ticketId]
  );
  try {
    const { invalidarCacheListagens } = require('../tickets/tickets.service');
    await invalidarCacheListagens();
  } catch (_) {}
}

/**
 * Resolver menções @lid no texto de mensagens de grupo.
 * Substitui padrões como @121762792661023 pelo nome do contato se encontrado.
 * Se não encontrar, substitui por @participante (mais limpo que o número).
 */
async function _resolverMencoesLid(client, texto) {
  // Regex: captura @ seguido de 8+ dígitos (LIDs e telefones)
  const mencoes = texto.match(/@(\d{8,})/g);
  if (!mencoes || mencoes.length === 0) return texto;

  let textoResolvido = texto;

  for (const mencao of mencoes) {
    const numero = mencao.replace('@', '');

    // Buscar contato por lid, telefone, ou telefone parcial
    const contato = await client.query(
      `SELECT nome FROM contatos
       WHERE lid = $1 OR telefone = $1 OR telefone LIKE '%' || $1 || '%'
       LIMIT 1`,
      [numero]
    );

    if (contato.rows.length > 0 && contato.rows[0].nome) {
      textoResolvido = textoResolvido.replace(mencao, `@${contato.rows[0].nome}`);
    } else {
      // Não encontrou — manter como @participante (mais limpo)
      textoResolvido = textoResolvido.replace(mencao, '@participante');
    }
  }

  return textoResolvido;
}

function obterQrCode() { return null; }
function obterStatus() { return conexaoWA.obterStatus(); }
function obterConexao() { return { instanceId: conexaoWA.instanceId, token: conexaoWA.token, securityToken: conexaoWA.securityToken }; }
async function reconectar() { await conexaoWA.desconectar(); await conexaoWA.conectar(); }
async function forcarLogout() { await conexaoWA.desconectar(); }

// ============================================================
// INICIAR CONVERSA, REAGIR, DELETAR, ENCAMINHAR, STICKERS
// ============================================================

async function iniciarConversa({ telefone, mensagem, contatoId, usuarioId }) {
  const telefoneLimpo = telefone.replace(/\D/g, '');
  await conexaoWA.enviarTexto(telefoneLimpo, mensagem);

  const ticketExistente = await query(
    `SELECT t.id, t.status, t.protocolo, c.nome as contato_nome, c.telefone as contato_telefone, c.avatar_url as contato_avatar
     FROM tickets t LEFT JOIN contatos c ON c.id = t.contato_id
     WHERE t.contato_id = $1 AND t.status IN ('aberto', 'pendente', 'aguardando')
     ORDER BY t.id DESC LIMIT 1`,
    [contatoId]
  );

  let ticketId, protocolo;
  if (ticketExistente.rows.length > 0) {
    ticketId = ticketExistente.rows[0].id;
    protocolo = ticketExistente.rows[0].protocolo;
    await query(`UPDATE tickets SET status = 'aberto', usuario_id = $1, atualizado_em = NOW() WHERE id = $2`, [usuarioId, ticketId]);
  } else {
    const resolvido = await query(`SELECT id, protocolo FROM tickets WHERE contato_id = $1 AND status = 'resolvido' ORDER BY id DESC LIMIT 1`, [contatoId]);
    if (resolvido.rows.length > 0) {
      ticketId = resolvido.rows[0].id;
      protocolo = resolvido.rows[0].protocolo;
      await query(`UPDATE tickets SET status = 'aberto', usuario_id = $1, atualizado_em = NOW() WHERE id = $2`, [usuarioId, ticketId]);
    } else {
      protocolo = _gerarProtocolo();
      const novo = await query(
        `INSERT INTO tickets (contato_id, status, protocolo, usuario_id, ultima_mensagem_em) VALUES ($1, 'aberto', $2, $3, NOW()) RETURNING id`,
        [contatoId, protocolo, usuarioId]
      );
      ticketId = novo.rows[0].id;
    }
  }

  const waMessageId = `sistema_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await query(
    `INSERT INTO mensagens (ticket_id, contato_id, corpo, tipo, wa_message_id, is_from_me, status_envio) VALUES ($1, $2, $3, 'texto', $4, TRUE, 'enviada')`,
    [ticketId, contatoId, mensagem, waMessageId]
  );
  await _atualizarPreviewTicket(ticketId, mensagem);

  const ticketCompleto = await query(
    `SELECT t.*, c.nome as contato_nome, c.telefone as contato_telefone, c.avatar_url as contato_avatar
     FROM tickets t LEFT JOIN contatos c ON c.id = t.contato_id WHERE t.id = $1`,
    [ticketId]
  );

  logger.info({ ticketId, protocolo, telefone: telefoneLimpo, usuarioId }, '[WA] Conversa iniciada');
  return { sucesso: true, ticket: ticketCompleto.rows[0] };
}

async function reagirMensagem(mensagemId, emoji) {
  const msg = await query(`SELECT wa_message_id, ticket_id FROM mensagens WHERE id = $1`, [mensagemId]);
  if (msg.rows.length === 0) throw new AppError('Mensagem não encontrada', 404);
  const telefone = await _obterDestinoDoTicket(msg.rows[0].ticket_id);
  await conexaoWA.reagirMensagem(msg.rows[0].wa_message_id, telefone, emoji);
  await query(`UPDATE mensagens SET reacao = $1 WHERE id = $2`, [emoji, mensagemId]);
  return { sucesso: true };
}

async function deletarMensagem(mensagemId) {
  const msg = await query(`SELECT wa_message_id, ticket_id, is_from_me FROM mensagens WHERE id = $1`, [mensagemId]);
  if (msg.rows.length === 0) throw new AppError('Mensagem não encontrada', 404);
  if (!msg.rows[0].is_from_me) throw new AppError('Só é possível deletar mensagens enviadas por você', 400);
  const telefone = await _obterDestinoDoTicket(msg.rows[0].ticket_id);
  await conexaoWA.deletarMensagem(msg.rows[0].wa_message_id, telefone);
  await query(`UPDATE mensagens SET deletada = TRUE, deletada_por = 'atendente' WHERE id = $1`, [mensagemId]);

  const { invalidarCacheMensagens } = require('../messages/messages.service');
  await invalidarCacheMensagens(msg.rows[0].ticket_id);

  return { sucesso: true, mensagemId: parseInt(mensagemId), ticketId: msg.rows[0].ticket_id };
}

async function encaminharMensagem(mensagemId, telefoneDestino) {
  const msg = await query(
    `SELECT m.wa_message_id, m.ticket_id, m.corpo, m.tipo, m.media_url, c.nome as contato_nome
     FROM mensagens m LEFT JOIN tickets t ON t.id = m.ticket_id LEFT JOIN contatos c ON c.id = t.contato_id WHERE m.id = $1`,
    [mensagemId]
  );
  if (msg.rows.length === 0) throw new AppError('Mensagem não encontrada', 404);

  const telefoneOrigem = await _obterDestinoDoTicket(msg.rows[0].ticket_id);
  const telDestino = telefoneDestino.replace(/\D/g, '');
  const { wa_message_id, corpo, tipo, media_url, contato_nome } = msg.rows[0];

  try {
    await conexaoWA.encaminharMensagem(wa_message_id, telefoneOrigem, telDestino);
    return { sucesso: true, metodo: 'forward' };
  } catch (forwardErr) {
    logger.warn({ err: forwardErr.message }, '[WA] forward-message falhou, reenviando como texto');
  }

  const prefixo = `📨 *Encaminhada de ${contato_nome || 'contato'}:*\n\n`;
  if (tipo === 'imagem' && media_url) {
    await conexaoWA.enviarImagem(telDestino, media_url, prefixo + (corpo || ''));
  } else if (tipo === 'audio' && media_url) {
    await conexaoWA.enviarAudio(telDestino, media_url);
  } else if (tipo === 'video' && media_url) {
    await conexaoWA.enviarVideo(telDestino, media_url, prefixo + (corpo || ''));
  } else if (tipo === 'documento' && media_url) {
    await conexaoWA.enviarDocumento(telDestino, media_url, corpo || 'documento');
  } else {
    await conexaoWA.enviarTexto(telDestino, prefixo + (corpo || ''));
  }
  return { sucesso: true, metodo: 'reenvio' };
}

async function enviarSticker(ticketId, stickerUrl) {
  const telefone = await _obterDestinoDoTicket(ticketId);
  const result = await conexaoWA.enviarSticker(telefone, stickerUrl);
  const waMessageId = result.key?.id || `sticker_${Date.now()}`;
  const ticket = await query(`SELECT contato_id FROM tickets WHERE id = $1`, [ticketId]);
  const contatoId = ticket.rows[0]?.contato_id;

  await query(
    `INSERT INTO mensagens (ticket_id, contato_id, corpo, tipo, wa_message_id, is_from_me, media_url, status_envio)
     VALUES ($1, $2, '🎭 Sticker', 'sticker', $3, TRUE, $4, 'enviada')`,
    [ticketId, contatoId, waMessageId, stickerUrl]
  );
  await _atualizarPreviewTicket(ticketId, '🎭 Sticker');
  return { sucesso: true, waMessageId };
}

async function listarStickersGaleria({ limite = 30 }) {
  try {
    const resultado = await query(`SELECT id, url, usado_em FROM stickers_galeria ORDER BY usado_em DESC LIMIT $1`, [limite]);
    return resultado.rows;
  } catch { return []; }
}

/**
 * Mapear LIDs de contatos que ainda não têm lid salvo.
 * Usa Z-API phone-exists pra converter telefone → lid.
 * Rate limited: 1 request por segundo pra não sobrecarregar.
 */
async function mapearLidsContatos({ limite = 50 }) {
  if (!conexaoWA.instanceId || !conexaoWA.token) {
    throw new AppError('Z-API não configurada', 503);
  }

  // Buscar contatos sem lid e com telefone real (<=13 dígitos, começa com 55)
  const contatos = await query(
    `SELECT id, nome, telefone FROM contatos
     WHERE lid IS NULL
       AND telefone IS NOT NULL
       AND LENGTH(telefone) <= 13
       AND telefone ~ '^\\d+$'
     ORDER BY id DESC
     LIMIT $1`,
    [limite]
  );

  logger.info(`[WA] Mapeando LIDs: ${contatos.rows.length} contatos sem lid`);

  let mapeados = 0;
  let erros = 0;
  const resultados = [];

  for (const contato of contatos.rows) {
    try {
      // Chamar Z-API phone-exists
      const response = await fetch(
        `${conexaoWA.baseUrl}/phone-exists/${contato.telefone}`,
        { headers: conexaoWA.headers }
      );

      if (!response.ok) {
        erros++;
        continue;
      }

      const data = await response.json();

      // Z-API retorna: { exists: true/false, phone: "...", lid: "999@lid" }
      const lidRetornado = data.lid || data.chatLid || null;

      if (lidRetornado && data.exists !== false) {
        // Limpar o lid (remover @lid suffix se presente)
        const lidLimpo = String(lidRetornado).replace('@lid', '').replace(/\D/g, '');

        if (lidLimpo) {
          await query(
            `UPDATE contatos SET lid = $1, atualizado_em = NOW() WHERE id = $2`,
            [lidLimpo, contato.id]
          );
          mapeados++;
          resultados.push({ id: contato.id, nome: contato.nome, telefone: contato.telefone, lid: lidLimpo });
          logger.info(`[WA] LID mapeado: ${contato.telefone} → ${lidLimpo} (${contato.nome})`);
        }
      }

      // Rate limit: 1 request por segundo
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      erros++;
      logger.error({ err: err.message, telefone: contato.telefone }, '[WA] Erro ao mapear LID');
    }
  }

  logger.info({ total: contatos.rows.length, mapeados, erros }, '[WA] Mapeamento de LIDs concluído');

  return {
    total: contatos.rows.length,
    mapeados,
    erros,
    resultados,
  };
}

// Listar stickers RECEBIDOS (das mensagens) — usado na aba "Recebidos" da galeria
async function listarStickersRecebidos({ limite = 50 }) {
  try {
    const resultado = await query(
      `SELECT DISTINCT ON (media_url) id, media_url as url, criado_em as usado_em
       FROM mensagens
       WHERE tipo = 'sticker' AND media_url IS NOT NULL AND is_from_me = FALSE
       ORDER BY media_url, criado_em DESC
       LIMIT $1`,
      [limite]
    );
    return resultado.rows;
  } catch { return []; }
}

/**
 * Editar mensagem enviada (dentro de 15 minutos)
 * Z-API: POST /send-text com editMessageId
 */
async function editarMensagem({ mensagemId, novoTexto, usuarioId }) {
  const msg = await query(
    `SELECT m.id, m.wa_message_id, m.is_from_me, m.criado_em, m.ticket_id, c.telefone, c.lid
     FROM mensagens m
     JOIN tickets t ON t.id = m.ticket_id
     JOIN contatos c ON c.id = t.contato_id
     WHERE m.id = $1`,
    [mensagemId]
  );
  if (msg.rows.length === 0) throw new AppError('Mensagem não encontrada', 404);
  const { wa_message_id, is_from_me, criado_em, ticket_id, telefone, lid } = msg.rows[0];

  if (!is_from_me) throw new AppError('Só é possível editar mensagens enviadas', 400);

  const diffMin = (Date.now() - new Date(criado_em).getTime()) / 60000;
  if (diffMin > 15) throw new AppError('Só é possível editar mensagens dentro de 15 minutos', 400);

  if (!wa_message_id || wa_message_id === 'sent') throw new AppError('Mensagem sem ID do WhatsApp', 400);

  const destino = lid ? `${lid}@lid` : telefone;

  // Editar no WhatsApp via Z-API (send-text com editMessageId)
  await conexaoWA.editarMensagem(wa_message_id, destino, novoTexto);

  // Atualizar no banco
  await query(`UPDATE mensagens SET corpo = $1, atualizado_em = NOW() WHERE id = $2`, [novoTexto, mensagemId]);

  // Invalidar cache Redis
  const { invalidarCacheMensagens } = require('../messages/messages.service');
  await invalidarCacheMensagens(ticket_id);

  logger.info({ mensagemId, ticketId: ticket_id }, '[WA] Mensagem editada');
  return { id: mensagemId, corpo: novoTexto, ticket_id };
}

/**
 * Enviar contato (vCard) via Z-API
 */
async function enviarContato({ ticketId, contactName, contactPhone, avatarUrl, usuarioId }) {
  const destino = await _obterDestinoDoTicket(ticketId);
  const telefoneContato = contactPhone.replace(/\D/g, '');

  await conexaoWA.enviarContato(destino, contactName, telefoneContato);

  // Salvar no banco — avatar vai no media_url
  const msgResult = await query(
    `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio, media_url)
     VALUES ($1, $2, $3, 'contato', $4, TRUE, 'enviada', $5)
     RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em, media_url`,
    [ticketId, usuarioId, `👤 ${contactName}`, `vcard-${Date.now()}`, avatarUrl || null]
  );

  await query(
    `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW() WHERE id = $2`,
    [`👤 ${contactName}`, ticketId]
  );

  try {
    const { invalidarCacheListagens } = require('../tickets/tickets.service');
    await invalidarCacheListagens();
  } catch (_) {}

  return msgResult.rows[0];
}

/**
 * Marcar mensagem como lida no WhatsApp (blue ticks pro contato)
 */
async function marcarLidaNoWhatsApp(ticketId) {
  // Buscar última mensagem do contato (não lida)
  const resultado = await query(
    `SELECT m.wa_message_id, c.telefone, c.lid
     FROM mensagens m
     JOIN tickets t ON t.id = m.ticket_id
     JOIN contatos c ON c.id = t.contato_id
     WHERE m.ticket_id = $1 AND m.is_from_me = FALSE AND m.status_envio != 'lida'
     ORDER BY m.id DESC LIMIT 1`,
    [ticketId]
  );
  if (resultado.rows.length === 0) return;

  const { wa_message_id, telefone, lid } = resultado.rows[0];
  if (!wa_message_id || wa_message_id === 'sent') return;

  const destino = lid ? `${lid}@lid` : telefone;
  await conexaoWA.marcarComoLida(wa_message_id, destino);
  logger.info({ ticketId, msgId: wa_message_id }, '[WA] Blue tick enviado');
}

module.exports = {
  enviarMensagemTexto, enviarAudio, enviarImagem, enviarVideo, enviarDocumento,
  buscarFotoPerfil, processarMensagemRecebida, iniciarConversa,
  reagirMensagem, deletarMensagem, encaminharMensagem, enviarSticker,
  editarMensagem, enviarContato, marcarLidaNoWhatsApp,
  listarStickersGaleria, listarStickersRecebidos,
  mapearLidsContatos,
  obterQrCode, obterStatus, obterConexao, reconectar, forcarLogout,
};
