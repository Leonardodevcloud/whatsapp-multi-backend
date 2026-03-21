// src/middleware/rateLimiter.js
// Rate limiting — otimizado para 15+ atendentes simultâneos
// Key por usuario_id (não IP) — evita bloquear escritório inteiro

const rateLimit = require('express-rate-limit');

// Rate limit geral: 300 req/min por usuário (ou IP se não logado)
// 15 users fazendo ~20 req/min cada = 300 req/min total
// Se todos estão no mesmo IP do escritório, o keyGenerator por usuario resolve
const limiteGeral = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em instantes.' },
  keyGenerator: (req) => req.usuario?.id ? `user_${req.usuario.id}` : req.ip,
});

// Rate limit para envio de mensagens: 60 req/min por usuário
// Um atendente ativo pode enviar 1 msg/seg em picos de conversa
const limiteSensivel = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas mensagens enviadas. Aguarde alguns segundos.' },
  keyGenerator: (req) => req.usuario?.id ? `user_send_${req.usuario.id}` : req.ip,
});

// Rate limit para login: 10 tentativas/15min
const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de login. Aguarde 15 minutos.' },
  keyGenerator: (req) => req.ip,
});

module.exports = { limiteGeral, limiteSensivel, limiteLogin };
