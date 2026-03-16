// src/modules/tags/tags.service.js
const { query } = require('../../config/database');
const AppError = require('../../shared/AppError');
const { validarId, validarCampoObrigatorio } = require('../../shared/validators');

async function listarTags() {
  const resultado = await query(
    `SELECT t.*, 
            (SELECT COUNT(*) FROM ticket_tags tt WHERE tt.tag_id = t.id) as total_tickets,
            (SELECT COUNT(*) FROM contato_tags ct WHERE ct.tag_id = t.id) as total_contatos
     FROM tags t ORDER BY t.nome ASC`
  );
  return resultado.rows;
}

async function criarTag({ nome, cor }) {
  validarCampoObrigatorio(nome, 'nome');
  const existe = await query(`SELECT id FROM tags WHERE nome = $1`, [nome.trim()]);
  if (existe.rows.length > 0) throw new AppError('Tag já existe', 409);

  const resultado = await query(
    `INSERT INTO tags (nome, cor) VALUES ($1, $2) RETURNING *`,
    [nome.trim(), cor || '#6B7280']
  );
  return resultado.rows[0];
}

async function atualizarTag({ id, dados }) {
  const tagId = validarId(id);
  const updates = [];
  const params = [];
  let idx = 1;

  if (dados.nome) { updates.push(`nome = $${idx++}`); params.push(dados.nome.trim()); }
  if (dados.cor) { updates.push(`cor = $${idx++}`); params.push(dados.cor); }

  if (updates.length === 0) throw new AppError('Nenhum campo válido', 400);

  params.push(tagId);
  await query(`UPDATE tags SET ${updates.join(', ')} WHERE id = $${idx}`, params);
  return (await query(`SELECT * FROM tags WHERE id = $1`, [tagId])).rows[0];
}

async function deletarTag(id) {
  const tagId = validarId(id);
  await query(`DELETE FROM tags WHERE id = $1`, [tagId]);
  return { sucesso: true };
}

// Tags em tickets
async function adicionarTagTicket({ ticketId, tagId }) {
  await query(
    `INSERT INTO ticket_tags (ticket_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [validarId(ticketId), validarId(tagId, 'tag_id')]
  );
  return { sucesso: true };
}

async function removerTagTicket({ ticketId, tagId }) {
  await query(
    `DELETE FROM ticket_tags WHERE ticket_id = $1 AND tag_id = $2`,
    [validarId(ticketId), validarId(tagId, 'tag_id')]
  );
  return { sucesso: true };
}

module.exports = { listarTags, criarTag, atualizarTag, deletarTag, adicionarTagTicket, removerTagTicket };
