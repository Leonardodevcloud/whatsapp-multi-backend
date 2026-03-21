// src/modules/auth/auth.routes.js
// Rotas de autenticação

const { Router } = require('express');
const authService = require('./auth.service');
const { verificarToken, verificarAdmin, gerarTokens, setarCookiesAuth, limparCookiesAuth } = require('../../middleware/auth');
const { limiteLogin } = require('../../middleware/rateLimiter');

const router = Router();

// POST /api/auth/login
router.post('/login', limiteLogin, async (req, res, next) => {
  try {
    const { email, senha } = req.body;
    const usuario = await authService.login({ email, senha, ip: req.ip });
    const { accessToken, refreshToken } = gerarTokens(usuario);

    setarCookiesAuth(res, accessToken, refreshToken);

    res.json({
      sucesso: true,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil,
      },
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies?.refresh_token;
    const usuario = await authService.refreshToken(token);
    const { accessToken, refreshToken } = gerarTokens(usuario);

    setarCookiesAuth(res, accessToken, refreshToken);

    res.json({ sucesso: true, usuario });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post('/logout', verificarToken, async (req, res, next) => {
  try {
    await authService.logout(req.usuario.id);
    limparCookiesAuth(res);
    res.json({ sucesso: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
router.get('/me', verificarToken, async (req, res, next) => {
  try {
    const perfil = await authService.obterPerfil(req.usuario.id);
    res.json(perfil);
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/ws-token — retorna token para conexão WebSocket
// O cookie httpOnly autentica — retorna o access_token pro frontend usar no WS
router.get('/ws-token', verificarToken, (req, res) => {
  const { accessToken } = gerarTokens({
    id: req.usuario.id,
    nome: req.usuario.nome,
    email: req.usuario.email,
    perfil: req.usuario.perfil,
  });
  res.json({ token: accessToken });
});

// POST /api/auth/usuarios — criar atendente (admin only)
router.post('/usuarios', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { nome, email, senha, perfil, max_tickets } = req.body;
    const usuario = await authService.criarUsuario({
      nome,
      email,
      senha,
      perfil,
      maxTickets: max_tickets,
      adminId: req.usuario.id,
      ip: req.ip,
    });
    res.status(201).json(usuario);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
