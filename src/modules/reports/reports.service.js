// src/modules/reports/reports.service.js
// Todas as funções aceitam { dataInicio, dataFim, usuarioId? }
// Filtro de horário comercial: Seg-Sex 8-18h, Sáb 8-11h, Dom ignorado
// GRUPOS EXCLUÍDOS de todas as métricas (grupos não são atendimentos)

const { query } = require('../../config/database');

function _hc(col) {
  return `(
    (EXTRACT(DOW FROM ${col} AT TIME ZONE 'America/Bahia') BETWEEN 1 AND 5
     AND EXTRACT(HOUR FROM ${col} AT TIME ZONE 'America/Bahia') BETWEEN 8 AND 18)
    OR
    (EXTRACT(DOW FROM ${col} AT TIME ZONE 'America/Bahia') = 6
     AND EXTRACT(HOUR FROM ${col} AT TIME ZONE 'America/Bahia') BETWEEN 8 AND 11)
  )`;
}

// Filtro anti-grupo
const NG_TC = `JOIN contatos _cg ON _cg.id = tc.contato_id AND (_cg.is_group = FALSE OR _cg.is_group IS NULL)`;
const NG_T  = `JOIN contatos _cg ON _cg.id = t.contato_id AND (_cg.is_group = FALSE OR _cg.is_group IS NULL)`;

async function obterDashboard({ dataInicio, dataFim, usuarioId } = {}) {
  const uCond = usuarioId ? 'AND tc.usuario_id = $3' : '';
  const uCondT = usuarioId ? 'AND t.usuario_id = $3' : '';
  const params = [dataInicio, dataFim];
  if (usuarioId) params.push(usuarioId);

  const ciclos = await query(`
    SELECT COUNT(*) as total,
      ROUND(AVG(tc.tempo_primeira_resposta_seg) FILTER (WHERE tc.tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
      ROUND(AVG(tc.tempo_resolucao_seg) FILTER (WHERE tc.tempo_resolucao_seg IS NOT NULL)) as tma_medio
    FROM ticket_ciclos tc ${NG_TC}
    WHERE tc.fechado_em >= $1::DATE AND tc.fechado_em < ($2::DATE + INTERVAL '1 day')
      AND ${_hc('tc.fechado_em')} ${uCond}
  `, params);

  const andamento = await query(`
    SELECT COUNT(*) as total
    FROM tickets t ${NG_T}
    WHERE t.status IN ('pendente','aberto','aguardando')
      AND t.criado_em >= $1::DATE AND t.criado_em < ($2::DATE + INTERVAL '1 day')
      AND ${_hc('t.criado_em')} ${uCondT}
  `, params);

  const pendentes = usuarioId
    ? await query(`SELECT COUNT(*) as total FROM tickets t ${NG_T} WHERE t.status = 'pendente' AND t.usuario_id = $1`, [usuarioId])
    : await query(`SELECT COUNT(*) as total FROM tickets t ${NG_T} WHERE t.status = 'pendente'`);
  const emAtendimento = usuarioId
    ? await query(`SELECT COUNT(*) as total FROM tickets t ${NG_T} WHERE t.status IN ('aberto','aguardando') AND t.usuario_id = $1`, [usuarioId])
    : await query(`SELECT COUNT(*) as total FROM tickets t ${NG_T} WHERE t.status IN ('aberto','aguardando')`);
  const online = await query(`SELECT COUNT(*) as total FROM usuarios WHERE online = TRUE AND ativo = TRUE AND ultimo_acesso >= NOW() - INTERVAL '15 minutes'`);

  const ct = parseInt(ciclos.rows[0].total) || 0;
  const at = parseInt(andamento.rows[0].total) || 0;
  const tpr = parseInt(ciclos.rows[0].tpr_medio) || 0;
  const tma = parseInt(ciclos.rows[0].tma_medio) || 0;

  return {
    chamados: ct + at, tpr_medio: tpr, tma_medio: tma,
    pendentes: parseInt(pendentes.rows[0].total) || 0,
    em_atendimento: parseInt(emAtendimento.rows[0].total) || 0,
    atendentes_online: parseInt(online.rows[0].total) || 0,
  };
}

async function ticketsPorHora() {
  const resultado = await query(`
    SELECT date_trunc('hour', tc.fechado_em AT TIME ZONE 'America/Bahia') as hora, COUNT(*) as total
    FROM ticket_ciclos tc ${NG_TC}
    WHERE tc.fechado_em >= NOW() - INTERVAL '24 hours' AND ${_hc('tc.fechado_em')}
    GROUP BY 1 ORDER BY 1
  `);
  return resultado.rows;
}

