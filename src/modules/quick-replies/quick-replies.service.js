// src/modules/quick-replies/quick-replies.service.js
const { query } = require('../../config/database');
const AppError = require('../../shared/AppError');
const { validarId, validarCampoObrigatorio } = require('../../shared/validators');

async function listarRespostasRapidas({ filaId } = {}) {
  const condicoes = [];
  const params = [];
  let idx = 1;

  if (filaId) {
    condicoes.push(`(rr.fila_id = $${idx++} OR rr.fila_id IS NULL)`);
    params.push(parseInt(filaId));
  }

  const where = condicoes.length > 0 ? `WHERE ${condicoes.join(' AND ')}` : '';

  const resultado = await query(
    `SELECT rr.*, f.nome as fila_nome, u.nome as criado_por_nome
     FROM respostas_rapidas rr
     LEFT JOIN filas f ON f.id = rr.fila_id
     LEFT JOIN usuarios u ON u.id = rr.criado_por
     ${where}
     ORDER BY rr.atalho ASC`,
    params
  );

  return resultado.rows;
}

async function criarRespostaRapida({ atalho, titulo, corpo, mediaUrl, filaId, usuarioId }) {
  validarCampoObrigatorio(atalho, 'atalho');
  validarCampoObrigatorio(titulo, 'titulo');
  validarCampoObrigatorio(corpo, 'corpo');

  // Garantir prefixo /
  const atalhoLimpo = atalho.startsWith('/') ? atalho.trim() : `/${atalho.trim()}`;

  const existe = await query(`SELECT id FROM respostas_rapidas WHERE atalho = $1`, [atalhoLimpo]);
  if (existe.rows.length > 0) throw new AppError('Atalho já existe', 409);

  const resultado = await query(
    `INSERT INTO respostas_rapidas (atalho, titulo, corpo, media_url, fila_id, criado_por)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [atalhoLimpo, titulo.trim(), corpo.trim(), mediaUrl || null, filaId || null, usuarioId]
  );

  return resultado.rows[0];
}

async function atualizarRespostaRapida({ id, dados }) {
  const rrId = validarId(id);
  const camposPermitidos = ['titulo', 'corpo', 'media_url', 'fila_id'];
  const updates = [];
  const params = [];
  let idx = 1;

  for (const [campo, valor] of Object.entries(dados)) {
    if (camposPermitidos.includes(campo)) {
      updates.push(`${campo} = $${idx++}`);
      params.push(valor);
    }
  }

  if (updates.length === 0) throw new AppError('Nenhum campo válido', 400);

  params.push(rrId);
  await query(`UPDATE respostas_rapidas SET ${updates.join(', ')} WHERE id = $${idx}`, params);

  return (await query(`SELECT * FROM respostas_rapidas WHERE id = $1`, [rrId])).rows[0];
}

async function deletarRespostaRapida(id) {
  const rrId = validarId(id);
  const resultado = await query(`DELETE FROM respostas_rapidas WHERE id = $1 RETURNING id`, [rrId]);
  if (resultado.rows.length === 0) throw new AppError('Resposta rápida não encontrada', 404);
  return { sucesso: true };
}

module.exports = { listarRespostasRapidas, criarRespostaRapida, atualizarRespostaRapida, deletarRespostaRapida };
