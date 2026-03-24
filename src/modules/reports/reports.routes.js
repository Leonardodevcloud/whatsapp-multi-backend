// src/modules/reports/reports.routes.js
const { Router } = require('express');
const svc = require('./reports.service');
const { verificarToken, verificarAdminOuSupervisor } = require('../../middleware/auth');

const router = Router();

function _p(query) {
  let { dataInicio, dataFim, dias, usuarioId } = query;
  if (!dataInicio || !dataFim) {
    const d = parseInt(dias) || 30;
    const fim = new Date(); const inicio = new Date();
    inicio.setDate(inicio.getDate() - d);
    dataInicio = inicio.toISOString().split('T')[0];
    dataFim = fim.toISOString().split('T')[0];
  }
  return { dataInicio, dataFim, usuarioId: usuarioId ? parseInt(usuarioId) : null };
}

// Lista de atendentes (para o dropdown do filtro)
router.get('/atendentes', verificarToken, async (req, res, next) => {
  try { res.json(await svc.listarAtendentes()); } catch (err) { next(err); }
});

router.get('/dashboard', verificarToken, async (req, res, next) => {
  try { res.json(await svc.obterDashboard(_p(req.query))); } catch (err) { next(err); }
});
router.get('/tickets-hora', verificarToken, async (req, res, next) => {
  try { res.json(await svc.ticketsPorHora()); } catch (err) { next(err); }
});
router.get('/tickets-dia', verificarToken, async (req, res, next) => {
  try { res.json(await svc.ticketsPorDia(_p(req.query))); } catch (err) { next(err); }
});
router.get('/tickets-fila', verificarToken, async (req, res, next) => {
  try { res.json(await svc.ticketsPorFila()); } catch (err) { next(err); }
});
router.get('/performance', verificarToken, verificarAdminOuSupervisor, async (req, res, next) => {
  try { res.json(await svc.performanceAtendentes(_p(req.query))); } catch (err) { next(err); }
});
router.get('/csat', verificarToken, async (req, res, next) => {
  try { res.json(await svc.csatDistribuicao({ dias: parseInt(req.query.dias) || 30 })); } catch (err) { next(err); }
});
router.get('/tempos-resposta', verificarToken, async (req, res, next) => {
  try { res.json(await svc.temposResposta(_p(req.query))); } catch (err) { next(err); }
});
router.get('/picos', verificarToken, verificarAdminOuSupervisor, async (req, res, next) => {
  try { res.json(await svc.picosAtendimento(_p(req.query))); } catch (err) { next(err); }
});
router.get('/heatmap', verificarToken, async (req, res, next) => {
  try { res.json(await svc.volumePorHoraDia({ dias: parseInt(req.query.dias) || 30 })); } catch (err) { next(err); }
});
router.get('/atendente/:id', verificarToken, verificarAdminOuSupervisor, async (req, res, next) => {
  try { res.json(await svc.detalheAtendente(req.params.id, { dias: parseInt(req.query.dias) || 30 })); } catch (err) { next(err); }
});
router.get('/contatos-unicos', verificarToken, async (req, res, next) => {
  try { res.json(await svc.contatosUnicos(_p(req.query))); } catch (err) { next(err); }
});
router.get('/tempos-hora', verificarToken, async (req, res, next) => {
  try { res.json(await svc.temposPorHora(_p(req.query))); } catch (err) { next(err); }
});
router.get('/mensagens-dia', verificarToken, async (req, res, next) => {
  try { res.json(await svc.mensagensPorDia(_p(req.query))); } catch (err) { next(err); }
});
router.get('/picos-horario', verificarToken, async (req, res, next) => {
  try { res.json(await svc.picosHorario(_p(req.query))); } catch (err) { next(err); }
});

// AI Insights
router.get('/insights', verificarToken, verificarAdminOuSupervisor, async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.json({ insights: [] });
    const p = _p(req.query);
    const [dashboard, picos, performance, tempos] = await Promise.all([
      svc.obterDashboard(p), svc.picosHorario(p), svc.performanceAtendentes(p), svc.temposResposta(p),
    ]);
    const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
    const resp = await fetch(`${GEMINI_API}?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: `Você é um analista de operações de atendimento ao cliente via WhatsApp. Gere 3-5 insights CONCISOS e ACIONÁVEIS em português. Cada insight: tipo (positivo/alerta/sugestao), titulo (máx 10 palavras), descricao (máx 30 palavras). Use "chamados". NÃO mencione CSAT. Responda APENAS em JSON: {"insights": [{"tipo":"alerta","titulo":"...","descricao":"..."}]}` }] },
        contents: [{ parts: [{ text: `Dashboard: ${JSON.stringify(dashboard)}\nPicos: ${JSON.stringify(picos.slice(0, 12))}\nPerformance: ${JSON.stringify(performance.map(p => ({ nome: p.nome, chamados: p.chamados, tpr: p.tpr_medio, tma: p.tma_medio })))}\nTempos: ${JSON.stringify(tempos)}` }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 500, responseMimeType: 'application/json' },
      }),
    });
    if (!resp.ok) return res.json({ insights: [] });
    const data = await resp.json();
    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = texto.match(/\{[\s\S]*\}/);
    res.json(match ? JSON.parse(match[0]) : { insights: [] });
  } catch { res.json({ insights: [] }); }
});

module.exports = router;
