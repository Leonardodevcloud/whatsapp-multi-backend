// src/modules/queues/queues.routes.js
const { Router } = require('express');
const queuesService = require('./queues.service');
const { verificarToken, verificarAdmin } = require('../../middleware/auth');

const router = Router();

// GET /api/queues
router.get('/', verificarToken, async (req, res, next) => {
  try {
    const filas = await queuesService.listarFilas();
    res.json(filas);
  } catch (err) { next(err); }
});

// POST /api/queues
router.post('/', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { nome, cor, descricao } = req.body;
    const fila = await queuesService.criarFila({ nome, cor, descricao, usuarioId: req.usuario.id, ip: req.ip });
    res.status(201).json(fila);
  } catch (err) { next(err); }
});

// PATCH /api/queues/:id
router.patch('/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const fila = await queuesService.atualizarFila({
      filaId: req.params.id, dados: req.body, usuarioId: req.usuario.id, ip: req.ip,
    });
    res.json(fila);
  } catch (err) { next(err); }
});

// POST /api/queues/:id/atendentes — vincular atendente
router.post('/:id/atendentes', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { atendente_id } = req.body;
    const resultado = await queuesService.vincularAtendente({
      filaId: req.params.id, atendenteId: atendente_id, usuarioId: req.usuario.id, ip: req.ip,
    });
    res.json(resultado);
  } catch (err) { next(err); }
});

// DELETE /api/queues/:id/atendentes/:atendenteId — desvincular
router.delete('/:id/atendentes/:atendenteId', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const resultado = await queuesService.desvincularAtendente({
      filaId: req.params.id, atendenteId: req.params.atendenteId, usuarioId: req.usuario.id, ip: req.ip,
    });
    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
