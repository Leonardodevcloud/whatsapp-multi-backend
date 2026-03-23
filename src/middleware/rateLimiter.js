// src/middleware/rateLimiter.js
// Rate limiting — ajustado pra proxy Vercel

const rateLimit = require('express-rate-limit');

// Rate limit geral: 1000 req/min por IP (alto por causa do proxy Vercel)
const limiteGeral = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em instantes.' },
  keyGenerator: (req) => {
    // Usar X-Forwarded-For do Vercel pra pegar IP real
    const realIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    return realIp;
  },
});

// Rate limit para endpoints sensíveis: 60 req/min por usuário
const limiteSensivel = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições neste endpoint. Aguarde.' },
  keyGenerator: (req) => req.usuario?.id ? `user_${req.usuario.id}` : (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip),
});

// Rate limit para login: 20 tentativas/15min por IP real
const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de login. Aguarde 15 minutos.' },
  keyGenerator: (req) => req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip,
});

module.exports = { limiteGeral, limiteSensivel, limiteLogin };