async function ticketsPorDia({ dataInicio, dataFim, usuarioId } = {}) {
  const uCond = usuarioId ? 'AND tc.usuario_id = $3' : '';
  const params = [dataInicio, dataFim];
  if (usuarioId) params.push(usuarioId);
  const resultado = await query(`
    SELECT DATE(tc.fechado_em AT TIME ZONE 'America/Bahia') as dia, COUNT(*) as total,
      ROUND(AVG(tc.tempo_primeira_resposta_seg) FILTER (WHERE tc.tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio
    FROM ticket_ciclos tc ${NG_TC}
    WHERE tc.fechado_em >= $1::DATE AND tc.fechado_em < ($2::DATE + INTERVAL '1 day') AND ${_hc('tc.fechado_em')} ${uCond}
    GROUP BY 1 ORDER BY 1
  `, params);
  return resultado.rows;
}

async function ticketsPorFila() {
  const resultado = await query(`
    SELECT f.nome, f.cor,
      (SELECT COUNT(*) FROM ticket_ciclos tc ${NG_TC} WHERE tc.fila_id = f.id AND tc.fechado_em >= NOW() - INTERVAL '30 days' AND ${_hc('tc.fechado_em')})
      + (SELECT COUNT(*) FROM tickets t ${NG_T} WHERE t.fila_id = f.id AND t.status IN ('pendente','aberto','aguardando') AND t.criado_em >= NOW() - INTERVAL '30 days' AND ${_hc('t.criado_em')}) as total,
      (SELECT COUNT(*) FROM tickets t ${NG_T} WHERE t.fila_id = f.id AND t.status = 'pendente') as pendentes,
      (SELECT COUNT(*) FROM tickets t ${NG_T} WHERE t.fila_id = f.id AND t.status = 'aberto') as abertos
    FROM filas f WHERE f.ativo = TRUE ORDER BY total DESC
  `);
  return resultado.rows;
}

async function performanceAtendentes({ dataInicio, dataFim, usuarioId } = {}) {
  const uCondBase = usuarioId ? `AND u.id = ${parseInt(usuarioId)}` : '';
  const base = await query(`
    SELECT u.id, u.nome, u.avatar_url, u.online,
      (SELECT COUNT(*) FROM tickets t2 ${NG_T.replace('t.contato_id','t2.contato_id')} WHERE t2.usuario_id = u.id AND t2.status IN ('aberto','aguardando')) as tickets_ativos
    FROM usuarios u
    WHERE u.ativo = TRUE AND u.perfil != 'admin' ${uCondBase}
  `);

  const uCond = usuarioId ? 'AND tc.usuario_id = $3' : '';
  const uCondT = usuarioId ? 'AND t.usuario_id = $3' : '';
  const params = [dataInicio, dataFim];
  if (usuarioId) params.push(usuarioId);

  const ciclos = await query(`
    SELECT tc.usuario_id, COUNT(*) as concluidos,
      ROUND(AVG(tc.tempo_primeira_resposta_seg) FILTER (WHERE tc.tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
      ROUND(AVG(tc.tempo_resolucao_seg) FILTER (WHERE tc.tempo_resolucao_seg IS NOT NULL)) as tma_medio
    FROM ticket_ciclos tc ${NG_TC}
    WHERE tc.fechado_em >= $1::DATE AND tc.fechado_em < ($2::DATE + INTERVAL '1 day')
      AND ${_hc('tc.fechado_em')} AND tc.usuario_id IS NOT NULL ${uCond}
    GROUP BY tc.usuario_id
  `, params);

  const andamento = await query(`
    SELECT t.usuario_id, COUNT(*) as total FROM tickets t ${NG_T}
    WHERE t.status IN ('pendente','aberto','aguardando')
      AND t.criado_em >= $1::DATE AND t.criado_em < ($2::DATE + INTERVAL '1 day')
      AND ${_hc('t.criado_em')} AND t.usuario_id IS NOT NULL ${uCondT}
    GROUP BY t.usuario_id
  `, params);

  const cm = {}; for (const r of ciclos.rows) cm[r.usuario_id] = r;
  const am = {}; for (const r of andamento.rows) am[r.usuario_id] = parseInt(r.total);

  return base.rows.map(r => {
    const c = cm[r.id] || {};
    return {
      id: r.id, nome: r.nome, avatar_url: r.avatar_url, online: r.online,
      chamados: (parseInt(c.concluidos) || 0) + (am[r.id] || 0),
      tpr_medio: parseInt(c.tpr_medio) || 0, tma_medio: parseInt(c.tma_medio) || 0,
      tickets_ativos: parseInt(r.tickets_ativos) || 0,
    };
  }).sort((a, b) => b.chamados - a.chamados);
}

