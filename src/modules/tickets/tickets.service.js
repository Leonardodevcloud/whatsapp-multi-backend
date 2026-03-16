// src/modules/tickets/tickets.service.js
// Serviço de tickets — CRUD, assignment, busca, resolução

const { query, getClient } = require('../../config/database');
const AppError = require('../../shared/AppError');
const { ERROS, STATUS_TICKET } = require('../../shared/constants');
const { registrarAuditoria } = require('../../shared/audit');
const { validarId, validarPaginacao } = require('../../shared/validators');
const logger = require('../../shared/logger');

/**
 * Listar tickets com filtros e paginação por cursor
 */
async function listarTickets({ cursor, limite = 50, status, filaId, usuarioId, busca, prioridade }) {
  const { cursor: cursorVal, limite: limiteVal } = validarPaginacao(cursor, limite);

  const condicoes = [];
  const params = [];
  let paramIdx = 1;

  if (cursorVal) {
    condicoes.push(`t.id < $${paramIdx++}`);
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

  const resultado = await query(
    `SELECT t.id, t.contato_id, t.fila_id, t.usuario_id, t.status, t.protocolo,
            t.assunto, t.prioridade, t.ultima_mensagem_em, t.ultima_mensagem_preview,
            t.is_bot, t.avaliacao, t.tempo_primeira_resposta_seg, t.criado_em, t.atualizado_em,
            c.nome as contato_nome, c.telefone as contato_telefone, c.avatar_url as contato_avatar,
            f.nome as fila_nome, f.cor as fila_cor,
            u.nome as atendente_nome,
            (SELECT COUNT(*) FROM mensagens m WHERE m.ticket_id = t.id AND m.is_from_me = FALSE AND m.status_envio != 'lida') as nao_lidas
     FROM tickets t
     LEFT JOIN contatos c ON c.id = t.contato_id
     LEFT JOIN filas f ON f.id = t.fila_id
     LEFT JOIN usuarios u ON u.id = t.usuario_id
     ${where}
     ORDER BY t.id DESC
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
 * Atribuir ticket a um atendente
 */
async function atribuirTicket({ ticketId, usuarioId, adminId, ip }) {
  const tId = validarId(ticketId);
  const uId = validarId(usuarioId);

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Verificar ticket
    const ticket = await client.query(
      `SELECT id, status, usuario_id FROM tickets WHERE id = $1 FOR UPDATE`,
      [tId]
    );
    if (ticket.rows.length === 0) {
      throw new AppError(ERROS.NAO_ENCONTRADO, 404);
    }

    // Verificar atendente
    const atendente = await client.query(
      `SELECT id, nome, max_tickets_simultaneos, online, ativo FROM usuarios WHERE id = $1`,
      [uId]
    );
    if (atendente.rows.length === 0 || !atendente.rows[0].ativo) {
      throw new AppError('Atendente não encontrado ou inativo', 404);
    }

    // Verificar limite de tickets simultâneos
    const ticketsAtivos = await client.query(
      `SELECT COUNT(*) as total FROM tickets WHERE usuario_id = $1 AND status IN ('aberto', 'aguardando')`,
      [uId]
    );
    if (parseInt(ticketsAtivos.rows[0].total) >= atendente.rows[0].max_tickets_simultaneos) {
      throw new AppError(ERROS.MAX_TICKETS_ATINGIDO, 409);
    }

    // Atribuir
    await client.query(
      `UPDATE tickets SET usuario_id = $1, status = 'aberto', atualizado_em = NOW() WHERE id = $2`,
      [uId, tId]
    );

    // Mensagem de sistema
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
      // Transferir pra fila sem atendente = voltar pra pendente
      updates.push(`usuario_id = NULL`);
      updates.push(`status = 'pendente'`);
    }

    params.push(tId);
    await client.query(`UPDATE tickets SET ${updates.join(', ')} WHERE id = $${idx}`, params);

    // Mensagem de sistema
    const motivo = motivoTransferencia ? ` — Motivo: ${motivoTransferencia}` : '';
    await client.query(
      `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, is_from_me, is_internal)
       VALUES ($1, $2, $3, 'sistema', TRUE, TRUE)`,
      [tId, adminId, `Ticket transferido${motivo}`]
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
async function resolverTicket({ ticketId, usuarioId, ip }) {
  const tId = validarId(ticketId);

  const ticket = await query(`SELECT * FROM tickets WHERE id = $1`, [tId]);
  if (ticket.rows.length === 0) throw new AppError(ERROS.NAO_ENCONTRADO, 404);

  const tempoResolucao = Math.floor(
    (Date.now() - new Date(ticket.rows[0].criado_em).getTime()) / 1000
  );

  await query(
    `UPDATE tickets SET status = 'resolvido', tempo_resolucao_seg = $1, atualizado_em = NOW() WHERE id = $2`,
    [tempoResolucao, tId]
  );

  // Mensagem de sistema
  await query(
    `INSERT INTO mensagens (ticket_id, usuario_id, corpo, tipo, is_from_me, is_internal)
     VALUES ($1, $2, 'Ticket resolvido', 'sistema', TRUE, TRUE)`,
    [tId, usuarioId]
  );

  await registrarAuditoria({
    usuarioId,
    acao: 'resolver_ticket',
    entidade: 'ticket',
    entidadeId: tId,
    dadosNovos: { status: 'resolvido', tempo_resolucao_seg: tempoResolucao },
    ip,
  });

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
};
