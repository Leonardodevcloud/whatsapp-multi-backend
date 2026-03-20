// src/modules/tickets/tickets.routes.js
// Rotas do módulo tickets
// IMPORTANTE: rotas estáticas (/motivos, /contadores) ANTES de /:id

const { Router } = require('express');
const ticketsService = require('./tickets.service');
const { verificarToken, verificarAdminOuSupervisor } = require('../../middleware/auth');

const router = Router();

// GET /api/tickets — listar com filtros e cursor
router.get('/', verificarToken, async (req, res, next) => {
  try {
    const { cursor, limite, status, fila_id, usuario_id, busca, prioridade } = req.query;
    const resultado = await ticketsService.listarTickets({
      cursor, limite, status, filaId: fila_id, usuarioId: usuario_id, busca, prioridade,
    });
    res.json(resultado);
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/contadores
router.get('/contadores', verificarToken, async (req, res, next) => {
  try {
    const contadores = await ticketsService.obterContadores(req.usuario.id);
    res.json(contadores);
  } catch (err) { next(err); }
});

// GET /api/tickets/busca-texto
router.get('/busca-texto', verificarToken, async (req, res, next) => {
  try {
    const { q, limite } = req.query;
    if (!q || q.length < 3) return res.json({ resultados: [] });
    const { query: dbQuery } = require('../../config/database');
    const resultado = await dbQuery(
      `SELECT m.id, m.corpo, m.tipo, m.criado_em, m.ticket_id,
              t.protocolo, t.status, c.nome as contato_nome, c.telefone as contato_telefone
       FROM mensagens m JOIN tickets t ON t.id = m.ticket_id LEFT JOIN contatos c ON c.id = t.contato_id
       WHERE m.corpo ILIKE $1 AND m.tipo = 'texto' ORDER BY m.criado_em DESC LIMIT $2`,
      [`%${q}%`, parseInt(limite) || 20]
    );
    res.json({ resultados: resultado.rows, total: resultado.rows.length });
  } catch (err) { next(err); }
});

// ============================================================
// MOTIVOS DE ATENDIMENTO — CRUD (ANTES de /:id pra não conflitar)
// ============================================================
router.get('/motivos', verificarToken, async (req, res, next) => {
  try { res.json({ motivos: await ticketsService.listarMotivos() }); } catch (err) { next(err); }
});
router.get('/motivos/ativos', verificarToken, async (req, res, next) => {
  try { res.json({ motivos: await ticketsService.listarMotivosAtivos() }); } catch (err) { next(err); }
});
router.post('/motivos', verificarToken, async (req, res, next) => {
  try { res.json(await ticketsService.criarMotivo(req.body)); } catch (err) { next(err); }
});
router.patch('/motivos/:id', verificarToken, async (req, res, next) => {
  try { res.json(await ticketsService.atualizarMotivo({ id: req.params.id, ...req.body })); } catch (err) { next(err); }
});
router.delete('/motivos/:id', verificarToken, async (req, res, next) => {
  try { res.json(await ticketsService.deletarMotivo(req.params.id)); } catch (err) { next(err); }
});

// POST /api/tickets/criar-para-contato
router.post('/criar-para-contato', verificarToken, async (req, res, next) => {
  try {
    const { contato_id } = req.body;
    if (!contato_id) return res.status(400).json({ erro: 'contato_id é obrigatório' });
    const ticket = await ticketsService.criarParaContato({ contatoId: contato_id, usuarioId: req.usuario.id, ip: req.ip });
    res.json(ticket);
  } catch (err) { next(err); }
});

// ============================================================
// ROTAS COM :id (DEPOIS das estáticas)
// ============================================================
router.get('/:id', verificarToken, async (req, res, next) => {
  try { res.json(await ticketsService.obterTicketPorId(req.params.id)); } catch (err) { next(err); }
});

router.patch('/:id', verificarToken, async (req, res, next) => {
  try {
    res.json(await ticketsService.atualizarTicket({ ticketId: req.params.id, dados: req.body, usuarioId: req.usuario.id, ip: req.ip }));
  } catch (err) { next(err); }
});

router.post('/:id/aceitar', verificarToken, async (req, res, next) => {
  try { res.json(await ticketsService.aceitarTicket({ ticketId: req.params.id, usuarioId: req.usuario.id, ip: req.ip })); } catch (err) { next(err); }
});

router.post('/:id/atribuir', verificarToken, verificarAdminOuSupervisor, async (req, res, next) => {
  try {
    const { usuario_id } = req.body;
    if (!usuario_id) return res.status(400).json({ erro: 'usuario_id é obrigatório' });
    res.json(await ticketsService.atribuirTicket({ ticketId: req.params.id, usuarioId: usuario_id, adminId: req.usuario.id, ip: req.ip }));
  } catch (err) { next(err); }
});

router.post('/:id/transferir', verificarToken, async (req, res, next) => {
  try {
    const { fila_id, usuario_id, motivo } = req.body;
    if (!fila_id && !usuario_id) return res.status(400).json({ erro: 'Informe fila_id ou usuario_id para transferir' });
    res.json(await ticketsService.transferirTicket({ ticketId: req.params.id, filaId: fila_id, usuarioId: usuario_id, motivoTransferencia: motivo, adminId: req.usuario.id, ip: req.ip }));
  } catch (err) { next(err); }
});

// POST /api/tickets/:id/resolver — com motivo
router.post('/:id/resolver', verificarToken, async (req, res, next) => {
  try {
    const { motivo_id, motivo_texto } = req.body || {};
    res.json(await ticketsService.resolverTicket({ ticketId: req.params.id, usuarioId: req.usuario.id, ip: req.ip, motivoId: motivo_id, motivoTexto: motivo_texto }));
  } catch (err) { next(err); }
});

router.post('/:id/fechar', verificarToken, async (req, res, next) => {
  try { res.json(await ticketsService.fecharTicket({ ticketId: req.params.id, usuarioId: req.usuario.id, ip: req.ip })); } catch (err) { next(err); }
});

router.post('/:id/aguardando', verificarToken, async (req, res, next) => {
  try { res.json(await ticketsService.marcarAguardando({ ticketId: req.params.id, usuarioId: req.usuario.id, ip: req.ip })); } catch (err) { next(err); }
});

router.post('/:id/avaliar', async (req, res, next) => {
  try {
    const nota = parseInt(req.body.avaliacao);
    if (isNaN(nota) || nota < 1 || nota > 5) return res.status(400).json({ erro: 'Avaliação deve ser entre 1 e 5' });
    const { query } = require('../../config/database');
    await query(`UPDATE tickets SET avaliacao = $1, atualizado_em = NOW() WHERE id = $2`, [nota, req.params.id]);
    res.json({ sucesso: true, avaliacao: nota });
  } catch (err) { next(err); }
});

router.post('/:id/visualizar', verificarToken, async (req, res, next) => {
  try {
    const { query: dbQuery } = require('../../config/database');
    const { registrarMensagemSistema } = require('../messages/messages.service');
    const { broadcast } = require('../../websocket');
    const ticketId = req.params.id;
    const usuario = req.usuario;
    const jaVisualizou = await dbQuery(
      `SELECT id FROM mensagens WHERE ticket_id = $1 AND tipo = 'sistema' AND corpo LIKE $2 AND criado_em > NOW() - INTERVAL '5 minutes'`,
      [ticketId, `%${usuario.nome} visualizou%`]
    );
    if (jaVisualizou.rows.length === 0) {
      const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' });
      const msg = await registrarMensagemSistema({ ticketId, corpo: `${usuario.nome} visualizou o chamado às ${hora}`, usuarioId: usuario.id });
      broadcast('mensagem:nova', { ...msg, ticket_id: parseInt(ticketId) });
    }
    await dbQuery(`UPDATE mensagens SET status_envio = 'lida' WHERE ticket_id = $1 AND is_from_me = FALSE AND status_envio != 'lida'`, [ticketId]);
    res.json({ sucesso: true });
  } catch (err) { next(err); }
});

module.exports = router;
