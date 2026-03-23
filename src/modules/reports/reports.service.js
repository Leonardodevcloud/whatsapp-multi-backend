// src/modules/reports/reports.service.js
// Serviço de relatórios — consulta ticket_ciclos para métricas precisas
// Cada registro em ticket_ciclos = 1 ciclo (abertura→fechamento)
// TPR e TMA são gravados por ciclo, nunca sobrescritos

const { query } = require('../../config/database');

// ── helpers ──────────────────────────────────────────────

async function _getHorarioOperacao() {
  try {
    const r = await query(`SELECT MIN(hora_abertura) as abertura, MAX(hora_fechamento) as fechamento FROM configuracao_horario WHERE ativo = TRUE`);
    return { abertura: parseInt(r.rows[0]?.abertura) || 7, fechamento: parseInt(r.rows[0]?.fechamento) || 22 };
  } catch { return { abertura: 7, fechamento: 22 }; }
}

// ── Dashboard principal ──────────────────────────────────

async function obterDashboard({ dataInicio, dataFim } = {}) {
  const usaFiltro = dataInicio && dataFim;

  // 1. Ciclos concluídos no período (da tabela ticket_ciclos)
  const ciclos = usaFiltro
    ? await query(`
        SELECT 
          COUNT(*) as total,
          ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
          ROUND(AVG(tempo_resolucao_seg) FILTER (WHERE tempo_resolucao_seg IS NOT NULL)) as tma_medio
        FROM ticket_ciclos
        WHERE fechado_em >= $1::DATE AND fechado_em < ($2::DATE + INTERVAL '1 day')
      `, [dataInicio, dataFim])
    : await query(`
        SELECT 
          COUNT(*) as total,
          ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
          ROUND(AVG(tempo_resolucao_seg) FILTER (WHERE tempo_resolucao_seg IS NOT NULL)) as tma_medio
        FROM ticket_ciclos
        WHERE fechado_em >= CURRENT_DATE
      `);

  // 2. Ciclos em andamento (tickets ativos cujo ciclo atual iniciou no período)
  const andamento = usaFiltro
    ? await query(`
        SELECT 
          COUNT(*) as total,
          ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio
        FROM tickets
        WHERE status IN ('pendente', 'aberto', 'aguardando')
          AND criado_em >= $1::DATE AND criado_em < ($2::DATE + INTERVAL '1 day')
      `, [dataInicio, dataFim])
    : await query(`
        SELECT 
          COUNT(*) as total,
          ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio
        FROM tickets
        WHERE status IN ('pendente', 'aberto', 'aguardando')
          AND criado_em >= CURRENT_DATE
      `);

  // 3. Snapshots em tempo real
  const pendentes = await query(`SELECT COUNT(*) as total FROM tickets WHERE status = 'pendente'`);
  const emAtendimento = await query(`SELECT COUNT(*) as total FROM tickets WHERE status IN ('aberto', 'aguardando')`);
  const online = await query(`SELECT COUNT(*) as total FROM usuarios WHERE online = TRUE AND ativo = TRUE AND ultimo_acesso >= NOW() - INTERVAL '15 minutes'`);

  const ciclosTotal = parseInt(ciclos.rows[0].total) || 0;
  const andamentoTotal = parseInt(andamento.rows[0].total) || 0;

  // TPR combinado: média ponderada de ciclos concluídos + em andamento
  const tprCiclos = parseInt(ciclos.rows[0].tpr_medio) || 0;
  const tprAndamento = parseInt(andamento.rows[0].tpr_medio) || 0;
  let tprMedio = tprCiclos;
  if (tprCiclos && tprAndamento) {
    tprMedio = Math.round((tprCiclos * ciclosTotal + tprAndamento * andamentoTotal) / (ciclosTotal + andamentoTotal));
  } else if (tprAndamento && !tprCiclos) {
    tprMedio = tprAndamento;
  }

  return {
    chamados: ciclosTotal + andamentoTotal,
    tpr_medio: tprMedio,
    tma_medio: parseInt(ciclos.rows[0].tma_medio) || 0,
    pendentes: parseInt(pendentes.rows[0].total) || 0,
    em_atendimento: parseInt(emAtendimento.rows[0].total) || 0,
    atendentes_online: parseInt(online.rows[0].total) || 0,
  };
}

// ── Tickets por hora (últimas 24h) ──────────────────────

