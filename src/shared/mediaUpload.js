// src/shared/mediaUpload.js
// Helper para upload de mídias — R2 se disponível, fallback base64
// Usado por whatsapp.service.js nas funções de envio

const { uploadParaR2, r2Ativo } = require('../config/r2');
const logger = require('./logger');
const crypto = require('crypto');

/**
 * Mapear tipo de mídia para MIME type e extensão
 */
const TIPO_MAP = {
  imagem: { mime: 'image/jpeg', ext: 'jpg' },
  audio: { mime: 'audio/ogg', ext: 'ogg' },
  video: { mime: 'video/mp4', ext: 'mp4' },
  documento: { mime: 'application/octet-stream', ext: 'bin' },
  sticker: { mime: 'image/webp', ext: 'webp' },
};

/**
 * Detectar MIME type do base64 (data:image/jpeg;base64,...)
 */
function detectarMimeDoBase64(base64) {
  const match = base64.match(/^data:([^;]+);base64,/);
  return match ? match[1] : null;
}

/**
 * Extrair extensão do MIME type
 */
function extensaoDoMime(mime) {
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'audio/webm': 'webm', 'audio/wav': 'wav',
    'video/mp4': 'mp4', 'video/webm': 'webm',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  };
  return map[mime] || 'bin';
}

/**
 * Upload de mídia base64 para R2 (ou retorna o base64 se R2 não configurado)
 *
 * @param {string} base64Data - Dados em base64 (com ou sem prefixo data:...)
 * @param {string} tipo - Tipo da mídia: 'imagem', 'audio', 'video', 'documento', 'sticker'
 * @param {object} opts - Opções extras
 * @param {string} opts.fileName - Nome original do arquivo (pra documentos)
 * @param {number} opts.ticketId - ID do ticket (pra organizar no bucket)
 * @returns {string} URL pública do R2 ou o base64 original (fallback)
 */
async function uploadMidia(base64Data, tipo, opts = {}) {
  // Se R2 não está configurado, retorna base64 (modo legado)
  if (!r2Ativo()) {
    return base64Data;
  }

  try {
    // Detectar MIME do prefixo base64 ou usar default do tipo
    const mimeDetectado = detectarMimeDoBase64(base64Data);
    const defaults = TIPO_MAP[tipo] || TIPO_MAP.documento;
    const mime = mimeDetectado || defaults.mime;
    const ext = mimeDetectado ? extensaoDoMime(mimeDetectado) : defaults.ext;

    // Extrair bytes puros (remover prefixo data:...)
    const base64Puro = base64Data.includes(',')
      ? base64Data.split(',')[1]
      : base64Data;

    const buffer = Buffer.from(base64Puro, 'base64');

    // Gerar nome único: media/{ano}/{mes}/{hash}.{ext}
    const agora = new Date();
    const ano = agora.getFullYear();
    const mes = String(agora.getMonth() + 1).padStart(2, '0');
    const hash = crypto.randomBytes(12).toString('hex');
    const fileName = opts.fileName
      ? `${hash}_${opts.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`
      : `${hash}.${ext}`;

    const key = `media/${ano}/${mes}/${fileName}`;

    const url = await uploadParaR2(buffer, key, mime);

    const sizeKB = (buffer.length / 1024).toFixed(1);
    logger.info({ key, tipo, mime, sizeKB, ticketId: opts.ticketId }, '[MediaUpload] Upload R2 concluído');

    return url;
  } catch (err) {
    // Fallback: se R2 falhar, salva base64 no banco (não perder a mensagem)
    logger.error({ err: err.message, tipo }, '[MediaUpload] Erro no upload R2 — fallback para base64');
    return base64Data;
  }
}

/**
 * Verificar se uma media_url é base64 (legado) ou URL real
 */
function isBase64(url) {
  if (!url) return false;
  return url.startsWith('data:') || url.length > 1000;
}

module.exports = {
  uploadMidia,
  isBase64,
};
