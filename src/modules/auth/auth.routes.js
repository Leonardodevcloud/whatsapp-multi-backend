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
        avatar_url: usuario.avatar_url || null,
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

// GET /api/auth/me — dados atualizados do usuário logado
router.get('/me', verificarToken, async (req, res) => {
  try {
    const { query: dbQuery } = require('../../config/database');
    const result = await dbQuery(`SELECT id, nome, email, perfil, avatar_url, online FROM usuarios WHERE id = $1`, [req.usuario.id]);
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(result.rows[0]);
  } catch { res.status(500).json({ erro: 'Erro interno' }); }
});

// PATCH /api/auth/me — qualquer usuário edita seu próprio perfil (nome, senha, avatar)
router.patch('/me', verificarToken, async (req, res) => {
  try {
    const { query: dbQuery } = require('../../config/database');
    const bcrypt = require('bcrypt');
    const { nome, senha, avatar_base64 } = req.body;

    const updates = [];
    const params = [];
    let idx = 1;

    if (nome?.trim()) { updates.push(`nome = $${idx++}`); params.push(nome.trim()); }
    if (senha && senha.length >= 8) {
      const hash = await bcrypt.hash(senha, 12);
      updates.push(`senha_hash = $${idx++}`); params.push(hash);
    }

    // Upload avatar se enviado
    if (avatar_base64) {
      try {
        const { uploadMidia } = require('../../shared/mediaUpload');
        const url = await uploadMidia(avatar_base64, 'imagem', `avatars/user-${req.usuario.id}`);
        updates.push(`avatar_url = $${idx++}`); params.push(url);
      } catch {}
    }

    if (updates.length === 0) return res.status(400).json({ erro: 'Nenhum campo válido' });

    updates.push('atualizado_em = NOW()');
    params.push(req.usuario.id);
    await dbQuery(`UPDATE usuarios SET ${updates.join(', ')} WHERE id = $${idx}`, params);

    const result = await dbQuery(`SELECT id, nome, email, perfil, avatar_url, online FROM usuarios WHERE id = $1`, [req.usuario.id]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ erro: err.message }); }
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
