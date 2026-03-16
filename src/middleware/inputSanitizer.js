// src/middleware/inputSanitizer.js
// Sanitização de inputs contra XSS

const xss = require('xss');

const xssOpcoes = {
  whiteList: {},
  stripIgnoreTag: true,
  stripIgnoreTagBody: ['script'],
};

function sanitizarValor(valor) {
  if (typeof valor === 'string') {
    return xss(valor, xssOpcoes);
  }
  if (Array.isArray(valor)) {
    return valor.map(sanitizarValor);
  }
  if (valor && typeof valor === 'object') {
    return sanitizarObjeto(valor);
  }
  return valor;
}

function sanitizarObjeto(obj) {
  const resultado = {};
  for (const [chave, valor] of Object.entries(obj)) {
    resultado[chave] = sanitizarValor(valor);
  }
  return resultado;
}

function inputSanitizer(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizarObjeto(req.body);
  }
  if (req.query && typeof req.query === 'object') {
    req.query = sanitizarObjeto(req.query);
  }
  if (req.params && typeof req.params === 'object') {
    req.params = sanitizarObjeto(req.params);
  }
  next();
}

module.exports = inputSanitizer;