async function ticketsPorHora() {
  const h = await _getHorarioOperacao();
  const resultado = await query(`
    SELECT date_trunc('hour', fechado_em AT TIME ZONE 'America/Bahia') as hora, COUNT(*) as total
    FROM ticket_ciclos
    WHERE fechado_em >= NOW() - INTERVAL '24 hours'
      AND EXTRACT(HOUR FROM fechado_em AT TIME ZONE 'America/Bahia') BETWEEN $1 AND $2
    GROUP BY 1 ORDER BY 1
  `, [h.abertura, h.fechamento]);
  return resultado.rows;
}

// ── Chamados por dia ────────────────────────────────────

async function ticketsPorDia({ dias = 30 } = {}) {
  // Ciclos concluídos por dia
  const concluidos = await query(`
    SELECT 
      DATE(fechado_em AT TIME ZONE 'America/Bahia') as dia, 
      COUNT(*) as total,
      ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio
    FROM ticket_ciclos
    WHERE fechado_em >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY 1 ORDER BY 1
  `, [dias]);

  return concluidos.rows;
}

// ── Por fila (últimos 30 dias) ──────────────────────────

async function ticketsPorFila() {
  const resultado = await query(`
    SELECT f.nome, f.cor,
      (
        SELECT COUNT(*) FROM ticket_ciclos tc 
        WHERE tc.fila_id = f.id AND tc.fechado_em >= NOW() - INTERVAL '30 days'
      ) + (
        SELECT COUNT(*) FROM tickets t 
        WHERE t.fila_id = f.id AND t.status IN ('pendente', 'aberto', 'aguardando') 
          AND t.criado_em >= NOW() - INTERVAL '30 days'
      ) as total,
      (SELECT COUNT(*) FROM tickets t WHERE t.fila_id = f.id AND t.status = 'pendente') as pendentes,
      (SELECT COUNT(*) FROM tickets t WHERE t.fila_id = f.id AND t.status = 'aberto') as abertos
    FROM filas f
    WHERE f.ativo = TRUE
    ORDER BY total DESC
  `);
  return resultado.rows;
}

// ── Performance dos atendentes ──────────────────────────

async function performanceAtendentes({ dias = 30 } = {}) {
  // 1. Lista de atendentes ativos + tickets ativos
  const base = await query(`
    SELECT u.id, u.nome, u.avatar_url, u.online,
      COUNT(t.id) FILTER (WHERE t.status IN ('aberto', 'aguardando')) as tickets_ativos
    FROM usuarios u
    LEFT JOIN tickets t ON t.usuario_id = u.id
    WHERE u.ativo = TRUE AND u.perfil != 'admin'
    GROUP BY u.id
  `);

  // 2. Métricas de ciclos concluídos por atendente (da tabela ticket_ciclos)
  const ciclos = await query(`
    SELECT 
      usuario_id,
      COUNT(*) as concluidos,
      ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
      ROUND(AVG(tempo_resolucao_seg) FILTER (WHERE tempo_resolucao_seg IS NOT NULL)) as tma_medio
    FROM ticket_ciclos
    WHERE fechado_em >= NOW() - ($1 || ' days')::INTERVAL AND usuario_id IS NOT NULL
    GROUP BY usuario_id
  `, [dias]);

  // 3. Ciclos em andamento por atendente
  const andamento = await query(`
    SELECT usuario_id, COUNT(*) as total
    FROM tickets
    WHERE status IN ('pendente', 'aberto', 'aguardando')
      AND criado_em >= NOW() - ($1 || ' days')::INTERVAL AND usuario_id IS NOT NULL
    GROUP BY usuario_id
  `, [dias]);

  const cicloMap = {};
  for (const r of ciclos.rows) cicloMap[r.usuario_id] = r;
  const andMap = {};
  for (const r of andamento.rows) andMap[r.usuario_id] = parseInt(r.total);

  return base.rows.map(r => {
    const c = cicloMap[r.id] || {};
    const concluidos = parseInt(c.concluidos) || 0;
    const emAndamento = andMap[r.id] || 0;
    return {
      id: r.id,
      nome: r.nome,
      avatar_url: r.avatar_url,
      online: r.online,
      chamados: concluidos + emAndamento,
      tpr_medio: parseInt(c.tpr_medio) || 0,
      tma_medio: parseInt(c.tma_medio) || 0,
      tickets_ativos: parseInt(r.tickets_ativos) || 0,
    };
  }).sort((a, b) => b.chamados - a.chamados);
}

// ── CSAT (mantido por compatibilidade) ──────────────────

