// Service — módulo IA
// Prompt builder dinâmico, CRUD de contexto, aprendizado automático

const { query } = require('../../config/database');
const logger = require('../../shared/logger');

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// ============================================================
// PROMPT BUILDER — monta system prompt dinâmico por chamada
// ============================================================

async function construirSystemPrompt({ tipo = 'sugestao', mensagensRecentes = [], tagAtual = null }) {
  const partes = [];

  // 1. Instruções do admin
  const instrucoes = await query(
    `SELECT conteudo FROM ia_instrucoes WHERE ativo = TRUE ORDER BY ordem ASC`
  );
  if (instrucoes.rows.length > 0) {
    partes.push('## Instruções\n' + instrucoes.rows.map(r => r.conteudo).join('\n'));
  }

  // 2. Base de conhecimento relevante
  const conhecimento = await query(
    `SELECT categoria, pergunta, resposta FROM ia_conhecimento WHERE ativo = TRUE ORDER BY categoria, id`
  );
  if (conhecimento.rows.length > 0) {
    partes.push('## Base de conhecimento\n' + conhecimento.rows.map(r =>
      `[${r.categoria || 'Geral'}] P: ${r.pergunta}\nR: ${r.resposta}`
    ).join('\n\n'));
  }

  // 3. Exemplos aprovados (top 10 mais relevantes por qualidade)
  let exemplosQuery = `SELECT pergunta_contato, resposta_atendente, tag, qualidade
    FROM ia_exemplos WHERE aprovado = TRUE`;
  const exemplosParams = [];

  if (tagAtual) {
    exemplosQuery += ` AND (tag = $1 OR tag IS NULL)`;
    exemplosParams.push(tagAtual);
  }

  exemplosQuery += ` ORDER BY qualidade DESC, id DESC LIMIT 10`;
  const exemplos = await query(exemplosQuery, exemplosParams);

  if (exemplos.rows.length > 0) {
    partes.push('## Exemplos de boas respostas\n' + exemplos.rows.map(r =>
      `Contato: "${r.pergunta_contato}"\nResposta: "${r.resposta_atendente}"${r.tag ? ` [${r.tag}]` : ''}`
    ).join('\n\n'));
  }

  // 4. Regras de tags (para classificação)
  if (tipo === 'classificacao' || tipo === 'sugestao') {
    const regras = await query(
      `SELECT tag, palavras_chave, descricao FROM ia_tags_regras WHERE ativo = TRUE ORDER BY acertos DESC`
    );
    if (regras.rows.length > 0) {
      partes.push('## Tags disponíveis para classificação\n' + regras.rows.map(r =>
        `- ${r.tag}: ${r.descricao || ''} (palavras-chave: ${r.palavras_chave})`
      ).join('\n'));
    }
  }

  // 5. Prompt base por tipo
  const promptBase = {
    sugestao: `Você é um assistente de atendimento ao cliente via WhatsApp.
Analise a conversa e sugira 2-3 respostas curtas e diretas que o atendente pode enviar.
Responda APENAS em JSON: {"sugestoes": ["resposta 1", "resposta 2", "resposta 3"]}
Sem markdown, sem explicação, só o JSON.`,

    resumo: `Você é um assistente que resume conversas de atendimento.
Gere um resumo conciso da conversa em 2-3 frases curtas.
Responda APENAS em JSON: {"resumo": "texto do resumo", "sentimento": "positivo|neutro|negativo", "tags_sugeridas": ["tag1"]}`,

    classificacao: `Você é um classificador de atendimentos.
Analise a conversa e classifique com a tag mais adequada da lista fornecida.
Responda APENAS em JSON: {"tag": "nome_da_tag", "confianca": 0.95, "justificativa": "motivo curto"}`,

    melhoria: `Você é um assistente que melhora textos de atendimento.
Reescreva o texto do atendente de forma mais profissional e empática, mantendo o sentido.
Responda APENAS em JSON: {"texto_melhorado": "texto reescrito"}`,

    sentimento: `Você é um analisador de sentimento de conversas de atendimento.
Analise as mensagens do contato e classifique o sentimento geral.
Responda APENAS em JSON: {"sentimento": "positivo|neutro|negativo", "confianca": 0.95, "resumo": "motivo curto"}`,
  };

  const systemPrompt = [
    promptBase[tipo] || promptBase.sugestao,
    ...partes,
  ].join('\n\n');

  return systemPrompt;
}

