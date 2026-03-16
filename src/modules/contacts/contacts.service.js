// src/modules/contacts/contacts.service.js
// Serviço de contatos — CRUD, busca, histórico

const { query } = require('../../config/database');
const AppError = require('../../shared/AppError');
const { validarId, validarPaginacao, validarTelefone } = require('../../shared/validators');
const { registrarAuditoria } = require('../../shared/audit');

/**
 * Listar contatos com busca e paginação por cursor
 */
async function listarContatos({ cursor, limite = 50, busca }) {
  const { cursor: cursorVal, limite: limiteVal } = validarPaginacao(cursor, limite);

  const condicoes = [];
  const params = [];
  let idx = 1;

  if (cursorVal) {
    condicoes.push(`c.id < $${idx++}`);
    params.push(cursorVal);
  }

  if (busca) {
    condicoes.push(`(c.nome ILIKE $${idx} OR c.telefone ILIKE $${idx} OR c.email ILIKE $${idx})`);
    params.push(`%${busca}%`);
    idx++;
  }

  const where = condicoes.length > 0 ? `WHERE ${condicoes.join(' AND ')}` : '';
  params.push(limiteVal);

  const resultado = await query(
    `SELECT c.id, c.nome, c.telefone, c.avatar_url, c.email, c.criado_em,
            (SELECT COUNT(*) FROM tickets t WHERE t.contato_id = c.id) as total_tickets,
            (SELECT t.ultima_mensagem_em FROM tickets t WHERE t.contato_id = c.id ORDER BY t.criado_em DESC LIMIT 1) as ultimo_contato,
            COALESCE(
              (SELECT json_agg(json_build_object('id', tg.id, 'nome', tg.nome, 'cor', tg.cor))
               FROM contato_tags ct JOIN tags tg ON tg.id = ct.tag_id
               WHERE ct.contato_id = c.id), '[]'
            ) as tags
     FROM contatos c
     ${where}
     ORDER BY c.id DESC
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
 * Atualizar contato
 */
async function atualizarContato({ contatoId, dados, usuarioId, ip }) {
  const id = validarId(contatoId);
  const camposPermitidos = ['nome', 'email', 'notas'];

  const updates = [];
  const params = [];
  let idx = 1;

  for (const [campo, valor] of Object.entries(dados)) {
    if (camposPermitidos.includes(campo)) {
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
  const tId = validarId(tagId, 'tag_id');

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
  const tId = validarId(tagId, 'tag_id');

  await query(`DELETE FROM contato_tags WHERE contato_id = $1 AND tag_id = $2`, [cId, tId]);

  return obterContatoPorId(cId);
}

module.exports = {
  listarContatos,
  obterContatoPorId,
  atualizarContato,
  adicionarTag,
  removerTag,
};
