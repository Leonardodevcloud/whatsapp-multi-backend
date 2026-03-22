// src/modules/supervision/supervision.routes.js
// Supervisão em tempo real — admin vê tudo

const { Router } = require('express');
const { verificarToken, verificarAdmin } = require('../../middleware/auth');
const { query } = require('../../config/database');
const logger = require('../../shared/logger');

const router = Router();

// GET /api/supervision/dashboard — visão geral
router.get('/dashboard', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    // Atendentes online + tickets em atendimento
    const atendentes = await query(`
      SELECT u.id, u.nome, u.avatar_url, u.online, u.ultimo_acesso,
             COUNT(t.id) FILTER (WHERE t.status = 'aberto') as tickets_abertos,
             COUNT(t.id) FILTER (WHERE t.status = 'aguardando') as tickets_aguardando
      FROM usuarios u
      LEFT JOIN tickets t ON t.usuario_id = u.id AND t.status IN ('aberto', 'aguardando')
      WHERE u.ativo = TRUE
      GROUP BY u.id
      ORDER BY u.online DESC, u.nome
    `);

    // Resumo geral
    const resumo = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pendente') as pendentes,
        COUNT(*) FILTER (WHERE status = 'aberto') as abertos,
        COUNT(*) FILTER (WHERE status = 'aguardando') as aguardando,
        COUNT(*) FILTER (WHERE status = 'resolvido' AND fechado_em > NOW() - INTERVAL '24 hours') as resolvidos_24h,
        COALESCE(AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL AND criado_em > NOW() - INTERVAL '24 hours'), 0)::int as tpr_medio_seg
      FROM tickets
    `);

    // Fila por fila
    const filas = await query(`
      SELECT f.id, f.nome, f.cor,
             COUNT(t.id) FILTER (WHERE t.status = 'pendente') as pendentes,
             COUNT(t.id) FILTER (WHERE t.status = 'aberto') as abertos
      FROM filas f
      LEFT JOIN tickets t ON t.fila_id = f.id AND t.status IN ('pendente', 'aberto')
      WHERE f.ativo = TRUE
      GROUP BY f.id
      ORDER BY f.ordem, f.nome
    `);

    res.json({
      atendentes: atendentes.rows,
      resumo: resumo.rows[0],
      filas: filas.rows,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/supervision/chats-ativos — todos os chats abertos com última msg
router.get('/chats-ativos', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const resultado = await query(`
      SELECT t.id, t.status, t.protocolo, t.criado_em, t.ultima_mensagem_em, t.ultima_mensagem_preview,
             c.nome as contato_nome, c.telefone as contato_telefone, c.avatar_url as contato_avatar,
             u.id as atendente_id, u.nome as atendente_nome, u.avatar_url as atendente_avatar,
             f.nome as fila_nome, f.cor as fila_cor,
             (SELECT COUNT(*) FROM mensagens m WHERE m.ticket_id = t.id) as total_mensagens
      FROM tickets t
      LEFT JOIN contatos c ON c.id = t.contato_id
      LEFT JOIN usuarios u ON u.id = t.usuario_id
      LEFT JOIN filas f ON f.id = t.fila_id
      WHERE t.status IN ('aberto', 'pendente', 'aguardando')
      ORDER BY t.ultima_mensagem_em DESC NULLS LAST
      LIMIT 100
    `);

    res.json({ chats: resultado.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/supervision/assumir/:ticketId — admin assume um ticket
router.post('/assumir/:ticketId', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    await query(
      `UPDATE tickets SET usuario_id = $1, status = 'aberto', atualizado_em = NOW() WHERE id = $2`,
      [req.usuario.id, ticketId]
    );

    const { registrarMensagemSistema } = require('../messages/messages.service');
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' });
    await registrarMensagemSistema({
      ticketId: parseInt(ticketId),
      corpo: `Supervisor assumiu o atendimento às ${hora}`,
      usuarioId: req.usuario.id,
    });

    logger.info({ ticketId, adminId: req.usuario.id }, '[Supervision] Admin assumiu ticket');
    res.json({ sucesso: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/supervision/nota-interna/:ticketId — admin envia nota interna
router.post('/nota-interna/:ticketId', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    const { ticketId } = req.params;
    const { texto } = req.body;
    if (!texto?.trim()) return res.status(400).json({ erro: 'texto é obrigatório' });

    const { criarNotaInterna } = require('../messages/messages.service');
    const nota = await criarNotaInterna({
      ticketId: parseInt(ticketId),
      texto: texto.trim(),
      usuarioId: req.usuario.id,
    });

    const { broadcast } = require('../../websocket');
    broadcast('mensagem:nova', { ...nota, ticket_id: parseInt(ticketId) });

    res.json({ sucesso: true, nota });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
