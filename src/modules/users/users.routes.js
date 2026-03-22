// src/modules/users/users.routes.js
const { Router } = require('express');
const usersService = require('./users.service');
const { verificarToken, verificarAdmin, verificarAdminOuSupervisor } = require('../../middleware/auth');

const router = Router();

// GET /api/users
router.get('/', verificarToken, verificarAdminOuSupervisor, async (req, res, next) => {
  try {
    const usuarios = await usersService.listarUsuarios();
    res.json(usuarios);
  } catch (err) { next(err); }
});

// GET /api/users/online — atendentes online (para assignment)
router.get('/online', verificarToken, async (req, res, next) => {
  try {
    const { fila_id } = req.query;
    const online = await usersService.listarOnline({ filaId: fila_id });
    res.json(online);
  } catch (err) { next(err); }
});

// GET /api/users/:id
router.get('/:id', verificarToken, verificarAdminOuSupervisor, async (req, res, next) => {
  try {
    const usuario = await usersService.obterUsuarioPorId(req.params.id);
    res.json(usuario);
  } catch (err) { next(err); }
});

// PATCH /api/users/:id
router.patch('/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const usuario = await usersService.atualizarUsuario({
      userId: req.params.id, dados: req.body, adminId: req.usuario.id, ip: req.ip,
    });
    res.json(usuario);
  } catch (err) { next(err); }
});

// POST /api/users/:id/avatar — upload de avatar base64
router.post('/:id/avatar', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { avatar_base64 } = req.body;
    if (!avatar_base64) return res.status(400).json({ erro: 'avatar_base64 é obrigatório' });

    const { uploadMidia } = require('../../shared/mediaUpload');
    const url = await uploadMidia(avatar_base64, 'imagem', `avatars/user-${req.params.id}`);

    const usuario = await usersService.atualizarUsuario({
      userId: req.params.id,
      dados: { avatar_url: url },
      adminId: req.usuario.id,
      ip: req.ip,
    });
    res.json(usuario);
  } catch (err) { next(err); }
});

module.exports = router;
