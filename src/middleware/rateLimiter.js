// src/middleware/rateLimiter.js
// Rate limiting — por usuário JWT (não por IP, pois atendentes compartilham rede)

const rateLimit = require('express-rate-limit');

// Extrair user ID do cookie JWT (decode rápido sem verificar, só pra key)
function _extractUserId(req) {
  if (req.cookies?.access_token) {
    try {
      const payload = JSON.parse(Buffer.from(req.cookies.access_token.split('.')[1], 'base64').toString());
      if (payload.id) return `user_${payload.id}`;
    } catch {}
  }
  // Fallback: IP real (prefixo diferente pra não misturar pools)
  return `ip_${req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip}`;
}

// Rate limit geral: 600 req/min POR USUÁRIO logado
const limiteGeral = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em instantes.' },
  keyGenerator: _extractUserId,
  skip: (req) => {
    return req.path === '/api/whatsapp/webhook' || req.path === '/health';
  },
});

// Rate limit para endpoints sensíveis: 200 req/min por usuário
const limiteSensivel = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições neste endpoint. Aguarde.' },
  keyGenerator: (req) => req.usuario?.id ? `user_${req.usuario.id}` : _extractUserId(req),
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
