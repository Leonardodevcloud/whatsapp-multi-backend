// src/middleware/auth.js
// Middleware de autenticação JWT (access + refresh com httpOnly cookies)

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const AppError = require('../shared/AppError');
const { ERROS, PERFIS } = require('../shared/constants');

/**
 * Verificar token JWT do cookie httpOnly
 */
function verificarToken(req, res, next) {
  const token = req.cookies?.access_token;

  if (!token) {
    throw new AppError(ERROS.NAO_AUTORIZADO, 401);
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    req.usuario = {
      id: decoded.id,
      email: decoded.email,
      perfil: decoded.perfil,
      nome: decoded.nome,
    };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new AppError('Token expirado', 401);
    }
    throw new AppError(ERROS.NAO_AUTORIZADO, 401);
  }
}

/**
 * Verificar se usuário é admin
 */
function verificarAdmin(req, res, next) {
  if (!req.usuario || req.usuario.perfil !== PERFIS.ADMIN) {
    throw new AppError(ERROS.ACESSO_NEGADO, 403);
  }
  next();
}

/**
 * Verificar se usuário é admin ou supervisor
 */
function verificarAdminOuSupervisor(req, res, next) {
  if (!req.usuario || ![PERFIS.ADMIN, PERFIS.SUPERVISOR].includes(req.usuario.perfil)) {
    throw new AppError(ERROS.ACESSO_NEGADO, 403);
  }
  next();
}

/**
 * Gerar par de tokens (access + refresh)
 */
function gerarTokens(usuario) {
  const payload = {
    id: usuario.id,
    email: usuario.email,
    perfil: usuario.perfil,
    nome: usuario.nome,
  };

  const accessToken = jwt.sign(payload, env.JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ id: usuario.id }, env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

  return { accessToken, refreshToken };
}

/**
 * Setar cookies httpOnly com os tokens
 */
function setarCookiesAuth(res, accessToken, refreshToken) {
  const isProduction = env.NODE_ENV === 'production';

  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 15 * 60 * 1000, // 15 minutos
    path: '/',
  });

  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
    path: '/api/auth/refresh',
  });
}

/**
 * Limpar cookies de auth
 */
function limparCookiesAuth(res) {
  res.clearCookie('access_token', { path: '/' });
  res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
}

module.exports = {
  verificarToken,
  verificarAdmin,
  verificarAdminOuSupervisor,
  gerarTokens,
  setarCookiesAuth,
  limparCookiesAuth,
};
