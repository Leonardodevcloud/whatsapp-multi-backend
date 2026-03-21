// src/shared/mediaUpload.js
// Upload de mídias — base64→R2, URL→R2 (CDN permanente), thumbnails

const { uploadParaR2, r2Ativo } = require('../config/r2');
const logger = require('./logger');
const crypto = require('crypto');

const TIPO_MAP = {
  imagem: { mime: 'image/jpeg', ext: 'jpg' },
  audio: { mime: 'audio/ogg', ext: 'ogg' },
  video: { mime: 'video/mp4', ext: 'mp4' },
  documento: { mime: 'application/octet-stream', ext: 'bin' },
  sticker: { mime: 'image/webp', ext: 'webp' },
};

function detectarMimeDoBase64(b64) {
  const m = b64.match(/^data:([^;]+);base64,/);
  return m ? m[1] : null;
}

function extensaoDoMime(mime) {
  const map = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif',
    'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'audio/webm': 'webm', 'video/mp4': 'mp4', 'video/webm': 'webm',
    'application/pdf': 'pdf',
  };
  return map[mime] || 'bin';
}

function _gerarKey(tipo, ext, fileName) {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  const hash = crypto.randomBytes(12).toString('hex');
  const nome = fileName
    ? `${hash}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    : `${hash}.${ext}`;
  return `media/${ano}/${mes}/${nome}`;
}

/**
 * Upload de base64 para R2 (mídias enviadas pelo atendente)
 */
async function uploadMidia(base64Data, tipo, opts = {}) {
  if (!r2Ativo()) return base64Data;
  try {
    const mimeDetectado = detectarMimeDoBase64(base64Data);
    const defaults = TIPO_MAP[tipo] || TIPO_MAP.documento;
    const mime = mimeDetectado || defaults.mime;
    const ext = mimeDetectado ? extensaoDoMime(mimeDetectado) : defaults.ext;

    const base64Puro = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
    const buffer = Buffer.from(base64Puro, 'base64');
    const key = _gerarKey(tipo, ext, opts.fileName);

    const url = await uploadParaR2(buffer, key, mime);
    logger.info({ key, tipo, sizeKB: (buffer.length / 1024).toFixed(1) }, '[MediaUpload] base64→R2 OK');
    return url;
  } catch (err) {
    logger.error({ err: err.message, tipo }, '[MediaUpload] Erro R2 — fallback base64');
    return base64Data;
  }
}

/**
 * Download de URL externa → upload R2 (mídias recebidas via Z-API)
 * URLs da Z-API expiram — R2 é permanente
 * Retorna { url, thumbnail } se imagem, ou string se outros tipos
 */
async function uploadFromUrl(externalUrl, tipo) {
  if (!r2Ativo() || !externalUrl) return externalUrl;
  if (externalUrl.includes('r2.dev') || externalUrl.includes('r2.cloudflarestorage')) return externalUrl;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(externalUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'SynapseChat/1.0' },
    });
    clearTimeout(timeout);

    if (!response.ok) return externalUrl;

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type');
    const defaults = TIPO_MAP[tipo] || TIPO_MAP.documento;
    const mime = contentType?.split(';')[0] || defaults.mime;
    const ext = extensaoDoMime(mime) || defaults.ext;
    const key = _gerarKey(tipo, ext);

    const url = await uploadParaR2(buffer, key, mime);

    // Thumbnail para imagens >50KB
    let thumbnail = null;
    if (tipo === 'imagem' && buffer.length > 50 * 1024) {
      try {
        const sharp = require('sharp');
        const thumbBuf = await sharp(buffer)
          .resize(200, 200, { fit: 'cover', withoutEnlargement: true })
          .jpeg({ quality: 50 })
          .toBuffer();
        const thumbKey = key.replace(/\.[^.]+$/, '_thumb.jpg');
        thumbnail = await uploadParaR2(thumbBuf, thumbKey, 'image/jpeg');
      } catch (_) { /* sharp opcional */ }
    }

    logger.info({ key, tipo, sizeKB: (buffer.length / 1024).toFixed(1), thumb: !!thumbnail }, '[MediaUpload] URL→R2 OK');
    return thumbnail ? { url, thumbnail } : url;
  } catch (err) {
    logger.warn({ err: err.message, url: externalUrl?.substring(0, 60) }, '[MediaUpload] URL→R2 falhou — mantendo original');
    return externalUrl;
  }
}

function isBase64(url) {
  if (!url) return false;
  return url.startsWith('data:') || url.length > 1000;
}

module.exports = { uploadMidia, uploadFromUrl, isBase64 };
