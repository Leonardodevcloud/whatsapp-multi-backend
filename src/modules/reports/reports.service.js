// src/modules/reports/reports.service.js
// Serviço de relatórios — conta ciclos de atendimento (cada open→close = 1 chamado + 1 resolução)

const { query } = require('../../config/database');

async function _getHorarioOperacao() {
  try {
    const r = await query(`SELECT MIN(hora_abertura) as abertura, MAX(hora_fechamento) as fechamento FROM configuracao_horario WHERE ativo = TRUE`);
    return { abertura: parseInt(r.rows[0]?.abertura) || 7, fechamento: parseInt(r.rows[0]?.fechamento) || 22 };
  } catch { return { abertura: 7, fechamento: 22 }; }
}

async function obterDashboard({ dataInicio, dataFim } = {}) {
  const usaFiltro = dataInicio && dataFim;

  let metricas;
  if (usaFiltro) {
    metricas = await query(`
      SELECT
        COUNT(*) FILTER (WHERE criado_em >= $1::DATE AND criado_em < ($2::DATE + INTERVAL '1 day')) as tickets_periodo,
        COUNT(*) FILTER (WHERE status = 'pendente') as pendentes_total,
        ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE criado_em >= $1::DATE AND criado_em < ($2::DATE + INTERVAL '1 day') AND tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
        ROUND(AVG(tempo_resolucao_seg) FILTER (WHERE atualizado_em >= $1::DATE AND atualizado_em < ($2::DATE + INTERVAL '1 day') AND tempo_resolucao_seg IS NOT NULL)) as tr_medio
      FROM tickets
    `, [dataInicio, dataFim]);
  } else {
    metricas = await query(`
      SELECT
        COUNT(*) FILTER (WHERE criado_em >= CURRENT_DATE) as tickets_periodo,
        COUNT(*) FILTER (WHERE status = 'pendente') as pendentes_total,
        ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE criado_em >= CURRENT_DATE AND tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
        ROUND(AVG(tempo_resolucao_seg) FILTER (WHERE atualizado_em >= CURRENT_DATE AND tempo_resolucao_seg IS NOT NULL)) as tr_medio
      FROM tickets
    `);
  }

  // Resoluções = mensagens de sistema com "finalizou"/"resolveu"/"encerrou"
  let resolucoes;
  if (usaFiltro) {
    resolucoes = await query(`
      SELECT COUNT(*) as total FROM mensagens
      WHERE tipo = 'sistema' AND (corpo ILIKE '%finalizou%' OR corpo ILIKE '%resolveu%' OR corpo ILIKE '%encerrou%' OR corpo ILIKE '%fechou%' OR corpo ILIKE '%Ticket fechado%')
        AND criado_em >= $1::DATE AND criado_em < ($2::DATE + INTERVAL '1 day')
    `, [dataInicio, dataFim]);
  } else {
    resolucoes = await query(`
      SELECT COUNT(*) as total FROM mensagens
      WHERE tipo = 'sistema' AND (corpo ILIKE '%finalizou%' OR corpo ILIKE '%resolveu%' OR corpo ILIKE '%encerrou%' OR corpo ILIKE '%fechou%' OR corpo ILIKE '%Ticket fechado%')
        AND criado_em >= CURRENT_DATE
    `);
  }

  // Online = ativo + online + atividade nos últimos 15min
  const online = await query(`
    SELECT COUNT(*) as total FROM usuarios
    WHERE online = TRUE AND ativo = TRUE AND ultimo_acesso >= NOW() - INTERVAL '15 minutes'
  `);

  return {
    tickets_hoje: parseInt(metricas.rows[0].tickets_periodo) || 0,
    resolvidos_hoje: parseInt(resolucoes.rows[0].total) || 0,
    pendentes_total: parseInt(metricas.rows[0].pendentes_total) || 0,
    tpr_medio_hoje: parseInt(metricas.rows[0].tpr_medio) || 0,
    tr_medio_hoje: parseInt(metricas.rows[0].tr_medio) || 0,
    atendentes_online: parseInt(online.rows[0].total) || 0,
  };
}

async function ticketsPorHora() {
  const h = await _getHorarioOperacao();
  const resultado = await query(`
    SELECT date_trunc('hour', criado_em AT TIME ZONE 'America/Bahia') as hora, COUNT(*) as total
    FROM tickets WHERE criado_em >= NOW() - INTERVAL '24 hours'
      AND EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Bahia') BETWEEN $1 AND $2
    GROUP BY 1 ORDER BY 1
  `, [h.abertura, h.fechamento]);
  return resultado.rows;
}

