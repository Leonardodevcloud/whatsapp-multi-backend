// src/modules/ai/ai.routes.js
const { Router } = require('express');
const aiService = require('./ai.service');
const { verificarToken } = require('../../middleware/auth');
const { limiteSensivel } = require('../../middleware/rateLimiter');

const router = Router();

// GET /api/ai/sugestao/:ticketId — gerar sugestão de resposta
router.get('/sugestao/:ticketId', verificarToken, limiteSensivel, async (req, res, next) => {
  try {
    const ativa = await aiService.iaEstaAtiva();
    if (!ativa) return res.json({ sugestao: '', desativada: true });

    const resultado = await aiService.gerarSugestao(req.params.ticketId);
    res.json(resultado);
  } catch (err) { next(err); }
});

// GET /api/ai/resumo/:ticketId — resumo da conversa
router.get('/resumo/:ticketId', verificarToken, limiteSensivel, async (req, res, next) => {
  try {
    const resultado = await aiService.gerarResumo(req.params.ticketId);
    res.json(resultado);
  } catch (err) { next(err); }
});

// POST /api/ai/classificar/:ticketId — classificar fila automaticamente
router.post('/classificar/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await aiService.classificarFila(req.params.ticketId);
    res.json(resultado);
  } catch (err) { next(err); }
});

// GET /api/ai/sentimento/:ticketId — detectar sentimento
router.get('/sentimento/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await aiService.detectarSentimento(req.params.ticketId);
    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
