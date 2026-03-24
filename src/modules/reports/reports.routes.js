// src/modules/reports/reports.routes.js
const { Router } = require('express');
const reportsService = require('./reports.service');
const { verificarToken, verificarAdminOuSupervisor } = require('../../middleware/auth');

const router = Router();

// Helper: extrai dataInicio/dataFim (aceita dias OU datas explícitas)
function _p(query) {
  let { dataInicio, dataFim, dias } = query;
  if (dataInicio && dataFim) return { dataInicio, dataFim };
  const d = parseInt(dias) || 30;
  const fim = new Date();
  const inicio = new Date();
  inicio.setDate(inicio.getDate() - d);
  return { dataInicio: inicio.toISOString().split('T')[0], dataFim: fim.toISOString().split('T')[0] };
}

router.get('/dashboard', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.obterDashboard(_p(req.query))); } catch (err) { next(err); }
});

router.get('/tickets-hora', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.ticketsPorHora()); } catch (err) { next(err); }
});

router.get('/tickets-dia', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.ticketsPorDia(_p(req.query))); } catch (err) { next(err); }
});

router.get('/tickets-fila', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.ticketsPorFila()); } catch (err) { next(err); }
});

router.get('/performance', verificarToken, verificarAdminOuSupervisor, async (req, res, next) => {
  try { res.json(await reportsService.performanceAtendentes(_p(req.query))); } catch (err) { next(err); }
});

router.get('/csat', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.csatDistribuicao({ dias: parseInt(req.query.dias) || 30 })); } catch (err) { next(err); }
});

router.get('/tempos-resposta', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.temposResposta(_p(req.query))); } catch (err) { next(err); }
});

router.get('/picos', verificarToken, verificarAdminOuSupervisor, async (req, res, next) => {
  try { res.json(await reportsService.picosAtendimento(_p(req.query))); } catch (err) { next(err); }
});

router.get('/heatmap', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.volumePorHoraDia({ dias: parseInt(req.query.dias) || 30 })); } catch (err) { next(err); }
});

router.get('/atendente/:id', verificarToken, verificarAdminOuSupervisor, async (req, res, next) => {
  try { res.json(await reportsService.detalheAtendente(req.params.id, { dias: parseInt(req.query.dias) || 30 })); } catch (err) { next(err); }
});

router.get('/contatos-unicos', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.contatosUnicos(_p(req.query))); } catch (err) { next(err); }
});

router.get('/tempos-dia', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.temposPorDia(_p(req.query))); } catch (err) { next(err); }
});

router.get('/mensagens-dia', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.mensagensPorDia(_p(req.query))); } catch (err) { next(err); }
});

router.get('/picos-horario', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.picosHorario(_p(req.query))); } catch (err) { next(err); }
});

router.get('/insights', verificarToken, verificarAdminOuSupervisor, async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.json({ insights: [] });
    const p = _p(req.query);
    const [dashboard, picos, performance, tempos] = await Promise.all([
      reportsService.obterDashboard(p), reportsService.picosHorario(p),
      reportsService.performanceAtendentes(p), reportsService.temposResposta(p),
    ]);
    const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
    const resp = await fetch(`${GEMINI_API}?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: `Você é um analista de operações de atendimento ao cliente via WhatsApp. Analise os dados e gere 3-5 insights CONCISOS e ACIONÁVEIS em português. Cada insight deve ter: tipo (positivo/alerta/sugestao), titulo (máx 10 palavras), descricao (máx 30 palavras). Use "chamados" em vez de "tickets". NÃO mencione CSAT. Foque em: volume, tempos, gargalos, melhoria, equipe. Responda APENAS em JSON: {"insights": [{"tipo": "alerta", "titulo": "...", "descricao": "..."}]}` }] },
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
