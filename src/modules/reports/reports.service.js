// src/modules/reports/reports.service.js
// Serviço de relatórios — conta CICLOS de atendimento
// Cada abertura→fechamento = 1 chamado. Reabertura = novo chamado.
// TPR e TMA calculados por ciclo (resetados a cada reabertura)

const { query } = require('../../config/database');

// ── helpers ──────────────────────────────────────────────

const FILTRO_FECHAMENTO = `tipo = 'sistema' AND (corpo ILIKE '%finalizou%' OR corpo ILIKE '%resolveu%' OR corpo ILIKE '%encerrou%' OR corpo ILIKE '%fechou%' OR corpo ILIKE '%Ticket fechado%')`;

async function _getHorarioOperacao() {
  try {
    const r = await query(`SELECT MIN(hora_abertura) as abertura, MAX(hora_fechamento) as fechamento FROM configuracao_horario WHERE ativo = TRUE`);
    return { abertura: parseInt(r.rows[0]?.abertura) || 7, fechamento: parseInt(r.rows[0]?.fechamento) || 22 };
  } catch { return { abertura: 7, fechamento: 22 }; }
}

// ── Dashboard principal ──────────────────────────────────

async function obterDashboard({ dataInicio, dataFim } = {}) {
  const usaFiltro = dataInicio && dataFim;

  // 1. Ciclos COMPLETOS no período (mensagens de fechamento)
  const ciclosCompletos = usaFiltro
    ? await query(`SELECT COUNT(*) as total FROM mensagens WHERE ${FILTRO_FECHAMENTO} AND criado_em >= $1::DATE AND criado_em < ($2::DATE + INTERVAL '1 day')`, [dataInicio, dataFim])
    : await query(`SELECT COUNT(*) as total FROM mensagens WHERE ${FILTRO_FECHAMENTO} AND criado_em >= CURRENT_DATE`);

  // 2. Ciclos EM ANDAMENTO (tickets ativos cujo ciclo atual iniciou no período)
  const ciclosAndamento = usaFiltro
    ? await query(`SELECT COUNT(*) as total FROM tickets WHERE status IN ('pendente', 'aberto', 'aguardando') AND criado_em >= $1::DATE AND criado_em < ($2::DATE + INTERVAL '1 day')`, [dataInicio, dataFim])
    : await query(`SELECT COUNT(*) as total FROM tickets WHERE status IN ('pendente', 'aberto', 'aguardando') AND criado_em >= CURRENT_DATE`);

  // 3. TPR e TMA — médias dos ciclos com criado_em no período
  //    (criado_em é resetado a cada reabertura, então reflete o ciclo atual)
  const metricas = usaFiltro
    ? await query(`
        SELECT
          ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
          ROUND(AVG(tempo_resolucao_seg) FILTER (WHERE tempo_resolucao_seg IS NOT NULL)) as tma_medio
        FROM tickets
        WHERE criado_em >= $1::DATE AND criado_em < ($2::DATE + INTERVAL '1 day')
      `, [dataInicio, dataFim])
    : await query(`
        SELECT
          ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
          ROUND(AVG(tempo_resolucao_seg) FILTER (WHERE tempo_resolucao_seg IS NOT NULL)) as tma_medio
        FROM tickets
        WHERE criado_em >= CURRENT_DATE
      `);

  // 4. Snapshots em tempo real (não dependem de período)
  const pendentes = await query(`SELECT COUNT(*) as total FROM tickets WHERE status = 'pendente'`);
  const emAtendimento = await query(`SELECT COUNT(*) as total FROM tickets WHERE status IN ('aberto', 'aguardando')`);
  const online = await query(`SELECT COUNT(*) as total FROM usuarios WHERE online = TRUE AND ativo = TRUE AND ultimo_acesso >= NOW() - INTERVAL '15 minutes'`);

  return {
    chamados: (parseInt(ciclosCompletos.rows[0].total) || 0) + (parseInt(ciclosAndamento.rows[0].total) || 0),
    tpr_medio: parseInt(metricas.rows[0].tpr_medio) || 0,
    tma_medio: parseInt(metricas.rows[0].tma_medio) || 0,
    pendentes: parseInt(pendentes.rows[0].total) || 0,
    em_atendimento: parseInt(emAtendimento.rows[0].total) || 0,
    atendentes_online: parseInt(online.rows[0].total) || 0,
  };
}

// ── Tickets por hora (últimas 24h) ──────────────────────

