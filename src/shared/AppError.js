// src/shared/AppError.js
// Classe de erro com status HTTP

class AppError extends Error {
  constructor(mensagem, statusCode = 500, detalhes = null) {
    super(mensagem);
    this.statusCode = statusCode;
    this.detalhes = detalhes;
    this.isOperacional = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
