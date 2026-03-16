// src/middleware/rateLimiter.js
// Rate limiting por IP e por usuário

const rateLimit = require('express-rate-limit');

// Rate limit geral: 100 req/min por IP
const limiteGeral = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em instantes.' },
  keyGenerator: (req) => req.ip,
});

// Rate limit para endpoints sensíveis: 30 req/min
const limiteSensivel = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições neste endpoint. Aguarde.' },
  keyGenerator: (req) => req.usuario?.id ? `user_${req.usuario.id}` : req.ip,
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
