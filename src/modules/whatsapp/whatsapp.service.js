// src/modules/whatsapp/whatsapp.service.js
// Serviço WhatsApp — Cloud API

const conexaoWA = require('./whatsapp.connection');
const { query } = require('../../config/database');
const AppError = require('../../shared/AppError');
const logger = require('../../shared/logger');

/**
 * Enviar mensagem de texto via WhatsApp Cloud API
 */
async function enviarMensagemTexto({ ticketId, texto, usuarioId }) {
  if (conexaoWA.status !== 'conectado') {
    throw new AppError('WhatsApp não está conectado', 503);
  }

  // Buscar contato do ticket
  const resultado = await query(
    `SELECT c.telefone FROM tickets t JOIN contatos c ON c.id = t.contato_id WHERE t.id = $1`,
    [ticketId]
  );

  if (resultado.rows.length === 0) {
    throw new AppError('Ticket não encontrado', 404);
  }

  const { telefone } = resultado.rows[0];

  // Enviar via Cloud API
  const sent = await conexaoWA.enviarTexto(telefone, texto);

  // Salvar mensagem no banco
  const msgResult = await query(
    `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio)
     VALUES ($1, $2, $3, 'texto', $4, TRUE, 'enviada')
     RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em`,
    [ticketId, usuarioId, texto, sent.key.id]
  );

  // Atualizar preview
  await query(
    `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW() WHERE id = $2`,
    [texto.substring(0, 200), ticketId]
  );

  // Calcular tempo de primeira resposta
  await _calcularTempoRespostaSeNecessario(ticketId);

  return msgResult.rows[0];
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
    logger.error({ err, ticketId }, '[WA] Erro ao calcular TPR');
  }
}

/**
 * Processar mensagem recebida via webhook
 */
async function processarMensagemRecebida({ telefone, nome, corpo, tipo, waMessageId, timestamp }) {
  const client = await require('../../config/database').getClient();

  try {
    await client.query('BEGIN');

    // Deduplicação
    const duplicada = await client.query(`SELECT id FROM mensagens WHERE wa_message_id = $1`, [waMessageId]);
    if (duplicada.rows.length > 0) {
      await client.query('COMMIT');
      return null;
    }

    // Contato
    let contatoResult = await client.query(`SELECT id, nome FROM contatos WHERE telefone = $1`, [telefone]);
    let contatoId;

    if (contatoResult.rows.length === 0) {
      const novo = await client.query(
        `INSERT INTO contatos (nome, telefone) VALUES ($1, $2) RETURNING id`,
        [nome || telefone, telefone]
      );
      contatoId = novo.rows[0].id;
      logger.info({ contatoId, telefone }, '[WA] Novo contato criado');
    } else {
      contatoId = contatoResult.rows[0].id;
      if (nome && !contatoResult.rows[0].nome) {
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
      if (ticketResult.rows[0].status === 'resolvido') {
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
      logger.info({ ticketId, protocolo }, '[WA] Novo ticket criado');
    }

    // Salvar mensagem
    const msgResult = await client.query(
      `INSERT INTO mensagens (ticket_id, contato_id, corpo, tipo, wa_message_id, is_from_me, status_envio)
       VALUES ($1, $2, $3, $4, $5, FALSE, 'entregue')
       RETURNING id, ticket_id, corpo, tipo, is_from_me, criado_em`,
      [ticketId, contatoId, corpo || '', tipo || 'texto', waMessageId]
    );

    // Atualizar preview
    await client.query(
      `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW() WHERE id = $2`,
      [(corpo || '📎 Mídia').substring(0, 200), ticketId]
    );

    await client.query('COMMIT');

    // Marcar como lida na Cloud API
    conexaoWA.marcarComoLida(waMessageId);

    const mensagemCompleta = {
      ...msgResult.rows[0],
      contato: { id: contatoId, nome: nome || telefone, telefone },
      ticketNovo,
    };

    logger.info({ ticketId, waMessageId, tipo }, '[WA] Mensagem recebida processada');

    return mensagemCompleta;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err: err.message, waMessageId }, '[WA] Erro ao processar mensagem');
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

async function reconectar() {
  await conexaoWA.desconectar();
  await conexaoWA.conectar();
}

async function forcarLogout() {
  await conexaoWA.desconectar();
}

module.exports = {
  enviarMensagemTexto,
  processarMensagemRecebida,
  obterQrCode,
  obterStatus,
  reconectar,
  forcarLogout,
};