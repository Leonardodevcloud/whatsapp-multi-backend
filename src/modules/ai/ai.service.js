// src/modules/ai/ai.service.js
// Serviço de IA — Claude API para sugestões, resumo, classificação e sentimento

const { query } = require('../../config/database');
const { cacheGet, cacheSet } = require('../../config/redis');
const AppError = require('../../shared/AppError');
const logger = require('../../shared/logger');

const AI_API_URL = 'https://api.anthropic.com/v1/messages';
const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const AI_API_KEY = process.env.AI_API_KEY;
const MAX_CHAMADAS_POR_MINUTO = 30;

// Rate limiter simples em memória
let chamadasNoMinuto = 0;
setInterval(() => { chamadasNoMinuto = 0; }, 60000);

/**
 * Chamar Claude API
 */
async function chamarClaude({ systemPrompt, userPrompt, maxTokens = 500 }) {
  if (!AI_API_KEY) {
    throw new AppError('API Key de IA não configurada', 503);
  }

  if (chamadasNoMinuto >= MAX_CHAMADAS_POR_MINUTO) {
    throw new AppError('Limite de chamadas à IA atingido. Aguarde.', 429);
  }

  chamadasNoMinuto++;

  try {
    const response = await fetch(AI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AI_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const erro = await response.text();
      logger.error({ status: response.status, erro }, '[AI] Erro na API Claude');
      throw new AppError('Falha na chamada à IA', 502);
    }

    const data = await response.json();
    return data.content?.[0]?.text || '';
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error({ err }, '[AI] Erro ao chamar Claude');
    throw new AppError('Erro ao processar com IA', 500);
  }
}

/**
 * Buscar contexto do sistema (prompt personalizável)
 */
async function obterSystemPrompt() {
  try {
    const resultado = await query(
      `SELECT valor FROM configuracoes WHERE chave = 'ia_system_prompt'`
    );
    if (resultado.rows.length > 0) return resultado.rows[0].valor;
  } catch { /* ignore */ }

  return `Você é um assistente de atendimento ao cliente profissional e empático.
Sua empresa opera no setor de logística e entregas.
Responda de forma clara, educada e objetiva. Use português brasileiro.
Não invente informações que você não sabe. Se não souber, sugira que o atendente verifique.`;
}

/**
 * Buscar últimas N mensagens de um ticket para contexto
 */
async function buscarContextoMensagens(ticketId, limite = 10) {
  const resultado = await query(
    `SELECT m.corpo, m.is_from_me, m.tipo, m.is_internal, m.criado_em,
            CASE WHEN m.is_from_me THEN u.nome ELSE c.nome END as remetente
     FROM mensagens m
     LEFT JOIN usuarios u ON u.id = m.usuario_id
     LEFT JOIN contatos c ON c.id = m.contato_id
     WHERE m.ticket_id = $1 AND m.tipo IN ('texto', 'sistema') AND m.is_internal = FALSE
     ORDER BY m.id DESC LIMIT $2`,
    [ticketId, limite]
  );

  return resultado.rows.reverse().map((m) => {
    const papel = m.is_from_me ? 'Atendente' : 'Cliente';
    return `[${papel}${m.remetente ? ` (${m.remetente})` : ''}]: ${m.corpo}`;
  }).join('\n');
}

/**
 * Gerar sugestão de resposta para o atendente
 */
