// src/middleware/requestLogger.js
// Log de requests com duração

const logger = require('../shared/logger');

function requestLogger(req, res, next) {
  const inicio = Date.now();

  res.on('finish', () => {
    const duracao = Date.now() - inicio;
    const nivel = res.statusCode >= 400 ? 'warn' : 'info';

    logger[nivel](
      {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        duracao: `${duracao}ms`,
        ip: req.ip,
        userId: req.usuario?.id,
      },
      `${req.method} ${req.originalUrl} ${res.statusCode} ${duracao}ms`
    );
  });

  next();
}

module.exports = requestLogger;
