// src/middleware/errorHandler.js
// Error handler global — captura AppError e erros inesperados

const logger = require('../shared/logger');
const AppError = require('../shared/AppError');

function errorHandler(err, req, res, _next) {
  // AppError (erros operacionais conhecidos)
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      erro: err.message,
      ...(err.detalhes && { detalhes: err.detalhes }),
    });
  }

  // Erros de parsing JSON
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ erro: 'JSON inválido no body da requisição' });
  }

  // Erro inesperado — logar e retornar 500 genérico
  logger.error(
    {
      err,
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      userId: req.usuario?.id,
    },
    '[ErrorHandler] Erro inesperado'
  );

  return res.status(500).json({ erro: 'Erro interno do servidor' });
}

module.exports = errorHandler;
