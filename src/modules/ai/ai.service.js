// src/modules/ai/ai.service.js
// Serviço de IA — Gemini API para sugestões, resumo, classificação e sentimento

const { query } = require('../../config/database');
const { cacheGet, cacheSet } = require('../../config/redis');
const AppError = require('../../shared/AppError');
const logger = require('../../shared/logger');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
const MAX_CHAMADAS_POR_MINUTO = 30;

// Rate limiter simples em memória
let chamadasNoMinuto = 0;
setInterval(() => { chamadasNoMinuto = 0; }, 60000);

/**
 * Chamar Gemini API
 */
async function chamarClaude({ systemPrompt, userPrompt, maxTokens = 500 }) {
  if (!GEMINI_API_KEY) {
    throw new AppError('GEMINI_API_KEY não configurada', 503);
  }

  if (chamadasNoMinuto >= MAX_CHAMADAS_POR_MINUTO) {
    throw new AppError('Limite de chamadas à IA atingido. Aguarde.', 429);
  }

  chamadasNoMinuto++;

  try {
    const response = await fetch(GEMINI_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
      }),
    });

    if (!response.ok) {
      const erro = await response.text();
      logger.error({ status: response.status, erro }, '[AI] Erro na API Gemini');
      throw new AppError('Falha na chamada à IA', 502);
    }

    const data = await response.json();
    const texto = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return texto.trim();
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error({ err: err.message }, '[AI] Erro ao chamar Gemini');
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
async function buscarContextoMensagens(ticketId, limite = 15) {
  const resultado = await query(
    `SELECT m.corpo, m.is_from_me, m.tipo, m.is_internal, m.criado_em, m.nome_participante,
            CASE WHEN m.is_from_me THEN u.nome ELSE c.nome END as remetente
     FROM mensagens m
     LEFT JOIN usuarios u ON u.id = m.usuario_id
     LEFT JOIN contatos c ON c.id = m.contato_id
     WHERE m.ticket_id = $1 AND m.is_internal = FALSE AND m.tipo != 'sistema'
     ORDER BY m.id DESC LIMIT $2`,
    [ticketId, limite]
  );

  return resultado.rows.reverse().map((m) => {
    const papel = m.is_from_me ? 'Atendente' : 'Cliente';
    const nome = m.nome_participante || m.remetente || '';
    const conteudo = m.corpo || `[${m.tipo}]`;
    return `[${papel}${nome ? ` (${nome})` : ''}]: ${conteudo}`;
  }).join('\n');
}

/**
 * Gerar sugestão de resposta para o atendente
 */
async function gerarSugestao(ticketId) {
  const cacheKey = `ai:sugestao:${ticketId}`;
  const cached = await cacheGet(cacheKey);
  if (cached && cached.sugestao) return cached; // Só usar cache se tem sugestão real

  const systemPrompt = await obterSystemPrompt();
  const contexto = await buscarContextoMensagens(ticketId, 15);

  if (!contexto || contexto.trim().length < 5) {
    return { sugestao: 'Ainda não há mensagens suficientes para gerar uma sugestão.' };
  }

  const userPrompt = `Com base na conversa abaixo entre atendente e cliente, sugira UMA resposta curta, profissional e empática que o atendente pode enviar ao cliente.
A resposta deve ser direta e pronta para enviar, sem explicações, prefixos ou aspas.
Se a conversa não tiver contexto suficiente, sugira uma saudação apropriada.

Conversa:
${contexto}

Sugestão de resposta:`;

  const sugestao = await chamarClaude({ systemPrompt, userPrompt, maxTokens: 300 });
  const resultado = { sugestao: sugestao.trim() };

  if (resultado.sugestao) {
    await cacheSet(cacheKey, resultado, 300);
  }
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
  if (!GEMINI_API_KEY) return false;
  try {
    const resultado = await query(`SELECT valor FROM configuracoes WHERE chave = 'ia_ativa'`);
    if (resultado.rows.length === 0) return true; // Se não tem config, considerar ativa
    return resultado.rows[0]?.valor !== 'false';
  } catch {
    return true; // Se tabela não existe, considerar ativa
  }
}

/**
 * Melhorar texto — corrigir gramática, ortografia e clareza
 */
async function melhorarTexto(texto) {
  try {
    const resposta = await chamarClaude({
      systemPrompt: `Você é um assistente de escrita em português brasileiro. 
Corrija gramática, ortografia e melhore a clareza do texto enviado.
Mantenha o tom informal/profissional adequado a uma conversa de atendimento via WhatsApp.
Responda APENAS com o texto corrigido, sem explicações, sem aspas, sem prefixo.
Se o texto já estiver correto, retorne ele sem alterações.`,
      userPrompt: texto,
      maxTokens: 500,
    });
    return { textoOriginal: texto, textoMelhorado: resposta };
  } catch (err) {
    logger.error({ err: err.message }, '[IA] Erro ao melhorar texto');
    return { textoOriginal: texto, textoMelhorado: texto, erro: err.message };
  }
}

