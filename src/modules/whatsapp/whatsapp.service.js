// src/modules/whatsapp/whatsapp.service.js
// Lógica de envio/recebimento de mensagens WhatsApp

const conexaoWA = require('./whatsapp.connection');
const { query } = require('../../config/database');
const AppError = require('../../shared/AppError');
const { ERROS } = require('../../shared/constants');
const logger = require('../../shared/logger');

/**
 * Formatar número para JID do WhatsApp
 * Entrada: 5571999999999 → Saída: 5571999999999@s.whatsapp.net
 */
function formatarJid(telefone) {
  const limpo = telefone.replace(/\D/g, '');
  return `${limpo}@s.whatsapp.net`;
}

/**
 * Extrair telefone do JID
 * Entrada: 5571999999999@s.whatsapp.net → Saída: 5571999999999
 */
function extrairTelefone(jid) {
  return jid?.split('@')[0]?.replace(/\D/g, '') || '';
}

/**
 * Enviar mensagem de texto via WhatsApp
 */
async function enviarMensagemTexto({ ticketId, texto, usuarioId }) {
  if (conexaoWA.status !== 'conectado') {
    throw new AppError(ERROS.WHATSAPP_DESCONECTADO, 503);
  }

  // Buscar contato do ticket
  const resultado = await query(
    `SELECT c.telefone, t.id as ticket_id
     FROM tickets t
     JOIN contatos c ON c.id = t.contato_id
     WHERE t.id = $1`,
    [ticketId]
  );

  if (resultado.rows.length === 0) {
    throw new AppError('Ticket não encontrado', 404);
  }

  const { telefone } = resultado.rows[0];
  const jid = formatarJid(telefone);

  // Enviar via Baileys
  const sent = await conexaoWA.enviarTexto(jid, texto);

  // Salvar mensagem no banco
  const msgResult = await query(
    `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, wa_message_id, is_from_me, status_envio)
     VALUES ($1, $2, $3, 'texto', $4, TRUE, 'enviada')
     RETURNING id, corpo, tipo, is_from_me, status_envio, criado_em`,
    [ticketId, usuarioId, texto, sent.key.id]
  );

  // Atualizar preview do ticket
  await query(
    `UPDATE tickets SET ultima_mensagem_em = NOW(), ultima_mensagem_preview = $1, atualizado_em = NOW()
     WHERE id = $2`,
    [texto.substring(0, 200), ticketId]
  );

  // Calcular tempo de primeira resposta se for a primeira msg do atendente
  await _calcularTempoRespostaSeNecessario(ticketId);

  logger.info({ ticketId, waMessageId: sent.key.id }, '[WA] Mensagem enviada');

  return msgResult.rows[0];
}

/**
 * Calcular tempo de primeira resposta do atendente
 */
async function _calcularTempoRespostaSeNecessario(ticketId) {
  try {
    const ticket = await query(
      `SELECT tempo_primeira_resposta_seg, criado_em FROM tickets WHERE id = $1`,
      [ticketId]
    );

    if (ticket.rows[0]?.tempo_primeira_resposta_seg !== null) return;

    const diffSeg = Math.floor(
      (Date.now() - new Date(ticket.rows[0].criado_em).getTime()) / 1000
    );

    await query(
      `UPDATE tickets SET tempo_primeira_resposta_seg = $1 WHERE id = $2`,
      [diffSeg, ticketId]
    );
  } catch (err) {
    logger.error({ err, ticketId }, '[WA] Erro ao calcular tempo de primeira resposta');
  }
}

/**
 * Obter QR Code atual
 */
function obterQrCode() {
  return conexaoWA.qrCode;
}

/**
 * Obter status da conexão
 */
function obterStatus() {
  return conexaoWA.obterStatus();
}

/**
 * Reconectar WhatsApp
 */
async function reconectar() {
  await conexaoWA.desconectar();
  conexaoWA.tentativasReconexao = 0;
  await conexaoWA.conectar();
}

/**
 * Forçar logout (desvincular aparelho)
 */
async function forcarLogout() {
  await conexaoWA.forcarLogout();
}

module.exports = {
  enviarMensagemTexto,
  obterQrCode,
  obterStatus,
  reconectar,
  forcarLogout,
  formatarJid,
  extrairTelefone,
};