async function ticketsPorDia({ dias = 30 } = {}) {
  const resultado = await query(`
    SELECT DATE(criado_em AT TIME ZONE 'America/Bahia') as dia, COUNT(*) as total,
      ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio
    FROM tickets WHERE criado_em >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY 1 ORDER BY 1
  `, [dias]);

  const resolucoes = await query(`
    SELECT DATE(criado_em AT TIME ZONE 'America/Bahia') as dia, COUNT(*) as resolvidos
    FROM mensagens WHERE tipo = 'sistema' AND (corpo ILIKE '%finalizou%' OR corpo ILIKE '%resolveu%' OR corpo ILIKE '%encerrou%' OR corpo ILIKE '%fechou%' OR corpo ILIKE '%Ticket fechado%')
      AND criado_em >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY 1
  `, [dias]);

  const resolMap = {};
  for (const r of resolucoes.rows) resolMap[r.dia] = parseInt(r.resolvidos);
  return resultado.rows.map(r => ({ ...r, resolvidos: resolMap[r.dia] || 0 }));
}

async function ticketsPorFila() {
  const resultado = await query(`
    SELECT f.nome, f.cor, COUNT(t.id) as total,
      COUNT(t.id) FILTER (WHERE t.status = 'pendente') as pendentes,
      COUNT(t.id) FILTER (WHERE t.status = 'aberto') as abertos
    FROM filas f LEFT JOIN tickets t ON t.fila_id = f.id AND t.criado_em >= NOW() - INTERVAL '30 days'
    WHERE f.ativo = TRUE GROUP BY f.id, f.nome, f.cor ORDER BY total DESC
  `);
  return resultado.rows;
}

async function performanceAtendentes({ dias = 30 } = {}) {
  const resultado = await query(`
    SELECT u.id, u.nome, u.avatar_url, u.online,
      COUNT(t.id) as tickets_total,
      ROUND(AVG(t.tempo_primeira_resposta_seg) FILTER (WHERE t.tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
      ROUND(AVG(t.tempo_resolucao_seg) FILTER (WHERE t.tempo_resolucao_seg IS NOT NULL)) as tr_medio,
      COUNT(t.id) FILTER (WHERE t.status IN ('aberto', 'aguardando')) as tickets_ativos
    FROM usuarios u
    LEFT JOIN tickets t ON t.usuario_id = u.id AND t.criado_em >= NOW() - ($1 || ' days')::INTERVAL
    WHERE u.ativo = TRUE AND u.perfil != 'admin'
    GROUP BY u.id ORDER BY tickets_total DESC
  `, [dias]);

  const resolucoes = await query(`
    SELECT m.usuario_id, COUNT(*) as resolvidos FROM mensagens m
    WHERE m.tipo = 'sistema' AND (m.corpo ILIKE '%finalizou%' OR m.corpo ILIKE '%resolveu%' OR m.corpo ILIKE '%encerrou%')
      AND m.criado_em >= NOW() - ($1 || ' days')::INTERVAL AND m.usuario_id IS NOT NULL
    GROUP BY m.usuario_id
  `, [dias]);

  const resolMap = {};
  for (const r of resolucoes.rows) resolMap[r.usuario_id] = parseInt(r.resolvidos);
  return resultado.rows.map(r => ({ ...r, resolvidos: resolMap[r.id] || 0 }));
}

async function csatDistribuicao({ dias = 30 } = {}) {
  const resultado = await query(`SELECT avaliacao, COUNT(*) as total FROM tickets WHERE avaliacao IS NOT NULL AND atualizado_em >= NOW() - ($1 || ' days')::INTERVAL GROUP BY avaliacao ORDER BY avaliacao`, [dias]);
  const mediaResult = await query(`SELECT ROUND(AVG(avaliacao), 2) as media, COUNT(*) as total_avaliacoes FROM tickets WHERE avaliacao IS NOT NULL AND atualizado_em >= NOW() - ($1 || ' days')::INTERVAL`, [dias]);
  return { distribuicao: resultado.rows, media: parseFloat(mediaResult.rows[0]?.media) || 0, total: parseInt(mediaResult.rows[0]?.total_avaliacoes) || 0 };
}

async function temposResposta({ dias = 30 } = {}) {
  const resultado = await query(`
    SELECT CASE
      WHEN tempo_primeira_resposta_seg < 60 THEN '< 1 min'
      WHEN tempo_primeira_resposta_seg < 300 THEN '1-5 min'
      WHEN tempo_primeira_resposta_seg < 900 THEN '5-15 min'
      WHEN tempo_primeira_resposta_seg < 1800 THEN '15-30 min'
      WHEN tempo_primeira_resposta_seg < 3600 THEN '30-60 min'
      ELSE '> 1 hora'
    END as faixa, COUNT(*) as total
    FROM tickets WHERE tempo_primeira_resposta_seg IS NOT NULL AND criado_em >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY faixa ORDER BY MIN(tempo_primeira_resposta_seg)
  `, [dias]);
  return resultado.rows;
}

