// src/shared/constants.js
// Constantes globais da aplicação

const CATEGORIAS_AUDITORIA = {
  AUTH: 'auth',
  TICKET: 'ticket',
  MENSAGEM: 'mensagem',
  USUARIO: 'usuario',
  FILA: 'fila',
  CONTATO: 'contato',
  CONFIG: 'config',
  WHATSAPP: 'whatsapp',
};

const ERROS = {
  NAO_AUTORIZADO: 'Token inválido ou não fornecido',
  ACESSO_NEGADO: 'Sem permissão para acessar este recurso',
  NAO_ENCONTRADO: 'Recurso não encontrado',
  CREDENCIAIS_INVALIDAS: 'Email ou senha incorretos',
  EMAIL_DUPLICADO: 'Este email já está cadastrado',
  TICKET_JA_ATRIBUIDO: 'Este ticket já possui um atendente',
  MAX_TICKETS_ATINGIDO: 'Atendente atingiu o limite de tickets simultâneos',
  WHATSAPP_DESCONECTADO: 'WhatsApp não está conectado',
  RATE_LIMIT: 'Muitas requisições. Tente novamente em instantes',
};

const STATUS_TICKET = {
  PENDENTE: 'pendente',
  ABERTO: 'aberto',
  AGUARDANDO: 'aguardando',
  RESOLVIDO: 'resolvido',
  FECHADO: 'fechado',
};

const PERFIS = {
  ADMIN: 'admin',
  SUPERVISOR: 'supervisor',
  ATENDENTE: 'atendente',
};

const TIPOS_MENSAGEM = {
  TEXTO: 'texto',
  IMAGEM: 'imagem',
  AUDIO: 'audio',
  VIDEO: 'video',
  DOCUMENTO: 'documento',
  LOCALIZACAO: 'localizacao',
  CONTATO: 'contato',
  STICKER: 'sticker',
  SISTEMA: 'sistema',
};

const STATUS_ENVIO = {
  PENDENTE: 'pendente',
  ENVIADA: 'enviada',
  ENTREGUE: 'entregue',
  LIDA: 'lida',
  ERRO: 'erro',
};

module.exports = {
  CATEGORIAS_AUDITORIA,
  ERROS,
  STATUS_TICKET,
  PERFIS,
  TIPOS_MENSAGEM,
  STATUS_ENVIO,
};
