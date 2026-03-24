// src/modules/contacts/contacts.service.js
// Serviço de contatos — CRUD, tags, busca com filtro grupo/individual, mídias

const { query, getClient } = require('../../config/database');
const AppError = require('../../shared/AppError');
const { registrarAuditoria } = require('../../shared/audit');
const { validarId } = require('../../shared/validators');
const logger = require('../../shared/logger');

/**
 * Listar contatos com filtro por tipo (grupo/individual), ordenado por total de tickets
 */
async function listarContatos({ cursor, limite = 100, busca, tipo, offset = 0 }) {
  const limiteVal = Math.min(parseInt(limite) || 100, 200);

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

  // Contar total (sem limite)
  const countParams = [...params];
  const countResult = await query(
    `SELECT COUNT(*) as total FROM contatos c ${where}`,
    countParams
  );
  const total = parseInt(countResult.rows[0]?.total || 0);

  params.push(limiteVal);
  params.push(parseInt(offset) || 0);

  const resultado = await query(
    `SELECT c.id, c.nome, c.telefone, c.avatar_url, c.email, c.criado_em,
            (SELECT COUNT(*) FROM ticket_ciclos tc WHERE tc.contato_id = c.id)
            + (SELECT COUNT(*) FROM tickets t WHERE t.contato_id = c.id AND t.status IN ('pendente','aberto','aguardando'))
            as total_chamados,
            (SELECT t.ultima_mensagem_em FROM tickets t WHERE t.contato_id = c.id ORDER BY t.criado_em DESC LIMIT 1) as ultimo_contato,
            (SELECT t.status FROM tickets t WHERE t.contato_id = c.id ORDER BY t.criado_em DESC LIMIT 1) as ultimo_status,
            COALESCE(
              (SELECT json_agg(json_build_object('id', tg.id, 'nome', tg.nome, 'cor', tg.cor))
               FROM contato_tags ct JOIN tags tg ON tg.id = ct.tag_id
               WHERE ct.contato_id = c.id), '[]'
            ) as tags
     FROM contatos c
     ${where}
     ORDER BY (SELECT COUNT(*) FROM ticket_ciclos tc WHERE tc.contato_id = c.id) DESC, c.nome ASC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    params
  );

  const contatos = resultado.rows;
  const temMais = (parseInt(offset) || 0) + contatos.length < total;

  return { contatos, total, temMais };
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
 * Obter mídias e documentos de um contato (imagens, vídeos, documentos)
 */
async function obterMidiasContato(contatoId, { limite = 50, offset = 0, tipo } = {}) {
  const id = validarId(contatoId);
  const limiteVal = Math.min(parseInt(limite) || 50, 200);
  const offsetVal = parseInt(offset) || 0;

  const condicoes = [
    `t.contato_id = $1`,
    `m.media_url IS NOT NULL`,
    `m.media_url != ''`,
    `m.tipo IN ('imagem', 'video', 'documento', 'sticker')`,
  ];
  const params = [id];
  let idx = 2;

  // Filtrar por tipo específico se informado
  if (tipo && ['imagem', 'video', 'documento'].includes(tipo)) {
    condicoes.push(`m.tipo = $${idx}`);
    params.push(tipo);
    idx++;
  }

  const where = condicoes.join(' AND ');

  // Contar total
  const countResult = await query(
    `SELECT COUNT(*) as total
     FROM mensagens m
     JOIN tickets t ON t.id = m.ticket_id
     WHERE ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.total || 0);

  // Buscar mídias
  params.push(limiteVal);
  params.push(offsetVal);

  const resultado = await query(
    `SELECT m.id, m.tipo, m.media_url, m.media_tipo, m.media_nome, m.corpo,
            m.criado_em, m.is_from_me, t.protocolo
     FROM mensagens m
     JOIN tickets t ON t.id = m.ticket_id
     WHERE ${where}
     ORDER BY m.criado_em DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    params
  );

  return {
    midias: resultado.rows,
    total,
    temMais: offsetVal + resultado.rows.length < total,
  };
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

  // Se o nome foi editado manualmente, marcar flag pra impedir webhook de sobrescrever
  if (dados.nome !== undefined) {
    updates.push(`nome_editado = TRUE`);
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
  obterMidiasContato,
  atualizarContato,
  adicionarTag,
  removerTag,
};