async function picosAtendimento({ dias = 30 } = {}) {
  const h = await _getHorarioOperacao();
  const resultado = await query(`
    SELECT EXTRACT(HOUR FROM t.criado_em AT TIME ZONE 'America/Bahia') as hora,
      COUNT(t.id) as tickets, COUNT(DISTINCT t.usuario_id) as atendentes_ativos,
      ROUND(AVG(t.tempo_primeira_resposta_seg) FILTER (WHERE t.tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
      ROUND(AVG(t.tempo_resolucao_seg) FILTER (WHERE t.tempo_resolucao_seg IS NOT NULL)) as tr_medio
    FROM tickets t WHERE t.criado_em >= NOW() - ($1 || ' days')::INTERVAL
      AND EXTRACT(HOUR FROM t.criado_em AT TIME ZONE 'America/Bahia') BETWEEN $2 AND $3
    GROUP BY 1 ORDER BY 1
  `, [dias, h.abertura, h.fechamento]);

  const totalDias = Math.max(dias, 1);
  return resultado.rows.map(r => ({
    hora: parseInt(r.hora), tickets_total: parseInt(r.tickets),
    tickets_media_dia: Math.round(parseInt(r.tickets) / totalDias * 10) / 10,
    atendentes_ativos: parseInt(r.atendentes_ativos),
    tpr_medio: parseInt(r.tpr_medio) || 0, tr_medio: parseInt(r.tr_medio) || 0,
  }));
}

async function volumePorHoraDia({ dias = 30 } = {}) {
  const h = await _getHorarioOperacao();
  const resultado = await query(`
    SELECT EXTRACT(DOW FROM criado_em AT TIME ZONE 'America/Bahia') as dia_semana,
      EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Bahia') as hora, COUNT(*) as total
    FROM tickets WHERE criado_em >= NOW() - ($1 || ' days')::INTERVAL
      AND EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Bahia') BETWEEN $2 AND $3
    GROUP BY 1, 2 ORDER BY 1, 2
  `, [dias, h.abertura, h.fechamento]);
  return resultado.rows;
}

async function detalheAtendente(userId, { dias = 30 } = {}) {
  const resumo = await query(`
    SELECT u.id, u.nome, u.avatar_url, u.online, u.email, u.perfil,
      COUNT(t.id) as tickets_total,
      COUNT(t.id) FILTER (WHERE t.status IN ('aberto', 'aguardando')) as ativos,
      ROUND(AVG(t.tempo_primeira_resposta_seg) FILTER (WHERE t.tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
      ROUND(AVG(t.tempo_resolucao_seg) FILTER (WHERE t.tempo_resolucao_seg IS NOT NULL)) as tr_medio
    FROM usuarios u LEFT JOIN tickets t ON t.usuario_id = u.id AND t.criado_em >= NOW() - ($2 || ' days')::INTERVAL
    WHERE u.id = $1 GROUP BY u.id
  `, [userId, dias]);

  const resolucoes = await query(`
    SELECT COUNT(*) as resolvidos FROM mensagens
    WHERE tipo = 'sistema' AND (corpo ILIKE '%finalizou%' OR corpo ILIKE '%resolveu%' OR corpo ILIKE '%encerrou%' OR corpo ILIKE '%fechou%' OR corpo ILIKE '%Ticket fechado%')
      AND usuario_id = $1 AND criado_em >= NOW() - ($2 || ' days')::INTERVAL
  `, [userId, dias]);

  const porDia = await query(`SELECT DATE(criado_em AT TIME ZONE 'America/Bahia') as dia, COUNT(*) as total FROM tickets WHERE usuario_id = $1 AND criado_em >= NOW() - ($2 || ' days')::INTERVAL GROUP BY 1 ORDER BY 1`, [userId, dias]);
  const porHora = await query(`SELECT EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Bahia') as hora, COUNT(*) as total FROM tickets WHERE usuario_id = $1 AND criado_em >= NOW() - ($2 || ' days')::INTERVAL GROUP BY 1 ORDER BY 1`, [userId, dias]);

  const r = resumo.rows[0] || {};
  r.resolvidos = parseInt(resolucoes.rows[0]?.resolvidos) || 0;
  return { resumo: r, por_dia: porDia.rows, por_hora: porHora.rows };
}

module.exports = { obterDashboard, ticketsPorHora, ticketsPorDia, ticketsPorFila, performanceAtendentes, csatDistribuicao, temposResposta, picosAtendimento, detalheAtendente, volumePorHoraDia };
