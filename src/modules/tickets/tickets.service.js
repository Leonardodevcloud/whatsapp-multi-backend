// src/modules/tickets/tickets.service.js
// Serviço de tickets — CRUD, assignment, busca, resolução
// COM Redis cache nas listagens (sidebar) — reduz carga no Neon

const { query, getClient } = require('../../config/database');
const AppError = require('../../shared/AppError');
const { ERROS, STATUS_TICKET } = require('../../shared/constants');
const { registrarAuditoria } = require('../../shared/audit');
const { validarId, validarPaginacao } = require('../../shared/validators');
const logger = require('../../shared/logger');
const { cacheGet, cacheSet, cacheDel } = require('../../config/redis');

// Prefixo de cache para listagens de tickets
const CACHE_PREFIX = 'tickets:list:';
const CACHE_TTL = 8; // 8 segundos — curto o suficiente pra ser "fresco", longo pra evitar 15 users batendo o mesmo

/**
 * Invalidar cache de todas as listagens de tickets
 * Chamado após qualquer mudança de estado (aceitar, transferir, resolver, fechar)
 */
async function invalidarCacheListagens() {
  try {
    const { getRedis } = require('../../config/redis');
    const redis = getRedis();
    if (!redis) return;
    const keys = await redis.keys(`${CACHE_PREFIX}*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (err) {
    logger.error({ err: err.message }, '[Tickets] Erro ao invalidar cache');
  }
}

/**
 * Listar tickets com filtros e paginação por cursor
 * 
 * NOVO: parâmetro `ordem` controla a ordenação:
 *   - 'recente' (default): mais recente primeiro (ORDER BY t.id DESC)
 *   - 'antigo': mais antigo primeiro (ORDER BY t.criado_em ASC) — usado na Fila
 *   - 'atividade': última mensagem mais recente primeiro
 */
async function listarTickets({ cursor, limite = 50, status, filaId, usuarioId, busca, prioridade, ordem }) {
  // Redis cache — só pra listagens da sidebar (sem cursor e sem busca)
  const usarCache = !cursor && !busca;
  if (usarCache) {
    const cacheKey = `${CACHE_PREFIX}${status || 'all'}:${filaId || '0'}:${usuarioId || '0'}:${ordem || 'r'}:${limite}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;

    // Executar query e cachear resultado
    const resultado = await _executarQueryListagem({ cursor, limite, status, filaId, usuarioId, busca, prioridade, ordem });
    await cacheSet(cacheKey, resultado, CACHE_TTL);
    return resultado;
  }

  return _executarQueryListagem({ cursor, limite, status, filaId, usuarioId, busca, prioridade, ordem });
}

async function _executarQueryListagem({ cursor, limite = 50, status, filaId, usuarioId, busca, prioridade, ordem }) {
  const { cursor: cursorVal, limite: limiteVal } = validarPaginacao(cursor, limite);

  const condicoes = [];
  const params = [];
  let paramIdx = 1;

  if (cursorVal) {
    // Direção do cursor depende da ordem
    if (ordem === 'antigo') {
      condicoes.push(`t.id > $${paramIdx++}`);
    } else {
      condicoes.push(`t.id < $${paramIdx++}`);
    }
    params.push(cursorVal);
  }

  if (status) {
    condicoes.push(`t.status = $${paramIdx++}`);
    params.push(status);
  }

  if (filaId) {
    condicoes.push(`t.fila_id = $${paramIdx++}`);
    params.push(parseInt(filaId));
  }

  if (usuarioId) {
    condicoes.push(`t.usuario_id = $${paramIdx++}`);
    params.push(parseInt(usuarioId));
  }

  if (prioridade) {
    condicoes.push(`t.prioridade = $${paramIdx++}`);
    params.push(prioridade);
  }

  if (busca) {
    condicoes.push(`(
      c.nome ILIKE $${paramIdx} OR
      c.telefone ILIKE $${paramIdx} OR
      t.protocolo ILIKE $${paramIdx} OR
      t.ultima_mensagem_preview ILIKE $${paramIdx}
    )`);
    params.push(`%${busca}%`);
    paramIdx++;
  }

  const where = condicoes.length > 0 ? `WHERE ${condicoes.join(' AND ')}` : '';

  params.push(limiteVal);

  // Definir ORDER BY baseado no parâmetro `ordem`
  let orderBy;
  switch (ordem) {
    case 'antigo':
      orderBy = 't.criado_em ASC, t.id ASC';
      break;
    case 'atividade':
      orderBy = 'COALESCE(t.ultima_mensagem_em, t.criado_em) DESC, t.id DESC';
      break;
    default:
      orderBy = 't.id DESC';
  }

  // Usar LEFT JOIN com aggregation em vez de subquery correlata pra nao_lidas
  // Isto evita N+1: uma única contagem é feita via JOIN
  const resultado = await query(
    `SELECT t.id, t.contato_id, t.fila_id, t.usuario_id, t.status, t.protocolo,
            t.assunto, t.assunto_cor, t.prioridade, t.ultima_mensagem_em, t.ultima_mensagem_preview,
            t.is_bot, t.avaliacao, t.tempo_primeira_resposta_seg, t.criado_em, t.atualizado_em,
            c.nome as contato_nome, c.telefone as contato_telefone, c.avatar_url as contato_avatar,
            f.nome as fila_nome, f.cor as fila_cor,
            u.nome as atendente_nome,
            COALESCE(nl.total, 0)::int as nao_lidas
     FROM tickets t
     LEFT JOIN contatos c ON c.id = t.contato_id
     LEFT JOIN filas f ON f.id = t.fila_id
     LEFT JOIN usuarios u ON u.id = t.usuario_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) as total
       FROM mensagens m
       WHERE m.ticket_id = t.id AND m.is_from_me = FALSE AND m.status_envio != 'lida'
     ) nl ON true
     ${where}
     ORDER BY ${orderBy}
     LIMIT $${paramIdx}`,
    params
  );

  const tickets = resultado.rows;
  const proximoCursor = tickets.length === limiteVal ? tickets[tickets.length - 1].id : null;

  return { tickets, proximoCursor, total: tickets.length };
}

/**
 * Obter ticket por ID com detalhes completos
 */
async function obterTicketPorId(ticketId) {
  const id = validarId(ticketId);

  const resultado = await query(
    `SELECT t.*,
            c.nome as contato_nome, c.telefone as contato_telefone,
            c.avatar_url as contato_avatar, c.email as contato_email, c.notas as contato_notas,
            f.nome as fila_nome, f.cor as fila_cor,
            u.nome as atendente_nome, u.email as atendente_email,
            COALESCE(
              (SELECT json_agg(json_build_object('id', tg.id, 'nome', tg.nome, 'cor', tg.cor))
               FROM ticket_tags tt JOIN tags tg ON tg.id = tt.tag_id
               WHERE tt.ticket_id = t.id), '[]'
            ) as tags
     FROM tickets t
     LEFT JOIN contatos c ON c.id = t.contato_id
     LEFT JOIN filas f ON f.id = t.fila_id
     LEFT JOIN usuarios u ON u.id = t.usuario_id
     WHERE t.id = $1`,
    [id]
  );

  if (resultado.rows.length === 0) {
    throw new AppError(ERROS.NAO_ENCONTRADO, 404);
  }

  return resultado.rows[0];
}

/**
 * Criar ticket para contato SEM enviar mensagem (iniciar conversa direto)
 * Reaproveita ticket existente aberto/pendente/aguardando ou resolvido.
 */
async function criarParaContato({ contatoId, usuarioId, ip }) {
  const cId = validarId(contatoId);
  const uId = validarId(usuarioId);

  // Verificar se já existe ticket aberto/pendente/aguardando pra este contato
  const ticketExistente = await query(
    `SELECT t.id FROM tickets t
     WHERE t.contato_id = $1 AND t.status IN ('aberto', 'pendente', 'aguardando')
     ORDER BY t.id DESC LIMIT 1`,
    [cId]
  );

  let ticketId;

  if (ticketExistente.rows.length > 0) {
    ticketId = ticketExistente.rows[0].id;
    // Atribuir ao atendente atual
    await query(
      `UPDATE tickets SET usuario_id = $1, status = 'aberto', atualizado_em = NOW() WHERE id = $2`,
      [uId, ticketId]
    );
  } else {
    // Tentar reabrir resolvido recente (últimos 7 dias)
    const resolvido = await query(
      `SELECT id FROM tickets WHERE contato_id = $1 AND status = 'resolvido'
       AND atualizado_em > NOW() - INTERVAL '7 days'
       ORDER BY id DESC LIMIT 1`,
      [cId]
    );

    if (resolvido.rows.length > 0) {
      ticketId = resolvido.rows[0].id;
      await query(
        `UPDATE tickets SET status = 'aberto', usuario_id = $1, atualizado_em = NOW() WHERE id = $2`,
        [uId, ticketId]
      );
    } else {
      // Criar novo ticket
      const protocolo = `${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const novo = await query(
        `INSERT INTO tickets (contato_id, status, protocolo, usuario_id, ultima_mensagem_em)
         VALUES ($1, 'aberto', $2, $3, NOW()) RETURNING id`,
        [cId, protocolo, uId]
      );
      ticketId = novo.rows[0].id;
    }
  }

  // Mensagem de sistema
  const nomeResult = await query(`SELECT nome FROM usuarios WHERE id = $1`, [uId]);
  const nomeAtendente = nomeResult.rows[0]?.nome || 'Atendente';
  const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' });
  await query(
    `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, is_from_me, is_internal)
     VALUES ($1, $2, $3, 'sistema', TRUE, TRUE)`,
    [ticketId, uId, `${nomeAtendente} iniciou conversa às ${hora}`]
  );

  await registrarAuditoria({
    usuarioId: uId,
    acao: 'criar_ticket_contato',
    entidade: 'ticket',
    entidadeId: ticketId,
    dadosNovos: { contato_id: cId },
    ip,
  });

  logger.info({ ticketId, contatoId: cId, usuarioId: uId }, '[Tickets] Ticket criado para contato (sem mensagem)');

  await invalidarCacheListagens();
  return obterTicketPorId(ticketId);
}

/**
 * Atribuir ticket a um atendente
 */
async function atribuirTicket({ ticketId, usuarioId, adminId, ip }) {
  const tId = validarId(ticketId);
  const uId = validarId(usuarioId);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const ticket = await client.query(
      `SELECT id, status, usuario_id FROM tickets WHERE id = $1 FOR UPDATE`,
      [tId]
    );
    if (ticket.rows.length === 0) {
      throw new AppError(ERROS.NAO_ENCONTRADO, 404);
    }

    const atendente = await client.query(
      `SELECT id, nome, max_tickets_simultaneos, online, ativo FROM usuarios WHERE id = $1`,
      [uId]
    );
    if (atendente.rows.length === 0 || !atendente.rows[0].ativo) {
      throw new AppError('Atendente não encontrado ou inativo', 404);
    }

    const ticketsAtivos = await client.query(
      `SELECT COUNT(*) as total FROM tickets WHERE usuario_id = $1 AND status IN ('aberto', 'aguardando')`,
      [uId]
    );
    if (parseInt(ticketsAtivos.rows[0].total) >= atendente.rows[0].max_tickets_simultaneos) {
      throw new AppError(ERROS.MAX_TICKETS_ATINGIDO, 409);
    }

    await client.query(
      `UPDATE tickets SET usuario_id = $1, status = 'aberto', atualizado_em = NOW() WHERE id = $2`,
      [uId, tId]
    );

    await client.query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, is_from_me, is_internal)
       VALUES ($1, $2, $3, 'sistema', TRUE, TRUE)`,
      [tId, adminId || uId, `Ticket atribuído para ${atendente.rows[0].nome}`]
    );

    await client.query('COMMIT');

    await registrarAuditoria({
      usuarioId: adminId || uId,
      acao: 'atribuir_ticket',
      entidade: 'ticket',
      entidadeId: tId,
      dadosAnteriores: { usuario_id: ticket.rows[0].usuario_id },
      dadosNovos: { usuario_id: uId },
      ip,
    });

    logger.info({ ticketId: tId, atendenteId: uId }, '[Tickets] Ticket atribuído');

    await invalidarCacheListagens();
    return obterTicketPorId(tId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Aceitar ticket (atendente aceita da fila)
 */
async function aceitarTicket({ ticketId, usuarioId, ip }) {
  return atribuirTicket({ ticketId, usuarioId, adminId: usuarioId, ip });
}

/**
 * Transferir ticket para outra fila ou atendente
 */
async function transferirTicket({ ticketId, filaId, usuarioId, motivoTransferencia, adminId, ip }) {
  const tId = validarId(ticketId);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const ticket = await client.query(`SELECT * FROM tickets WHERE id = $1 FOR UPDATE`, [tId]);
    if (ticket.rows.length === 0) throw new AppError(ERROS.NAO_ENCONTRADO, 404);

    const dadosAnteriores = { fila_id: ticket.rows[0].fila_id, usuario_id: ticket.rows[0].usuario_id };

    const updates = ['atualizado_em = NOW()'];
    const params = [];
    let idx = 1;

    if (filaId) {
      updates.push(`fila_id = $${idx++}`);
      params.push(parseInt(filaId));
    }

    if (usuarioId) {
      updates.push(`usuario_id = $${idx++}`);
      params.push(parseInt(usuarioId));
      updates.push(`status = 'aberto'`);
    } else {
      updates.push(`usuario_id = NULL`);
      updates.push(`status = 'pendente'`);
    }

    params.push(tId);
    await client.query(`UPDATE tickets SET ${updates.join(', ')} WHERE id = $${idx}`, params);

    const adminResult = await client.query(`SELECT nome FROM usuarios WHERE id = $1`, [adminId]);
    const adminNome = adminResult.rows[0]?.nome || 'Atendente';
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' });

    let msgSistema = '';
    if (usuarioId) {
      const destinoResult = await client.query(`SELECT nome FROM usuarios WHERE id = $1`, [parseInt(usuarioId)]);
      const destinoNome = destinoResult.rows[0]?.nome || 'outro atendente';
      msgSistema = `${adminNome} transferiu o chamado para ${destinoNome} às ${hora}`;
    } else if (filaId) {
      msgSistema = `${adminNome} transferiu o chamado para a fila às ${hora}`;
    }
    const motivo = motivoTransferencia ? ` — Motivo: ${motivoTransferencia}` : '';

    await client.query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, is_from_me, is_internal)
       VALUES ($1, $2, $3, 'sistema', TRUE, TRUE)`,
      [tId, adminId, `${msgSistema}${motivo}`]
    );

    await client.query('COMMIT');

    await registrarAuditoria({
      usuarioId: adminId,
      acao: 'transferir_ticket',
      entidade: 'ticket',
      entidadeId: tId,
      dadosAnteriores,
      dadosNovos: { fila_id: filaId, usuario_id: usuarioId },
      ip,
    });

    await invalidarCacheListagens();
    return obterTicketPorId(tId);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolver ticket
 */
async function resolverTicket({ ticketId, usuarioId, ip, motivoId, motivoTexto }) {
  const tId = validarId(ticketId);

  const ticket = await query(`SELECT * FROM tickets WHERE id = $1`, [tId]);
  if (ticket.rows.length === 0) throw new AppError(ERROS.NAO_ENCONTRADO, 404);

  const tempoResolucao = Math.floor(
    (Date.now() - new Date(ticket.rows[0].criado_em).getTime()) / 1000
  );

  await query(
    `UPDATE tickets SET status = 'resolvido', tempo_resolucao_seg = $1, motivo_fechamento_id = $2, motivo_fechamento_texto = $3, atualizado_em = NOW() WHERE id = $4`,
    [tempoResolucao, motivoId || null, motivoTexto || null, tId]
  );

  const nomeResult = await query(`SELECT nome FROM usuarios WHERE id = $1`, [usuarioId]);
  const nomeAtendente = nomeResult.rows[0]?.nome || 'Atendente';
  const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' });

  await query(
    `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, is_from_me, is_internal)
     VALUES ($1, $2, $3, 'sistema', TRUE, TRUE)`,
    [tId, usuarioId, `${nomeAtendente} finalizou o chamado às ${hora}`]
  );

  await registrarAuditoria({
    usuarioId,
    acao: 'resolver_ticket',
    entidade: 'ticket',
    entidadeId: tId,
    dadosNovos: { status: 'resolvido', tempo_resolucao_seg: tempoResolucao },
    ip,
  });

  await invalidarCacheListagens();
  return obterTicketPorId(tId);
}

/**
 * Fechar ticket
 */
async function fecharTicket({ ticketId, usuarioId, ip }) {
  const tId = validarId(ticketId);

  await query(
    `UPDATE tickets SET status = 'fechado', fechado_em = NOW(), atualizado_em = NOW() WHERE id = $1`,
    [tId]
  );

  await query(
    `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, is_from_me, is_internal)
     VALUES ($1, $2, 'Ticket fechado', 'sistema', TRUE, TRUE)`,
    [tId, usuarioId]
  );

  await registrarAuditoria({
    usuarioId,
    acao: 'fechar_ticket',
    entidade: 'ticket',
    entidadeId: tId,
    ip,
  });

  await invalidarCacheListagens();
  return obterTicketPorId(tId);
}

/**
 * Atualizar campos do ticket (assunto, prioridade, fila)
 */
async function atualizarTicket({ ticketId, dados, usuarioId, ip }) {
  const tId = validarId(ticketId);
  const camposPermitidos = ['assunto', 'prioridade', 'fila_id'];

  const updates = [];
  const params = [];
  let idx = 1;

  for (const [campo, valor] of Object.entries(dados)) {
    if (camposPermitidos.includes(campo) && valor !== undefined) {
      updates.push(`${campo} = $${idx++}`);
      params.push(valor);
    }
  }

  if (updates.length === 0) {
    throw new AppError('Nenhum campo válido para atualizar', 400);
  }

  updates.push('atualizado_em = NOW()');
  params.push(tId);

  await query(`UPDATE tickets SET ${updates.join(', ')} WHERE id = $${idx}`, params);

  await registrarAuditoria({
    usuarioId,
    acao: 'atualizar_ticket',
    entidade: 'ticket',
    entidadeId: tId,
    dadosNovos: dados,
    ip,
  });

  await invalidarCacheListagens();
  return obterTicketPorId(tId);
}

/**
 * Marcar ticket como aguardando (retorno do cliente)
 */
async function marcarAguardando({ ticketId, usuarioId, ip }) {
  const tId = validarId(ticketId);

  await query(
    `UPDATE tickets SET status = 'aguardando', atualizado_em = NOW() WHERE id = $1`,
    [tId]
  );

  await query(
    `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, is_from_me, is_internal)
     VALUES ($1, $2, 'Ticket marcado como aguardando retorno', 'sistema', TRUE, TRUE)`,
    [tId, usuarioId]
  );

  await invalidarCacheListagens();
  return obterTicketPorId(tId);
}

/**
 * Contadores de tickets por status (para dashboard)
 */
async function obterContadores(usuarioId) {
  const resultado = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pendente') as pendentes,
       COUNT(*) FILTER (WHERE status = 'aberto') as abertos,
       COUNT(*) FILTER (WHERE status = 'aguardando') as aguardando,
       COUNT(*) FILTER (WHERE status = 'resolvido' AND DATE(atualizado_em) = CURRENT_DATE) as resolvidos_hoje,
       COUNT(*) FILTER (WHERE status IN ('aberto', 'aguardando') AND usuario_id = $1) as meus_tickets
     FROM tickets`,
    [usuarioId]
  );

  return resultado.rows[0];
}

