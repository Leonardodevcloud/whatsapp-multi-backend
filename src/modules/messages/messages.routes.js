// src/modules/messages/messages.routes.js
// Rotas do módulo mensagens

const { Router } = require('express');
const messagesService = require('./messages.service');
const { verificarToken } = require('../../middleware/auth');

const router = Router();

// GET /api/messages/:ticketId — listar mensagens de um ticket
router.get('/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const { cursor, limite } = req.query;
    const resultado = await messagesService.listarMensagens({
      ticketId: req.params.ticketId,
      cursor,
      limite,
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// POST /api/messages/:ticketId/nota — criar nota interna
router.post('/:ticketId/nota', verificarToken, async (req, res, next) => {
  try {
    const { texto } = req.body;
    const mensagem = await messagesService.criarNotaInterna({
      ticketId: req.params.ticketId,
      texto,
      usuarioId: req.usuario.id,
    });
    res.status(201).json(mensagem);
  } catch (err) {
    next(err);
  }
});

// POST /api/messages/:ticketId/lidas — marcar como lidas
router.post('/:ticketId/lidas', verificarToken, async (req, res, next) => {
  try {
    const resultado = await messagesService.marcarComoLidas({
      ticketId: req.params.ticketId,
      usuarioId: req.usuario.id,
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// GET /api/messages/nao-lidas/todas — contagem de não lidas por ticket
router.get('/nao-lidas/todas', verificarToken, async (req, res, next) => {
  try {
    const resultado = await messagesService.contarNaoLidas(req.usuario.id);
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
