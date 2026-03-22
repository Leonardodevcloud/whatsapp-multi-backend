// src/modules/users/users.service.js
// Serviço de gestão de atendentes

const bcrypt = require('bcrypt');
const { query } = require('../../config/database');
const AppError = require('../../shared/AppError');
const { validarId } = require('../../shared/validators');
const { registrarAuditoria } = require('../../shared/audit');

/**
 * Listar todos os atendentes com métricas
 */
async function listarUsuarios() {
  const resultado = await query(
    `SELECT u.id, u.nome, u.email, u.perfil, u.avatar_url, u.online,
            u.max_tickets_simultaneos, u.ativo, u.ultimo_acesso, u.criado_em,
            (SELECT COUNT(*) FROM tickets t WHERE t.usuario_id = u.id AND t.status IN ('aberto', 'aguardando')) as tickets_ativos,
            (SELECT COUNT(*) FROM tickets t WHERE t.usuario_id = u.id AND t.status = 'resolvido' AND DATE(t.atualizado_em) = CURRENT_DATE) as resolvidos_hoje,
            COALESCE(
              (SELECT json_agg(json_build_object('id', f.id, 'nome', f.nome, 'cor', f.cor))
               FROM usuario_filas uf JOIN filas f ON f.id = uf.fila_id AND f.ativo = TRUE
               WHERE uf.usuario_id = u.id), '[]'
            ) as filas
     FROM usuarios u
     ORDER BY u.ativo DESC, u.nome ASC`
  );

  return resultado.rows;
}

/**
 * Obter usuário por ID
 */
async function obterUsuarioPorId(userId) {
  const id = validarId(userId);

  const resultado = await query(
    `SELECT u.id, u.nome, u.email, u.perfil, u.avatar_url, u.online,
            u.max_tickets_simultaneos, u.ativo, u.ultimo_acesso, u.criado_em,
            COALESCE(
              (SELECT json_agg(json_build_object('id', f.id, 'nome', f.nome, 'cor', f.cor))
               FROM usuario_filas uf JOIN filas f ON f.id = uf.fila_id
               WHERE uf.usuario_id = u.id), '[]'
            ) as filas
     FROM usuarios u WHERE u.id = $1`,
    [id]
  );

  if (resultado.rows.length === 0) throw new AppError('Usuário não encontrado', 404);
  return resultado.rows[0];
}

/**
 * Atualizar usuário
 */
async function atualizarUsuario({ userId, dados, adminId, ip }) {
  const id = validarId(userId);
  const camposPermitidos = ['nome', 'email', 'perfil', 'max_tickets_simultaneos', 'ativo', 'avatar_url'];

  const updates = [];
  const params = [];
  let idx = 1;

  for (const [campo, valor] of Object.entries(dados)) {
    if (camposPermitidos.includes(campo) && valor !== undefined) {
      updates.push(`${campo} = $${idx++}`);
      params.push(valor);
    }
  }

  // Senha separada — precisa hash
  if (dados.senha && dados.senha.length >= 8) {
    const hash = await bcrypt.hash(dados.senha, 12);
    updates.push(`senha_hash = $${idx++}`);
    params.push(hash);
  }

  if (updates.length === 0) throw new AppError('Nenhum campo válido', 400);

  updates.push('atualizado_em = NOW()');
  params.push(id);

  await query(`UPDATE usuarios SET ${updates.join(', ')} WHERE id = $${idx}`, params);

  await registrarAuditoria({
    usuarioId: adminId, acao: 'atualizar_usuario', entidade: 'usuario',
    entidadeId: id, dadosNovos: { ...dados, senha: dados.senha ? '***' : undefined }, ip,
  });

  return obterUsuarioPorId(id);
}

/**
 * Listar atendentes online (para assignment)
 */
async function listarOnline({ filaId } = {}) {
  const condicoes = [`u.online = TRUE`, `u.ativo = TRUE`];
  const params = [];
  let idx = 1;

  if (filaId) {
    condicoes.push(`EXISTS (SELECT 1 FROM usuario_filas uf WHERE uf.usuario_id = u.id AND uf.fila_id = $${idx++})`);
    params.push(parseInt(filaId));
  }

  const resultado = await query(
    `SELECT u.id, u.nome, u.perfil, u.avatar_url, u.max_tickets_simultaneos,
            (SELECT COUNT(*) FROM tickets t WHERE t.usuario_id = u.id AND t.status IN ('aberto', 'aguardando')) as tickets_ativos
     FROM usuarios u
     WHERE ${condicoes.join(' AND ')}
     ORDER BY tickets_ativos ASC`,
    params
  );

  return resultado.rows;
}

module.exports = { listarUsuarios, obterUsuarioPorId, atualizarUsuario, listarOnline };
