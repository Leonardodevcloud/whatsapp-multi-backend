// src/modules/contacts/contacts.routes.js
const { Router } = require('express');
const contactsService = require('./contacts.service');
const { verificarToken } = require('../../middleware/auth');

const router = Router();

// GET /api/contacts
router.get('/', verificarToken, async (req, res, next) => {
  try {
    const { cursor, limite, busca } = req.query;
    const resultado = await contactsService.listarContatos({ cursor, limite, busca });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// GET /api/contacts/:id
router.get('/:id', verificarToken, async (req, res, next) => {
  try {
    const contato = await contactsService.obterContatoPorId(req.params.id);
    res.json(contato);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/contacts/:id
router.patch('/:id', verificarToken, async (req, res, next) => {
  try {
    const contato = await contactsService.atualizarContato({
      contatoId: req.params.id,
      dados: req.body,
      usuarioId: req.usuario.id,
      ip: req.ip,
    });
    res.json(contato);
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/:id/tags
router.post('/:id/tags', verificarToken, async (req, res, next) => {
  try {
    const { tag_id } = req.body;
    const contato = await contactsService.adicionarTag({ contatoId: req.params.id, tagId: tag_id });
    res.json(contato);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/contacts/:id/tags/:tagId
router.delete('/:id/tags/:tagId', verificarToken, async (req, res, next) => {
  try {
    const contato = await contactsService.removerTag({ contatoId: req.params.id, tagId: req.params.tagId });
    res.json(contato);
  } catch (err) {
    next(err);
  }
});

// POST /api/contacts/importar — importar contatos em massa (admin)
router.post('/importar', verificarToken, async (req, res, next) => {
  try {
    const { query: dbQuery } = require('../../config/database');
    const { contatos } = req.body;
    if (!Array.isArray(contatos) || contatos.length === 0) {
      return res.status(400).json({ erro: 'Array de contatos é obrigatório' });
    }

    let inseridos = 0;
    let duplicados = 0;

    for (const c of contatos) {
      const nome = (c.nome || '').trim().substring(0, 200);
      const telefone = (c.telefone || '').trim().replace(/\D/g, '');
      if (!telefone) continue;

      try {
        await dbQuery(
          `INSERT INTO contatos (nome, telefone) VALUES ($1, $2) ON CONFLICT (telefone) DO NOTHING`,
          [nome || telefone, telefone]
        );
        inseridos++;
      } catch {
        duplicados++;
      }
    }

    res.json({ sucesso: true, inseridos, duplicados, total: contatos.length });
  } catch (err) { next(err); }
});

module.exports = router;