async function ticketsPorHora() {
  const h = await _getHorarioOperacao();
  // Conta mensagens de fechamento (ciclos completos) por hora
  const resultado = await query(`
    SELECT date_trunc('hour', criado_em AT TIME ZONE 'America/Bahia') as hora, COUNT(*) as total
    FROM mensagens
    WHERE ${FILTRO_FECHAMENTO}
      AND criado_em >= NOW() - INTERVAL '24 hours'
      AND EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Bahia') BETWEEN $1 AND $2
    GROUP BY 1 ORDER BY 1
  `, [h.abertura, h.fechamento]);
  return resultado.rows;
}

// ── Chamados por dia ────────────────────────────────────

async function ticketsPorDia({ dias = 30 } = {}) {
  // Ciclos completos por dia (mensagens de fechamento)
  const concluidos = await query(`
    SELECT DATE(criado_em AT TIME ZONE 'America/Bahia') as dia, COUNT(*) as concluidos
    FROM mensagens
    WHERE ${FILTRO_FECHAMENTO}
      AND criado_em >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY 1
  `, [dias]);

  // Ciclos iniciados por dia (tickets com criado_em — inclui reaberturas pois criado_em é resetado)
  // Para ciclos antigos já fechados, o criado_em foi sobrescrito na reabertura,
  // então tickets inativos com criado_em nesse dia = ciclos que iniciaram e já terminaram
  const iniciados = await query(`
    SELECT DATE(criado_em AT TIME ZONE 'America/Bahia') as dia, COUNT(*) as total,
      ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio
    FROM tickets
    WHERE criado_em >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY 1 ORDER BY 1
  `, [dias]);

  // Ciclos em andamento por dia (tickets ativos cujo ciclo atual começou nesse dia)
  const andamento = await query(`
    SELECT DATE(criado_em AT TIME ZONE 'America/Bahia') as dia, COUNT(*) as em_andamento
    FROM tickets
    WHERE status IN ('pendente', 'aberto', 'aguardando')
      AND criado_em >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY 1
  `, [dias]);

  const conclMap = {};
  for (const r of concluidos.rows) conclMap[r.dia] = parseInt(r.concluidos);
  const andMap = {};
  for (const r of andamento.rows) andMap[r.dia] = parseInt(r.em_andamento);

  return iniciados.rows.map(r => {
    const conclDia = conclMap[r.dia] || 0;
    const andDia = andMap[r.dia] || 0;
    return {
      dia: r.dia,
      // Total de chamados do dia = concluídos nesse dia + em andamento iniciados nesse dia
      // Nota: usamos os concluídos + em andamento como proxy
      // Os tickets inativos com criado_em nesse dia representam ciclos antigos já sobrescritos
      total: conclDia + andDia,
      concluidos: conclDia,
      tpr_medio: r.tpr_medio,
    };
  });
}

// ── Por fila (últimos 30 dias) ──────────────────────────

async function ticketsPorFila() {
  // Conta ciclos completos por fila (mensagens de fechamento vinculadas ao ticket → fila)
  const resultado = await query(`
    SELECT f.nome, f.cor,
      COUNT(DISTINCT CASE WHEN t.criado_em >= NOW() - INTERVAL '30 days' THEN t.id END) as total,
      COUNT(DISTINCT CASE WHEN t.status = 'pendente' THEN t.id END) as pendentes,
      COUNT(DISTINCT CASE WHEN t.status = 'aberto' THEN t.id END) as abertos
    FROM filas f
    LEFT JOIN tickets t ON t.fila_id = f.id
    WHERE f.ativo = TRUE
    GROUP BY f.id, f.nome, f.cor
    ORDER BY total DESC
  `);
  return resultado.rows;
}

// ── Performance dos atendentes ──────────────────────────

