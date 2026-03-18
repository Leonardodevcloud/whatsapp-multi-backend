// src/modules/tickets/tickets.routes.js
// Rotas do módulo tickets

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

// GET /api/tickets/contadores — contadores por status
router.get('/contadores', verificarToken, async (req, res, next) => {
  try {
    const contadores = await ticketsService.obterContadores(req.usuario.id);
    res.json(contadores);
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/:id — detalhes do ticket
router.get('/:id', verificarToken, async (req, res, next) => {
  try {
    const ticket = await ticketsService.obterTicketPorId(req.params.id);
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/tickets/:id — atualizar campos
router.patch('/:id', verificarToken, async (req, res, next) => {
  try {
    const ticket = await ticketsService.atualizarTicket({
      ticketId: req.params.id,
      dados: req.body,
      usuarioId: req.usuario.id,
      ip: req.ip,
    });
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/aceitar — atendente aceita ticket da fila
router.post('/:id/aceitar', verificarToken, async (req, res, next) => {
  try {
    const ticket = await ticketsService.aceitarTicket({
      ticketId: req.params.id,
      usuarioId: req.usuario.id,
      ip: req.ip,
    });
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/atribuir — admin atribui a um atendente
router.post('/:id/atribuir', verificarToken, verificarAdminOuSupervisor, async (req, res, next) => {
  try {
    const { usuario_id } = req.body;
    if (!usuario_id) return res.status(400).json({ erro: 'usuario_id é obrigatório' });

    const ticket = await ticketsService.atribuirTicket({
      ticketId: req.params.id,
      usuarioId: usuario_id,
      adminId: req.usuario.id,
      ip: req.ip,
    });
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/transferir — transferir para outra fila/atendente
router.post('/:id/transferir', verificarToken, async (req, res, next) => {
  try {
    const { fila_id, usuario_id, motivo } = req.body;
    if (!fila_id && !usuario_id) {
      return res.status(400).json({ erro: 'Informe fila_id ou usuario_id para transferir' });
    }

    const ticket = await ticketsService.transferirTicket({
      ticketId: req.params.id,
      filaId: fila_id,
      usuarioId: usuario_id,
      motivoTransferencia: motivo,
      adminId: req.usuario.id,
      ip: req.ip,
    });
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/resolver — resolver ticket
router.post('/:id/resolver', verificarToken, async (req, res, next) => {
  try {
    const ticket = await ticketsService.resolverTicket({
      ticketId: req.params.id,
      usuarioId: req.usuario.id,
      ip: req.ip,
    });
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/fechar — fechar ticket
router.post('/:id/fechar', verificarToken, async (req, res, next) => {
  try {
    const ticket = await ticketsService.fecharTicket({
      ticketId: req.params.id,
      usuarioId: req.usuario.id,
      ip: req.ip,
    });
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/aguardando — marcar como aguardando
router.post('/:id/aguardando', verificarToken, async (req, res, next) => {
  try {
    const ticket = await ticketsService.marcarAguardando({
      ticketId: req.params.id,
      usuarioId: req.usuario.id,
      ip: req.ip,
    });
    res.json(ticket);
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/avaliar — avaliação CSAT (1-5)
router.post('/:id/avaliar', async (req, res, next) => {
  try {
    const { avaliacao } = req.body;
    const nota = parseInt(avaliacao);
    if (isNaN(nota) || nota < 1 || nota > 5) {
      return res.status(400).json({ erro: 'Avaliação deve ser entre 1 e 5' });
    }

    const { query } = require('../../config/database');
    await query(
      `UPDATE tickets SET avaliacao = $1, atualizado_em = NOW() WHERE id = $2`,
      [nota, req.params.id]
    );

    res.json({ sucesso: true, avaliacao: nota });
  } catch (err) {
    next(err);
  }
});

// GET /api/tickets/busca-texto — busca full-text em mensagens
router.get('/busca-texto', verificarToken, async (req, res, next) => {
  try {
    const { q, limite } = req.query;
    if (!q || q.length < 3) return res.json({ resultados: [] });

    const { query: dbQuery } = require('../../config/database');
    const resultado = await dbQuery(
      `SELECT m.id, m.corpo, m.tipo, m.criado_em, m.ticket_id,
              t.protocolo, t.status,
              c.nome as contato_nome, c.telefone as contato_telefone
       FROM mensagens m
       JOIN tickets t ON t.id = m.ticket_id
       LEFT JOIN contatos c ON c.id = t.contato_id
       WHERE m.corpo ILIKE $1 AND m.tipo = 'texto'
       ORDER BY m.criado_em DESC
       LIMIT $2`,
      [`%${q}%`, parseInt(limite) || 20]
    );

    res.json({ resultados: resultado.rows, total: resultado.rows.length });
  } catch (err) {
    next(err);
  }
});

// POST /api/tickets/:id/visualizar — registrar que atendente visualizou o chamado
router.post('/:id/visualizar', verificarToken, async (req, res, next) => {
  try {
    const { query: dbQuery } = require('../../config/database');
    const { registrarMensagemSistema } = require('../messages/messages.service');
    const { broadcast } = require('../../websocket');

    const ticketId = req.params.id;
    const usuario = req.usuario;

    // Verificar se já visualizou recentemente (evitar spam)
    const jaVisualizou = await dbQuery(
      `SELECT id FROM mensagens WHERE ticket_id = $1 AND tipo = 'sistema' AND corpo LIKE $2 AND criado_em > NOW() - INTERVAL '5 minutes'`,
      [ticketId, `%${usuario.nome} visualizou%`]
    );

    if (jaVisualizou.rows.length === 0) {
      const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      const msg = await registrarMensagemSistema({
        ticketId,
        corpo: `${usuario.nome} visualizou o chamado às ${hora}`,
        usuarioId: usuario.id,
      });
      broadcast('mensagem:nova', { ...msg, ticket_id: parseInt(ticketId) });
    }

    // Marcar todas as mensagens recebidas como lidas
    await dbQuery(
      `UPDATE mensagens SET status_envio = 'lida' WHERE ticket_id = $1 AND is_from_me = FALSE AND status_envio != 'lida'`,
      [ticketId]
    );

    res.json({ sucesso: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;