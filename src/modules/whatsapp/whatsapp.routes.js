// src/modules/whatsapp/whatsapp.routes.js
// Rotas do módulo WhatsApp

const { Router } = require('express');
const whatsappService = require('./whatsapp.service');
const { verificarToken, verificarAdmin } = require('../../middleware/auth');
const { limiteSensivel } = require('../../middleware/rateLimiter');

const router = Router();

// GET /api/whatsapp/status — status da conexão
router.get('/status', verificarToken, (req, res) => {
  const status = whatsappService.obterStatus();
  res.json(status);
});

// GET /api/whatsapp/qr — obter QR code atual
router.get('/qr', verificarToken, verificarAdmin, (req, res) => {
  const qr = whatsappService.obterQrCode();
  if (!qr) {
    return res.json({ qr: null, mensagem: 'QR não disponível. Já conectado ou aguardando geração.' });
  }
  res.json({ qr });
});

// POST /api/whatsapp/enviar — enviar mensagem de texto
router.post('/enviar', verificarToken, limiteSensivel, async (req, res, next) => {
  try {
    const { ticket_id, texto } = req.body;

    if (!ticket_id || !texto?.trim()) {
      return res.status(400).json({ erro: 'ticket_id e texto são obrigatórios' });
    }

    const mensagem = await whatsappService.enviarMensagemTexto({
      ticketId: ticket_id,
      texto: texto.trim(),
      usuarioId: req.usuario.id,
    });

    res.json({ sucesso: true, mensagem });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/reconectar — forçar reconexão (admin only)
router.post('/reconectar', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await whatsappService.reconectar();
    res.json({ sucesso: true, mensagem: 'Reconexão iniciada' });
  } catch (err) {
    next(err);
  }
});

// POST /api/whatsapp/logout — desvincular aparelho (admin only)
router.post('/logout', verificarToken, verificarAdmin, async (req, res, next) => {
  try {
    await whatsappService.forcarLogout();
    res.json({ sucesso: true, mensagem: 'Logout realizado. Escaneie o QR novamente.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
