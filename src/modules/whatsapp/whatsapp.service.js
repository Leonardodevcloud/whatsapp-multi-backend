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
async function processarMensagemRecebida({ telefone, nome, corpo, tipo, waMessageId, isGroup, fromMe, mediaUrl }) {
  if (isGroup) return null;

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
    let contatoResult = await client.query(`SELECT id, nome FROM contatos WHERE telefone = $1`, [telefoneLimpo]);
    let contatoId;

    if (contatoResult.rows.length === 0) {
      const novo = await client.query(
        `INSERT INTO contatos (nome, telefone) VALUES ($1, $2) RETURNING id`,
        [nome || telefoneLimpo, telefoneLimpo]
      );
      contatoId = novo.rows[0].id;
      logger.info({ contatoId, telefone: telefoneLimpo, nome }, '[WA] Novo contato');
    } else {
      contatoId = contatoResult.rows[0].id;
      // Atualizar nome se veio um nome diferente (chatName da agenda)
      if (nome && nome !== telefoneLimpo && nome !== contatoResult.rows[0].nome) {
        await client.query(`UPDATE contatos SET nome = $1, atualizado_em = NOW() WHERE id = $2`, [nome, contatoId]);
      }
    }

    // Ticket
    let ticketResult = await client.query(
      `SELECT id, status, usuario_id FROM tickets WHERE contato_id = $1 AND status NOT IN ('fechado') ORDER BY criado_em DESC LIMIT 1`,
      [contatoId]
    );

    let ticketId;
    let ticketNovo = false;

    if (ticketResult.rows.length > 0) {
      ticketId = ticketResult.rows[0].id;
      if (ticketResult.rows[0].status === 'resolvido' && !fromMe) {
        await client.query(`UPDATE tickets SET status = 'pendente', usuario_id = NULL, atualizado_em = NOW() WHERE id = $1`, [ticketId]);
      }
    } else {
      const protocolo = _gerarProtocolo();
      const novo = await client.query(
        `INSERT INTO tickets (contato_id, status, protocolo, ultima_mensagem_em) VALUES ($1, 'pendente', $2, NOW()) RETURNING id`,
        [contatoId, protocolo]
      );
      ticketId = novo.rows[0].id;
      ticketNovo = true;
      logger.info({ ticketId, protocolo }, '[WA] Novo ticket');
    }

    // Salvar mensagem
    const msgResult = await client.query(
      `INSERT INTO mensagens (ticket_id, contato_id, corpo, tipo, wa_message_id, is_from_me, status_envio, media_url)
       VALUES ($1, $2, $3, $4, $5, $6, 'entregue', $7)
       RETURNING id, ticket_id, corpo, tipo, is_from_me, criado_em, media_url`,
      [ticketId, fromMe ? null : contatoId, corpo || '', tipo, waMessageId, fromMe || false, mediaUrl || null]
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
    };

    logger.info({ ticketId, waMessageId, tipo, fromMe }, '[WA] Mensagem processada');
    return mensagemCompleta;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err: err.message, waMessageId }, '[WA] Erro ao processar');
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

function obterQrCode() { return null; }
function obterStatus() { return conexaoWA.obterStatus(); }
async function reconectar() { await conexaoWA.desconectar(); await conexaoWA.conectar(); }
async function forcarLogout() { await conexaoWA.desconectar(); }

module.exports = {
  enviarMensagemTexto,
  processarMensagemRecebida,
  obterQrCode,
  obterStatus,
  reconectar,
  forcarLogout,
};