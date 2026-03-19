// src/modules/whatsapp/whatsapp.service.js
// Serviço WhatsApp — Z-API (CORRIGIDO — unificação LID + stickers + revoke)

const conexaoWA = require('./whatsapp.connection');
const { query, getClient } = require('../../config/database');
const AppError = require('../../shared/AppError');
const logger = require('../../shared/logger');

/**
 * Enviar mensagem de texto via Z-API
 */
async function enviarMensagemTexto({ ticketId, texto, usuarioId }) {
  // Forçar conectado se tem credenciais
  if (conexaoWA.status !== 'conectado' && conexaoWA.instanceId && conexaoWA.token) {
    conexaoWA.status = 'conectado';
  }

  if (conexaoWA.status !== 'conectado') {
    throw new AppError('WhatsApp não está conectado. Configure ZAPI_INSTANCE_ID e ZAPI_TOKEN.', 503);
  }

  const resultado = await query(
    `SELECT c.telefone FROM tickets t JOIN contatos c ON c.id = t.contato_id WHERE t.id = $1`,
    [ticketId]
  );

  if (resultado.rows.length === 0) throw new AppError('Ticket não encontrado', 404);
  const { telefone } = resultado.rows[0];

  try {
    // Auto-aceitar: se chamado é pendente, atribuir ao atendente que respondeu
    const ticketCheck = await query(`SELECT status, usuario_id FROM tickets WHERE id = $1`, [ticketId]);
    if (ticketCheck.rows[0]?.status === 'pendente') {
      await query(
        `UPDATE tickets SET status = 'aberto', usuario_id = $1, atualizado_em = NOW() WHERE id = $2`,
        [usuarioId, ticketId]
      );

      // Registrar mensagem de sistema
      const { registrarMensagemSistema } = require('../messages/messages.service');
      const nomeResult = await query(`SELECT nome FROM usuarios WHERE id = $1`, [usuarioId]);
      const nomeAtendente = nomeResult.rows[0]?.nome || 'Atendente';
      const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' });

      await registrarMensagemSistema({
        ticketId,
        corpo: `${nomeAtendente} iniciou o atendimento às ${hora}`,
        usuarioId,
      });

      logger.info({ ticketId, usuarioId }, '[WA] Chamado auto-aceito ao responder');
    }

    const sent = await conexaoWA.enviarTexto(telefone, texto);

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
    logger.error({ err: err.message, ticketId, telefone }, '[WA] ERRO AO ENVIAR');
    throw new AppError(`Falha ao enviar: ${err.message}`, 500);
  }
}

async function _calcularTempoRespostaSeNecessario(ticketId) {
  try {
    const ticket = await query(
      `SELECT tempo_primeira_resposta_seg, criado_em FROM tickets WHERE id = $1`,
      [ticketId]
    );
    if (ticket.rows[0]?.tempo_primeira_resposta_seg !== null) return;

    const diffSeg = Math.floor((Date.now() - new Date(ticket.rows[0].criado_em).getTime()) / 1000);
    await query(`UPDATE tickets SET tempo_primeira_resposta_seg = $1 WHERE id = $2`, [diffSeg, ticketId]);
  } catch (err) {
    logger.error({ err, ticketId }, '[WA] Erro TPR');
  }
}