async function performanceAtendentes({ dias = 30 } = {}) {
  // 1. Dados base dos atendentes + tickets ativos + médias de TPR/TMA
  const base = await query(`
    SELECT u.id, u.nome, u.avatar_url, u.online,
      COUNT(t.id) FILTER (WHERE t.status IN ('aberto', 'aguardando')) as tickets_ativos,
      ROUND(AVG(t.tempo_primeira_resposta_seg) FILTER (WHERE t.tempo_primeira_resposta_seg IS NOT NULL AND t.criado_em >= NOW() - ($1 || ' days')::INTERVAL)) as tpr_medio,
      ROUND(AVG(t.tempo_resolucao_seg) FILTER (WHERE t.tempo_resolucao_seg IS NOT NULL AND t.criado_em >= NOW() - ($1 || ' days')::INTERVAL)) as tma_medio
    FROM usuarios u
    LEFT JOIN tickets t ON t.usuario_id = u.id
    WHERE u.ativo = TRUE AND u.perfil != 'admin'
    GROUP BY u.id
  `, [dias]);

  // 2. Ciclos concluídos por atendente (mensagens de fechamento no período)
  const concluidos = await query(`
    SELECT m.usuario_id, COUNT(*) as total FROM mensagens m
    WHERE ${FILTRO_FECHAMENTO}
      AND m.criado_em >= NOW() - ($1 || ' days')::INTERVAL AND m.usuario_id IS NOT NULL
    GROUP BY m.usuario_id
  `, [dias]);

  // 3. Ciclos em andamento por atendente (tickets ativos com criado_em no período)
  const andamento = await query(`
    SELECT usuario_id, COUNT(*) as total FROM tickets
    WHERE status IN ('pendente', 'aberto', 'aguardando')
      AND criado_em >= NOW() - ($1 || ' days')::INTERVAL AND usuario_id IS NOT NULL
    GROUP BY usuario_id
  `, [dias]);

  const conclMap = {};
  for (const r of concluidos.rows) conclMap[r.usuario_id] = parseInt(r.total);
  const andMap = {};
  for (const r of andamento.rows) andMap[r.usuario_id] = parseInt(r.total);

  return base.rows.map(r => ({
    id: r.id,
    nome: r.nome,
    avatar_url: r.avatar_url,
    online: r.online,
    chamados: (conclMap[r.id] || 0) + (andMap[r.id] || 0),
    tpr_medio: parseInt(r.tpr_medio) || 0,
    tma_medio: parseInt(r.tma_medio) || 0,
    tickets_ativos: parseInt(r.tickets_ativos) || 0,
  })).sort((a, b) => b.chamados - a.chamados);
}

// ── CSAT (mantido por compatibilidade) ──────────────────

async function csatDistribuicao({ dias = 30 } = {}) {
  const resultado = await query(`SELECT avaliacao, COUNT(*) as total FROM tickets WHERE avaliacao IS NOT NULL AND atualizado_em >= NOW() - ($1 || ' days')::INTERVAL GROUP BY avaliacao ORDER BY avaliacao`, [dias]);
  const mediaResult = await query(`SELECT ROUND(AVG(avaliacao), 2) as media, COUNT(*) as total_avaliacoes FROM tickets WHERE avaliacao IS NOT NULL AND atualizado_em >= NOW() - ($1 || ' days')::INTERVAL`, [dias]);
  return { distribuicao: resultado.rows, media: parseFloat(mediaResult.rows[0]?.media) || 0, total: parseInt(mediaResult.rows[0]?.total_avaliacoes) || 0 };
}

// ── Tempos de resposta (distribuição) ───────────────────

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

// ── Picos de atendimento ────────────────────────────────

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

// ── Volume por hora/dia (heatmap) ───────────────────────

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

// ── Detalhe por atendente ───────────────────────────────

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
    SELECT COUNT(*) as concluidos FROM mensagens
    WHERE ${FILTRO_FECHAMENTO}
      AND usuario_id = $1 AND criado_em >= NOW() - ($2 || ' days')::INTERVAL
  `, [userId, dias]);

  const porDia = await query(`SELECT DATE(criado_em AT TIME ZONE 'America/Bahia') as dia, COUNT(*) as total FROM tickets WHERE usuario_id = $1 AND criado_em >= NOW() - ($2 || ' days')::INTERVAL GROUP BY 1 ORDER BY 1`, [userId, dias]);
  const porHora = await query(`SELECT EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Bahia') as hora, COUNT(*) as total FROM tickets WHERE usuario_id = $1 AND criado_em >= NOW() - ($2 || ' days')::INTERVAL GROUP BY 1 ORDER BY 1`, [userId, dias]);

  const r = resumo.rows[0] || {};
  r.concluidos = parseInt(resolucoes.rows[0]?.concluidos) || 0;
  return { resumo: r, por_dia: porDia.rows, por_hora: porHora.rows };
}

module.exports = { obterDashboard, ticketsPorHora, ticketsPorDia, ticketsPorFila, performanceAtendentes, csatDistribuicao, temposResposta, picosAtendimento, detalheAtendente, volumePorHoraDia };
