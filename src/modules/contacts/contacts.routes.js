// src/modules/contacts/contacts.routes.js
const { Router } = require('express');
const contactsService = require('./contacts.service');
const { verificarToken } = require('../../middleware/auth');

const router = Router();

// GET /api/contacts
router.get('/', verificarToken, async (req, res, next) => {
  try {
    const { cursor, limite, busca } = req.query;
    const resultado = await contactsService.listarContatos({ cursor, limite, busca });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/:id
router.get('/:id', verificarToken, async (req, res, next) => {
  try {
    const contato = await contactsService.obterContatoPorId(req.params.id);
    res.json(contato);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/contacts/:id
router.patch('/:id', verificarToken, async (req, res, next) => {
  try {
    const contato = await contactsService.atualizarContato({
      contatoId: req.params.id,
      dados: req.body,
      usuarioId: req.usuario.id,
      ip: req.ip,
    });
    res.json(contato);
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/:id/tags
router.post('/:id/tags', verificarToken, async (req, res, next) => {
  try {
    const { tag_id } = req.body;
    const contato = await contactsService.adicionarTag({ contatoId: req.params.id, tagId: tag_id });
    res.json(contato);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/contacts/:id/tags/:tagId
router.delete('/:id/tags/:tagId', verificarToken, async (req, res, next) => {
  try {
    const contato = await contactsService.removerTag({ contatoId: req.params.id, tagId: req.params.tagId });
    res.json(contato);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
