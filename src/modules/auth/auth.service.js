// src/modules/auth/auth.service.js
// Serviço de autenticação — login, registro, refresh, logout

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { query } = require('../../config/database');
const env = require('../../config/env');
const AppError = require('../../shared/AppError');
const { ERROS } = require('../../shared/constants');
const { registrarAuditoria } = require('../../shared/audit');
const { validarEmail, validarSenha, validarCampoObrigatorio } = require('../../shared/validators');
const logger = require('../../shared/logger');

const SALT_ROUNDS = 12;

/**
 * Login de usuário
 */
async function login({ email, senha, ip }) {
  const emailLimpo = validarEmail(email);
  validarCampoObrigatorio(senha, 'senha');

  const resultado = await query(
    `SELECT id, nome, email, senha_hash, perfil, ativo
     FROM usuarios WHERE email = $1`,
    [emailLimpo]
  );

  const usuario = resultado.rows[0];

  if (!usuario) {
    throw new AppError(ERROS.CREDENCIAIS_INVALIDAS, 401);
  }

  if (!usuario.ativo) {
    throw new AppError('Conta desativada. Contate o administrador.', 403);
  }

  const senhaCorreta = await bcrypt.compare(senha, usuario.senha_hash);
  if (!senhaCorreta) {
    throw new AppError(ERROS.CREDENCIAIS_INVALIDAS, 401);
  }

  // Atualizar último acesso e status online
  await query(
    `UPDATE usuarios SET ultimo_acesso = NOW(), online = TRUE WHERE id = $1`,
    [usuario.id]
  );

  await registrarAuditoria({
    usuarioId: usuario.id,
    acao: 'login',
    entidade: 'usuario',
    entidadeId: usuario.id,
    ip,
  });

  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    perfil: usuario.perfil,
  };
}

/**
 * Criar novo usuário (admin only)
 */
async function criarUsuario({ nome, email, senha, perfil = 'atendente', maxTickets = 5, adminId, ip }) {
  const nomeLimpo = validarCampoObrigatorio(nome, 'nome');
  const emailLimpo = validarEmail(email);
  validarSenha(senha);

  // Verificar duplicidade
  const existe = await query('SELECT id FROM usuarios WHERE email = $1', [emailLimpo]);
  if (existe.rows.length > 0) {
    throw new AppError(ERROS.EMAIL_DUPLICADO, 409);
  }

  const senhaHash = await bcrypt.hash(senha, SALT_ROUNDS);

  const resultado = await query(
    `INSERT INTO usuarios (nome, email, senha_hash, perfil, max_tickets_simultaneos)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, nome, email, perfil, max_tickets_simultaneos, ativo, criado_em`,
    [nomeLimpo, emailLimpo, senhaHash, perfil, maxTickets]
  );

  const novoUsuario = resultado.rows[0];

  await registrarAuditoria({
    usuarioId: adminId,
    acao: 'criar_usuario',
    entidade: 'usuario',
    entidadeId: novoUsuario.id,
    dadosNovos: { nome: nomeLimpo, email: emailLimpo, perfil },
    ip,
  });

  logger.info({ usuarioId: novoUsuario.id, email: emailLimpo }, '[Auth] Novo usuário criado');

  return novoUsuario;
}

/**
 * Refresh token — gera novo access token
 */
async function refreshToken(token) {
  if (!token) {
    throw new AppError('Refresh token não fornecido', 401);
  }

  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET);

    // Buscar usuário atualizado
    const resultado = await query(
      `SELECT id, nome, email, perfil, ativo FROM usuarios WHERE id = $1`,
      [decoded.id]
    );

    const usuario = resultado.rows[0];
    if (!usuario || !usuario.ativo) {
      throw new AppError('Usuário não encontrado ou inativo', 401);
    }

    return usuario;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Refresh token inválido ou expirado', 401);
  }
}

/**
 * Logout — marcar offline
 */
async function logout(usuarioId) {
  await query('UPDATE usuarios SET online = FALSE WHERE id = $1', [usuarioId]);
}

/**
 * Obter perfil do usuário logado
 */
async function obterPerfil(usuarioId) {
  const resultado = await query(
    `SELECT u.id, u.nome, u.email, u.perfil, u.avatar_url, u.online,
            u.max_tickets_simultaneos, u.ativo, u.ultimo_acesso, u.criado_em,
            COALESCE(
              json_agg(json_build_object('id', f.id, 'nome', f.nome, 'cor', f.cor))
              FILTER (WHERE f.id IS NOT NULL), '[]'
            ) as filas
     FROM usuarios u
     LEFT JOIN usuario_filas uf ON uf.usuario_id = u.id
     LEFT JOIN filas f ON f.id = uf.fila_id AND f.ativo = TRUE
     WHERE u.id = $1
     GROUP BY u.id`,
    [usuarioId]
  );

  if (resultado.rows.length === 0) {
    throw new AppError('Usuário não encontrado', 404);
  }

  return resultado.rows[0];
}

module.exports = { login, criarUsuario, refreshToken, logout, obterPerfil };
