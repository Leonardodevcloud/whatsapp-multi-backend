// src/modules/config/config.routes.js
const { Router } = require('express');
const configService = require('./config.service');
const { verificarToken, verificarAdmin } = require('../../middleware/auth');

const router = Router();

router.get('/', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const config = await configService.obterConfiguracoes();
    res.json(config);
  } catch (err) { next(err); }
});

router.put('/:chave', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { valor } = req.body;
    const resultado = await configService.atualizarConfiguracao({
      chave: req.params.chave, valor, usuarioId: req.usuario.id, ip: req.ip,
    });
    res.json(resultado);
  } catch (err) { next(err); }
});

router.get('/horarios', verificarToken, async (req, res, next) => {
  try {
    const horarios = await configService.obterHorarios();
    res.json(horarios);
  } catch (err) { next(err); }
});

router.put('/horarios', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { horarios } = req.body;
    const resultado = await configService.atualizarHorarios({
      horarios, usuarioId: req.usuario.id, ip: req.ip,
    });
    res.json(resultado);
  } catch (err) { next(err); }
});

router.get('/horario-ativo', verificarToken, async (req, res, next) => {
  try {
    const ativo = await configService.estaDentroDoHorario();
    res.json({ dentroDoHorario: ativo });
  } catch (err) { next(err); }
});

module.exports = router;