async function csatDistribuicao({ dias = 30 } = {}) {
  const resultado = await query(`SELECT avaliacao, COUNT(*) as total FROM tickets WHERE avaliacao IS NOT NULL AND atualizado_em >= NOW() - ($1 || ' days')::INTERVAL GROUP BY avaliacao ORDER BY avaliacao`, [dias]);
  const mediaResult = await query(`SELECT ROUND(AVG(avaliacao), 2) as media, COUNT(*) as total_avaliacoes FROM tickets WHERE avaliacao IS NOT NULL AND atualizado_em >= NOW() - ($1 || ' days')::INTERVAL`, [dias]);
  return { distribuicao: resultado.rows, media: parseFloat(mediaResult.rows[0]?.media) || 0, total: parseInt(mediaResult.rows[0]?.total_avaliacoes) || 0 };
}

async function temposResposta({ dataInicio, dataFim, usuarioId } = {}) {
  const uCond = usuarioId ? 'AND tc.usuario_id = $3' : '';
  const uCondT = usuarioId ? 'AND t.usuario_id = $3' : '';
  const params = [dataInicio, dataFim];
  if (usuarioId) params.push(usuarioId);

  const resultado = await query(`
    SELECT CASE
      WHEN tc.tempo_primeira_resposta_seg < 60 THEN '< 1 min'
      WHEN tc.tempo_primeira_resposta_seg < 300 THEN '1-5 min'
      WHEN tc.tempo_primeira_resposta_seg < 900 THEN '5-15 min'
      WHEN tc.tempo_primeira_resposta_seg < 1800 THEN '15-30 min'
      WHEN tc.tempo_primeira_resposta_seg < 3600 THEN '30-60 min'
      ELSE '> 1 hora'
    END as faixa, COUNT(*) as total
    FROM ticket_ciclos tc ${NG_TC}
    WHERE tc.tempo_primeira_resposta_seg IS NOT NULL
      AND tc.fechado_em >= $1::DATE AND tc.fechado_em < ($2::DATE + INTERVAL '1 day') AND ${_hc('tc.fechado_em')} ${uCond}
    GROUP BY faixa ORDER BY MIN(tc.tempo_primeira_resposta_seg)
  `, params);

  const ativos = await query(`
    SELECT CASE
      WHEN t.tempo_primeira_resposta_seg < 60 THEN '< 1 min'
      WHEN t.tempo_primeira_resposta_seg < 300 THEN '1-5 min'
      WHEN t.tempo_primeira_resposta_seg < 900 THEN '5-15 min'
      WHEN t.tempo_primeira_resposta_seg < 1800 THEN '15-30 min'
      WHEN t.tempo_primeira_resposta_seg < 3600 THEN '30-60 min'
      ELSE '> 1 hora'
    END as faixa, COUNT(*) as total
    FROM tickets t ${NG_T}
    WHERE t.tempo_primeira_resposta_seg IS NOT NULL AND t.status IN ('aberto','aguardando')
      AND t.criado_em >= $1::DATE AND t.criado_em < ($2::DATE + INTERVAL '1 day') AND ${_hc('t.criado_em')} ${uCondT}
    GROUP BY faixa ORDER BY MIN(t.tempo_primeira_resposta_seg)
  `, params);

  const fm = {};
  for (const r of resultado.rows) fm[r.faixa] = parseInt(r.total);
  for (const r of ativos.rows) fm[r.faixa] = (fm[r.faixa] || 0) + parseInt(r.total);
  const ordem = ['< 1 min', '1-5 min', '5-15 min', '15-30 min', '30-60 min', '> 1 hora'];
  return ordem.filter(f => fm[f]).map(f => ({ faixa: f, total: fm[f] }));
}

