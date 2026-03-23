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
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
router.get('/sugestao/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await ia.sugerirResposta(req.params.ticketId);
    const texto = resultado?.sugestoes?.[0] || resultado?.sugestao || resultado?.raw || 'Não foi possível gerar sugestão. Tente novamente.';
    res.json({ sugestao: texto });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/ai/resumo/:ticketId (AiPanel chama GET)
// POST /api/ai/resumo/:ticketId (fallback)
router.get('/resumo/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await ia.resumirTicket(req.params.ticketId);
    res.json({ resumo: resultado?.resumo || 'Sem resumo disponível.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
router.post('/resumo/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await ia.resumirTicket(req.params.ticketId);
    res.json({ resumo: resultado?.resumo || 'Sem resumo disponível.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/ai/sentimento/:ticketId
router.get('/sentimento/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await ia.analisarSentimento(req.params.ticketId);
    res.json(resultado);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/ia/classificar/:ticketId
router.post('/classificar/:ticketId', verificarToken, async (req, res, next) => {
  try {
    const resultado = await ia.classificarTicket(req.params.ticketId);
    res.json(resultado);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/ia/melhorar-texto
router.post('/melhorar-texto', verificarToken, async (req, res, next) => {
  try {
    const { texto } = req.body;
    if (!texto?.trim()) return res.status(400).json({ erro: 'texto é obrigatório' });
    const resultado = await ia.melhorarTexto(texto.trim());
    // Frontend espera camelCase
    res.json({ textoMelhorado: resultado?.texto_melhorado || resultado?.textoMelhorado || texto.trim() });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/ia/feedback
router.post('/feedback', verificarToken, async (req, res, next) => {
  try {
    const resultado = await ia.registrarFeedback(req.body);
    res.json(resultado);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/ia/stats
router.get('/stats', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const stats = await ia.obterStats();
    res.json(stats);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
// CRUD — Instruções (admin)
// ============================================================

router.get('/instrucoes', verificarToken, verificarAdmin, async (req, res) => {
  try { res.json(await ia.listarInstrucoes()); } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/instrucoes', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { titulo, conteudo, ordem } = req.body;
    if (!titulo || !conteudo) return res.status(400).json({ erro: 'titulo e conteudo são obrigatórios' });
    res.json(await ia.criarInstrucao({ titulo, conteudo, ordem }));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/instrucoes/:id', verificarToken, verificarAdmin, async (req, res) => {
  try {
    res.json(await ia.atualizarInstrucao(req.params.id, req.body));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/instrucoes/:id', verificarToken, verificarAdmin, async (req, res) => {
  try {
    await ia.deletarInstrucao(req.params.id);
    res.json({ sucesso: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
// CRUD — Conhecimento (admin)
// ============================================================

router.get('/conhecimento', verificarToken, verificarAdmin, async (req, res, next) => {
  try { res.json(await ia.listarConhecimento(req.query)); } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/conhecimento', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { categoria, pergunta, resposta } = req.body;
    if (!pergunta || !resposta) return res.status(400).json({ erro: 'pergunta e resposta são obrigatórios' });
    res.json(await ia.criarConhecimento({ categoria, pergunta, resposta }));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/conhecimento/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    res.json(await ia.atualizarConhecimento(req.params.id, req.body));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/conhecimento/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await ia.deletarConhecimento(req.params.id);
    res.json({ sucesso: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
// CRUD — Exemplos aprendidos (admin)
// ============================================================

router.get('/exemplos', verificarToken, verificarAdmin, async (req, res, next) => {
  try { res.json(await ia.listarExemplos(req.query)); } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/exemplos/:id/aprovar', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    res.json(await ia.aprovarExemplo(req.params.id, { aprovado: true, resposta_corrigida: req.body.resposta_corrigida }));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/exemplos/:id/rejeitar', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    res.json(await ia.aprovarExemplo(req.params.id, { aprovado: false }));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/exemplos/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await ia.deletarExemplo(req.params.id);
    res.json({ sucesso: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
// CRUD — Regras de Tags (admin)
// ============================================================

router.get('/tags-regras', verificarToken, verificarAdmin, async (req, res, next) => {
  try { res.json(await ia.listarTagsRegras()); } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.post('/tags-regras', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { tag, palavras_chave, descricao, cor } = req.body;
    if (!tag || !palavras_chave) return res.status(400).json({ erro: 'tag e palavras_chave são obrigatórios' });
    res.json(await ia.criarTagRegra({ tag, palavras_chave, descricao, cor }));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/tags-regras/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    res.json(await ia.atualizarTagRegra(req.params.id, req.body));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.delete('/tags-regras/:id', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await ia.deletarTagRegra(req.params.id);
    res.json({ sucesso: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/ia/aprender-agora — forçar aprendizado manual
router.post('/aprender-agora', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await ia.aprenderDeTicketsFechados();
    res.json({ sucesso: true, mensagem: 'Aprendizado executado' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ============================================================
// ============================================================
// TRANSCRIÇÃO DE ÁUDIO
// ============================================================

// POST /api/ai/transcrever-audio-base64 — transcrever áudio via Gemini
router.post('/transcrever-audio-base64', verificarToken, async (req, res) => {
  try {
    const { mensagem_id, audio_base64 } = req.body;
    if (!audio_base64) return res.status(400).json({ erro: 'audio_base64 obrigatório' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(503).json({ erro: 'GEMINI_API_KEY não configurada' });

    // Extrair mime type e data do base64
    const match = audio_base64.match(/^data:(audio\/[^;]+);base64,(.+)$/);
    const mimeType = match ? match[1] : 'audio/ogg';
    const base64Data = match ? match[2] : audio_base64.replace(/^data:[^;]+;base64,/, '');

    const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
    const resp = await fetch(`${GEMINI_API}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType, data: base64Data } },
            { text: 'Transcreva este áudio para texto em português. Retorne APENAS o texto transcrito, sem explicações ou formatação.' }
          ]
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      return res.status(500).json({ erro: 'Gemini falhou', detalhe: err });
    }

    const data = await resp.json();
    const transcricao = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    // Salvar transcrição no banco se tiver mensagem_id
    if (mensagem_id && transcricao) {
      const { query } = require('../../config/database');
      await query(`UPDATE mensagens SET corpo = $1 WHERE id = $2 AND (corpo IS NULL OR corpo = '' OR corpo = '🎵 Áudio')`, [transcricao, mensagem_id]).catch(() => {});
    }

    res.json({ transcricao });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// POST /api/ai/transcrever-audio/:mensagemId — transcrever por ID (busca mídia do banco)
router.post('/transcrever-audio/:mensagemId', verificarToken, async (req, res) => {
  try {
    const { query } = require('../../config/database');
    const { mensagemId } = req.params;

    const msg = await query(`SELECT media_url, corpo FROM mensagens WHERE id = $1`, [mensagemId]);
    if (msg.rows.length === 0) return res.status(404).json({ erro: 'Mensagem não encontrada' });

    const mediaUrl = msg.rows[0].media_url;
    if (!mediaUrl) return res.status(400).json({ erro: 'Mensagem sem mídia' });

    // Download do áudio
    const audioResp = await fetch(mediaUrl);
    if (!audioResp.ok) return res.status(500).json({ erro: 'Falha ao baixar áudio' });

    const buffer = Buffer.from(await audioResp.arrayBuffer());
    const base64Data = buffer.toString('base64');

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(503).json({ erro: 'GEMINI_API_KEY não configurada' });

    const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
    const resp = await fetch(`${GEMINI_API}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inlineData: { mimeType: 'audio/ogg', data: base64Data } },
            { text: 'Transcreva este áudio para texto em português. Retorne APENAS o texto transcrito, sem explicações.' }
          ]
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 2000 },
      }),
    });

    if (!resp.ok) return res.status(500).json({ erro: 'Gemini falhou' });

    const data = await resp.json();
    const transcricao = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    if (transcricao) {
      await query(`UPDATE mensagens SET corpo = $1 WHERE id = $2 AND (corpo IS NULL OR corpo = '' OR corpo = '🎵 Áudio')`, [transcricao, mensagemId]).catch(() => {});
    }

    res.json({ transcricao });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// CONFIG IA — toggles
// ============================================================

router.get('/config', verificarToken, async (req, res) => {
  try { res.json(await ia.getIaConfig()); } catch (err) { res.status(500).json({ erro: err.message }); }
});

router.put('/config', verificarToken, verificarAdmin, async (req, res) => {
  try {
    const { chave, valor } = req.body;
    if (!chave) return res.status(400).json({ erro: 'chave obrigatória' });
    await ia.setIaConfig(chave, String(valor));
    res.json({ sucesso: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

module.exports = router;