// ============================================================
// MOTIVOS DE ATENDIMENTO — CRUD
// ============================================================

async function listarMotivos() {
  const resultado = await query(
    `SELECT id, nome, ativo, ordem FROM motivos_atendimento ORDER BY ordem ASC, nome ASC`
  );
  return resultado.rows;
}

async function listarMotivosAtivos() {
  const resultado = await query(
    `SELECT id, nome FROM motivos_atendimento WHERE ativo = TRUE ORDER BY ordem ASC, nome ASC`
  );
  return resultado.rows;
}

async function criarMotivo({ nome, ordem }) {
  if (!nome?.trim()) throw new AppError('Nome do motivo é obrigatório', 400);
  const resultado = await query(
    `INSERT INTO motivos_atendimento (nome, ordem) VALUES ($1, $2) RETURNING *`,
    [nome.trim(), ordem || 0]
  );
  return resultado.rows[0];
}

async function atualizarMotivo({ id, nome, ativo, ordem }) {
  const mId = validarId(id);
  const updates = [];
  const params = [];
  let idx = 1;

  if (nome !== undefined) { updates.push(`nome = $${idx++}`); params.push(nome.trim()); }
  if (ativo !== undefined) { updates.push(`ativo = $${idx++}`); params.push(ativo); }
  if (ordem !== undefined) { updates.push(`ordem = $${idx++}`); params.push(ordem); }

  if (updates.length === 0) throw new AppError('Nada para atualizar', 400);

  updates.push('atualizado_em = NOW()');
  params.push(mId);

  const resultado = await query(
    `UPDATE motivos_atendimento SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  if (resultado.rows.length === 0) throw new AppError(ERROS.NAO_ENCONTRADO, 404);
  return resultado.rows[0];
}

async function deletarMotivo(id) {
  const mId = validarId(id);
  const usado = await query(`SELECT COUNT(*) as total FROM tickets WHERE motivo_fechamento_id = $1`, [mId]);
  if (parseInt(usado.rows[0].total) > 0) {
    await query(`UPDATE motivos_atendimento SET ativo = FALSE, atualizado_em = NOW() WHERE id = $1`, [mId]);
    return { desativado: true };
  }
  await query(`DELETE FROM motivos_atendimento WHERE id = $1`, [mId]);
  return { deletado: true };
}

module.exports = {
  listarTickets,
  obterTicketPorId,
  atribuirTicket,
  aceitarTicket,
  transferirTicket,
  resolverTicket,
  fecharTicket,
  atualizarTicket,
  marcarAguardando,
  obterContadores,
  criarParaContato,
  invalidarCacheListagens,
  listarMotivos,
  listarMotivosAtivos,
  criarMotivo,
  atualizarMotivo,
  deletarMotivo,
};