async function picosAtendimento({ dataInicio, dataFim } = {}) {
  const resultado = await query(`
    SELECT EXTRACT(HOUR FROM t.criado_em AT TIME ZONE 'America/Bahia') as hora,
      COUNT(t.id) as tickets, COUNT(DISTINCT t.usuario_id) as atendentes_ativos,
      ROUND(AVG(t.tempo_primeira_resposta_seg) FILTER (WHERE t.tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
      ROUND(AVG(t.tempo_resolucao_seg) FILTER (WHERE t.tempo_resolucao_seg IS NOT NULL)) as tr_medio
    FROM tickets t ${NG_T}
    WHERE t.criado_em >= $1::DATE AND t.criado_em < ($2::DATE + INTERVAL '1 day') AND ${_hc('t.criado_em')}
    GROUP BY 1 ORDER BY 1
  `, [dataInicio, dataFim]);
  const d1 = new Date(dataFim); const d0 = new Date(dataInicio);
  const totalDias = Math.max(Math.ceil((d1 - d0) / 86400000), 1);
  return resultado.rows.map(r => ({
    hora: parseInt(r.hora), tickets_total: parseInt(r.tickets),
    tickets_media_dia: Math.round(parseInt(r.tickets) / totalDias * 10) / 10,
    atendentes_ativos: parseInt(r.atendentes_ativos),
    tpr_medio: parseInt(r.tpr_medio) || 0, tr_medio: parseInt(r.tr_medio) || 0,
  }));
}

async function volumePorHoraDia({ dias = 30 } = {}) {
  const resultado = await query(`
    SELECT EXTRACT(DOW FROM t.criado_em AT TIME ZONE 'America/Bahia') as dia_semana,
      EXTRACT(HOUR FROM t.criado_em AT TIME ZONE 'America/Bahia') as hora, COUNT(*) as total
    FROM tickets t ${NG_T}
    WHERE t.criado_em >= NOW() - ($1 || ' days')::INTERVAL AND ${_hc('t.criado_em')}
    GROUP BY 1, 2 ORDER BY 1, 2
  `, [dias]);
  return resultado.rows;
}

async function detalheAtendente(userId, { dias = 30 } = {}) {
  const resumo = await query(`SELECT u.id, u.nome, u.avatar_url, u.online, u.email, u.perfil FROM usuarios u WHERE u.id = $1`, [userId]);
  const ativos = await query(`SELECT COUNT(*) as total FROM tickets t ${NG_T} WHERE t.usuario_id = $1 AND t.status IN ('aberto','aguardando')`, [userId]);
  const ciclos = await query(`SELECT COUNT(*) as concluidos, ROUND(AVG(tc.tempo_primeira_resposta_seg) FILTER (WHERE tc.tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio, ROUND(AVG(tc.tempo_resolucao_seg) FILTER (WHERE tc.tempo_resolucao_seg IS NOT NULL)) as tma_medio FROM ticket_ciclos tc ${NG_TC} WHERE tc.usuario_id = $1 AND tc.fechado_em >= NOW() - ($2 || ' days')::INTERVAL AND ${_hc('tc.fechado_em')}`, [userId, dias]);
  const andamento = await query(`SELECT COUNT(*) as total FROM tickets t ${NG_T} WHERE t.usuario_id = $1 AND t.status IN ('pendente','aberto','aguardando') AND t.criado_em >= NOW() - ($2 || ' days')::INTERVAL`, [userId, dias]);
  const porDia = await query(`SELECT DATE(tc.fechado_em AT TIME ZONE 'America/Bahia') as dia, COUNT(*) as total FROM ticket_ciclos tc ${NG_TC} WHERE tc.usuario_id = $1 AND tc.fechado_em >= NOW() - ($2 || ' days')::INTERVAL AND ${_hc('tc.fechado_em')} GROUP BY 1 ORDER BY 1`, [userId, dias]);
  const porHora = await query(`SELECT EXTRACT(HOUR FROM tc.fechado_em AT TIME ZONE 'America/Bahia') as hora, COUNT(*) as total FROM ticket_ciclos tc ${NG_TC} WHERE tc.usuario_id = $1 AND tc.fechado_em >= NOW() - ($2 || ' days')::INTERVAL AND ${_hc('tc.fechado_em')} GROUP BY 1 ORDER BY 1`, [userId, dias]);
  const r = resumo.rows[0] || {}; const c = ciclos.rows[0] || {};
  r.ativos = parseInt(ativos.rows[0]?.total) || 0;
  r.chamados = (parseInt(c.concluidos) || 0) + (parseInt(andamento.rows[0]?.total) || 0);
  r.tpr_medio = parseInt(c.tpr_medio) || 0; r.tma_medio = parseInt(c.tma_medio) || 0;
  return { resumo: r, por_dia: porDia.rows, por_hora: porHora.rows };
}

