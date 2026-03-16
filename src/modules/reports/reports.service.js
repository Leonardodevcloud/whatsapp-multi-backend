// src/modules/reports/reports.service.js
// Serviço de relatórios e métricas

const { query } = require('../../config/database');

/**
 * Dashboard — métricas do dia
 */
async function obterDashboard() {
  const hoje = await query(`
    SELECT
      COUNT(*) FILTER (WHERE DATE(criado_em) = CURRENT_DATE) as tickets_hoje,
      COUNT(*) FILTER (WHERE DATE(criado_em) = CURRENT_DATE AND status = 'resolvido') as resolvidos_hoje,
      COUNT(*) FILTER (WHERE status = 'pendente') as pendentes_total,
      COUNT(*) FILTER (WHERE status = 'aberto') as abertos_total,
      COUNT(*) FILTER (WHERE status = 'aguardando') as aguardando_total,
      ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE DATE(criado_em) = CURRENT_DATE AND tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio_hoje,
      ROUND(AVG(tempo_resolucao_seg) FILTER (WHERE DATE(atualizado_em) = CURRENT_DATE AND tempo_resolucao_seg IS NOT NULL)) as tr_medio_hoje,
      ROUND(AVG(avaliacao) FILTER (WHERE DATE(atualizado_em) = CURRENT_DATE AND avaliacao IS NOT NULL), 1) as csat_medio_hoje
    FROM tickets
  `);

  // Mensagens hoje
  const msgs = await query(`
    SELECT COUNT(*) as total,
           COUNT(*) FILTER (WHERE is_from_me = FALSE) as recebidas,
           COUNT(*) FILTER (WHERE is_from_me = TRUE AND is_internal = FALSE) as enviadas
    FROM mensagens WHERE DATE(criado_em) = CURRENT_DATE
  `);

  // Atendentes online
  const online = await query(`SELECT COUNT(*) as total FROM usuarios WHERE online = TRUE AND ativo = TRUE`);

  return {
    ...hoje.rows[0],
    mensagens_hoje: msgs.rows[0],
    atendentes_online: parseInt(online.rows[0].total),
  };
}

/**
 * Tickets por hora (gráfico de barras — últimas 24h)
 */
async function ticketsPorHora() {
  const resultado = await query(`
    SELECT
      date_trunc('hour', criado_em) as hora,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'resolvido') as resolvidos
    FROM tickets
    WHERE criado_em >= NOW() - INTERVAL '24 hours'
    GROUP BY date_trunc('hour', criado_em)
    ORDER BY hora ASC
  `);
  return resultado.rows;
}

/**
 * Tickets por dia (últimos 30 dias)
 */
async function ticketsPorDia({ dias = 30 } = {}) {
  const resultado = await query(`
    SELECT
      DATE(criado_em) as dia,
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'resolvido') as resolvidos,
      ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
      ROUND(AVG(avaliacao) FILTER (WHERE avaliacao IS NOT NULL), 1) as csat_medio
    FROM tickets
    WHERE criado_em >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY DATE(criado_em)
    ORDER BY dia ASC
  `, [dias]);
  return resultado.rows;
}

/**
 * Tickets por fila
 */
async function ticketsPorFila() {
  const resultado = await query(`
    SELECT f.nome, f.cor,
           COUNT(t.id) as total,
           COUNT(t.id) FILTER (WHERE t.status = 'pendente') as pendentes,
           COUNT(t.id) FILTER (WHERE t.status = 'aberto') as abertos,
           COUNT(t.id) FILTER (WHERE t.status = 'resolvido') as resolvidos
    FROM filas f
    LEFT JOIN tickets t ON t.fila_id = f.id AND t.criado_em >= NOW() - INTERVAL '30 days'
    WHERE f.ativo = TRUE
    GROUP BY f.id, f.nome, f.cor
    ORDER BY total DESC
  `);
  return resultado.rows;
}

/**
 * Performance de atendentes
 */
async function performanceAtendentes({ dias = 30 } = {}) {
  const resultado = await query(`
    SELECT u.id, u.nome, u.avatar_url, u.online,
           COUNT(t.id) as tickets_total,
           COUNT(t.id) FILTER (WHERE t.status = 'resolvido') as resolvidos,
           ROUND(AVG(t.tempo_primeira_resposta_seg) FILTER (WHERE t.tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
           ROUND(AVG(t.tempo_resolucao_seg) FILTER (WHERE t.tempo_resolucao_seg IS NOT NULL)) as tr_medio,
           ROUND(AVG(t.avaliacao) FILTER (WHERE t.avaliacao IS NOT NULL), 1) as csat_medio,
           COUNT(t.id) FILTER (WHERE t.status IN ('aberto', 'aguardando')) as tickets_ativos
    FROM usuarios u
    LEFT JOIN tickets t ON t.usuario_id = u.id AND t.criado_em >= NOW() - ($1 || ' days')::INTERVAL
    WHERE u.ativo = TRUE AND u.perfil != 'admin'
    GROUP BY u.id, u.nome, u.avatar_url, u.online
    ORDER BY resolvidos DESC
  `, [dias]);
  return resultado.rows;
}

/**
 * CSAT — distribuição de avaliações
 */
async function csatDistribuicao({ dias = 30 } = {}) {
  const resultado = await query(`
    SELECT avaliacao, COUNT(*) as total
    FROM tickets
    WHERE avaliacao IS NOT NULL AND atualizado_em >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY avaliacao
    ORDER BY avaliacao
  `, [dias]);

  const mediaResult = await query(`
    SELECT ROUND(AVG(avaliacao), 2) as media, COUNT(*) as total_avaliacoes
    FROM tickets
    WHERE avaliacao IS NOT NULL AND atualizado_em >= NOW() - ($1 || ' days')::INTERVAL
  `, [dias]);

  return {
    distribuicao: resultado.rows,
    media: parseFloat(mediaResult.rows[0]?.media) || 0,
    total: parseInt(mediaResult.rows[0]?.total_avaliacoes) || 0,
  };
}

/**
 * Tempos de resposta — histograma
 */
async function temposResposta({ dias = 30 } = {}) {
  const resultado = await query(`
    SELECT
      CASE
        WHEN tempo_primeira_resposta_seg < 60 THEN '< 1 min'
        WHEN tempo_primeira_resposta_seg < 300 THEN '1-5 min'
        WHEN tempo_primeira_resposta_seg < 900 THEN '5-15 min'
        WHEN tempo_primeira_resposta_seg < 1800 THEN '15-30 min'
        WHEN tempo_primeira_resposta_seg < 3600 THEN '30-60 min'
        ELSE '> 1 hora'
      END as faixa,
      COUNT(*) as total
    FROM tickets
    WHERE tempo_primeira_resposta_seg IS NOT NULL AND criado_em >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY faixa
    ORDER BY MIN(tempo_primeira_resposta_seg)
  `, [dias]);
  return resultado.rows;
}

module.exports = {
  obterDashboard,
  ticketsPorHora,
  ticketsPorDia,
  ticketsPorFila,
  performanceAtendentes,
  csatDistribuicao,
  temposResposta,
};
