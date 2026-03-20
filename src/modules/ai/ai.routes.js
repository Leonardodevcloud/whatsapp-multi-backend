// src/modules/ai/ai.routes.js
const { Router } = require('express');
const aiService = require('./ai.service');
const { verificarToken } = require('../../middleware/auth');
const { limiteSensivel } = require('../../middleware/rateLimiter');

const router = Router();

// GET /api/ai/sugestao/:ticketId — gerar sugestão a partir das últimas mensagens
router.get('/sugestao/:ticketId', verificarToken, limiteSensivel, async (req, res, next) => {
  try {
    const ativa = await aiService.iaEstaAtiva();
    if (!ativa) return res.json({ sugestao: '', desativada: true });

    const resultado = await aiService.gerarSugestao(req.params.ticketId);
    res.json(resultado);
  } catch (err) { next(err); }
});

// POST /api/ai/sugestao/:ticketId — gerar sugestão a partir de texto colado pelo atendente
router.post('/sugestao/:ticketId', verificarToken, limiteSensivel, async (req, res, next) => {
  try {
    const ativa = await aiService.iaEstaAtiva();
    if (!ativa) return res.json({ sugestao: '', desativada: true });

    const { mensagem_cliente } = req.body;
    const resultado = await aiService.gerarSugestao(req.params.ticketId, mensagem_cliente);
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

// POST /api/ai/melhorar-texto — corrigir gramática e ortografia
router.post('/melhorar-texto', verificarToken, limiteSensivel, async (req, res, next) => {
  try {
    const { texto } = req.body;
    if (!texto?.trim()) return res.status(400).json({ erro: 'Texto é obrigatório' });
    const resultado = await aiService.melhorarTexto(texto.trim());
    res.json(resultado);
  } catch (err) { next(err); }
});

// POST /api/ai/transcrever-audio/:mensagemId — transcrever áudio de uma mensagem
router.post('/transcrever-audio/:mensagemId', verificarToken, limiteSensivel, async (req, res, next) => {
  try {
    const resultado = await aiService.transcreverAudio(req.params.mensagemId);
    res.json(resultado);
  } catch (err) { next(err); }
});

// POST /api/ai/transcrever-audio-base64 — transcrever áudio enviado como base64 pelo frontend
router.post('/transcrever-audio-base64', verificarToken, limiteSensivel, async (req, res, next) => {
  try {
    const { mensagem_id, audio_base64 } = req.body;
    if (!mensagem_id || !audio_base64) return res.status(400).json({ erro: 'mensagem_id e audio_base64 são obrigatórios' });
    const resultado = await aiService.transcreverAudioBase64(mensagem_id, audio_base64);
    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