/**
 * Processar mensagem recebida do webhook Z-API
 * CORRIGIDO: Unificação robusta de LID → contato real
 *
 * Fluxo:
 *  1. fromMe=true com LID: cria contato com LID como telefone + campo lid
 *  2. fromMe=false com telefone real: busca por telefone. Se não acha,
 *     busca contato por nome onde telefone existente é LID (>13 dígitos).
 *     Se encontra, UNIFICA: atualiza telefone para o real, preserva lid.
 *     Também migra tickets do contato LID duplicado se houver.
 */
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

    // Detectar se é LID:
    // 1. Flag isLidRaw (webhook veio com @lid no raw phone)
    // 2. chatLid existe e é diferente do telefone (Z-API mandou os dois)
    // 3. Fallback: telefone longo ou não-brasileiro
    const isLid = (isLidRaw === true) ||
      (telefoneLimpo.length > 13 && !isGroup) ||
      (telefoneLimpo.length >= 12 && !telefoneLimpo.startsWith('55') && !isGroup);

    logger.info(`[WA] Buscando contato tel=${telefoneLimpo} chatLid=${chatLid} fromMe=${fromMe} isLid=${isLid} isLidRaw=${isLidRaw} nome=${nome}`);

    let contatoResult = { rows: [] };

    // ============================================================
    // ESTRATÉGIA DEFINITIVA DE BUSCA (usa chatLid da Z-API)
    //
    // A Z-API manda body.chatLid em TODOS os webhooks de mensagem.
    // - fromMe=true:  chatLid="123@lid", phone="123@lid" (ambos LID)
    // - fromMe=false:  chatLid="123@lid", phone="5571XXXXX" (LID + real!)
    //
    // Então chatLid é a CHAVE ESTÁVEL pra unificar contatos.
    // ============================================================

    // PASSO 0 (PRIORITÁRIO): Se temos chatLid, buscar contato pelo campo lid
    if (chatLid && chatLid.length > 0) {
      contatoResult = await client.query(
        `SELECT id, nome, telefone, avatar_url, lid FROM contatos WHERE lid = $1`,
        [chatLid]
      );
      if (contatoResult.rows.length > 0) {
        logger.info(`[WA] ✅ Contato encontrado por chatLid: lid=${chatLid} → id=${contatoResult.rows[0].id} tel=${contatoResult.rows[0].telefone}`);

        // Se agora temos o telefone REAL (fromMe=false, não é LID), atualizar o contato
        if (!isLid && contatoResult.rows[0].telefone !== telefoneLimpo) {
          await client.query(
            `UPDATE contatos SET telefone = $1, atualizado_em = NOW() WHERE id = $2`,
            [telefoneLimpo, contatoResult.rows[0].id]
          );
          logger.info(`[WA] ✅ UNIFICAÇÃO VIA chatLid: telefone atualizado ${contatoResult.rows[0].telefone} → ${telefoneLimpo}`);
        }
      }
    }

    // PASSO 1: Se é LID (e chatLid não encontrou), buscar pelo campo lid com o telefone
    if (contatoResult.rows.length === 0 && isLid) {
      contatoResult = await client.query(
        `SELECT id, nome, telefone, avatar_url, lid FROM contatos WHERE lid = $1`,
        [telefoneLimpo]
      );
      if (contatoResult.rows.length > 0) {
        logger.info(`[WA] Contato encontrado por LID no campo lid: ${telefoneLimpo}`);
      }
    }

    // PASSO 2: Buscar por telefone exato
    if (contatoResult.rows.length === 0) {
      contatoResult = await client.query(
        `SELECT id, nome, telefone, avatar_url, lid FROM contatos WHERE telefone = $1`,
        [telefoneLimpo]
      );
    }

    // PASSO 3: Se é fromMe com LID e não encontrou, buscar pelo nome (chatName)
    if (contatoResult.rows.length === 0 && isLid && fromMe && nome && nome !== telefoneLimpo) {
      contatoResult = await client.query(
        `SELECT id, nome, telefone, avatar_url, lid FROM contatos WHERE nome = $1 AND lid IS NULL ORDER BY id DESC LIMIT 1`,
        [nome]
      );
      if (contatoResult.rows.length > 0) {
        const lidValue = chatLid || telefoneLimpo;
        await client.query(`UPDATE contatos SET lid = $1, atualizado_em = NOW() WHERE id = $2`, [lidValue, contatoResult.rows[0].id]);
        logger.info(`[WA] LID mapeado por nome: ${lidValue} → contato ${contatoResult.rows[0].id} (${nome})`);
      }
    }

    // PASSO 4: fromMe=false com número real, buscar por nome em contatos LID
    if (contatoResult.rows.length === 0 && !isLid && !fromMe && nome && nome !== telefoneLimpo && !/^\d+$/.test(nome)) {
      const lidMatch = await client.query(
        `SELECT id, nome, telefone, avatar_url, lid FROM contatos
         WHERE LOWER(nome) = LOWER($1) AND (LENGTH(telefone) > 13 OR lid IS NOT NULL)
         ORDER BY id DESC LIMIT 1`,
        [nome]
      );
      if (lidMatch.rows.length > 0) {
        const contatoLid = lidMatch.rows[0];
        logger.info({ contatoId: contatoLid.id, telefoneLid: contatoLid.telefone, telefoneReal: telefoneLimpo },
          '[WA] UNIFICAÇÃO LID por nome: atualizando telefone');

        const lidValue = chatLid || contatoLid.lid || contatoLid.telefone;
        await client.query(
          `UPDATE contatos SET telefone = $1, lid = $2, atualizado_em = NOW() WHERE id = $3`,
          [telefoneLimpo, lidValue, contatoLid.id]
        );
        contatoResult = await client.query(
          `SELECT id, nome, telefone, avatar_url, lid FROM contatos WHERE id = $1`,
          [contatoLid.id]
        );
      }
    }

    // PASSO 5: Match por ticket recente (quando nome é só número)
    if (contatoResult.rows.length === 0 && !isLid && !fromMe) {
      const ticketLidMatch = await client.query(
        `SELECT c.id, c.nome, c.telefone, c.avatar_url, c.lid
         FROM contatos c
         JOIN tickets t ON t.contato_id = c.id
         WHERE (LENGTH(c.telefone) > 13 OR c.lid IS NOT NULL)
           AND t.status IN ('pendente', 'aberto', 'aguardando')
           AND t.ultima_mensagem_em > NOW() - INTERVAL '2 hours'
         ORDER BY t.ultima_mensagem_em DESC
         LIMIT 5`,
        []
      );

      if (ticketLidMatch.rows.length === 1) {
        const contatoLid = ticketLidMatch.rows[0];
        logger.info({ contatoId: contatoLid.id, nomeLid: contatoLid.nome, telefoneReal: telefoneLimpo },
          '[WA] UNIFICAÇÃO por ticket recente (único candidato)');

        const lidValue = chatLid || contatoLid.lid || contatoLid.telefone;
        await client.query(
          `UPDATE contatos SET telefone = $1, lid = $2, atualizado_em = NOW() WHERE id = $3`,
          [telefoneLimpo, lidValue, contatoLid.id]
        );
        if (nome && !/^\d+$/.test(nome) && nome !== contatoLid.nome) {
          await client.query(`UPDATE contatos SET nome = $1 WHERE id = $2`, [nome, contatoLid.id]);
        }
        contatoResult = await client.query(
          `SELECT id, nome, telefone, avatar_url, lid FROM contatos WHERE id = $1`,
          [contatoLid.id]
        );
      } else if (ticketLidMatch.rows.length > 1 && nome && !/^\d+$/.test(nome)) {
        const matchPorNome = ticketLidMatch.rows.find(c => c.nome?.toLowerCase() === nome.toLowerCase());
        if (matchPorNome) {
          const lidValue = chatLid || matchPorNome.lid || matchPorNome.telefone;
          await client.query(
            `UPDATE contatos SET telefone = $1, lid = $2, atualizado_em = NOW() WHERE id = $3`,
            [telefoneLimpo, lidValue, matchPorNome.id]
          );
          contatoResult = await client.query(
            `SELECT id, nome, telefone, avatar_url, lid FROM contatos WHERE id = $1`,
            [matchPorNome.id]
          );
        }
      }
    }

    let contatoId;

    if (contatoResult.rows.length === 0) {
      // Criar novo contato
      let avatarUrl = null;
      try {
        avatarUrl = await buscarFotoPerfil(telefoneLimpo);
      } catch { /* não crítico */ }

      // Se é LID, salvar chatLid ou telefone como lid
      const lidValue = isLid ? (chatLid || telefoneLimpo) : (chatLid || null);
      const telParaSalvar = telefoneLimpo;

      const novo = await client.query(
        `INSERT INTO contatos (nome, telefone, avatar_url, lid)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [nome || telefoneLimpo, telParaSalvar, avatarUrl, lidValue]
      );
      contatoId = novo.rows[0].id;
      logger.info({ contatoId, telefone: telParaSalvar, nome, lid: lidValue, chatLid, temAvatar: !!avatarUrl }, '[WA] Novo contato');
    } else {
      contatoId = contatoResult.rows[0].id;

      // Atualizar nome se mudou (e não é um número genérico)
      if (nome && nome !== telefoneLimpo && !/^\d+$/.test(nome) && nome !== contatoResult.rows[0].nome) {
        await client.query(`UPDATE contatos SET nome = $1, atualizado_em = NOW() WHERE id = $2`, [nome, contatoId]);
      }

      // Se veio com número real (não LID) e o contato está salvo com LID como telefone, atualizar
      if (!isLid && contatoResult.rows[0].telefone !== telefoneLimpo && contatoResult.rows[0].telefone?.length > 13) {
        const lidValue = chatLid || contatoResult.rows[0].lid || contatoResult.rows[0].telefone;
        await client.query(
          `UPDATE contatos SET telefone = $1, lid = $2, atualizado_em = NOW() WHERE id = $3`,
          [telefoneLimpo, lidValue, contatoId]
        );
        logger.info(`[WA] Telefone atualizado: LID ${contatoResult.rows[0].telefone} → real ${telefoneLimpo}`);
      }

      // Se contato não tem lid salvo mas temos chatLid, salvar
      if (chatLid && !contatoResult.rows[0].lid) {
        await client.query(`UPDATE contatos SET lid = $1, atualizado_em = NOW() WHERE id = $2`, [chatLid, contatoId]);
        logger.info(`[WA] chatLid salvo: ${chatLid} → contato ${contatoId}`);
      }

      // Buscar foto se não tem
      if (!contatoResult.rows[0].avatar_url) {
        buscarFotoPerfil(telefoneLimpo).then(url => {
          if (url) {
            query(`UPDATE contatos SET avatar_url = $1 WHERE id = $2`, [url, contatoId]).catch(() => {});
          }
        }).catch(() => {});
      }
    }

    // ====== TICKET ======
    // Buscar ticket existente — qualquer status exceto 'fechado'
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

      // Reabrir ticket resolvido quando cliente manda nova mensagem
      if (ticketResult.rows[0].status === 'resolvido' && !fromMe) {
        await client.query(
          `UPDATE tickets SET status = 'pendente', usuario_id = NULL, atualizado_em = NOW() WHERE id = $1`,
          [ticketId]
        );
      }
    } else {
      const protocolo = _gerarProtocolo();

      // Para fromMe (celular), criar como 'pendente' na fila "Dispositivo Externo"
      let filaId = null;
      if (fromMe) {
        const filaResult = await client.query(
          `SELECT id FROM filas WHERE nome = 'Dispositivo Externo' AND ativo = TRUE LIMIT 1`
        );
        if (filaResult.rows.length > 0) {
          filaId = filaResult.rows[0].id;
        }
      }

      const novo = await client.query(
        `INSERT INTO tickets (contato_id, status, protocolo, fila_id, ultima_mensagem_em)
         VALUES ($1, 'pendente', $2, $3, NOW()) RETURNING id`,
        [contatoId, protocolo, filaId]
      );
      ticketId = novo.rows[0].id;
      ticketNovo = true;
      logger.info({ ticketId, protocolo, fromMe, filaId }, '[WA] Novo ticket');
    }

    // ====== SALVAR MENSAGEM ======
    let corpoFinal = corpo || '';

    const msgResult = await client.query(
      `INSERT INTO mensagens (ticket_id, contato_id, corpo, tipo, wa_message_id, is_from_me, status_envio, media_url, nome_participante)
       VALUES ($1, $2, $3, $4, $5, $6, 'entregue', $7, $8)
       RETURNING id, ticket_id, corpo, tipo, is_from_me, criado_em, media_url, nome_participante`,
      [ticketId, fromMe ? null : contatoId, corpoFinal, tipo, waMessageId, fromMe || false, mediaUrl || null, (isGroup && nomeParticipante) ? nomeParticipante : null]
    );

    // Preview
    await client.query(
      `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW() WHERE id = $2`,
      [(corpo || '📎 Mídia').substring(0, 200), ticketId]
    );

    // ====== SALVAR STICKER NA GALERIA ======
    if (tipo === 'sticker' && mediaUrl) {
      try {
        await client.query(
          `INSERT INTO stickers_galeria (url, recebido_de, ticket_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (url) DO UPDATE SET usado_em = NOW()`,
          [mediaUrl, contatoId, ticketId]
        );
      } catch (err) {
        // Tabela pode não existir ainda — não crítico
        logger.warn({ err: err.message }, '[WA] Erro ao salvar sticker na galeria (tabela pode não existir)');
      }
    }

    await client.query('COMMIT');

    // Marcar como lida no WhatsApp
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

    logger.info({ ticketId, waMessageId, tipo, fromMe, isGroup }, '[WA] Mensagem processada');
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

/**
 * Enviar áudio base64 via Z-API
 */
async function enviarAudio({ ticketId, audioBase64, usuarioId }) {
  const telefone = await _obterTelefoneDoTicket(ticketId);

  try {
    const response = await fetch(`${conexaoWA.baseUrl}/send-audio`, {
      method: 'POST',
      headers: conexaoWA.headers,
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

/**
 * Enviar imagem base64 via Z-API
 */
async function enviarImagem({ ticketId, imagemBase64, caption, usuarioId }) {
  const telefone = await _obterTelefoneDoTicket(ticketId);

  try {
    const response = await fetch(`${conexaoWA.baseUrl}/send-image`, {
      method: 'POST',
      headers: conexaoWA.headers,
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

/**
 * Enviar vídeo base64 via Z-API
 */
async function enviarVideo({ ticketId, videoBase64, caption, usuarioId }) {
  const telefone = await _obterTelefoneDoTicket(ticketId);

  try {
    const response = await fetch(`${conexaoWA.baseUrl}/send-video`, {
      method: 'POST',
      headers: conexaoWA.headers,
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

/**
 * Enviar documento base64 via Z-API
 */
async function enviarDocumento({ ticketId, documentoBase64, fileName, usuarioId }) {
  const telefone = await _obterTelefoneDoTicket(ticketId);
  const ext = fileName?.split('.').pop() || 'pdf';

  try {
    const response = await fetch(`${conexaoWA.baseUrl}/send-document/${ext}`, {
      method: 'POST',
      headers: conexaoWA.headers,
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

/**
 * Buscar foto de perfil via Z-API (contatos e grupos)
 */
async function buscarFotoPerfil(telefone) {
  if (!conexaoWA.instanceId || !conexaoWA.token || !telefone) return null;

  try {
    const response = await fetch(`${conexaoWA.baseUrl}/profile-picture?phone=${telefone}`, {
      headers: conexaoWA.headers,
    });
    if (!response.ok) return null;
    const data = await response.json();

    const url = data.link || data.imgUrl || data.profilePicThumbObj?.imgFull
      || data.profilePictureUrl || data.eurl || data.url || null;

    logger.info({ telefone, temFoto: !!url }, '[WA] Foto perfil');
    return url;
  } catch {
    return null;
  }
}

// Helpers internos
async function _obterTelefoneDoTicket(ticketId) {
  if (conexaoWA.status !== 'conectado' && conexaoWA.instanceId && conexaoWA.token) {
    conexaoWA.status = 'conectado';
  }
  if (conexaoWA.status !== 'conectado') throw new AppError('WhatsApp não conectado', 503);

  const resultado = await query(
    `SELECT c.telefone FROM tickets t JOIN contatos c ON c.id = t.contato_id WHERE t.id = $1`,
    [ticketId]
  );
  if (resultado.rows.length === 0) throw new AppError('Ticket não encontrado', 404);
  return resultado.rows[0].telefone;
}

async function _atualizarPreviewTicket(ticketId, preview) {
  await query(
    `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW() WHERE id = $2`,
    [preview.substring(0, 200), ticketId]
  );
}

function obterQrCode() {
  return null;
}

function obterStatus() {
  return conexaoWA.obterStatus();
}

async function reconectar() {
  await conexaoWA.desconectar();
  await conexaoWA.conectar();
}

async function forcarLogout() {
  await conexaoWA.desconectar();
}

/**
 * Iniciar conversa com contato existente
 */
async function iniciarConversa({ telefone, mensagem, contatoId, usuarioId }) {
  const telefoneLimpo = telefone.replace(/\D/g, '');

  // Enviar mensagem via Z-API
  await conexaoWA.enviarTexto(telefoneLimpo, mensagem);

  // Buscar ou criar ticket
  const ticketExistente = await query(
    `SELECT t.id, t.status, t.protocolo,
            c.nome as contato_nome, c.telefone as contato_telefone, c.avatar_url as contato_avatar
     FROM tickets t
     LEFT JOIN contatos c ON c.id = t.contato_id
     WHERE t.contato_id = $1 AND t.status IN ('aberto', 'pendente', 'aguardando')
     ORDER BY t.id DESC LIMIT 1`,
    [contatoId]
  );

  let ticketId, protocolo;

  if (ticketExistente.rows.length > 0) {
    ticketId = ticketExistente.rows[0].id;
    protocolo = ticketExistente.rows[0].protocolo;
    await query(
      `UPDATE tickets SET status = 'aberto', usuario_id = $1, atualizado_em = NOW() WHERE id = $2`,
      [usuarioId, ticketId]
    );
  } else {
    const resolvido = await query(
      `SELECT id, protocolo FROM tickets WHERE contato_id = $1 AND status = 'resolvido' ORDER BY id DESC LIMIT 1`,
      [contatoId]
    );

    if (resolvido.rows.length > 0) {
      ticketId = resolvido.rows[0].id;
      protocolo = resolvido.rows[0].protocolo;
      await query(
        `UPDATE tickets SET status = 'aberto', usuario_id = $1, atualizado_em = NOW() WHERE id = $2`,
        [usuarioId, ticketId]
      );
    } else {
      protocolo = _gerarProtocolo();
      const novo = await query(
        `INSERT INTO tickets (contato_id, status, protocolo, usuario_id, ultima_mensagem_em)
         VALUES ($1, 'aberto', $2, $3, NOW()) RETURNING id`,
        [contatoId, protocolo, usuarioId]
      );
      ticketId = novo.rows[0].id;
    }
  }

  // Salvar mensagem no banco
  const waMessageId = `sistema_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await query(
    `INSERT INTO mensagens (ticket_id, contato_id, corpo, tipo, wa_message_id, is_from_me, status_envio)
     VALUES ($1, $2, $3, 'texto', $4, TRUE, 'enviada')`,
    [ticketId, contatoId, mensagem, waMessageId]
  );

  await _atualizarPreviewTicket(ticketId, mensagem);

  const ticketCompleto = await query(
    `SELECT t.*, c.nome as contato_nome, c.telefone as contato_telefone, c.avatar_url as contato_avatar
     FROM tickets t LEFT JOIN contatos c ON c.id = t.contato_id WHERE t.id = $1`,
    [ticketId]
  );

  logger.info({ ticketId, protocolo, telefone: telefoneLimpo, usuarioId }, '[WA] Conversa iniciada pelo sistema');
  return { sucesso: true, ticket: ticketCompleto.rows[0] };
}

/**
 * Reagir a mensagem
 */
async function reagirMensagem(mensagemId, emoji) {
  const msg = await query(`SELECT wa_message_id, ticket_id FROM mensagens WHERE id = $1`, [mensagemId]);
  if (msg.rows.length === 0) throw new AppError('Mensagem não encontrada', 404);

  const waMessageId = msg.rows[0].wa_message_id;
  const telefone = await _obterTelefoneDoTicket(msg.rows[0].ticket_id);

  await conexaoWA.reagirMensagem(waMessageId, telefone, emoji);
  await query(`UPDATE mensagens SET reacao = $1 WHERE id = $2`, [emoji, mensagemId]);

  logger.info({ mensagemId, emoji }, '[WA] Reação enviada');
  return { sucesso: true };
}

/**
 * Deletar mensagem
 */
async function deletarMensagem(mensagemId) {
  const msg = await query(`SELECT wa_message_id, ticket_id, is_from_me FROM mensagens WHERE id = $1`, [mensagemId]);
  if (msg.rows.length === 0) throw new AppError('Mensagem não encontrada', 404);
  if (!msg.rows[0].is_from_me) throw new AppError('Só é possível deletar mensagens enviadas por você', 400);

  const telefone = await _obterTelefoneDoTicket(msg.rows[0].ticket_id);
  await conexaoWA.deletarMensagem(msg.rows[0].wa_message_id, telefone);

  await query(`UPDATE mensagens SET deletada = TRUE, deletada_por = 'atendente' WHERE id = $1`, [mensagemId]);
  logger.info({ mensagemId }, '[WA] Mensagem deletada');
  return { sucesso: true };
}

/**
 * Encaminhar mensagem para outro contato
 */
async function encaminharMensagem(mensagemId, telefoneDestino) {
  const msg = await query(
    `SELECT m.wa_message_id, m.ticket_id, m.corpo, m.tipo, m.media_url, c.nome as contato_nome
     FROM mensagens m
     LEFT JOIN tickets t ON t.id = m.ticket_id
     LEFT JOIN contatos c ON c.id = t.contato_id
     WHERE m.id = $1`,
    [mensagemId]
  );
  if (msg.rows.length === 0) throw new AppError('Mensagem não encontrada', 404);

  const telefoneOrigem = await _obterTelefoneDoTicket(msg.rows[0].ticket_id);
  const telDestino = telefoneDestino.replace(/\D/g, '');
  const { wa_message_id, corpo, tipo, media_url, contato_nome } = msg.rows[0];

  // Tentar forward-message da Z-API primeiro
  try {
    await conexaoWA.encaminharMensagem(wa_message_id, telefoneOrigem, telDestino);
    logger.info({ mensagemId, telefoneOrigem, telDestino }, '[WA] Mensagem encaminhada via forward');
    return { sucesso: true, metodo: 'forward' };
  } catch (forwardErr) {
    logger.warn({ err: forwardErr.message }, '[WA] forward-message falhou, reenviando como texto');
  }

  // Fallback — reenviar conteúdo como nova mensagem
  const prefixo = `📨 *Encaminhada de ${contato_nome || 'contato'}:*\n\n`;

  if (tipo === 'imagem' && media_url) {
    await conexaoWA.enviarImagem(telDestino, media_url, prefixo + (corpo || ''));
  } else if (tipo === 'audio' && media_url) {
    await conexaoWA.enviarTexto(telDestino, prefixo + '🎵 Áudio encaminhado');
  } else if (tipo === 'video' && media_url) {
    await conexaoWA.enviarTexto(telDestino, prefixo + (corpo || '🎥 Vídeo'));
  } else if (tipo === 'documento' && media_url) {
    await conexaoWA.enviarTexto(telDestino, prefixo + (corpo || '📄 Documento'));
  } else {
    await conexaoWA.enviarTexto(telDestino, prefixo + (corpo || ''));
  }

  logger.info({ mensagemId, telDestino, tipo }, '[WA] Mensagem reenviada como texto (fallback)');
  return { sucesso: true, metodo: 'reenvio' };
}

/**
 * Enviar sticker
 */
async function enviarSticker(ticketId, stickerUrl) {
  const telefone = await _obterTelefoneDoTicket(ticketId);

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

  logger.info({ ticketId, telefone }, '[WA] Sticker enviado');
  return { sucesso: true, waMessageId };
}

/**
 * Listar stickers da galeria (últimos recebidos)
 */
async function listarStickersGaleria({ limite = 30 }) {
  try {
    const resultado = await query(
      `SELECT id, url, usado_em FROM stickers_galeria ORDER BY usado_em DESC LIMIT $1`,
      [limite]
    );
    return resultado.rows;
  } catch {
    // Tabela pode não existir
    return [];
  }
}

module.exports = {
  enviarMensagemTexto,
  enviarAudio,
  enviarImagem,
  enviarVideo,
  enviarDocumento,
  buscarFotoPerfil,
  processarMensagemRecebida,
  iniciarConversa,
  reagirMensagem,
  deletarMensagem,
  encaminharMensagem,
  enviarSticker,
  listarStickersGaleria,
  obterQrCode,
  obterStatus,
  reconectar,
  forcarLogout,
};
