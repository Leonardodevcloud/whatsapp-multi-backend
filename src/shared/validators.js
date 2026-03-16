// src/shared/validators.js
// Validações reutilizáveis

const AppError = require('./AppError');

function validarEmail(email) {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !regex.test(email)) {
    throw new AppError('Email inválido', 400);
  }
  return email.trim().toLowerCase();
}

function validarSenha(senha) {
  if (!senha || senha.length < 8) {
    throw new AppError('Senha deve ter no mínimo 8 caracteres', 400);
  }
  return senha;
}

function validarTelefone(telefone) {
  // Formato esperado: 5571999999999 (código país + DDD + número)
  const limpo = telefone?.replace(/\D/g, '') || '';
  if (limpo.length < 12 || limpo.length > 15) {
    throw new AppError('Telefone inválido. Formato esperado: 5571999999999', 400);
  }
  return limpo;
}

function validarCampoObrigatorio(valor, nomeCampo) {
  if (valor === undefined || valor === null || (typeof valor === 'string' && valor.trim() === '')) {
    throw new AppError(`Campo obrigatório: ${nomeCampo}`, 400);
  }
  return typeof valor === 'string' ? valor.trim() : valor;
}

function validarId(id, nomeCampo = 'id') {
  const num = parseInt(id, 10);
  if (isNaN(num) || num < 1) {
    throw new AppError(`${nomeCampo} inválido`, 400);
  }
  return num;
}

function validarPaginacao(cursor, limite = 50) {
  return {
    cursor: cursor ? parseInt(cursor, 10) : null,
    limite: Math.min(Math.max(parseInt(limite, 10) || 50, 1), 100),
  };
}

module.exports = {
  validarEmail,
  validarSenha,
  validarTelefone,
  validarCampoObrigatorio,
  validarId,
  validarPaginacao,
};