async function csatDistribuicao({ dias = 30 } = {}) {
  const resultado = await query(`SELECT avaliacao, COUNT(*) as total FROM tickets WHERE avaliacao IS NOT NULL AND atualizado_em >= NOW() - ($1 || ' days')::INTERVAL GROUP BY avaliacao ORDER BY avaliacao`, [dias]);
  const mediaResult = await query(`SELECT ROUND(AVG(avaliacao), 2) as media, COUNT(*) as total_avaliacoes FROM tickets WHERE avaliacao IS NOT NULL AND atualizado_em >= NOW() - ($1 || ' days')::INTERVAL`, [dias]);
  return { distribuicao: resultado.rows, media: parseFloat(mediaResult.rows[0]?.media) || 0, total: parseInt(mediaResult.rows[0]?.total_avaliacoes) || 0 };
}

// ── Tempos de resposta (distribuição) ───────────────────

async function temposResposta({ dias = 30 } = {}) {
  // Usar ticket_ciclos para distribuição precisa
  const resultado = await query(`
    SELECT CASE
      WHEN tempo_primeira_resposta_seg < 60 THEN '< 1 min'
      WHEN tempo_primeira_resposta_seg < 300 THEN '1-5 min'
      WHEN tempo_primeira_resposta_seg < 900 THEN '5-15 min'
      WHEN tempo_primeira_resposta_seg < 1800 THEN '15-30 min'
      WHEN tempo_primeira_resposta_seg < 3600 THEN '30-60 min'
      ELSE '> 1 hora'
    END as faixa, COUNT(*) as total
    FROM ticket_ciclos
    WHERE tempo_primeira_resposta_seg IS NOT NULL 
      AND fechado_em >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY faixa ORDER BY MIN(tempo_primeira_resposta_seg)
  `, [dias]);

  // Incluir também tickets ativos com TPR definido
  const ativos = await query(`
    SELECT CASE
      WHEN tempo_primeira_resposta_seg < 60 THEN '< 1 min'
      WHEN tempo_primeira_resposta_seg < 300 THEN '1-5 min'
      WHEN tempo_primeira_resposta_seg < 900 THEN '5-15 min'
      WHEN tempo_primeira_resposta_seg < 1800 THEN '15-30 min'
      WHEN tempo_primeira_resposta_seg < 3600 THEN '30-60 min'
      ELSE '> 1 hora'
    END as faixa, COUNT(*) as total
    FROM tickets
    WHERE tempo_primeira_resposta_seg IS NOT NULL 
      AND status IN ('aberto', 'aguardando')
      AND criado_em >= NOW() - ($1 || ' days')::INTERVAL
    GROUP BY faixa ORDER BY MIN(tempo_primeira_resposta_seg)
  `, [dias]);

  // Combinar resultados
  const faixaMap = {};
  for (const r of resultado.rows) faixaMap[r.faixa] = parseInt(r.total);
  for (const r of ativos.rows) faixaMap[r.faixa] = (faixaMap[r.faixa] || 0) + parseInt(r.total);

  const ordem = ['< 1 min', '1-5 min', '5-15 min', '15-30 min', '30-60 min', '> 1 hora'];
  return ordem.filter(f => faixaMap[f]).map(f => ({ faixa: f, total: faixaMap[f] }));
}

// ── Picos de atendimento ────────────────────────────────

