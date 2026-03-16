// src/shared/audit.js
// Logger de auditoria — registra ações sensíveis no banco

const { query } = require('../config/database');
const logger = require('./logger');

/**
 * Registrar ação de auditoria
 * @param {object} params
 * @param {number} params.usuarioId - ID do usuário que executou a ação
 * @param {string} params.acao - Descrição da ação
 * @param {string} params.entidade - Nome da entidade (ticket, usuario, etc)
 * @param {number} params.entidadeId - ID da entidade
 * @param {object} params.dadosAnteriores - Dados antes da alteração
 * @param {object} params.dadosNovos - Dados após a alteração
 * @param {string} params.ip - IP do request
 */
async function registrarAuditoria({
  usuarioId = null,
  acao,
  entidade = null,
  entidadeId = null,
  dadosAnteriores = null,
  dadosNovos = null,
  ip = null,
}) {
  try {
    await query(
      `INSERT INTO auditoria (usuario_id, acao, entidade, entidade_id, dados_anteriores, dados_novos, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        usuarioId,
        acao,
        entidade,
        entidadeId,
        dadosAnteriores ? JSON.stringify(dadosAnteriores) : null,
        dadosNovos ? JSON.stringify(dadosNovos) : null,
        ip,
      ]
    );
  } catch (err) {
    // Auditoria não deve derrubar a operação principal
    logger.error({ err, acao, entidade }, '[Auditoria] Falha ao registrar');
  }
}

module.exports = { registrarAuditoria };
