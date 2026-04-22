import { zodToJsonSchema } from 'zod-to-json-schema';
import { toolSchemas } from './toolSchemas.js';

/**
 * Human-readable descriptions surfaced to the MCP client for each tool.
 * Kept in this module so the schema registry is the single source of truth.
 */
const toolDescriptions: Record<string, string> = {
  // Email Management
  list_emails: 'Lista emails da caixa de entrada ou de uma pasta específica',
  send_email: 'Envia um novo email com suporte a anexos e templates HTML',
  create_draft:
    'Cria um rascunho de email na pasta Rascunhos (apenas Mail.ReadWrite — não envia). Retorna o id do rascunho para revisão/envio posterior.',
  reply_to_email: 'Responde a um email existente',
  mark_as_read: 'Marca um email como lido',
  mark_as_unread: 'Marca um email como não lido',
  delete_email: 'Deleta um email permanentemente',
  summarize_email: 'Resume um email específico com análise inteligente',
  summarize_emails_batch:
    'Resume múltiplos emails em lote com categorização por prioridade',
  list_users:
    'Lista usuários do diretório (requer permissões de administrador)',

  // Attachment Management
  list_attachments: 'Lista todos os anexos de um email',
  download_attachment: 'Baixa um anexo específico como Base64',
  download_attachment_to_file:
    'Baixa um anexo diretamente para arquivo no disco (otimizado para arquivos grandes)',
  download_all_attachments: 'Baixa todos os anexos de um email em lote',
  list_downloaded_files: 'Lista arquivos baixados no diretório de downloads',
  get_download_directory_info:
    'Obtém informações sobre o diretório de downloads',
  cleanup_old_downloads: 'Limpa arquivos antigos do diretório de downloads',
  export_email_as_attachment:
    'Exporta um email como arquivo anexável (EML ou MSG)',
  encode_file_for_attachment:
    'Codifica um arquivo do disco para Base64 para usar como anexo',

  // Hybrid
  send_email_from_attachment:
    'Função híbrida: baixa anexo de um email e envia em novo email (solução para limitações do MCP)',
  send_email_with_file:
    'Envia email com arquivo do disco como anexo (sem transferência Base64 via MCP)',

  // Folder Management
  list_folders:
    'Lista todas as pastas de email do usuário com opção de incluir subpastas',
  create_folder: 'Cria uma nova pasta de email',
  move_emails_to_folder: 'Move um ou mais emails para uma pasta específica',
  copy_emails_to_folder: 'Copia um ou mais emails para uma pasta específica',
  delete_folder: 'Deleta uma pasta de email (cuidado: operação irreversível)',
  get_folder_stats: 'Obtém estatísticas detalhadas de uma pasta de email',
  organize_emails_by_rules:
    'Organiza emails automaticamente usando regras predefinidas (suporta modo simulação)',

  // Advanced Search
  advanced_search:
    'Busca avançada de emails com múltiplos critérios (texto, remetente, assunto, data, anexos, status)',
  search_by_sender_domain:
    'Busca emails por domínio do remetente com análise estatística',
  search_by_attachment_type:
    'Busca emails por tipo de anexo com análise detalhada',
  find_duplicate_emails:
    'Encontra emails duplicados com base em diferentes critérios',
  search_by_size: 'Busca emails por faixa de tamanho',
  saved_searches:
    'Gerencia buscas salvas (salvar, listar, executar, deletar)',

  // Batch Operations
  batch_mark_as_read:
    'Marca múltiplos emails como lidos em operação em lote otimizada',
  batch_mark_as_unread:
    'Marca múltiplos emails como não lidos em operação em lote otimizada',
  batch_delete_emails:
    'Deleta múltiplos emails em operação em lote com controle de permanência',
  batch_move_emails:
    'Move múltiplos emails para uma pasta específica em operação em lote',
  batch_download_attachments:
    'Baixa todos os anexos de múltiplos emails em operação em lote otimizada',
  email_cleanup_wizard:
    'Assistente inteligente de limpeza de emails com critérios personalizáveis e modo simulação'
};

type ToolSchemaEntry = {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
};

/**
 * Convert a zod schema into the JSON Schema shape the MCP protocol expects:
 *   { type: 'object', properties: {...}, required: [...] }
 *
 * `zod-to-json-schema` emits extra JSON-Schema metadata (`$schema`,
 * `additionalProperties`, `$ref`, etc.). We strip the top-level metadata that
 * MCP does not need so the output stays identical in shape to the previous
 * hand-written schemas.
 */
function toMcpInputSchema(schema: any): Record<string, any> {
  const json = zodToJsonSchema(schema, { target: 'jsonSchema7' }) as any;

  // zod-to-json-schema may return a wrapper with { $ref, definitions } when
  // complex refs are used. Unwrap by inlining the referenced definition.
  let resolved = json;
  if (json.$ref && json.definitions) {
    const refKey = json.$ref.split('/').pop();
    resolved = refKey ? json.definitions[refKey] : json;
  }

  const { $schema: _schema, definitions: _definitions, ...rest } = resolved || {};

  if (rest.type !== 'object') {
    return { type: 'object', properties: {} };
  }

  return rest;
}

/**
 * Build the array of tool descriptors the MCP server registers at startup.
 */
export function getToolSchemas(): ToolSchemaEntry[] {
  return Object.entries(toolSchemas).map(([name, schema]) => ({
    name,
    description: toolDescriptions[name] ?? name,
    inputSchema: toMcpInputSchema(schema)
  }));
}
