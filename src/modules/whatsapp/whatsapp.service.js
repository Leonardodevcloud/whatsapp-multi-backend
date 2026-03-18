// src/modules/whatsapp/whatsapp.service.js
// Serviço WhatsApp — Z-API (CORRIGIDO)

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
      const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
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
      `SELECT tempo_primeira_resposta_seg, criado_em FROM tickets WHERE id = $1`, [ticketId]
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
 * Agora suporta: fromMe (mensagens enviadas pelo celular), mídia, todos os tipos
 */
async function processarMensagemRecebida({ telefone, nome, corpo, tipo, waMessageId, isGroup, fromMe, mediaUrl, nomeParticipante }) {
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

    // Detectar se é LID (telefone com mais de 13 dígitos e não é grupo)
    const isLid = telefoneLimpo.length > 13 && !isGroup;

    logger.info(`[WA] Buscando contato tel=${telefoneLimpo} (raw=${telefone}) fromMe=${fromMe} isLid=${isLid}`);

    let contatoResult;

    if (isLid) {
      // Buscar por LID primeiro
      contatoResult = await client.query(`SELECT id, nome, telefone, avatar_url FROM contatos WHERE lid = $1`, [telefoneLimpo]);
      if (contatoResult.rows.length > 0) {
        logger.info(`[WA] Contato encontrado por LID: ${telefoneLimpo} → tel=${contatoResult.rows[0].telefone}`);
      }
    }

    if (!contatoResult || contatoResult.rows.length === 0) {
      // Buscar por telefone exato
      contatoResult = await client.query(`SELECT id, nome, telefone, avatar_url FROM contatos WHERE telefone = $1`, [telefoneLimpo]);
    }

    // Se é fromMe com LID e não encontrou, buscar pelo nome (chatName) pra mapear
    if (contatoResult.rows.length === 0 && isLid && fromMe && nome && nome !== telefoneLimpo) {
      // Buscar contato recente com mesmo nome que não tenha LID ainda
      contatoResult = await client.query(
        `SELECT id, nome, telefone, avatar_url FROM contatos WHERE nome = $1 AND lid IS NULL ORDER BY id DESC LIMIT 1`,
        [nome]
      );
      if (contatoResult.rows.length > 0) {
        // Mapear o LID a este contato
        await client.query(`UPDATE contatos SET lid = $1 WHERE id = $2`, [telefoneLimpo, contatoResult.rows[0].id]);
        logger.info(`[WA] LID mapeado: ${telefoneLimpo} → contato ${contatoResult.rows[0].telefone} (${nome})`);
      }
    }

    let contatoId;

    if (contatoResult.rows.length === 0) {
      // Criar novo contato
      let avatarUrl = null;
      try {
        avatarUrl = await buscarFotoPerfil(telefoneLimpo);
      } catch { /* não crítico */ }

      // Se é LID, salvar o LID no campo lid e usar o LID como telefone temporário
      const lidValue = isLid ? telefoneLimpo : null;
      const telParaSalvar = telefoneLimpo;

      const novo = await client.query(
        `INSERT INTO contatos (nome, telefone, avatar_url, lid) VALUES ($1, $2, $3, $4) RETURNING id`,
        [nome || telefoneLimpo, telParaSalvar, avatarUrl, lidValue]
      );
      contatoId = novo.rows[0].id;
      logger.info({ contatoId, telefone: telParaSalvar, nome, lid: lidValue, temAvatar: !!avatarUrl }, '[WA] Novo contato');
    } else {
      contatoId = contatoResult.rows[0].id;
      
      // Se NÃO é LID e contato não tem LID mapeado ainda, e veio fromMe=false (número real)
      // Não precisa mapear aqui — o LID será mapeado quando fromMe=true

      // Atualizar nome se mudou
      if (nome && nome !== telefoneLimpo && nome !== contatoResult.rows[0].nome) {
        await client.query(`UPDATE contatos SET nome = $1 WHERE id = $2`, [nome, contatoId]);
      }

      // Se veio com número real (não LID) e o contato está salvo com LID como telefone, atualizar
      if (!isLid && contatoResult.rows[0].telefone !== telefoneLimpo && contatoResult.rows[0].telefone?.length > 13) {
        await client.query(`UPDATE contatos SET telefone = $1, lid = $2 WHERE id = $3`, [telefoneLimpo, contatoResult.rows[0].telefone, contatoId]);
        logger.info(`[WA] Telefone atualizado: LID ${contatoResult.rows[0].telefone} → real ${telefoneLimpo}`);
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

    // Ticket
    // Buscar ticket existente — qualquer status exceto 'fechado'
    let ticketResult = await client.query(
      `SELECT id, status, usuario_id FROM tickets WHERE contato_id = $1 AND status NOT IN ('fechado') ORDER BY id DESC LIMIT 1`,
      [contatoId]
    );

    let ticketId;
    let ticketNovo = false;

    if (ticketResult.rows.length > 0) {
      ticketId = ticketResult.rows[0].id;
      // Reabrir ticket resolvido quando cliente manda nova mensagem
      if (ticketResult.rows[0].status === 'resolvido' && !fromMe) {
        await client.query(`UPDATE tickets SET status = 'pendente', usuario_id = NULL, atualizado_em = NOW() WHERE id = $1`, [ticketId]);
      }
    } else {
      // Só criar ticket novo se não tem NENHUM ticket aberto/pendente/aguardando/resolvido
      const protocolo = _gerarProtocolo();
      
      // Para fromMe (celular), criar como 'pendente' na fila "Dispositivo Externo"
      // Para mensagens normais, criar como 'pendente' sem fila
      let filaId = null;
      if (fromMe) {
        const filaResult = await client.query(`SELECT id FROM filas WHERE nome = 'Dispositivo Externo' AND ativo = TRUE LIMIT 1`);
        if (filaResult.rows.length > 0) {
          filaId = filaResult.rows[0].id;
        }
      }

      const novo = await client.query(
        `INSERT INTO tickets (contato_id, status, protocolo, fila_id, ultima_mensagem_em) VALUES ($1, 'pendente', $2, $3, NOW()) RETURNING id`,
        [contatoId, protocolo, filaId]
      );
      ticketId = novo.rows[0].id;
      ticketNovo = true;
      logger.info({ ticketId, protocolo, fromMe, filaId }, '[WA] Novo ticket');
    }

    // Salvar mensagem
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

    await client.query('COMMIT');

    // Marcar como lida
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

    // Salvar base64 como media_url — o <audio> aceita data URI
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

    // Salvar base64 como media_url — o <img> aceita data URI
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
    // Z-API: GET /profile-picture?phone=5571999999999
    // Para grupos, o telefone é o ID do grupo (ex: 120363421560154850)
    const response = await fetch(`${conexaoWA.baseUrl}/profile-picture?phone=${telefone}`, {
      headers: conexaoWA.headers,
    });
    if (!response.ok) return null;
    const data = await response.json();
    const url = data.link || data.imgUrl || data.profilePicThumbObj?.imgFull || data.profilePictureUrl || data.eurl || data.url || null;
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
    `SELECT c.telefone FROM tickets t JOIN contatos c ON c.id = t.contato_id WHERE t.id = $1`, [ticketId]
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

function obterQrCode() { return null; }
function obterStatus() { return conexaoWA.obterStatus(); }
async function reconectar() { await conexaoWA.desconectar(); await conexaoWA.conectar(); }
async function forcarLogout() { await conexaoWA.desconectar(); }

/**
 * Iniciar conversa com contato existente — envia mensagem + cria/reabre ticket
 */
async function iniciarConversa({ telefone, mensagem, contatoId, usuarioId }) {
  const telefoneLimpo = telefone.replace(/\D/g, '');

  // Enviar mensagem via Z-API
  await conexaoWA.enviarTexto(telefoneLimpo, mensagem);

  // Buscar ou criar ticket
  const ticketExistente = await query(
    `SELECT t.id, t.status, t.protocolo, c.nome as contato_nome, c.telefone as contato_telefone, c.avatar_url as contato_avatar
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
    // Atribuir ao atendente se não tem
    await query(
      `UPDATE tickets SET status = 'aberto', usuario_id = $1, atualizado_em = NOW() WHERE id = $2`,
      [usuarioId, ticketId]
    );
  } else {
    // Verificar se tem ticket resolvido pra reabrir
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
      // Criar ticket novo
      protocolo = _gerarProtocolo();
      const novo = await query(
        `INSERT INTO tickets (contato_id, status, protocolo, usuario_id, ultima_mensagem_em) VALUES ($1, 'aberto', $2, $3, NOW()) RETURNING id`,
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

  // Atualizar preview
  await _atualizarPreviewTicket(ticketId, mensagem);

  // Buscar dados completos do ticket pra retornar
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

  // Salvar reação no banco
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

  // Marcar como deletada no banco
  await query(`UPDATE mensagens SET corpo = '🚫 Mensagem apagada', tipo = 'sistema', deletada = TRUE WHERE id = $1`, [mensagemId]);

  logger.info({ mensagemId }, '[WA] Mensagem deletada');
  return { sucesso: true };
}

/**
 * Encaminhar mensagem para outro contato
 */
async function encaminharMensagem(mensagemId, telefoneDestino) {
  const msg = await query(`SELECT wa_message_id, ticket_id FROM mensagens WHERE id = $1`, [mensagemId]);
  if (msg.rows.length === 0) throw new AppError('Mensagem não encontrada', 404);

  const telLimpo = telefoneDestino.replace(/\D/g, '');
  await conexaoWA.encaminharMensagem(msg.rows[0].wa_message_id, telLimpo);

  logger.info({ mensagemId, telefoneDestino: telLimpo }, '[WA] Mensagem encaminhada');
  return { sucesso: true };
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
  obterQrCode,
  obterStatus,
  reconectar,
  forcarLogout,
};