// src/modules/reports/reports.routes.js
const { Router } = require('express');
const reportsService = require('./reports.service');
const { verificarToken, verificarAdminOuSupervisor } = require('../../middleware/auth');

const router = Router();

router.get('/dashboard', verificarToken, async (req, res, next) => {
  try { res.json(await reportsService.obterDashboard()); } catch (err) { next(err); }
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

module.exports = router;
