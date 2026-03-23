// src/middleware/rateLimiter.js
// Rate limiting — por usuário JWT (não por IP, pois Vercel proxy compartilha IPs)

const rateLimit = require('express-rate-limit');

// Rate limit geral: 300 req/min POR USUÁRIO logado
const limiteGeral = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em instantes.' },
  keyGenerator: (req) => {
    // Extrair user ID do cookie JWT (decode sem verificar, só pra key)
    if (req.cookies?.access_token) {
      try {
        const payload = JSON.parse(Buffer.from(req.cookies.access_token.split('.')[1], 'base64').toString());
        if (payload.id) return `user_${payload.id}`;
      } catch {}
    }
    // Fallback: IP real
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
  },
  skip: (req) => {
    // Não limitar webhooks e health check
    return req.path === '/api/whatsapp/webhook' || req.path === '/health';
  },
});

// Rate limit para endpoints sensíveis: 120 req/min por usuário
const limiteSensivel = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
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