async function contatosUnicos({ dataInicio, dataFim, usuarioId } = {}) {
  const uCond = usuarioId ? 'AND t.usuario_id = $3' : '';
  const params = [dataInicio, dataFim];
  if (usuarioId) params.push(usuarioId);
  const resultado = await query(`
    SELECT DATE(t.criado_em AT TIME ZONE 'America/Bahia') as dia, COUNT(DISTINCT t.contato_id) as unicos
    FROM tickets t ${NG_T}
    WHERE t.criado_em >= $1::DATE AND t.criado_em < ($2::DATE + INTERVAL '1 day') AND ${_hc('t.criado_em')} ${uCond}
    GROUP BY 1 ORDER BY 1
  `, params);
  const total = await query(`SELECT COUNT(DISTINCT t.contato_id) as total FROM tickets t ${NG_T} WHERE t.criado_em >= $1::DATE AND t.criado_em < ($2::DATE + INTERVAL '1 day') AND ${_hc('t.criado_em')} ${usuarioId ? 'AND t.usuario_id = $3' : ''}`, params);
  return { total: parseInt(total.rows[0].total) || 0, por_dia: resultado.rows };
}

async function temposPorHora({ dataInicio, dataFim, usuarioId } = {}) {
  const uCond = usuarioId ? 'AND tc.usuario_id = $3' : '';
  const params = [dataInicio, dataFim];
  if (usuarioId) params.push(usuarioId);
  const ciclos = await query(`
    SELECT EXTRACT(HOUR FROM tc.fechado_em AT TIME ZONE 'America/Bahia')::int as hora,
      COUNT(*) as chamados,
      ROUND(AVG(tc.tempo_resolucao_seg) FILTER (WHERE tc.tempo_resolucao_seg IS NOT NULL)) as tma_medio,
      ROUND(AVG(tc.tempo_primeira_resposta_seg) FILTER (WHERE tc.tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio
    FROM ticket_ciclos tc ${NG_TC}
    WHERE tc.fechado_em >= $1::DATE AND tc.fechado_em < ($2::DATE + INTERVAL '1 day') AND ${_hc('tc.fechado_em')} ${uCond}
    GROUP BY 1 ORDER BY 1
  `, params);
  const geral = await query(`
    SELECT ROUND(AVG(tc.tempo_resolucao_seg) FILTER (WHERE tc.tempo_resolucao_seg IS NOT NULL)) as tma_geral,
      ROUND(AVG(tc.tempo_primeira_resposta_seg) FILTER (WHERE tc.tempo_primeira_resposta_seg IS NOT NULL)) as tpr_geral
    FROM ticket_ciclos tc ${NG_TC}
    WHERE tc.fechado_em >= $1::DATE AND tc.fechado_em < ($2::DATE + INTERVAL '1 day') AND ${_hc('tc.fechado_em')} ${uCond}
  `, params);
  const horaMap = {};
  for (const r of ciclos.rows) horaMap[parseInt(r.hora)] = r;
  const horas = [];
  for (let h = 8; h <= 18; h++) {
    const r = horaMap[h];
    horas.push({ hora: h, label: `${String(h).padStart(2, '0')}:00`, chamados: r ? parseInt(r.chamados) : 0, tma_medio: r ? parseInt(r.tma_medio) || 0 : 0, tpr_medio: r ? parseInt(r.tpr_medio) || 0 : 0 });
  }
  return { tma_geral: parseInt(geral.rows[0].tma_geral) || 0, tpr_geral: parseInt(geral.rows[0].tpr_geral) || 0, por_hora: horas };
}

