// src/modules/messages/messages.service.js
// Serviço de mensagens — listagem com Redis cache, notas internas, status

const { query } = require('../../config/database');
const AppError = require('../../shared/AppError');
const { validarId, validarPaginacao, validarCampoObrigatorio } = require('../../shared/validators');
const logger = require('../../shared/logger');
const { cacheGet, cacheSet, cacheDel } = require('../../config/redis');

const CACHE_PREFIX = 'msgs:';
const CACHE_TTL = 10; // 10 segundos — curto pra ser fresco

/**
 * Listar mensagens de um ticket com paginação por cursor
 * Redis cache nas últimas 50 (sem cursor) — cache invalidado por WS
 */
async function listarMensagens({ ticketId, cursor, limite = 50 }) {
  const tId = validarId(ticketId, 'ticket_id');
  const { cursor: cursorVal, limite: limiteVal } = validarPaginacao(cursor, limite);

  // Cache só para a primeira página (sem cursor) — é o caso mais comum
  if (!cursorVal) {
    const cacheKey = `${CACHE_PREFIX}${tId}:${limiteVal}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    const resultado = await _queryMensagens(tId, null, limiteVal);
    await cacheSet(cacheKey, resultado, CACHE_TTL);
    return resultado;
  }

  return _queryMensagens(tId, cursorVal, limiteVal);
}

async function _queryMensagens(tId, cursorVal, limiteVal) {
  const condicoes = [`m.ticket_id = $1`];
  const params = [tId];
  let paramIdx = 2;

  if (cursorVal) {
    condicoes.push(`m.id < $${paramIdx++}`);
    params.push(cursorVal);
  }

  params.push(limiteVal);

  const resultado = await query(
    `SELECT m.id, m.ticket_id, m.contato_id, m.usuario_id, m.corpo, m.tipo,
            m.media_url, m.media_tipo, m.media_nome, m.wa_message_id,
            m.is_from_me, m.is_internal, m.status_envio, m.quoted_message_id, m.criado_em,
            m.nome_participante, m.reacao, m.deletada, m.deletada_por, m.atualizado_em,
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

  const mensagens = resultado.rows.reverse();
  const proximoCursor = resultado.rows.length === limiteVal ? resultado.rows[resultado.rows.length - 1].id : null;

  return { mensagens, proximoCursor, total: mensagens.length };
}

/**
 * Invalidar cache de mensagens de um ticket (chamado após nova mensagem)
 */
async function invalidarCacheMensagens(ticketId) {
  try {
    const { getRedis } = require('../../config/redis');
    const redis = getRedis();
    if (!redis) return;
    const keys = await redis.keys(`${CACHE_PREFIX}${ticketId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  } catch (err) {
    logger.error({ err: err.message }, '[Messages] Erro ao invalidar cache');
  }
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

  const usuario = await query(`SELECT nome, avatar_url FROM usuarios WHERE id = $1`, [usuarioId]);
  mensagem.usuario_nome = usuario.rows[0]?.nome;
  mensagem.usuario_avatar = usuario.rows[0]?.avatar_url;

  await invalidarCacheMensagens(tId);
  logger.info({ ticketId: tId, mensagemId: mensagem.id }, '[Messages] Nota interna criada');

  return mensagem;
}

/**
 * Atualizar status de envio (chamado pelo webhook do Baileys)
 */
async function atualizarStatusEnvio({ waMessageId, status }) {
  if (!waMessageId || !status) return;

  const result = await query(
    `UPDATE mensagens SET status_envio = $1 WHERE wa_message_id = $2 RETURNING ticket_id`,
    [status, waMessageId]
  );

  // Invalidar cache do ticket afetado
  if (result.rows[0]?.ticket_id) {
    await invalidarCacheMensagens(result.rows[0].ticket_id);
  }
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

  await invalidarCacheMensagens(tId);
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

/**
 * Registrar mensagem de sistema
 */
async function registrarMensagemSistema({ ticketId, corpo, usuarioId }) {
  const resultado = await query(
    `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, is_from_me, is_internal, status_envio)
     VALUES ($1, $2, $3, 'sistema', TRUE, TRUE, 'entregue')
     RETURNING id, ticket_id, corpo, tipo, is_from_me, is_internal, criado_em`,
    [ticketId, usuarioId || null, corpo]
  );

  await invalidarCacheMensagens(ticketId);
  return resultado.rows[0];
}

module.exports = {
  listarMensagens,
  criarNotaInterna,
  atualizarStatusEnvio,
  marcarComoLidas,
  contarNaoLidas,
  registrarMensagemSistema,
  invalidarCacheMensagens,
};
