// src/modules/contacts/contacts.service.js
// Serviço de contatos — CRUD, tags, busca com filtro grupo/individual

const { query, getClient } = require('../../config/database');
const AppError = require('../../shared/AppError');
const { registrarAuditoria } = require('../../shared/audit');
const { validarId, validarPaginacao } = require('../../shared/validators');
const logger = require('../../shared/logger');

/**
 * Listar contatos com filtro por tipo (grupo/individual), ordenado por total de tickets
 */
async function listarContatos({ cursor, limite = 100, busca, tipo }) {
  const { cursor: cursorVal, limite: limiteVal } = validarPaginacao(cursor, limite);

  const condicoes = [];
  const params = [];
  let idx = 1;

  if (busca) {
    condicoes.push(`(c.nome ILIKE $${idx} OR c.telefone ILIKE $${idx} OR c.email ILIKE $${idx})`);
    params.push(`%${busca}%`);
    idx++;
  }

  // Filtrar por tipo: grupos têm telefone com 15+ dígitos
  if (tipo === 'grupo') {
    condicoes.push(`LENGTH(c.telefone) > 15`);
  } else if (tipo === 'contato') {
    condicoes.push(`LENGTH(c.telefone) <= 15`);
  }

  const where = condicoes.length > 0 ? `WHERE ${condicoes.join(' AND ')}` : '';
  params.push(limiteVal);

  const resultado = await query(
    `SELECT c.id, c.nome, c.telefone, c.avatar_url, c.email, c.criado_em,
            (SELECT COUNT(*) FROM tickets t WHERE t.contato_id = c.id) as total_tickets,
            (SELECT t.ultima_mensagem_em FROM tickets t WHERE t.contato_id = c.id ORDER BY t.criado_em DESC LIMIT 1) as ultimo_contato,
            (SELECT t.status FROM tickets t WHERE t.contato_id = c.id ORDER BY t.criado_em DESC LIMIT 1) as ultimo_status,
            COALESCE(
              (SELECT json_agg(json_build_object('id', tg.id, 'nome', tg.nome, 'cor', tg.cor))
               FROM contato_tags ct JOIN tags tg ON tg.id = ct.tag_id
               WHERE ct.contato_id = c.id), '[]'
            ) as tags
     FROM contatos c
     ${where}
     ORDER BY (SELECT COUNT(*) FROM tickets t WHERE t.contato_id = c.id) DESC, c.nome ASC
     LIMIT $${idx}`,
    params
  );

  const contatos = resultado.rows;
  const proximoCursor = contatos.length === limiteVal ? contatos[contatos.length - 1].id : null;

  return { contatos, proximoCursor };
}

/**
 * Obter contato por ID com histórico de tickets
 */
async function obterContatoPorId(contatoId) {
  const id = validarId(contatoId);

  const resultado = await query(
    `SELECT c.*,
            COALESCE(
              (SELECT json_agg(json_build_object('id', tg.id, 'nome', tg.nome, 'cor', tg.cor))
               FROM contato_tags ct JOIN tags tg ON tg.id = ct.tag_id
               WHERE ct.contato_id = c.id), '[]'
            ) as tags
     FROM contatos c WHERE c.id = $1`,
    [id]
  );

  if (resultado.rows.length === 0) {
    throw new AppError('Contato não encontrado', 404);
  }

  // Últimos 20 tickets do contato
  const tickets = await query(
    `SELECT t.id, t.status, t.protocolo, t.assunto, t.prioridade, t.criado_em, t.fechado_em,
            t.ultima_mensagem_em, t.ultima_mensagem_preview,
            u.nome as atendente_nome, f.nome as fila_nome
     FROM tickets t
     LEFT JOIN usuarios u ON u.id = t.usuario_id
     LEFT JOIN filas f ON f.id = t.fila_id
     WHERE t.contato_id = $1
     ORDER BY t.id DESC
     LIMIT 20`,
    [id]
  );

  return { ...resultado.rows[0], historico_tickets: tickets.rows };
}

/**
 * Buscar histórico completo de mensagens de um contato (todos os tickets)
 */
async function obterHistoricoMensagens(contatoId, { limite = 200 }) {
  const id = validarId(contatoId);

  const resultado = await query(
    `SELECT m.id, m.corpo, m.tipo, m.is_from_me, m.is_internal, m.criado_em,
            m.media_url, m.status_envio, m.nome_participante, m.reacao, m.deletada,
            t.protocolo, t.id as ticket_id,
            u.nome as usuario_nome
     FROM mensagens m
     JOIN tickets t ON t.id = m.ticket_id
     LEFT JOIN usuarios u ON u.id = m.usuario_id
     WHERE t.contato_id = $1
     ORDER BY m.criado_em ASC
     LIMIT $2`,
    [id, limite]
  );

  return { mensagens: resultado.rows, total: resultado.rows.length };
}

/**
 * Atualizar contato
 */
async function atualizarContato({ contatoId, dados, usuarioId, ip }) {
  const id = validarId(contatoId);
  const camposPermitidos = ['nome', 'email', 'notas'];

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
  params.push(id);

  await query(`UPDATE contatos SET ${updates.join(', ')} WHERE id = $${idx}`, params);

  await registrarAuditoria({
    usuarioId,
    acao: 'atualizar_contato',
    entidade: 'contato',
    entidadeId: id,
    dadosNovos: dados,
    ip,
  });

  return obterContatoPorId(id);
}

/**
 * Adicionar tag a contato
 */
async function adicionarTag({ contatoId, tagId }) {
  const cId = validarId(contatoId);
  const tId = validarId(tagId);

  await query(
    `INSERT INTO contato_tags (contato_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [cId, tId]
  );

  return obterContatoPorId(cId);
}

/**
 * Remover tag de contato
 */
async function removerTag({ contatoId, tagId }) {
  const cId = validarId(contatoId);
  const tId = validarId(tagId);

  await query(`DELETE FROM contato_tags WHERE contato_id = $1 AND tag_id = $2`, [cId, tId]);

  return obterContatoPorId(cId);
}

module.exports = {
  listarContatos,
  obterContatoPorId,
  obterHistoricoMensagens,
  atualizarContato,
  adicionarTag,
  removerTag,
};
