// src/modules/quick-replies/quick-replies.routes.js
const { Router } = require('express');
const service = require('./quick-replies.service');
const { verificarToken } = require('../../middleware/auth');

const router = Router();

router.get('/', verificarToken, async (req, res, next) => {
  try {
    const { fila_id } = req.query;
    const respostas = await service.listarRespostasRapidas({ filaId: fila_id });
    res.json(respostas);
  } catch (err) { next(err); }
});

router.post('/', verificarToken, async (req, res, next) => {
  try {
    const { atalho, titulo, corpo, media_url, fila_id } = req.body;
    const resposta = await service.criarRespostaRapida({
      atalho, titulo, corpo, mediaUrl: media_url, filaId: fila_id, usuarioId: req.usuario.id,
    });
    res.status(201).json(resposta);
  } catch (err) { next(err); }
});

router.patch('/:id', verificarToken, async (req, res, next) => {
  try {
    const resposta = await service.atualizarRespostaRapida({ id: req.params.id, dados: req.body });
    res.json(resposta);
  } catch (err) { next(err); }
});

router.delete('/:id', verificarToken, async (req, res, next) => {
  try {
    const resultado = await service.deletarRespostaRapida(req.params.id);
    res.json(resultado);
  } catch (err) { next(err); }
});

module.exports = router;