async function gerarSugestao(ticketId) {
  // Cache — evitar chamadas duplicadas (TTL 5min)
  const cacheKey = `ai:sugestao:${ticketId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const systemPrompt = await obterSystemPrompt();
  const contexto = await buscarContextoMensagens(ticketId, 10);

  if (!contexto) {
    return { sugestao: '' };
  }

  const userPrompt = `Com base na conversa abaixo, sugira UMA resposta curta e profissional que o atendente pode enviar ao cliente.
Apenas a resposta, sem explicações ou prefixos.

Conversa:
${contexto}

Sugestão de resposta:`;

  const sugestao = await chamarClaude({ systemPrompt, userPrompt, maxTokens: 300 });
  const resultado = { sugestao: sugestao.trim() };

  await cacheSet(cacheKey, resultado, 300); // 5 min
  return resultado;
}

/**
 * Gerar resumo do ticket
 */
async function gerarResumo(ticketId) {
  const cacheKey = `ai:resumo:${ticketId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const contexto = await buscarContextoMensagens(ticketId, 30);

  if (!contexto) {
    return { resumo: 'Sem mensagens para resumir.' };
  }

  const userPrompt = `Resuma a conversa abaixo em 2-3 frases objetivas, destacando o problema principal e o status atual.

Conversa:
${contexto}

Resumo:`;

  const resumo = await chamarClaude({
    systemPrompt: 'Você é um assistente que faz resumos objetivos de conversas de atendimento.',
    userPrompt,
    maxTokens: 200,
  });

  const resultado = { resumo: resumo.trim() };
  await cacheSet(cacheKey, resultado, 600); // 10 min
  return resultado;
}

/**
 * Classificar ticket em uma fila com base na primeira mensagem
 */
async function classificarFila(ticketId) {
  // Buscar primeira mensagem do cliente
  const msgResult = await query(
    `SELECT corpo FROM mensagens WHERE ticket_id = $1 AND is_from_me = FALSE ORDER BY id ASC LIMIT 1`,
    [ticketId]
  );

  if (msgResult.rows.length === 0) return { filaId: null, filaNome: null };

  // Buscar filas disponíveis
  const filasResult = await query(`SELECT id, nome, descricao FROM filas WHERE ativo = TRUE ORDER BY ordem`);
  const filas = filasResult.rows;

  if (filas.length <= 1) return { filaId: filas[0]?.id || null, filaNome: filas[0]?.nome || null };

  const listaFilas = filas.map((f) => `- ${f.nome}${f.descricao ? `: ${f.descricao}` : ''}`).join('\n');

  const userPrompt = `Com base na mensagem do cliente, classifique em qual fila de atendimento ela deve ser direcionada.
Responda APENAS com o nome exato da fila, nada mais.

Filas disponíveis:
${listaFilas}

Mensagem do cliente:
"${msgResult.rows[0].corpo}"

Fila:`;

  const resposta = await chamarClaude({
    systemPrompt: 'Você classifica mensagens em filas de atendimento. Responda apenas com o nome da fila.',
    userPrompt,
    maxTokens: 50,
  });

  const nomeResposta = resposta.trim().toLowerCase();
  const filaEncontrada = filas.find((f) =>
    f.nome.toLowerCase() === nomeResposta || nomeResposta.includes(f.nome.toLowerCase())
  );

  if (filaEncontrada) {
    // Atualizar ticket
    await query(`UPDATE tickets SET fila_id = $1, atualizado_em = NOW() WHERE id = $2`, [filaEncontrada.id, ticketId]);
    logger.info({ ticketId, fila: filaEncontrada.nome }, '[AI] Ticket classificado');
    return { filaId: filaEncontrada.id, filaNome: filaEncontrada.nome };
  }

  return { filaId: null, filaNome: null };
}

/**
 * Detectar sentimento do cliente
 */
async function detectarSentimento(ticketId) {
  const cacheKey = `ai:sentimento:${ticketId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  // Últimas 5 mensagens do cliente
  const resultado = await query(
    `SELECT corpo FROM mensagens WHERE ticket_id = $1 AND is_from_me = FALSE AND tipo = 'texto'
     ORDER BY id DESC LIMIT 5`,
    [ticketId]
  );

  if (resultado.rows.length === 0) return { sentimento: 'neutro', confianca: 0 };

  const mensagens = resultado.rows.reverse().map((m) => m.corpo).join('\n');

  const userPrompt = `Analise o sentimento das mensagens do cliente abaixo.
Responda APENAS em JSON: {"sentimento": "positivo|neutro|negativo", "confianca": 0.0-1.0}

Mensagens:
${mensagens}

JSON:`;

  const resposta = await chamarClaude({
    systemPrompt: 'Você analisa sentimento de texto. Responda apenas em JSON válido.',
    userPrompt,
    maxTokens: 50,
  });

  try {
    const limpo = resposta.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(limpo);
    const resultado_final = {
      sentimento: ['positivo', 'neutro', 'negativo'].includes(parsed.sentimento) ? parsed.sentimento : 'neutro',
      confianca: Math.min(Math.max(parseFloat(parsed.confianca) || 0.5, 0), 1),
    };
    await cacheSet(cacheKey, resultado_final, 300);
    return resultado_final;
  } catch {
    return { sentimento: 'neutro', confianca: 0.5 };
  }
}

/**
 * Verificar se IA está ativa
 */
async function iaEstaAtiva() {
  try {
    const resultado = await query(`SELECT valor FROM configuracoes WHERE chave = 'ia_ativa'`);
    return resultado.rows[0]?.valor === 'true';
  } catch {
    return false;
  }
}

module.exports = {
  gerarSugestao,
  gerarResumo,
  classificarFila,
  detectarSentimento,
  iaEstaAtiva,
};
