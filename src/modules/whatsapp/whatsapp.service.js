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

    const telefoneLimpo = telefone.replace('@c.us', '').replace(/\D/g, '');

    // Contato — pra mensagens fromMe, o telefone é do destinatário
    let contatoResult = await client.query(`SELECT id, nome, avatar_url FROM contatos WHERE telefone = $1`, [telefoneLimpo]);
    let contatoId;

    if (contatoResult.rows.length === 0) {
      // Buscar foto de perfil (async, não bloqueia)
      let avatarUrl = null;
      try {
        avatarUrl = await buscarFotoPerfil(telefoneLimpo);
      } catch { /* não crítico */ }

      const novo = await client.query(
        `INSERT INTO contatos (nome, telefone, avatar_url) VALUES ($1, $2, $3) RETURNING id`,
        [nome || telefoneLimpo, telefoneLimpo, avatarUrl]
      );
      contatoId = novo.rows[0].id;
      logger.info({ contatoId, telefone: telefoneLimpo, nome, temAvatar: !!avatarUrl }, '[WA] Novo contato');
    } else {
      contatoId = contatoResult.rows[0].id;
      if (nome && nome !== telefoneLimpo && nome !== contatoResult.rows[0].nome) {
        await client.query(`UPDATE contatos SET nome = $1, atualizado_em = NOW() WHERE id = $2`, [nome, contatoId]);
      }
      // Buscar foto se não tem ainda
      if (!contatoResult.rows[0].avatar_url) {
        // Fazer async sem bloquear o processamento
        buscarFotoPerfil(telefoneLimpo).then(url => {
          if (url) {
            query(`UPDATE contatos SET avatar_url = $1, atualizado_em = NOW() WHERE id = $2`, [url, contatoId]).catch(() => {});
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
      // Para fromMe, criar como 'aberto' (não precisa aceitar)
      const statusInicial = fromMe ? 'aberto' : 'pendente';
      const novo = await client.query(
        `INSERT INTO tickets (contato_id, status, protocolo, ultima_mensagem_em) VALUES ($1, $2, $3, NOW()) RETURNING id`,
        [contatoId, statusInicial, protocolo]
      );
      ticketId = novo.rows[0].id;
      ticketNovo = true;
      logger.info({ ticketId, protocolo, fromMe }, '[WA] Novo ticket');
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

    const msgResult = await query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio, media_url)
       VALUES ($1, $2, '🎵 Áudio', 'audio', $3, TRUE, 'enviada', $4)
       RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em, media_url`,
      [ticketId, usuarioId, data.zapiMessageId || data.messageId || 'sent', audioBase64.substring(0, 500)]
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
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio)
       VALUES ($1, $2, $3, 'imagem', $4, TRUE, 'enviada')
       RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em`,
      [ticketId, usuarioId, caption || '📷 Imagem', data.zapiMessageId || data.messageId || 'sent']
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
 * Buscar foto de perfil via Z-API
 */
async function buscarFotoPerfil(telefone) {
  if (!conexaoWA.instanceId || !conexaoWA.token) return null;
  try {
    const response = await fetch(`${conexaoWA.baseUrl}/profile-picture/${telefone}`, {
      headers: conexaoWA.headers,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.link || data.profilePicThumbObj?.imgFull || data.profilePictureUrl || null;
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

module.exports = {
  enviarMensagemTexto,
  enviarAudio,
  enviarImagem,
  enviarVideo,
  enviarDocumento,
  buscarFotoPerfil,
  processarMensagemRecebida,
  obterQrCode,
  obterStatus,
  reconectar,
  forcarLogout,
};