async function picosAtendimento({ dias = 30 } = {}) {
  const h = await _getHorarioOperacao();
  // Combinar ciclos concluídos + tickets ativos
  const resultado = await query(`
    SELECT hora, SUM(total) as tickets, MAX(atendentes) as atendentes_ativos,
      ROUND(AVG(tpr) FILTER (WHERE tpr IS NOT NULL)) as tpr_medio,
      ROUND(AVG(tma) FILTER (WHERE tma IS NOT NULL)) as tr_medio
    FROM (
      SELECT EXTRACT(HOUR FROM fechado_em AT TIME ZONE 'America/Bahia') as hora,
        COUNT(*) as total, COUNT(DISTINCT usuario_id) as atendentes,
        AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL) as tpr,
        AVG(tempo_resolucao_seg) FILTER (WHERE tempo_resolucao_seg IS NOT NULL) as tma
      FROM ticket_ciclos
      WHERE fechado_em >= NOW() - ($1 || ' days')::INTERVAL
        AND EXTRACT(HOUR FROM fechado_em AT TIME ZONE 'America/Bahia') BETWEEN $2 AND $3
      GROUP BY 1
      UNION ALL
      SELECT EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Bahia') as hora,
        COUNT(*) as total, COUNT(DISTINCT usuario_id) as atendentes,
        AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL) as tpr,
        NULL as tma
      FROM tickets
      WHERE status IN ('pendente', 'aberto', 'aguardando')
        AND criado_em >= NOW() - ($1 || ' days')::INTERVAL
        AND EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Bahia') BETWEEN $2 AND $3
      GROUP BY 1
    ) combined
    GROUP BY hora ORDER BY hora
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
    SELECT dia_semana, hora, SUM(total) as total FROM (
      SELECT EXTRACT(DOW FROM fechado_em AT TIME ZONE 'America/Bahia') as dia_semana,
        EXTRACT(HOUR FROM fechado_em AT TIME ZONE 'America/Bahia') as hora, COUNT(*) as total
      FROM ticket_ciclos WHERE fechado_em >= NOW() - ($1 || ' days')::INTERVAL
        AND EXTRACT(HOUR FROM fechado_em AT TIME ZONE 'America/Bahia') BETWEEN $2 AND $3
      GROUP BY 1, 2
      UNION ALL
      SELECT EXTRACT(DOW FROM criado_em AT TIME ZONE 'America/Bahia') as dia_semana,
        EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Bahia') as hora, COUNT(*) as total
      FROM tickets WHERE status IN ('pendente', 'aberto', 'aguardando')
        AND criado_em >= NOW() - ($1 || ' days')::INTERVAL
        AND EXTRACT(HOUR FROM criado_em AT TIME ZONE 'America/Bahia') BETWEEN $2 AND $3
      GROUP BY 1, 2
    ) combined
    GROUP BY 1, 2 ORDER BY 1, 2
  `, [dias, h.abertura, h.fechamento]);
  return resultado.rows;
}

// ── Detalhe por atendente ───────────────────────────────

async function detalheAtendente(userId, { dias = 30 } = {}) {
  const resumo = await query(`
    SELECT u.id, u.nome, u.avatar_url, u.online, u.email, u.perfil,
      COUNT(t.id) FILTER (WHERE t.status IN ('aberto', 'aguardando')) as ativos
    FROM usuarios u
    LEFT JOIN tickets t ON t.usuario_id = u.id
    WHERE u.id = $1 GROUP BY u.id
  `, [userId]);

  // Métricas de ciclos concluídos
  const ciclos = await query(`
    SELECT 
      COUNT(*) as concluidos,
      ROUND(AVG(tempo_primeira_resposta_seg) FILTER (WHERE tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
      ROUND(AVG(tempo_resolucao_seg) FILTER (WHERE tempo_resolucao_seg IS NOT NULL)) as tma_medio
    FROM ticket_ciclos
    WHERE usuario_id = $1 AND fechado_em >= NOW() - ($2 || ' days')::INTERVAL
  `, [userId, dias]);

  // Ciclos em andamento
  const andamento = await query(`
    SELECT COUNT(*) as total FROM tickets
    WHERE usuario_id = $1 AND status IN ('pendente', 'aberto', 'aguardando')
      AND criado_em >= NOW() - ($2 || ' days')::INTERVAL
  `, [userId, dias]);

  // Por dia (ciclos concluídos)
  const porDia = await query(`
    SELECT DATE(fechado_em AT TIME ZONE 'America/Bahia') as dia, COUNT(*) as total 
    FROM ticket_ciclos WHERE usuario_id = $1 AND fechado_em >= NOW() - ($2 || ' days')::INTERVAL 
    GROUP BY 1 ORDER BY 1
  `, [userId, dias]);

  // Por hora (ciclos concluídos)
  const porHora = await query(`
    SELECT EXTRACT(HOUR FROM fechado_em AT TIME ZONE 'America/Bahia') as hora, COUNT(*) as total 
    FROM ticket_ciclos WHERE usuario_id = $1 AND fechado_em >= NOW() - ($2 || ' days')::INTERVAL 
    GROUP BY 1 ORDER BY 1
  `, [userId, dias]);

  const r = resumo.rows[0] || {};
  const c = ciclos.rows[0] || {};
  r.chamados = (parseInt(c.concluidos) || 0) + (parseInt(andamento.rows[0]?.total) || 0);
  r.tpr_medio = parseInt(c.tpr_medio) || 0;
  r.tma_medio = parseInt(c.tma_medio) || 0;
  return { resumo: r, por_dia: porDia.rows, por_hora: porHora.rows };
}

module.exports = { obterDashboard, ticketsPorHora, ticketsPorDia, ticketsPorFila, performanceAtendentes, csatDistribuicao, temposResposta, picosAtendimento, detalheAtendente, volumePorHoraDia };
