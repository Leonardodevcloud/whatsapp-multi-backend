// Rotas — módulo IA
const { Router } = require('express');
const { verificarToken, verificarAdmin } = require('../../middleware/auth');
const ia = require('./ai.service');

const router = Router();

// ============================================================
// IA CALLS — sugestão, resumo, classificação, melhoria
// ============================================================

// POST /api/ai/sugestao/:ticketId (com mensagem_cliente no body)
// GET  /api/ai/sugestao/:ticketId (usa últimas mensagens)
router.post('/sugestao/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await ia.sugerirResposta(req.params.ticketId, req.body?.mensagem_cliente);
    // Frontend espera { sugestao: "texto" } (string, não array)
    const texto = resultado?.sugestoes?.[0] || resultado?.sugestao || resultado?.raw || 'Não foi possível gerar sugestão. Tente novamente.';
    res.json({ sugestao: texto });
  } catch (err) { next(err); }
});
router.get('/sugestao/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await ia.sugerirResposta(req.params.ticketId);
    const texto = resultado?.sugestoes?.[0] || resultado?.sugestao || resultado?.raw || 'Não foi possível gerar sugestão. Tente novamente.';
    res.json({ sugestao: texto });
  } catch (err) { next(err); }
});

// GET /api/ai/resumo/:ticketId (AiPanel chama GET)
// POST /api/ai/resumo/:ticketId (fallback)
router.get('/resumo/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await ia.resumirTicket(req.params.ticketId);
    res.json({ resumo: resultado?.resumo || 'Sem resumo disponível.' });
  } catch (err) { next(err); }
});
router.post('/resumo/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await ia.resumirTicket(req.params.ticketId);
    res.json({ resumo: resultado?.resumo || 'Sem resumo disponível.' });
  } catch (err) { next(err); }
});

// GET /api/ai/sentimento/:ticketId
router.get('/sentimento/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await ia.analisarSentimento(req.params.ticketId);
    res.json(resultado);
  } catch (err) { next(err); }
});

// POST /api/ia/classificar/:ticketId
router.post('/classificar/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await ia.classificarTicket(req.params.ticketId);
    res.json(resultado);
  } catch (err) { next(err); }
});

// POST /api/ia/melhorar-texto
router.post('/melhorar-texto', verificarToken, async (req, res, next) => {
  try {
    const { texto } = req.body;
    if (!texto?.trim()) return res.status(400).json({ erro: 'texto é obrigatório' });
    const resultado = await ia.melhorarTexto(texto.trim());
    // Frontend espera camelCase
    res.json({ textoMelhorado: resultado?.texto_melhorado || resultado?.textoMelhorado || texto.trim() });
  } catch (err) { next(err); }
});

// POST /api/ia/feedback
router.post('/feedback', verificarToken, async (req, res, next) => {
  try {
    const resultado = await ia.registrarFeedback(req.body);
    res.json(resultado);
  } catch (err) { next(err); }
});

// GET /api/ia/stats
router.get('/stats', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const stats = await ia.obterStats();
    res.json(stats);
  } catch (err) { next(err); }
});

// ============================================================
// CRUD — Instruções (admin)
// ============================================================

router.get('/instrucoes', verificarToken, verificarAdmin, async (req, res, next) => {
  try { res.json(await ia.listarInstrucoes()); } catch (err) { next(err); }
});

router.post('/instrucoes', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { titulo, conteudo, ordem } = req.body;
    if (!titulo || !conteudo) return res.status(400).json({ erro: 'titulo e conteudo são obrigatórios' });
    res.json(await ia.criarInstrucao({ titulo, conteudo, ordem }));
  } catch (err) { next(err); }
});

router.put('/instrucoes/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    res.json(await ia.atualizarInstrucao(req.params.id, req.body));
  } catch (err) { next(err); }
});

router.delete('/instrucoes/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await ia.deletarInstrucao(req.params.id);
    res.json({ sucesso: true });
  } catch (err) { next(err); }
});

// ============================================================
// CRUD — Conhecimento (admin)
// ============================================================

router.get('/conhecimento', verificarToken, verificarAdmin, async (req, res, next) => {
  try { res.json(await ia.listarConhecimento(req.query)); } catch (err) { next(err); }
});

router.post('/conhecimento', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { categoria, pergunta, resposta } = req.body;
    if (!pergunta || !resposta) return res.status(400).json({ erro: 'pergunta e resposta são obrigatórios' });
    res.json(await ia.criarConhecimento({ categoria, pergunta, resposta }));
  } catch (err) { next(err); }
});

router.put('/conhecimento/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    res.json(await ia.atualizarConhecimento(req.params.id, req.body));
  } catch (err) { next(err); }
});

router.delete('/conhecimento/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await ia.deletarConhecimento(req.params.id);
    res.json({ sucesso: true });
  } catch (err) { next(err); }
});

// ============================================================
// CRUD — Exemplos aprendidos (admin)
// ============================================================

router.get('/exemplos', verificarToken, verificarAdmin, async (req, res, next) => {
  try { res.json(await ia.listarExemplos(req.query)); } catch (err) { next(err); }
});

router.put('/exemplos/:id/aprovar', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    res.json(await ia.aprovarExemplo(req.params.id, { aprovado: true, resposta_corrigida: req.body.resposta_corrigida }));
  } catch (err) { next(err); }
});

router.put('/exemplos/:id/rejeitar', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    res.json(await ia.aprovarExemplo(req.params.id, { aprovado: false }));
  } catch (err) { next(err); }
});

router.delete('/exemplos/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await ia.deletarExemplo(req.params.id);
    res.json({ sucesso: true });
  } catch (err) { next(err); }
});

// ============================================================
// CRUD — Regras de Tags (admin)
// ============================================================

router.get('/tags-regras', verificarToken, verificarAdmin, async (req, res, next) => {
  try { res.json(await ia.listarTagsRegras()); } catch (err) { next(err); }
});

router.post('/tags-regras', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { tag, palavras_chave, descricao, cor } = req.body;
    if (!tag || !palavras_chave) return res.status(400).json({ erro: 'tag e palavras_chave são obrigatórios' });
    res.json(await ia.criarTagRegra({ tag, palavras_chave, descricao, cor }));
  } catch (err) { next(err); }
});

router.put('/tags-regras/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    res.json(await ia.atualizarTagRegra(req.params.id, req.body));
  } catch (err) { next(err); }
});

router.delete('/tags-regras/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await ia.deletarTagRegra(req.params.id);
    res.json({ sucesso: true });
  } catch (err) { next(err); }
});

// POST /api/ia/aprender-agora — forçar aprendizado manual
router.post('/aprender-agora', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await ia.aprenderDeTicketsFechados();
    res.json({ sucesso: true, mensagem: 'Aprendizado executado' });
  } catch (err) { next(err); }
});

module.exports = router;
