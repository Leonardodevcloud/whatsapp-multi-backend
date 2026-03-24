// src/modules/reports/reports.routes.js
const { Router } = require('express');
const reportsService = require('./reports.service');
const { verificarToken, verificarAdminOuSupervisor } = require('../../middleware/auth');

const router = Router();

router.get('/dashboard', verificarToken, async (req, res, next) => {
  try {
    let { dataInicio, dataFim, dias } = req.query;
    if (dias && !dataInicio) {
      const d = parseInt(dias);
      const fim = new Date();
      const inicio = new Date();
      inicio.setDate(inicio.getDate() - d);
      dataInicio = inicio.toISOString().split('T')[0];
      dataFim = fim.toISOString().split('T')[0];
    }
    res.json(await reportsService.obterDashboard({ dataInicio, dataFim }));
  } catch (err) { next(err); }
});

router.get('/tickets-hora', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.ticketsPorHora()); } catch (err) { next(err); }
});

router.get('/tickets-dia', verificarToken, async (req, res, next) => {
  try {
    const { dias } = req.query;
    res.json(await reportsService.ticketsPorDia({ dias: parseInt(dias) || 30 }));
  } catch (err) { next(err); }
});

router.get('/tickets-fila', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.ticketsPorFila()); } catch (err) { next(err); }
});

router.get('/performance', verificarToken, verificarAdminOuSupervisor, async (req, res, next) => {
  try {
    const { dias } = req.query;
    res.json(await reportsService.performanceAtendentes({ dias: parseInt(dias) || 30 }));
  } catch (err) { next(err); }
});

router.get('/csat', verificarToken, async (req, res, next) => {
  try {
    const { dias } = req.query;
    res.json(await reportsService.csatDistribuicao({ dias: parseInt(dias) || 30 }));
  } catch (err) { next(err); }
});

router.get('/tempos-resposta', verificarToken, async (req, res, next) => {
  try {
    const { dias } = req.query;
    res.json(await reportsService.temposResposta({ dias: parseInt(dias) || 30 }));
  } catch (err) { next(err); }
});

router.get('/picos', verificarToken, verificarAdminOuSupervisor, async (req, res, next) => {
  try {
    const { dias } = req.query;
    res.json(await reportsService.picosAtendimento({ dias: parseInt(dias) || 30 }));
  } catch (err) { next(err); }
});

router.get('/heatmap', verificarToken, async (req, res, next) => {
  try {
    const { dias } = req.query;
    res.json(await reportsService.volumePorHoraDia({ dias: parseInt(dias) || 30 }));
  } catch (err) { next(err); }
});

router.get('/atendente/:id', verificarToken, verificarAdminOuSupervisor, async (req, res, next) => {
  try {
    const { dias } = req.query;
    res.json(await reportsService.detalheAtendente(req.params.id, { dias: parseInt(dias) || 30 }));
  } catch (err) { next(err); }
});

router.get('/contatos-unicos', verificarToken, async (req, res, next) => {
  try {
    const { dias } = req.query;
    res.json(await reportsService.contatosUnicos({ dias: parseInt(dias) || 30 }));
  } catch (err) { next(err); }
});

router.get('/tempos-dia', verificarToken, async (req, res, next) => {
  try {
    const { dias } = req.query;
    res.json(await reportsService.temposPorDia({ dias: parseInt(dias) || 30 }));
  } catch (err) { next(err); }
});

router.get('/mensagens-dia', verificarToken, async (req, res, next) => {
  try {
    const { dias } = req.query;
    res.json(await reportsService.mensagensPorDia({ dias: parseInt(dias) || 30 }));
  } catch (err) { next(err); }
});

router.get('/picos-horario', verificarToken, async (req, res, next) => {
  try {
    const { dias } = req.query;
    res.json(await reportsService.picosHorario({ dias: parseInt(dias) || 30 }));
  } catch (err) { next(err); }
});

// AI Insights — análise inteligente
router.get('/insights', verificarToken, verificarAdminOuSupervisor, async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.json({ insights: [] });

    const { dias } = req.query;
    const d = parseInt(dias) || 30;

    const [dashboard, picos, performance, tempos] = await Promise.all([
      reportsService.obterDashboard(),
      reportsService.picosAtendimento({ dias: d }),
      reportsService.performanceAtendentes({ dias: d }),
      reportsService.temposResposta({ dias: d }),
    ]);

    const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
    const resp = await fetch(`${GEMINI_API}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: `Você é um analista de operações de atendimento ao cliente via WhatsApp.
Analise os dados e gere 3-5 insights CONCISOS e ACIONÁVEIS em português.
Cada insight deve ter: tipo (positivo/alerta/sugestao), titulo (máx 10 palavras), descricao (máx 30 palavras).
Use o termo "chamados" em vez de "tickets".
NÃO mencione CSAT pois não usamos essa métrica.
Foque em: volume de chamados, tempos de resposta, gargalos, oportunidades de melhoria, dimensionamento de equipe.
Se os dados estiverem zerados, sugira que é um período sem dados e recomende operar normalmente.
Responda APENAS em JSON: {"insights": [{"tipo": "alerta", "titulo": "...", "descricao": "..."}]}` }] },
        contents: [{ parts: [{ text: `Dashboard: ${JSON.stringify(dashboard)}
Picos por hora: ${JSON.stringify(picos.slice(0, 12))}
Performance atendentes: ${JSON.stringify(performance.map(p => ({ nome: p.nome, chamados: p.chamados, tpr: p.tpr_medio, tma: p.tma_medio })))}
Tempos resposta: ${JSON.stringify(tempos)}` }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 500, responseMimeType: 'application/json' },
      }),
    });

    if (!resp.ok) return res.json({ insights: [] });
    const data = await resp.json();
    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const match = texto.match(/\{[\s\S]*\}/);
    const resultado = match ? JSON.parse(match[0]) : { insights: [] };
    res.json(resultado);
  } catch { res.json({ insights: [] }); }
});

module.exports = router;