async function mensagensPorDia({ dataInicio, dataFim, usuarioId } = {}) {
  const uJoin = usuarioId ? 'JOIN tickets t ON t.id = m.ticket_id AND t.usuario_id = $3' : '';
  const params = [dataInicio, dataFim];
  if (usuarioId) params.push(usuarioId);
  const resultado = await query(`
    SELECT DATE(m.criado_em AT TIME ZONE 'America/Bahia') as dia, COUNT(*) as total,
      COUNT(*) FILTER (WHERE m.is_from_me = TRUE AND m.tipo != 'sistema') as enviadas,
      COUNT(*) FILTER (WHERE m.is_from_me = FALSE) as recebidas
    FROM mensagens m ${uJoin}
    WHERE m.tipo != 'sistema'
      AND m.criado_em >= $1::DATE AND m.criado_em < ($2::DATE + INTERVAL '1 day') AND ${_hc('m.criado_em')}
    GROUP BY 1 ORDER BY 1
  `, params);
  const totais = await query(`
    SELECT COUNT(*) as total,
      COUNT(*) FILTER (WHERE m.is_from_me = TRUE AND m.tipo != 'sistema') as enviadas,
      COUNT(*) FILTER (WHERE m.is_from_me = FALSE) as recebidas
    FROM mensagens m ${uJoin}
    WHERE m.tipo != 'sistema'
      AND m.criado_em >= $1::DATE AND m.criado_em < ($2::DATE + INTERVAL '1 day') AND ${_hc('m.criado_em')}
  `, params);
  return {
    total: parseInt(totais.rows[0].total) || 0,
    enviadas: parseInt(totais.rows[0].enviadas) || 0,
    recebidas: parseInt(totais.rows[0].recebidas) || 0,
    por_dia: resultado.rows,
  };
}

async function picosHorario({ dataInicio, dataFim, usuarioId } = {}) {
  const uCond = usuarioId ? 'AND tc.usuario_id = $3' : '';
  const uCondT = usuarioId ? 'AND t.usuario_id = $3' : '';
  const params = [dataInicio, dataFim];
  if (usuarioId) params.push(usuarioId);
  const ciclosAbertos = await query(`
    SELECT EXTRACT(HOUR FROM tc.aberto_em AT TIME ZONE 'America/Bahia')::int as hora, COUNT(*) as total
    FROM ticket_ciclos tc ${NG_TC}
    WHERE tc.aberto_em >= $1::DATE AND tc.aberto_em < ($2::DATE + INTERVAL '1 day') AND ${_hc('tc.aberto_em')} ${uCond}
    GROUP BY 1
  `, params);
  const ativos = await query(`
    SELECT EXTRACT(HOUR FROM t.criado_em AT TIME ZONE 'America/Bahia')::int as hora, COUNT(*) as total
    FROM tickets t ${NG_T}
    WHERE t.status IN ('pendente','aberto','aguardando')
      AND t.criado_em >= $1::DATE AND t.criado_em < ($2::DATE + INTERVAL '1 day') AND ${_hc('t.criado_em')} ${uCondT}
    GROUP BY 1
  `, params);
  const ciclosMeta = await query(`
    SELECT EXTRACT(HOUR FROM tc.fechado_em AT TIME ZONE 'America/Bahia')::int as hora,
      ROUND(AVG(tc.tempo_primeira_resposta_seg) FILTER (WHERE tc.tempo_primeira_resposta_seg IS NOT NULL)) as tpr_medio,
      COUNT(DISTINCT tc.usuario_id) as atendentes
    FROM ticket_ciclos tc ${NG_TC}
    WHERE tc.fechado_em >= $1::DATE AND tc.fechado_em < ($2::DATE + INTERVAL '1 day') AND ${_hc('tc.fechado_em')} ${uCond}
    GROUP BY 1
  `, params);
  const cMap = {}; for (const r of ciclosAbertos.rows) cMap[parseInt(r.hora)] = parseInt(r.total);
  const aMap = {}; for (const r of ativos.rows) aMap[parseInt(r.hora)] = parseInt(r.total);
  const mMap = {}; for (const r of ciclosMeta.rows) mMap[parseInt(r.hora)] = r;
  const horas = [];
  for (let h = 8; h <= 18; h++) {
    const m = mMap[h];
    horas.push({
      hora: h, label: `${String(h).padStart(2, '0')}:00`,
      chamados: (cMap[h] || 0) + (aMap[h] || 0), concluidos: cMap[h] || 0,
      tpr_medio: m ? parseInt(m.tpr_medio) || 0 : 0, atendentes: m ? parseInt(m.atendentes) : 0,
    });
  }
  return horas;
}

async function listarAtendentes() {
  const resultado = await query(`SELECT id, nome, avatar_url, online FROM usuarios WHERE ativo = TRUE AND perfil != 'admin' ORDER BY nome`);
  return resultado.rows;
}

module.exports = { obterDashboard, ticketsPorHora, ticketsPorDia, ticketsPorFila, performanceAtendentes, csatDistribuicao, temposResposta, picosAtendimento, detalheAtendente, volumePorHoraDia, contatosUnicos, temposPorHora, mensagensPorDia, picosHorario, listarAtendentes };
