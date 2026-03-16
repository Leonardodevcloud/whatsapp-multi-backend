// src/modules/queues/queues.service.js
// Serviço de filas de atendimento

const { query } = require('../../config/database');
const AppError = require('../../shared/AppError');
const { validarId, validarCampoObrigatorio } = require('../../shared/validators');
const { registrarAuditoria } = require('../../shared/audit');

/**
 * Listar todas as filas com contadores
 */
async function listarFilas() {
  const resultado = await query(
    `SELECT f.id, f.nome, f.cor, f.descricao, f.ordem, f.ativo, f.criado_em,
            (SELECT COUNT(*) FROM tickets t WHERE t.fila_id = f.id AND t.status = 'pendente') as tickets_pendentes,
            (SELECT COUNT(*) FROM tickets t WHERE t.fila_id = f.id AND t.status = 'aberto') as tickets_abertos,
            COALESCE(
              (SELECT json_agg(json_build_object('id', u.id, 'nome', u.nome, 'online', u.online, 'avatar_url', u.avatar_url))
               FROM usuario_filas uf JOIN usuarios u ON u.id = uf.usuario_id AND u.ativo = TRUE
               WHERE uf.fila_id = f.id), '[]'
            ) as atendentes
     FROM filas f
     ORDER BY f.ordem ASC, f.nome ASC`
  );

  return resultado.rows;
}

/**
 * Criar fila
 */
async function criarFila({ nome, cor, descricao, usuarioId, ip }) {
  validarCampoObrigatorio(nome, 'nome');

  const resultado = await query(
    `INSERT INTO filas (nome, cor, descricao)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [nome.trim(), cor || '#7C3AED', descricao || null]
  );

  await registrarAuditoria({
    usuarioId,
    acao: 'criar_fila',
    entidade: 'fila',
    entidadeId: resultado.rows[0].id,
    dadosNovos: { nome, cor },
    ip,
  });

  return resultado.rows[0];
}

/**
 * Atualizar fila
 */
async function atualizarFila({ filaId, dados, usuarioId, ip }) {
  const id = validarId(filaId);
  const camposPermitidos = ['nome', 'cor', 'descricao', 'ordem', 'ativo'];

  const updates = [];
  const params = [];
  let idx = 1;

  for (const [campo, valor] of Object.entries(dados)) {
    if (camposPermitidos.includes(campo) && valor !== undefined) {
      updates.push(`${campo} = $${idx++}`);
      params.push(valor);
    }
  }

  if (updates.length === 0) throw new AppError('Nenhum campo válido', 400);

  params.push(id);
  await query(`UPDATE filas SET ${updates.join(', ')} WHERE id = $${idx}`, params);

  await registrarAuditoria({
    usuarioId, acao: 'atualizar_fila', entidade: 'fila', entidadeId: id, dadosNovos: dados, ip,
  });

  return (await query(`SELECT * FROM filas WHERE id = $1`, [id])).rows[0];
}

/**
 * Vincular atendente a fila
 */
async function vincularAtendente({ filaId, atendenteId, usuarioId, ip }) {
  const fId = validarId(filaId);
  const aId = validarId(atendenteId, 'atendente_id');

  await query(
    `INSERT INTO usuario_filas (usuario_id, fila_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [aId, fId]
  );

  await registrarAuditoria({
    usuarioId, acao: 'vincular_atendente_fila', entidade: 'fila', entidadeId: fId,
    dadosNovos: { atendente_id: aId }, ip,
  });

  return { sucesso: true };
}

/**
 * Desvincular atendente de fila
 */
async function desvincularAtendente({ filaId, atendenteId, usuarioId, ip }) {
  const fId = validarId(filaId);
  const aId = validarId(atendenteId, 'atendente_id');

  await query(`DELETE FROM usuario_filas WHERE usuario_id = $1 AND fila_id = $2`, [aId, fId]);

  await registrarAuditoria({
    usuarioId, acao: 'desvincular_atendente_fila', entidade: 'fila', entidadeId: fId,
    dadosNovos: { atendente_id: aId }, ip,
  });

  return { sucesso: true };
}

module.exports = {
  listarFilas,
  criarFila,
  atualizarFila,
  vincularAtendente,
  desvincularAtendente,
};