/**
 * Transcrever áudio de uma mensagem
 * Tenta: 1) base64 salvo, 2) baixar via Z-API, 3) baixar via URL direta
 * Salva no banco pra não precisar transcrever de novo
 */
async function transcreverAudio(mensagemId) {
  const msg = await query(`SELECT id, media_url, tipo, corpo, wa_message_id FROM mensagens WHERE id = $1`, [mensagemId]);
  if (msg.rows.length === 0) throw new AppError('Mensagem não encontrada', 404);
  if (msg.rows[0].tipo !== 'audio') throw new AppError('Mensagem não é um áudio', 400);

  // Se já tem transcrição salva
  const corpoAtual = msg.rows[0].corpo;
  if (corpoAtual && corpoAtual.length > 20 && !corpoAtual.startsWith('🎵')) {
    return { transcricao: corpoAtual, fonte: 'cache' };
  }

  const mediaUrl = msg.rows[0].media_url;
  if (!mediaUrl) throw new AppError('Áudio sem URL disponível. A mídia pode ter expirado.', 400);
  if (!GEMINI_API_KEY) throw new AppError('GEMINI_API_KEY não configurada', 503);

  try {
    let audioBase64, mimeType;

    // 1) Se media_url é data URI (base64) — áudios enviados pelo sistema
    if (mediaUrl.startsWith('data:')) {
      const match = mediaUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        mimeType = match[1];
        audioBase64 = match[2];
      }
    }

    // 2) Se é URL — tentar baixar
    if (!audioBase64 && mediaUrl.startsWith('http')) {
      try {
        const response = await fetch(mediaUrl, { signal: AbortSignal.timeout(15000) });
        if (response.ok) {
          const buffer = await response.arrayBuffer();
          audioBase64 = Buffer.from(buffer).toString('base64');
          mimeType = response.headers.get('content-type') || 'audio/ogg';
        }
      } catch (downloadErr) {
        logger.warn({ err: downloadErr.message, mediaUrl: mediaUrl.substring(0, 100) }, '[AI] Falha ao baixar áudio da URL');
      }
    }

    // 3) Se é URL mas não conseguiu baixar — tentar via fileUrl do Gemini
    if (!audioBase64 && mediaUrl.startsWith('http')) {
      // Usar Gemini com file_data via URL (Gemini aceita URLs públicas)
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

      const geminiResponse = await fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                file_data: {
                  mime_type: 'audio/ogg',
                  file_uri: mediaUrl,
                }
              },
              { text: 'Transcreva este áudio em português brasileiro. Retorne APENAS o texto transcrito, sem aspas, prefixos ou explicações. Se não conseguir entender, retorne "[Áudio inaudível]".' }
            ]
          }],
          generationConfig: { maxOutputTokens: 1000, temperature: 0.1 },
        }),
      });

      if (geminiResponse.ok) {
        const data = await geminiResponse.json();
        const transcricao = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '[Transcrição indisponível]';
        await query(`UPDATE mensagens SET corpo = $1, atualizado_em = NOW() WHERE id = $2`, [transcricao, mensagemId]);
        logger.info({ mensagemId, len: transcricao.length }, '[AI] Áudio transcrito via URL');
        return { transcricao, fonte: 'gemini-url' };
      } else {
        const erro = await geminiResponse.text();
        logger.error({ status: geminiResponse.status, erro: erro.substring(0, 300) }, '[AI] Gemini rejeitou URL do áudio');
        throw new Error('Não foi possível transcrever. A URL do áudio pode ter expirado.');
      }
    }

    if (!audioBase64) throw new Error('Não foi possível obter o áudio para transcrição');

    // Chamar Gemini com áudio inline (base64)
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    const geminiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: audioBase64 } },
            { text: 'Transcreva este áudio em português brasileiro. Retorne APENAS o texto transcrito, sem aspas, prefixos ou explicações. Se não conseguir entender, retorne "[Áudio inaudível]".' }
          ]
        }],
        generationConfig: { maxOutputTokens: 1000, temperature: 0.1 },
      }),
    });

    if (!geminiResponse.ok) {
      const erro = await geminiResponse.text();
      logger.error({ status: geminiResponse.status, erro: erro.substring(0, 300) }, '[AI] Erro Gemini transcrição');
      throw new Error('Falha na transcrição pelo Gemini');
    }

    const data = await geminiResponse.json();
    const transcricao = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '[Transcrição indisponível]';

    // Salvar no banco
    await query(`UPDATE mensagens SET corpo = $1, atualizado_em = NOW() WHERE id = $2`, [transcricao, mensagemId]);

    logger.info({ mensagemId, len: transcricao.length }, '[AI] Áudio transcrito');
    return { transcricao, fonte: 'gemini' };
  } catch (err) {
    logger.error({ err: err.message, mensagemId }, '[AI] Erro ao transcrever áudio');
    throw new AppError(err.message || 'Falha na transcrição', 500);
  }
}

module.exports = {
  gerarSugestao,
  gerarResumo,
  classificarFila,
  detectarSentimento,
  melhorarTexto,
  transcreverAudio,
  iaEstaAtiva,
};