// src/config/r2.js
// Cloudflare R2 — S3-compatible object storage para mídias
// Elimina base64 no PostgreSQL — queries de 20MB viram 5KB

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const logger = require('../shared/logger');

let r2Client = null;
let bucketName = null;
let publicUrl = null;

/**
 * Inicializar cliente R2
 * Retorna false se não configurado (fallback: salva base64 no banco como antes)
 */
function inicializarR2() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  bucketName = process.env.R2_BUCKET_NAME || 'synapse-media';
  publicUrl = process.env.R2_PUBLIC_URL; // ex: https://media.centraltutts.online

  if (!accountId || !accessKeyId || !secretAccessKey) {
    logger.warn('[R2] Variáveis R2_ACCOUNT_ID, R2_ACCESS_KEY_ID ou R2_SECRET_ACCESS_KEY não configuradas — mídias serão salvas no banco (modo legado)');
    return false;
  }

  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  logger.info({ bucket: bucketName, publicUrl }, '[R2] Cloudflare R2 inicializado');
  return true;
}

/**
 * Upload de arquivo para R2
 * @param {Buffer} buffer - Conteúdo do arquivo
 * @param {string} key - Caminho/nome do arquivo no bucket (ex: "media/2024/03/abc123.jpg")
 * @param {string} contentType - MIME type (ex: "image/jpeg")
 * @returns {string} URL pública do arquivo
 */
async function uploadParaR2(buffer, key, contentType) {
  if (!r2Client) {
    throw new Error('R2 não inicializado');
  }

  await r2Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));

  // Retornar URL pública
  // Se R2_PUBLIC_URL está configurado (custom domain), usa ele
  // Senão, usa o padrão do R2.dev (precisa habilitar no painel do Cloudflare)
  const url = publicUrl
    ? `${publicUrl.replace(/\/$/, '')}/${key}`
    : `https://${bucketName}.${process.env.R2_ACCOUNT_ID}.r2.dev/${key}`;

  return url;
}

/**
 * Deletar arquivo do R2
 */
async function deletarDoR2(key) {
  if (!r2Client) return;

  try {
    await r2Client.send(new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    }));
  } catch (err) {
    logger.error({ err: err.message, key }, '[R2] Erro ao deletar');
  }
}

/**
 * Verificar se R2 está ativo
 */
function r2Ativo() {
  return r2Client !== null;
}

module.exports = {
  inicializarR2,
  uploadParaR2,
  deletarDoR2,
  r2Ativo,
};
