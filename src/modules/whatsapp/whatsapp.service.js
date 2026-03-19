// src/modules/whatsapp/whatsapp.service.js
// FIX DEFINITIVO: chatLid como CHAVE PRINCIPAL, phone como secundário
// Baseado na documentação oficial Z-API e boas práticas de tratamento @lid

const conexaoWA = require('./whatsapp.connection');
const { query, getClient } = require('../../config/database');
const AppError = require('../../shared/AppError');
const logger = require('../../shared/logger');

// ============================================================
// ENVIAR MENSAGEM DE TEXTO
// ============================================================
async function enviarMensagemTexto({ ticketId, texto, usuarioId }) {
  if (conexaoWA.status !== 'conectado' && conexaoWA.instanceId && conexaoWA.token) {
    conexaoWA.status = 'conectado';
  }
  if (conexaoWA.status !== 'conectado') {
    throw new AppError('WhatsApp não está conectado.', 503);
  }

  // Buscar telefone OU lid do contato — priorizar lid pra envio
  const resultado = await query(
    `SELECT c.telefone, c.lid FROM tickets t JOIN contatos c ON c.id = t.contato_id WHERE t.id = $1`,
    [ticketId]
  );
  if (resultado.rows.length === 0) throw new AppError('Ticket não encontrado', 404);

  // Pra enviar: usar lid se disponível (Z-API aceita @lid), senão telefone
  const { telefone, lid } = resultado.rows[0];
  const destino = lid ? `${lid}@lid` : telefone;

  try {
    // Auto-aceitar: se chamado é pendente, atribuir ao atendente
    const ticketCheck = await query(`SELECT status, usuario_id FROM tickets WHERE id = $1`, [ticketId]);
    if (ticketCheck.rows[0]?.status === 'pendente') {
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
    }

    const sent = await conexaoWA.enviarTexto(destino, texto);

    const msgResult = await query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio)
       VALUES ($1, $2, $3, 'texto', $4, TRUE, 'enviada')
       RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em`,
      [ticketId, usuarioId, texto, sent.key.id]
    );

    await query(
      `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW() WHERE id = $2`,
      [texto.substring(0, 200), ticketId]
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

    // Deduplicação
    const duplicada = await client.query(`SELECT id FROM mensagens WHERE wa_message_id = $1`, [waMessageId]);
    if (duplicada.rows.length > 0) {
      await client.query('COMMIT');
      return null;
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
        `INSERT INTO contatos (nome, telefone, avatar_url, lid)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (telefone) DO UPDATE SET
           lid = COALESCE(contatos.lid, EXCLUDED.lid),
           nome = CASE WHEN EXCLUDED.nome ~ '^\d+$' THEN contatos.nome ELSE COALESCE(EXCLUDED.nome, contatos.nome) END,
           avatar_url = COALESCE(contatos.avatar_url, EXCLUDED.avatar_url),
           atualizado_em = NOW()
         RETURNING id`,
        [nome || telefoneLimpo, telefoneLimpo, avatarUrl, isGroup ? null : lidValue]
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
          `UPDATE tickets SET status = 'pendente', usuario_id = NULL, atualizado_em = NOW() WHERE id = $1`,
          [ticketId]
        );
      }
    } else {
      const protocolo = _gerarProtocolo();
      let filaId = null;
      if (fromMe) {
        const filaResult = await client.query(
          `SELECT id FROM filas WHERE nome = 'Dispositivo Externo' AND ativo = TRUE LIMIT 1`
        );
        if (filaResult.rows.length > 0) filaId = filaResult.rows[0].id;
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

    // Salvar sticker na galeria
    if (tipo === 'sticker' && mediaUrl) {
      try {
        await client.query(
          `INSERT INTO stickers_galeria (url, recebido_de, ticket_id)
           VALUES ($1, $2, $3) ON CONFLICT (url) DO UPDATE SET usado_em = NOW()`,
          [mediaUrl, contatoId, ticketId]
        );
      } catch (err) {
        logger.warn({ err: err.message }, '[WA] Erro ao salvar sticker');
      }
    }

    await client.query('COMMIT');

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

    const msgResult = await query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio, media_url)
       VALUES ($1, $2, '🎵 Áudio', 'audio', $3, TRUE, 'enviada', $4)
       RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em, media_url`,
      [ticketId, usuarioId, data.zapiMessageId || data.messageId || 'sent', audioBase64]
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

    const msgResult = await query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio, media_url)
       VALUES ($1, $2, $3, 'imagem', $4, TRUE, 'enviada', $5)
       RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em, media_url`,
      [ticketId, usuarioId, caption || '📷 Imagem', data.zapiMessageId || data.messageId || 'sent', imagemBase64]
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

    const msgResult = await query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio)
       VALUES ($1, $2, $3, 'video', $4, TRUE, 'enviada')
       RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em`,
      [ticketId, usuarioId, caption || '🎥 Vídeo', data.zapiMessageId || data.messageId || 'sent']
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

    const msgResult = await query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio)
       VALUES ($1, $2, $3, 'documento', $4, TRUE, 'enviada')
       RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em`,
      [ticketId, usuarioId, fileName || '📄 Documento', data.zapiMessageId || data.messageId || 'sent']
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

  // Pra GRUPOS: usar telefone raw (ID do grupo), NUNCA lid
  // Grupos têm telefone com 15+ dígitos (ex: 120363421560154850)
  const isGroupPhone = telefone && telefone.length > 15;
  if (isGroupPhone) return telefone;

  // Pra 1:1: priorizar lid (mais estável segundo Z-API)
  return lid ? `${lid}@lid` : telefone;
}

async function _atualizarPreviewTicket(ticketId, preview) {
  await query(
    `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW() WHERE id = $2`,
    [preview.substring(0, 200), ticketId]
  );
}

/**
 * Resolver menções @lid no texto de mensagens de grupo.
 * Substitui padrões como @1243243424 (que são LIDs) pelo nome do contato se encontrado.
 */
async function _resolverMencoesLid(client, texto) {
  // Regex: captura @ seguido de 10+ dígitos (LIDs típicos)
  const mencoes = texto.match(/@(\d{10,})/g);
  if (!mencoes || mencoes.length === 0) return texto;

  let textoResolvido = texto;

  for (const mencao of mencoes) {
    const lidNumero = mencao.replace('@', '');

    // Buscar contato por lid ou telefone
    const contato = await client.query(
      `SELECT nome FROM contatos WHERE lid = $1 OR telefone = $1 LIMIT 1`,
      [lidNumero]
    );

    if (contato.rows.length > 0 && contato.rows[0].nome) {
      // Substituir @lid pelo @nome
      textoResolvido = textoResolvido.replace(mencao, `@${contato.rows[0].nome}`);
    }
  }

  return textoResolvido;
}

function obterQrCode() { return null; }
function obterStatus() { return conexaoWA.obterStatus(); }
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
  return { sucesso: true };
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

module.exports = {
  enviarMensagemTexto, enviarAudio, enviarImagem, enviarVideo, enviarDocumento,
  buscarFotoPerfil, processarMensagemRecebida, iniciarConversa,
  reagirMensagem, deletarMensagem, encaminharMensagem, enviarSticker, listarStickersGaleria,
  obterQrCode, obterStatus, reconectar, forcarLogout,
};
