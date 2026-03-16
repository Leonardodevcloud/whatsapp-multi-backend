// src/modules/config/config.service.js
const { query } = require('../../config/database');
const { registrarAuditoria } = require('../../shared/audit');

async function obterConfiguracoes() {
  const resultado = await query(`SELECT chave, valor, descricao, atualizado_em FROM configuracoes ORDER BY chave`);
  // Retornar como objeto chave:valor para facilitar uso no frontend
  const config = {};
  for (const row of resultado.rows) {
    config[row.chave] = { valor: row.valor, descricao: row.descricao, atualizado_em: row.atualizado_em };
  }
  return config;
}

async function atualizarConfiguracao({ chave, valor, usuarioId, ip }) {
  await query(
    `INSERT INTO configuracoes (chave, valor, atualizado_em) VALUES ($1, $2, NOW())
     ON CONFLICT (chave) DO UPDATE SET valor = $2, atualizado_em = NOW()`,
    [chave, valor]
  );

  await registrarAuditoria({
    usuarioId, acao: 'atualizar_config', entidade: 'configuracao',
    dadosNovos: { chave, valor }, ip,
  });

  return { chave, valor };
}

async function obterHorarios() {
  const resultado = await query(
    `SELECT * FROM horarios_funcionamento ORDER BY dia_semana`
  );
  return resultado.rows;
}

async function atualizarHorarios({ horarios, usuarioId, ip }) {
  // Recebe array de { dia_semana, hora_inicio, hora_fim, ativo }
  for (const h of horarios) {
    await query(
      `UPDATE horarios_funcionamento SET hora_inicio = $1, hora_fim = $2, ativo = $3 WHERE dia_semana = $4`,
      [h.hora_inicio, h.hora_fim, h.ativo, h.dia_semana]
    );
  }

  await registrarAuditoria({
    usuarioId, acao: 'atualizar_horarios', entidade: 'horarios', dadosNovos: { horarios }, ip,
  });

  return obterHorarios();
}

/**
 * Verificar se está dentro do horário de funcionamento
 */
async function estaDentroDoHorario() {
  const agora = new Date();
  // Converter para horário de Salvador (America/Bahia = UTC-3)
  const options = { timeZone: 'America/Bahia', hour: '2-digit', minute: '2-digit', hour12: false };
  const horaAtual = agora.toLocaleTimeString('pt-BR', options);
  const diaSemana = parseInt(
    agora.toLocaleDateString('pt-BR', { timeZone: 'America/Bahia', weekday: 'narrow' })
      .replace(/[^\d]/g, '') || agora.getDay()
  );

  // Usar getDay direto com timezone offset
  const dataBahia = new Date(agora.toLocaleString('en-US', { timeZone: 'America/Bahia' }));
  const diaSemanaBahia = dataBahia.getDay();

  const resultado = await query(
    `SELECT * FROM horarios_funcionamento WHERE dia_semana = $1 AND ativo = TRUE`,
    [diaSemanaBahia]
  );

  if (resultado.rows.length === 0) return false;

  const { hora_inicio, hora_fim } = resultado.rows[0];
  return horaAtual >= hora_inicio && horaAtual <= hora_fim;
}

module.exports = { obterConfiguracoes, atualizarConfiguracao, obterHorarios, atualizarHorarios, estaDentroDoHorario };