// ============================================================
// CHAMADAS À IA (Gemini)
// ============================================================

async function chamarGemini(systemPrompt, userMessage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger.warn('[IA] GEMINI_API_KEY não configurada');
    return null;
  }

  try {
    const resp = await fetch(`${GEMINI_API}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userMessage }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 1000,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      logger.error({ status: resp.status, err }, '[IA] Erro API Gemini');
      return null;
    }

    const data = await resp.json();
    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    try {
      const jsonMatch = texto.match(/\{[\s\S]*\}/);
      return jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: texto };
    } catch {
      return { raw: texto };
    }
  } catch (err) {
    logger.error({ err: err.message }, '[IA] Erro ao chamar Gemini');
    return null;
  }
}

// Sugestão de resposta
async function sugerirResposta(ticketId, mensagemCliente) {
  const msgs = await query(
    `SELECT corpo, is_from_me, criado_em FROM mensagens
     WHERE ticket_id = $1 AND deletada = FALSE
     ORDER BY id DESC LIMIT 15`,
    [ticketId]
  );

  if (msgs.rows.length === 0 && !mensagemCliente) return { sugestoes: [] };

  let conversa = msgs.rows.reverse().map(m =>
    `${m.is_from_me ? 'Atendente' : 'Contato'}: ${m.corpo}`
  ).join('\n');

  // Se veio mensagem_cliente explícita, adicionar ao final
  if (mensagemCliente) {
    conversa += `\nContato: ${mensagemCliente}`;
  }

  const systemPrompt = await construirSystemPrompt({ tipo: 'sugestao', mensagensRecentes: msgs.rows });
  const resultado = await chamarGemini(systemPrompt, `Conversa:\n${conversa}`);

  return resultado || { sugestoes: [] };
}

// Resumo do ticket
async function resumirTicket(ticketId) {
  const msgs = await query(
    `SELECT corpo, is_from_me, criado_em FROM mensagens
     WHERE ticket_id = $1 AND deletada = FALSE
     ORDER BY id ASC LIMIT 30`,
    [ticketId]
  );

  if (msgs.rows.length === 0) return { resumo: 'Sem mensagens' };

  const conversa = msgs.rows.map(m =>
    `${m.is_from_me ? 'Atendente' : 'Contato'}: ${m.corpo}`
  ).join('\n');

  const systemPrompt = await construirSystemPrompt({ tipo: 'resumo' });
  const resultado = await chamarGemini(systemPrompt, `Conversa:\n${conversa}`);

  return resultado || { resumo: 'Não foi possível gerar resumo' };
}

// Classificar ticket (sugerir tag)
async function classificarTicket(ticketId) {
  const msgs = await query(
    `SELECT corpo, is_from_me FROM mensagens
     WHERE ticket_id = $1 AND deletada = FALSE AND is_from_me = FALSE
     ORDER BY id ASC LIMIT 10`,
    [ticketId]
  );

  if (msgs.rows.length === 0) return { tag: null };

  const textoContato = msgs.rows.map(m => m.corpo).join('\n');
  const systemPrompt = await construirSystemPrompt({ tipo: 'classificacao' });
  const resultado = await chamarGemini(systemPrompt, `Mensagens do contato:\n${textoContato}`);

  return resultado || { tag: null };
}

// Melhorar texto do atendente
async function melhorarTexto(texto) {
  const systemPrompt = await construirSystemPrompt({ tipo: 'melhoria' });
  const resultado = await chamarGemini(systemPrompt, `Texto original: "${texto}"`);
  return resultado || { texto_melhorado: texto };
}

// Analisar sentimento do contato
async function analisarSentimento(ticketId) {
  const msgs = await query(
    `SELECT corpo, is_from_me FROM mensagens
     WHERE ticket_id = $1 AND deletada = FALSE AND is_from_me = FALSE
     ORDER BY id DESC LIMIT 10`,
    [ticketId]
  );

  if (msgs.rows.length === 0) return { sentimento: 'neutro', confianca: 0, resumo: 'Sem mensagens do contato' };

  const textoContato = msgs.rows.reverse().map(m => m.corpo).join('\n');
  const systemPrompt = await construirSystemPrompt({ tipo: 'sentimento' });
  const resultado = await chamarGemini(systemPrompt, `Mensagens do contato:\n${textoContato}`);

  return resultado || { sentimento: 'neutro', confianca: 0 };
}

// ============================================================
// FEEDBACK — atendente aprova/rejeita sugestão
// ============================================================

async function registrarFeedback({ exemploId, aprovado, respostaCorrigida }) {
  if (exemploId) {
    await query(
      `UPDATE ia_exemplos SET aprovado = $1, rejeitado = $2, resposta_atendente = COALESCE($3, resposta_atendente) WHERE id = $4`,
      [aprovado, !aprovado, respostaCorrigida || null, exemploId]
    );
  }

  // Se aprovado e tem tag, incrementar acerto da regra
  if (aprovado) {
    const exemplo = await query(`SELECT tag FROM ia_exemplos WHERE id = $1`, [exemploId]);
    if (exemplo.rows[0]?.tag) {
      await query(
        `UPDATE ia_tags_regras SET acertos = acertos + 1 WHERE tag = $1`,
        [exemplo.rows[0].tag]
      );
    }
  }

  return { sucesso: true };
}

// ============================================================
// CRON — aprendizado automático de tickets fechados
// ============================================================

async function aprenderDeTicketsFechados() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return;

  // Buscar tickets fechados nas últimas 24h que ainda não foram processados
  const tickets = await query(
    `SELECT t.id, t.assunto
     FROM tickets t
     WHERE t.status IN ('fechado', 'resolvido')
       AND t.atualizado_em > NOW() - INTERVAL '24 hours'
       AND t.id NOT IN (SELECT DISTINCT ticket_id FROM ia_exemplos WHERE ticket_id IS NOT NULL)
     ORDER BY t.atualizado_em DESC
     LIMIT 10`
  );

  if (tickets.rows.length === 0) {
    logger.info('[IA Cron] Nenhum ticket novo para aprender');
    return;
  }

  let processados = 0;

  for (const ticket of tickets.rows) {
    try {
      // Buscar mensagens do ticket (APENAS mensagens reais, sem sistema/internas)
      const msgs = await query(
        `SELECT corpo, is_from_me FROM mensagens
         WHERE ticket_id = $1 AND deletada = FALSE
           AND tipo != 'sistema'
           AND is_internal = FALSE
           AND corpo IS NOT NULL
           AND corpo != ''
           AND corpo NOT LIKE '%finalizou o chamado%'
           AND corpo NOT LIKE '%visualizou o chamado%'
           AND corpo NOT LIKE '%atribuído%'
           AND corpo NOT LIKE '%transferi%'
         ORDER BY id ASC`,
        [ticket.id]
      );

      if (msgs.rows.length < 2) continue;

      // Agrupar mensagens consecutivas do mesmo remetente em blocos
      // Ex: [C:"oi", C:"quero saber", C:"do meu saque", A:"Bom dia! Seu saldo..."]
      // Vira: [{from:'contato', texto:'oi\nquero saber\ndo meu saque'}, {from:'atendente', texto:'Bom dia!...'}]
      const blocos = [];
      let blocoAtual = { fromMe: msgs.rows[0].is_from_me, partes: [msgs.rows[0].corpo] };

      for (let i = 1; i < msgs.rows.length; i++) {
        if (msgs.rows[i].is_from_me === blocoAtual.fromMe) {
          blocoAtual.partes.push(msgs.rows[i].corpo);
        } else {
          blocos.push({ fromMe: blocoAtual.fromMe, texto: blocoAtual.partes.filter(Boolean).join('\n') });
          blocoAtual = { fromMe: msgs.rows[i].is_from_me, partes: [msgs.rows[i].corpo] };
        }
      }
      blocos.push({ fromMe: blocoAtual.fromMe, texto: blocoAtual.partes.filter(Boolean).join('\n') });

      // Extrair pares bloco-contato → bloco-atendente
      const pares = [];
      for (let i = 0; i < blocos.length - 1; i++) {
        const bloco = blocos[i];
        const next = blocos[i + 1];
        if (!bloco.fromMe && next.fromMe
            && bloco.texto?.length > 10
            && next.texto?.length > 15
            && !next.texto.startsWith('http')
            && !bloco.texto.match(/^(oi|olá|bom dia|boa tarde|boa noite|ok|tá|sim|não)[\s!?.]*$/i)
        ) {
          pares.push({ pergunta: bloco.texto, resposta: next.texto });
        }
      }

      if (pares.length === 0) continue;

      // Classificar qualidade de cada par via Gemini
      const systemPrompt = `Classifique a qualidade desta resposta de atendimento.
Nota 1-5 (1=ruim, 5=excelente). Considere: clareza, empatia, resolução.
Se possível, sugira uma tag de classificação.
Responda APENAS em JSON: {"qualidade": 4, "tag": "suporte_tecnico"}`;

      for (const par of pares.slice(0, 3)) { // Max 3 pares por ticket
        const resultado = await chamarGemini(
          systemPrompt,
          `Contato: "${par.pergunta}"\nResposta: "${par.resposta}"`
        );

        const qualidade = resultado?.qualidade || 3;
        const tag = resultado?.tag || null;

        await query(
          `INSERT INTO ia_exemplos (ticket_id, pergunta_contato, resposta_atendente, qualidade, tag, origem)
           VALUES ($1, $2, $3, $4, $5, 'auto')
           ON CONFLICT DO NOTHING`,
          [ticket.id, par.pergunta.substring(0, 500), par.resposta.substring(0, 1000), qualidade, tag]
        );
      }

      processados++;
    } catch (err) {
      logger.error({ err: err.message, ticketId: ticket.id }, '[IA Cron] Erro ao processar ticket');
    }
  }

  logger.info({ processados, total: tickets.rows.length }, '[IA Cron] Aprendizado concluído');
}

// ============================================================
// CRUD — instruções
// ============================================================

async function listarInstrucoes() {
  const r = await query(`SELECT * FROM ia_instrucoes ORDER BY ordem ASC, id ASC`);
  return r.rows;
}
async function criarInstrucao({ titulo, conteudo, ordem }) {
  const r = await query(
    `INSERT INTO ia_instrucoes (titulo, conteudo, ordem) VALUES ($1, $2, $3) RETURNING *`,
    [titulo, conteudo, ordem || 0]
  );
  return r.rows[0];
}
async function atualizarInstrucao(id, { titulo, conteudo, ativo, ordem }) {
  const r = await query(
    `UPDATE ia_instrucoes SET titulo = COALESCE($1, titulo), conteudo = COALESCE($2, conteudo),
     ativo = COALESCE($3, ativo), ordem = COALESCE($4, ordem), atualizado_em = NOW()
     WHERE id = $5 RETURNING *`,
    [titulo, conteudo, ativo, ordem, id]
  );
  return r.rows[0];
}
async function deletarInstrucao(id) {
  await query(`DELETE FROM ia_instrucoes WHERE id = $1`, [id]);
}

// ============================================================
// CRUD — conhecimento
// ============================================================

async function listarConhecimento({ categoria } = {}) {
  let sql = `SELECT * FROM ia_conhecimento`;
  const params = [];
  if (categoria) { sql += ` WHERE categoria = $1`; params.push(categoria); }
  sql += ` ORDER BY categoria, id`;
  const r = await query(sql, params);
  return r.rows;
}
async function criarConhecimento({ categoria, pergunta, resposta }) {
  const r = await query(
    `INSERT INTO ia_conhecimento (categoria, pergunta, resposta) VALUES ($1, $2, $3) RETURNING *`,
    [categoria || 'Geral', pergunta, resposta]
  );
  return r.rows[0];
}
async function atualizarConhecimento(id, { categoria, pergunta, resposta, ativo }) {
  const r = await query(
    `UPDATE ia_conhecimento SET categoria = COALESCE($1, categoria), pergunta = COALESCE($2, pergunta),
     resposta = COALESCE($3, resposta), ativo = COALESCE($4, ativo), atualizado_em = NOW()
     WHERE id = $5 RETURNING *`,
    [categoria, pergunta, resposta, ativo, id]
  );
  return r.rows[0];
}
async function deletarConhecimento(id) {
  await query(`DELETE FROM ia_conhecimento WHERE id = $1`, [id]);
}

// ============================================================
// CRUD — exemplos
// ============================================================

async function listarExemplos({ aprovado, tag, limite = 50 } = {}) {
  let sql = `SELECT * FROM ia_exemplos`;
  const conds = [];
  const params = [];
  let idx = 1;
  if (aprovado !== undefined) { conds.push(`aprovado = $${idx++}`); params.push(aprovado); }
  if (tag) { conds.push(`tag = $${idx++}`); params.push(tag); }
  if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
  sql += ` ORDER BY criado_em DESC LIMIT $${idx}`;
  params.push(limite);
  const r = await query(sql, params);
  return r.rows;
}

async function aprovarExemplo(id, { aprovado, resposta_corrigida }) {
  const r = await query(
    `UPDATE ia_exemplos SET aprovado = $1, rejeitado = $2,
     resposta_atendente = COALESCE($3, resposta_atendente)
     WHERE id = $4 RETURNING *`,
    [aprovado, !aprovado, resposta_corrigida || null, id]
  );
  return r.rows[0];
}

async function deletarExemplo(id) {
  await query(`DELETE FROM ia_exemplos WHERE id = $1`, [id]);
}

// ============================================================
// CRUD — regras de tags
// ============================================================

async function listarTagsRegras() {
  const r = await query(`SELECT * FROM ia_tags_regras ORDER BY acertos DESC, tag ASC`);
  return r.rows;
}
async function criarTagRegra({ tag, palavras_chave, descricao, cor }) {
  const r = await query(
    `INSERT INTO ia_tags_regras (tag, palavras_chave, descricao, cor) VALUES ($1, $2, $3, $4) RETURNING *`,
    [tag, palavras_chave, descricao || '', cor || '#7c3aed']
  );
  return r.rows[0];
}
async function atualizarTagRegra(id, { tag, palavras_chave, descricao, cor, ativo }) {
  const r = await query(
    `UPDATE ia_tags_regras SET tag = COALESCE($1, tag), palavras_chave = COALESCE($2, palavras_chave),
     descricao = COALESCE($3, descricao), cor = COALESCE($4, cor), ativo = COALESCE($5, ativo)
     WHERE id = $6 RETURNING *`,
    [tag, palavras_chave, descricao, cor, ativo, id]
  );
  return r.rows[0];
}
async function deletarTagRegra(id) {
  await query(`DELETE FROM ia_tags_regras WHERE id = $1`, [id]);
}

// ============================================================
// STATS
// ============================================================

async function obterStats() {
  const [instrucoes, conhecimento, exemplos, exemplosPendentes, tags] = await Promise.all([
    query(`SELECT COUNT(*) as total FROM ia_instrucoes WHERE ativo = TRUE`),
    query(`SELECT COUNT(*) as total FROM ia_conhecimento WHERE ativo = TRUE`),
    query(`SELECT COUNT(*) as total FROM ia_exemplos WHERE aprovado = TRUE`),
    query(`SELECT COUNT(*) as total FROM ia_exemplos WHERE aprovado = FALSE AND rejeitado = FALSE`),
    query(`SELECT COUNT(*) as total FROM ia_tags_regras WHERE ativo = TRUE`),
  ]);
  return {
    instrucoes: parseInt(instrucoes.rows[0].total),
    conhecimento: parseInt(conhecimento.rows[0].total),
    exemplos_aprovados: parseInt(exemplos.rows[0].total),
    exemplos_pendentes: parseInt(exemplosPendentes.rows[0].total),
    tags_regras: parseInt(tags.rows[0].total),
    api_configurada: !!process.env.GEMINI_API_KEY,
  };
}

module.exports = {
  // IA calls
  sugerirResposta, resumirTicket, classificarTicket, melhorarTexto, analisarSentimento,
  registrarFeedback, construirSystemPrompt,
  // Cron
  aprenderDeTicketsFechados,
  // CRUD instrucoes
  listarInstrucoes, criarInstrucao, atualizarInstrucao, deletarInstrucao,
  // CRUD conhecimento
  listarConhecimento, criarConhecimento, atualizarConhecimento, deletarConhecimento,
  // CRUD exemplos
  listarExemplos, aprovarExemplo, deletarExemplo,
  // CRUD tags regras
  listarTagsRegras, criarTagRegra, atualizarTagRegra, deletarTagRegra,
  // Stats
  obterStats,
};
