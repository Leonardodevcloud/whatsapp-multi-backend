// src/modules/tags/tags.routes.js
const { Router } = require('express');
const tagsService = require('./tags.service');
const { verificarToken, verificarAdmin } = require('../../middleware/auth');

const router = Router();

router.get('/', verificarToken, async (req, res, next) => {
  try {
    const tags = await tagsService.listarTags();
    res.json(tags);
  } catch (err) { next(err); }
});

router.post('/', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { nome, cor } = req.body;
    const tag = await tagsService.criarTag({ nome, cor });
    res.status(201).json(tag);
  } catch (err) { next(err); }
});

router.patch('/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const tag = await tagsService.atualizarTag({ id: req.params.id, dados: req.body });
    res.json(tag);
  } catch (err) { next(err); }
});

router.delete('/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const resultado = await tagsService.deletarTag(req.params.id);
    res.json(resultado);
  } catch (err) { next(err); }
});

// Tags em tickets
router.post('/tickets/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const { tag_id } = req.body;
    const resultado = await tagsService.adicionarTagTicket({ ticketId: req.params.ticketId, tagId: tag_id });
    res.json(resultado);
  } catch (err) { next(err); }
});

router.delete('/tickets/:ticketId/:tagId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await tagsService.removerTagTicket({ ticketId: req.params.ticketId, tagId: req.params.tagId });
    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
