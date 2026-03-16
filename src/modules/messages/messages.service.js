// src/modules/messages/messages.service.js
// Serviço de mensagens — listagem, notas internas, status

const { query } = require('../../config/database');
const AppError = require('../../shared/AppError');
const { validarId, validarPaginacao, validarCampoObrigatorio } = require('../../shared/validators');
const logger = require('../../shared/logger');

/**
 * Listar mensagens de um ticket com paginação por cursor
 * Cursor ascendente — mensagens mais antigas primeiro
 */
async function listarMensagens({ ticketId, cursor, limite = 50 }) {
  const tId = validarId(ticketId, 'ticket_id');
  const { cursor: cursorVal, limite: limiteVal } = validarPaginacao(cursor, limite);

  const condicoes = [`m.ticket_id = $1`];
  const params = [tId];
  let paramIdx = 2;

  if (cursorVal) {
    condicoes.push(`m.id < $${paramIdx++}`);
    params.push(cursorVal);
  }

  params.push(limiteVal);

  // Buscar do mais recente pro mais antigo, depois inverter no frontend
  const resultado = await query(
    `SELECT m.id, m.ticket_id, m.contato_id, m.usuario_id, m.corpo, m.tipo,
            m.media_url, m.media_tipo, m.media_nome, m.wa_message_id,
            m.is_from_me, m.is_internal, m.status_envio, m.quoted_message_id, m.criado_em,
            c.nome as contato_nome,
            u.nome as usuario_nome, u.avatar_url as usuario_avatar,
            qm.corpo as quoted_corpo, qm.tipo as quoted_tipo
     FROM mensagens m
     LEFT JOIN contatos c ON c.id = m.contato_id
     LEFT JOIN usuarios u ON u.id = m.usuario_id
     LEFT JOIN mensagens qm ON qm.id = m.quoted_message_id
     WHERE ${condicoes.join(' AND ')}
     ORDER BY m.id DESC
     LIMIT $${paramIdx}`,
    params
  );

  const mensagens = resultado.rows.reverse(); // Ordem cronológica
  const proximoCursor = resultado.rows.length === limiteVal ? resultado.rows[resultado.rows.length - 1].id : null;

  return { mensagens, proximoCursor, total: mensagens.length };
}

/**
 * Criar nota interna (não é enviada ao cliente)
 */
async function criarNotaInterna({ ticketId, texto, usuarioId }) {
  const tId = validarId(ticketId, 'ticket_id');
  validarCampoObrigatorio(texto, 'texto');

  const resultado = await query(
    `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, is_from_me, is_internal, status_envio)
     VALUES ($1, $2, $3, 'texto', TRUE, TRUE, 'enviada')
     RETURNING id, ticket_id, usuario_id, corpo, tipo, is_from_me, is_internal, criado_em`,
    [tId, usuarioId, texto.trim()]
  );

  const mensagem = resultado.rows[0];

  // Buscar nome do usuario pra retornar completo
  const usuario = await query(`SELECT nome, avatar_url FROM usuarios WHERE id = $1`, [usuarioId]);
  mensagem.usuario_nome = usuario.rows[0]?.nome;
  mensagem.usuario_avatar = usuario.rows[0]?.avatar_url;

  logger.info({ ticketId: tId, mensagemId: mensagem.id }, '[Messages] Nota interna criada');

  return mensagem;
}

/**
 * Atualizar status de envio (chamado pelo webhook do Baileys)
 */
async function atualizarStatusEnvio({ waMessageId, status }) {
  if (!waMessageId || !status) return;

  await query(
    `UPDATE mensagens SET status_envio = $1 WHERE wa_message_id = $2`,
    [status, waMessageId]
  );
}

/**
 * Marcar mensagens como lidas (por ticket)
 */
async function marcarComoLidas({ ticketId, usuarioId }) {
  const tId = validarId(ticketId, 'ticket_id');

  const resultado = await query(
    `UPDATE mensagens SET status_envio = 'lida'
     WHERE ticket_id = $1 AND is_from_me = FALSE AND status_envio != 'lida'
     RETURNING id`,
    [tId]
  );

  return { atualizadas: resultado.rowCount };
}

/**
 * Contar mensagens não lidas por ticket (para badges)
 */
async function contarNaoLidas(usuarioId) {
  const resultado = await query(
    `SELECT t.id as ticket_id, COUNT(m.id) as nao_lidas
     FROM tickets t
     JOIN mensagens m ON m.ticket_id = t.id
     WHERE t.usuario_id = $1
       AND t.status IN ('aberto', 'aguardando')
       AND m.is_from_me = FALSE
       AND m.status_envio != 'lida'
     GROUP BY t.id`,
    [usuarioId]
  );

  return resultado.rows;
}

module.exports = {
  listarMensagens,
  criarNotaInterna,
  atualizarStatusEnvio,
  marcarComoLidas,
  contarNaoLidas,
};
