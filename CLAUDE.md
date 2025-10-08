# CLAUDE.md - Email MCP Server

## 📧 Multi-Tenant Configuration

Este servidor MCP (Model Context Protocol) fornece integração completa com Microsoft Outlook/Exchange via Microsoft Graph API, com suporte a múltiplas contas configuradas através do MCP Hub.

### Configurações Multi-Tenant Disponíveis:

**outlook-fernando** - fernando.taricano@cpzseg.com.br
- Conta pessoal/trabalho principal
- Acesso completo a todas as 39 ferramentas
- Templates HTML profissionais configurados

**outlook-faturamento** - faturamento@cpzseg.com.br
- Conta de faturamento corporativo
- Acesso completo a todas as 39 ferramentas
- Templates corporativos para comunicações financeiras

**Configuração**: Definido via variável de ambiente `TARGET_USER_EMAIL` no MCP Hub

## 🚨 MCP Hub Integration (MANDATORY)

**SEMPRE USE O MCP HUB** para acessar funcionalidades de email. NUNCA tente:
- Importar bibliotecas Microsoft Graph diretamente
- Fazer fetch() direto para APIs Microsoft
- Conectar stdio manualmente com o servidor
- Implementar autenticação OAuth manualmente

### Padrão Intelligence-First (OBRIGATÓRIO):

```typescript
// ✅ CORRETO: Usar busca inteligente em português
// Exemplo: "buscar emails não lidos"
1. smart-search({ query: "buscar emails não lidos", context: "trabalho" })
   // IA retorna: outlook-fernando tools com alta confiança
2. call-tool("outlook-fernando", "list_emails", {
     filter: "isRead eq false",
     limit: 10
   })

// ✅ ALTERNATIVO: Descoberta tradicional
1. list-all-tools({ query: "email" })
2. call-tool("outlook-fernando", "list_emails", { ... })

// ❌ ERRADO: NUNCA faça isso
import { Client } from '@microsoft/microsoft-graph-client';
fetch('https://graph.microsoft.com/v1.0/me/messages');
```

## 📋 Available Tools (39 Total)

### 1️⃣ Email Management (3 tools)

#### `list_emails`
Lista emails da caixa de entrada ou de uma pasta específica com filtros avançados.

**Parâmetros:**
- `limit` (number): Número de emails para retornar (padrão: 10, máx: 50)
- `skip` (number): Paginação - número de emails para pular
- `folder` (string): Pasta (inbox, sentitems, drafts, deleteditems)
- `search` (string): Termo de busca para filtrar emails

**Exemplo:**
```typescript
call-tool("outlook-fernando", "list_emails", {
  filter: "isRead eq false",
  limit: 20,
  folder: "inbox"
})
```

#### `send_email`
Envia novo email com suporte completo a anexos grandes (até 3MB) e templates HTML elegantes.

**Parâmetros:**
- `to` (array): Lista de destinatários (obrigatório)
- `subject` (string): Assunto do email (obrigatório)
- `body` (string): Corpo do email em texto ou HTML (obrigatório)
- `cc` (array): Destinatários em cópia (opcional)
- `bcc` (array): Destinatários em cópia oculta (opcional)
- `attachments` (array): Lista de anexos em Base64 (opcional)
- `useTemplate` (boolean): Usar template HTML elegante (padrão: false)
- `templateTheme` (string): Tema - professional, modern, minimal, corporate

**Exemplo:**
```typescript
call-tool("outlook-fernando", "send_email", {
  to: ["cliente@empresa.com"],
  subject: "Proposta Comercial",
  body: "Segue nossa proposta em anexo.",
  useTemplate: true,
  templateTheme: "professional",
  attachments: [{
    name: "proposta.pdf",
    contentType: "application/pdf",
    content: "base64EncodedContent...",
    size: 1024000
  }]
})
```

#### `reply_to_email`
Responde a um email existente com threading automático.

**Parâmetros:**
- `emailId` (string): ID do email para responder (obrigatório)
- `body` (string): Corpo da resposta (obrigatório)
- `replyAll` (boolean): Responder a todos (padrão: false)

### 2️⃣ Status Operations (3 tools)

#### `mark_as_read`
Marca um email como lido.

**Parâmetros:**
- `emailId` (string): ID do email (obrigatório)

#### `mark_as_unread`
Marca um email como não lido.

**Parâmetros:**
- `emailId` (string): ID do email (obrigatório)

#### `delete_email`
Deleta um email (move para lixeira ou deleta permanentemente).

**Parâmetros:**
- `emailId` (string): ID do email para deletar (obrigatório)

### 3️⃣ Analysis Tools (3 tools)

#### `summarize_email`
Cria resumo detalhado de um email específico com análise inteligente de:
- Prioridade (Alta/Média/Baixa)
- Categoria (Reunião, Projeto, Financeiro, RH, Marketing, etc.)
- Sentimento (Positivo/Neutro/Negativo)
- Ação necessária
- Pontos-chave e informações importantes

**Parâmetros:**
- `emailId` (string): ID do email para resumir (obrigatório)

#### `summarize_emails_batch`
Resume múltiplos emails em lote com categorização automática.

**Parâmetros:**
- `limit` (number): Número de emails para resumir (padrão: 5, máx: 20)
- `skip` (number): Paginação
- `folder` (string): Pasta para buscar (padrão: inbox)
- `priorityOnly` (boolean): Apenas emails de alta prioridade (padrão: false)

#### `list_users`
Lista usuários do diretório organizacional (requer permissões de administrador).

**Parâmetros:**
- `limit` (number): Número de usuários (padrão: 10)
- `search` (string): Termo de busca

### 4️⃣ Basic Attachment Operations (3 tools)

#### `list_attachments`
Lista todos os anexos de um email com metadados completos.

**Parâmetros:**
- `emailId` (string): ID do email (obrigatório)

#### `download_attachment`
Baixa um anexo específico como Base64.

**Parâmetros:**
- `emailId` (string): ID do email (obrigatório)
- `attachmentId` (string): ID do anexo (obrigatório)
- `includeMetadata` (boolean): Incluir metadados (padrão: true)

#### `download_attachment_to_file`
Baixa anexo diretamente para arquivo no disco - **otimizado para arquivos grandes**.

**Parâmetros:**
- `emailId` (string): ID do email (obrigatório)
- `attachmentId` (string): ID do anexo (obrigatório)
- `targetDirectory` (string): Diretório de destino (opcional)
- `customFilename` (string): Nome personalizado (opcional)
- `overwrite` (boolean): Sobrescrever existente (padrão: false)
- `validateIntegrity` (boolean): Validar MD5/SHA256 (padrão: true)

### 5️⃣ Advanced Attachment Operations (7 tools)

#### `download_all_attachments` ⭐
Baixa todos os anexos de um email em lote com processamento paralelo.

**Parâmetros:**
- `emailId` (string): ID do email (obrigatório)
- `targetDirectory` (string): Diretório de destino (opcional)
- `overwrite` (boolean): Sobrescrever arquivos (padrão: false)
- `validateIntegrity` (boolean): Validar integridade (padrão: true)
- `maxConcurrent` (number): Downloads simultâneos (padrão: 3)

#### `list_downloaded_files`
Lista arquivos baixados no diretório de downloads.

**Parâmetros:** Nenhum

#### `get_download_directory_info`
Obtém informações detalhadas sobre o diretório de downloads (tamanho, quantidade, etc.).

**Parâmetros:** Nenhum

#### `cleanup_old_downloads`
Limpa arquivos antigos do diretório de downloads.

**Parâmetros:**
- `daysOld` (number): Deletar arquivos mais antigos que X dias (padrão: 7)
- `dryRun` (boolean): Apenas simular (padrão: true)

#### `export_email_as_attachment`
Exporta um email como arquivo anexável (EML ou MSG).

**Parâmetros:**
- `emailId` (string): ID do email para exportar (obrigatório)
- `format` (string): Formato - eml ou msg (padrão: eml)

#### `encode_file_for_attachment`
Codifica arquivo do disco para Base64 para usar como anexo em emails.

**Parâmetros:**
- `filePath` (string): Caminho do arquivo no disco (obrigatório)
- `customFilename` (string): Nome personalizado para anexo (opcional)

#### `send_email_from_attachment` ⭐ **HYBRID FUNCTION**
**Função híbrida revolucionária** que resolve limitações do MCP para arquivos grandes.

Baixa anexo de um email → processa no disco → envia em novo email automaticamente.

**Parâmetros:**
- `sourceEmailId` (string): ID do email de origem (obrigatório)
- `attachmentId` (string): ID do anexo (obrigatório)
- `to` (array): Destinatários (obrigatório)
- `subject` (string): Assunto do novo email (obrigatório)
- `body` (string): Corpo do novo email (obrigatório)
- `cc` (array): Destinatários em cópia (opcional)
- `bcc` (array): Destinatários em cópia oculta (opcional)
- `useTemplate` (boolean): Usar template HTML (padrão: false)
- `templateTheme` (string): Tema do template (padrão: professional)
- `keepOriginalFile` (boolean): Manter arquivo no disco (padrão: false)
- `customFilename` (string): Nome personalizado do anexo (opcional)

**Exemplo:**
```typescript
call-tool("outlook-fernando", "send_email_from_attachment", {
  sourceEmailId: "AAMkADcxMDIy...",
  attachmentId: "AAMkADcxMDIy...",
  to: ["cliente@empresa.com"],
  subject: "Relatório Mensal - Encaminhado",
  body: "Segue o relatório solicitado em anexo.",
  useTemplate: true,
  templateTheme: "corporate"
})
```

#### `send_email_with_file` ⭐ **HYBRID FUNCTION**
Envia email com arquivo do disco como anexo - **sem transferência Base64 via MCP**.

**Parâmetros:**
- `filePath` (string): Caminho do arquivo no disco (obrigatório)
- `to` (array): Destinatários (obrigatório)
- `subject` (string): Assunto (obrigatório)
- `body` (string): Corpo do email (obrigatório)
- `cc` (array): Destinatários em cópia (opcional)
- `bcc` (array): Destinatários em cópia oculta (opcional)
- `useTemplate` (boolean): Usar template HTML (padrão: false)
- `templateTheme` (string): Tema do template (padrão: professional)
- `customFilename` (string): Nome personalizado do anexo (opcional)

### 6️⃣ Folder Management (7 tools)

#### `list_folders`
Lista todas as pastas de email com suporte a subpastas.

**Parâmetros:**
- `includeSubfolders` (boolean): Incluir subpastas (padrão: true)
- `maxDepth` (number): Profundidade máxima (padrão: 3)

#### `create_folder`
Cria nova pasta de email.

**Parâmetros:**
- `folderName` (string): Nome da pasta (obrigatório)
- `parentFolderId` (string): ID da pasta pai (opcional, se não especificado cria na raiz)

#### `move_emails_to_folder`
Move um ou mais emails para pasta específica.

**Parâmetros:**
- `emailIds` (string | array): ID(s) dos emails (obrigatório)
- `targetFolderId` (string): ID da pasta de destino (obrigatório)

#### `copy_emails_to_folder`
Copia um ou mais emails para pasta específica.

**Parâmetros:**
- `emailIds` (string | array): ID(s) dos emails (obrigatório)
- `targetFolderId` (string): ID da pasta de destino (obrigatório)

#### `delete_folder`
Deleta uma pasta de email (operação irreversível - cuidado!).

**Parâmetros:**
- `folderId` (string): ID da pasta (obrigatório)
- `permanent` (boolean): Deletar permanentemente (padrão: false, move para lixeira)

#### `get_folder_stats`
Obtém estatísticas detalhadas de uma pasta.

**Parâmetros:**
- `folderId` (string): ID da pasta (obrigatório)
- `includeSubfolders` (boolean): Incluir subpastas (padrão: false)

#### `organize_emails_by_rules`
Organiza emails automaticamente usando regras predefinidas com modo simulação.

**Parâmetros:**
- `sourceFolderId` (string): ID da pasta fonte (obrigatório)
- `rules` (array): Array de regras de organização (opcional)
  - `name` (string): Nome da regra
  - `targetFolderId` (string): Pasta de destino
  - `subjectContains` (array): Palavras-chave no assunto
  - `fromContains` (array): Domínios ou emails do remetente
  - `olderThanDays` (number): Emails mais antigos que X dias
- `dryRun` (boolean): Modo simulação (padrão: true)
- `maxEmails` (number): Máximo de emails a processar (padrão: 100)

### 7️⃣ Advanced Search (6 tools)

#### `advanced_search`
Busca avançada com múltiplos critérios (texto, remetente, assunto, data, anexos, status).

**Parâmetros:**
- `query` (string): Texto para buscar no conteúdo
- `sender` (string): Email do remetente específico
- `subject` (string): Texto para buscar no assunto
- `dateFrom` (string): Data inicial (ISO: 2024-01-01T00:00:00Z)
- `dateTo` (string): Data final (ISO: 2024-12-31T23:59:59Z)
- `hasAttachments` (boolean): Filtrar emails com/sem anexos
- `isRead` (boolean): Filtrar emails lidos/não lidos
- `folder` (string): Pasta para buscar (padrão: inbox)
- `maxResults` (number): Máximo de resultados (padrão: 20)
- `sortBy` (string): Campo para ordenação - receivedDateTime, subject, from
- `sortOrder` (string): Ordem - asc ou desc (padrão: desc)

#### `search_by_sender_domain`
Busca emails por domínio do remetente com análise estatística.

**Parâmetros:**
- `domain` (string): Domínio (ex: company.com) (obrigatório)
- `maxResults` (number): Máximo de resultados (padrão: 20)
- `includeSubdomains` (boolean): Incluir subdomínios (padrão: true)
- `folder` (string): Pasta para buscar (padrão: inbox)
- `dateRange` (object): Intervalo de datas opcional

#### `search_by_attachment_type`
Busca emails por tipo de anexo com análise detalhada.

**Parâmetros:**
- `fileTypes` (string | array): Tipo(s) de arquivo (ex: pdf, xlsx, jpg) (obrigatório)
- `maxResults` (number): Máximo de resultados (padrão: 20)
- `folder` (string): Pasta para buscar (padrão: inbox)
- `sizeLimit` (number): Limite de tamanho em MB
- `dateRange` (object): Intervalo de datas opcional

#### `find_duplicate_emails`
Encontra emails duplicados com base em diferentes critérios.

**Parâmetros:**
- `criteria` (string): Critério - subject, sender, subject+sender (padrão: subject)
- `folder` (string): Pasta para analisar (padrão: inbox)
- `maxResults` (number): Máximo de emails a analisar (padrão: 50)
- `includeRead` (boolean): Incluir emails lidos (padrão: true)
- `dateRange` (object): Intervalo de datas opcional

#### `search_by_size`
Busca emails por faixa de tamanho.

**Parâmetros:**
- `minSizeMB` (number): Tamanho mínimo em MB
- `maxSizeMB` (number): Tamanho máximo em MB
- `folder` (string): Pasta para buscar (padrão: inbox)
- `maxResults` (number): Máximo de resultados (padrão: 20)
- `includeAttachments` (boolean): Incluir tamanho dos anexos (padrão: true)

#### `saved_searches`
Gerencia buscas salvas (salvar, listar, executar, deletar).

**Parâmetros:**
- `action` (string): Ação - save, list, execute, delete (obrigatório)
- `name` (string): Nome da busca salva (obrigatório para save, execute, delete)
- `searchCriteria` (object): Critérios de busca a serem salvos (obrigatório para save)

### 8️⃣ Batch Operations (6 tools)

#### `batch_mark_as_read`
Marca múltiplos emails como lidos em operação otimizada em lote.

**Parâmetros:**
- `emailIds` (string | array): ID(s) dos emails (máx: 100) (obrigatório)
- `maxConcurrent` (number): Operações simultâneas (padrão: 5)

#### `batch_mark_as_unread`
Marca múltiplos emails como não lidos em operação otimizada em lote.

**Parâmetros:**
- `emailIds` (string | array): ID(s) dos emails (máx: 100) (obrigatório)
- `maxConcurrent` (number): Operações simultâneas (padrão: 5)

#### `batch_delete_emails`
Deleta múltiplos emails em operação em lote com controle de permanência.

**Parâmetros:**
- `emailIds` (string | array): ID(s) dos emails (máx: 50) (obrigatório)
- `permanent` (boolean): Deleção permanente (padrão: false)
- `maxConcurrent` (number): Operações simultâneas (padrão: 3)

#### `batch_move_emails`
Move múltiplos emails para pasta específica em operação em lote.

**Parâmetros:**
- `emailIds` (string | array): ID(s) dos emails (máx: 100) (obrigatório)
- `targetFolderId` (string): ID da pasta de destino (obrigatório)
- `maxConcurrent` (number): Operações simultâneas (padrão: 5)
- `validateTarget` (boolean): Validar pasta de destino (padrão: true)

#### `batch_download_attachments`
Baixa todos os anexos de múltiplos emails em operação otimizada em lote.

**Parâmetros:**
- `emailIds` (string | array): ID(s) dos emails (máx: 20) (obrigatório)
- `targetDirectory` (string): Diretório de destino (padrão: downloads)
- `maxConcurrent` (number): Downloads simultâneos (padrão: 3)
- `overwrite` (boolean): Sobrescrever arquivos (padrão: false)
- `validateIntegrity` (boolean): Validar integridade (padrão: true)
- `sizeLimit` (number): Limite de tamanho total em MB (padrão: 25)

#### `email_cleanup_wizard` ⭐
Assistente inteligente de limpeza de emails com critérios personalizáveis e modo simulação.

**Parâmetros:**
- `dryRun` (boolean): Modo simulação (padrão: true)
- `olderThanDays` (number): Deletar emails mais antigos que X dias (padrão: 30)
- `deleteRead` (boolean): Deletar emails lidos (padrão: false)
- `deleteLargeAttachments` (boolean): Deletar emails com anexos grandes (padrão: false)
- `attachmentSizeLimitMB` (number): Limite de tamanho de anexo (padrão: 10)
- `excludeFolders` (array): Pastas a excluir (padrão: [sent, drafts])
- `maxEmails` (number): Máximo de emails a analisar (padrão: 100)

## 💡 Usage Examples with Hub Intelligence

### Exemplo 1: Busca Inteligente de Emails
```typescript
// User: "busca emails não lidos sobre 'proposta'"
smart-search({
  query: "buscar emails não lidos proposta",
  context: "trabalho"
})
// IA retorna: outlook-fernando com alta confiança

call-tool("outlook-fernando", "list_emails", {
  filter: "isRead eq false",
  search: "proposta",
  limit: 10
})
```

### Exemplo 2: Envio de Email com Template
```typescript
// User: "envia email profissional para cliente"
smart-search({
  query: "enviar email profissional",
  context: "trabalho"
})

call-tool("outlook-fernando", "send_email", {
  to: ["cliente@empresa.com"],
  subject: "Proposta Comercial 2024",
  body: "Prezado Cliente,\n\nSegue nossa proposta comercial conforme solicitado.",
  useTemplate: true,
  templateTheme: "professional"
})
```

### Exemplo 3: Download e Reenvio de Anexo (Hybrid Function)
```typescript
// User: "pega o anexo daquele email e envia para outro cliente"
smart-search({
  query: "reenviar anexo email",
  context: "trabalho"
})

// Primeiro listar emails e anexos
call-tool("outlook-fernando", "list_emails", { limit: 5 })
call-tool("outlook-fernando", "list_attachments", {
  emailId: "AAMkADcxMDIy..."
})

// Depois usar função híbrida para reenviar
call-tool("outlook-fernando", "send_email_from_attachment", {
  sourceEmailId: "AAMkADcxMDIy...",
  attachmentId: "AAMkADcxMDIy...",
  to: ["outro-cliente@empresa.com"],
  subject: "Relatório Solicitado",
  body: "Segue o relatório em anexo.",
  useTemplate: true
})
```

### Exemplo 4: Organização Automática de Emails
```typescript
// User: "organiza emails antigos por categoria"
smart-search({
  query: "organizar emails automaticamente",
  context: "produtividade"
})

call-tool("outlook-fernando", "organize_emails_by_rules", {
  sourceFolderId: "inbox",
  rules: [
    {
      name: "Financeiro",
      targetFolderId: "folder_id_financeiro",
      subjectContains: ["fatura", "pagamento", "cobrança"],
      fromContains: ["@financeiro.com", "@contabilidade.com"]
    },
    {
      name: "Projetos",
      targetFolderId: "folder_id_projetos",
      subjectContains: ["projeto", "reunião", "deadline"]
    }
  ],
  dryRun: true // Primeiro simular
})
```

### Exemplo 5: Limpeza Inteligente de Emails
```typescript
// User: "limpa emails antigos do meu inbox"
smart-search({
  query: "limpar emails antigos",
  context: "manutenção"
})

call-tool("outlook-fernando", "email_cleanup_wizard", {
  dryRun: true, // Primeiro verificar o que seria deletado
  olderThanDays: 90,
  deleteRead: true,
  deleteLargeAttachments: true,
  attachmentSizeLimitMB: 15,
  excludeFolders: ["sent", "drafts", "important"],
  maxEmails: 200
})
```

## 🎨 HTML Templates

O servidor oferece 4 temas de templates HTML profissionais:

### 1. **professional** (Padrão)
- Design clássico e formal
- Cores corporativas azul e cinza
- Ideal para: Propostas, contratos, comunicações formais

### 2. **modern**
- Design contemporâneo e clean
- Cores vibrantes e modernas
- Ideal para: Startups, tech, comunicações criativas

### 3. **minimal**
- Design minimalista e elegante
- Foco no conteúdo
- Ideal para: Notificações, updates, comunicações diretas

### 4. **corporate**
- Design corporativo robusto
- Cabeçalho e rodapé estruturados
- Ideal para: Comunicações empresariais, relatórios, documentos oficiais

**Uso:**
```typescript
call-tool("outlook-fernando", "send_email", {
  to: ["cliente@empresa.com"],
  subject: "Assunto",
  body: "Conteúdo do email",
  useTemplate: true,
  templateTheme: "corporate" // ou professional, modern, minimal
})
```

## 🔧 Configuration

### Environment Variables Required

```env
# Azure AD Configuration
MICROSOFT_GRAPH_CLIENT_ID=your_client_id_here
MICROSOFT_GRAPH_CLIENT_SECRET=your_client_secret_here
MICROSOFT_GRAPH_TENANT_ID=your_tenant_id_here

# Multi-Tenant Support
TARGET_USER_EMAIL=fernando.taricano@cpzseg.com.br  # ou faturamento@cpzseg.com.br

# Optional Settings
DEBUG=false
LOG_LEVEL=info
```

### Azure AD Permissions Required

O aplicativo Azure AD precisa das seguintes permissões do Microsoft Graph:

**Application Permissions (para acesso via Client Credentials):**
- `Mail.ReadWrite` - Gerenciamento completo de emails
- `Mail.Send` - Envio de emails
- `User.Read.All` - Leitura de usuários do diretório (opcional)
- `Files.ReadWrite.All` - Operações com anexos (opcional)

**Delegated Permissions (para acesso em nome de usuário):**
- `Mail.ReadWrite` - Gerenciamento de emails do usuário
- `Mail.Send` - Envio de emails em nome do usuário
- `User.Read` - Leitura de perfil do usuário

**Importante:** Após configurar as permissões, você DEVE clicar em **"Grant admin consent"** no Azure Portal.

### Multi-Tenant Setup in MCP Hub

No arquivo `hub-config.json`:

```json
{
  "servers": {
    "outlook-fernando": {
      "command": "node",
      "args": ["/path/to/mcp-email/dist/index.js"],
      "env": {
        "MICROSOFT_GRAPH_CLIENT_ID": "your_id",
        "MICROSOFT_GRAPH_CLIENT_SECRET": "your_secret",
        "MICROSOFT_GRAPH_TENANT_ID": "your_tenant",
        "TARGET_USER_EMAIL": "fernando.taricano@cpzseg.com.br"
      }
    },
    "outlook-faturamento": {
      "command": "node",
      "args": ["/path/to/mcp-email/dist/index.js"],
      "env": {
        "MICROSOFT_GRAPH_CLIENT_ID": "your_id",
        "MICROSOFT_GRAPH_CLIENT_SECRET": "your_secret",
        "MICROSOFT_GRAPH_TENANT_ID": "your_tenant",
        "TARGET_USER_EMAIL": "faturamento@cpzseg.com.br"
      }
    }
  }
}
```

## 🐛 Troubleshooting

### Problema: Erro de autenticação
**Sintomas:** "Failed to authenticate with Microsoft Graph"

**Soluções:**
1. Verifique se as credenciais no `.env` ou `hub-config.json` estão corretas
2. Confirme que as permissões foram concedidas no Azure AD
3. Verifique se o client secret não expirou no Azure Portal
4. Teste a conexão com: `node test-connection.js`

### Problema: Anexos com 0KB
**Sintomas:** Anexos são enviados mas aparecem com 0KB

**Soluções:**
1. Use as **funções híbridas**: `send_email_from_attachment` ou `send_email_with_file`
2. Essas funções processam arquivos diretamente no disco, evitando limitações do MCP
3. Valide que o arquivo Base64 está corretamente codificado (se usar `send_email` básico)

### Problema: Timeout em operações grandes
**Sintomas:** Operações com muitos emails ou anexos grandes falham

**Soluções:**
1. Use operações em **lote** (`batch_*` tools) com limite de concorrência adequado
2. Reduza `maxConcurrent` para diminuir carga simultânea
3. Para anexos grandes, sempre use `download_attachment_to_file` em vez de `download_attachment`
4. Implemente paginação com `skip` e `limit` para processar em partes

### Problema: Emails não são encontrados
**Sintomas:** Busca retorna vazio mesmo com emails visíveis no Outlook

**Soluções:**
1. Verifique se o filtro OData está correto (sintaxe Microsoft Graph)
2. Confirme que há emails na pasta especificada
3. Teste sem filtros primeiro: `{ limit: 10 }` apenas
4. Use `advanced_search` para buscas complexas com múltiplos critérios

### Problema: Permissões negadas
**Sintomas:** "Access denied" ou "Insufficient privileges"

**Soluções:**
1. Certifique-se de que as permissões foram configuradas no Azure AD
2. Clique em **"Grant admin consent"** no Azure Portal
3. Aguarde alguns minutos para propagação das permissões
4. Verifique se `TARGET_USER_EMAIL` tem acesso à caixa de email

### Problema: Rate limiting
**Sintomas:** "Too many requests" ou erros 429

**Soluções:**
1. O servidor implementa rate limiting automático
2. Reduza `maxConcurrent` em operações em lote
3. Adicione delay entre chamadas sequenciais
4. Use cache quando possível para reduzir chamadas repetidas

### Problema: Hybrid functions não funcionam
**Sintomas:** Erro ao usar `send_email_from_attachment` ou `send_email_with_file`

**Soluções:**
1. Verifique se o servidor tem permissão para escrever no diretório de downloads
2. Confirme que o arquivo de origem existe e está acessível
3. Valide que o caminho do arquivo (`filePath`) está correto e absoluto
4. Use `validateIntegrity: false` se houver problemas com validação de hash

## 📊 Performance Best Practices

### 1. Use Hybrid Functions para Anexos Grandes
✅ Preferir: `send_email_from_attachment` ou `send_email_with_file`
❌ Evitar: Transferir Base64 via MCP para arquivos >500KB

### 2. Operações em Lote
✅ Preferir: `batch_mark_as_read` para múltiplos emails
❌ Evitar: Chamar `mark_as_read` individualmente em loop

### 3. Paginação Inteligente
✅ Use `skip` e `limit` para processar grandes volumes
❌ Evite buscar todos os emails de uma vez

### 4. Filtros OData
✅ Use filtros específicos no servidor (Microsoft Graph)
❌ Evite buscar tudo e filtrar localmente

### 5. Concorrência Controlada
✅ Configure `maxConcurrent` apropriadamente (3-5 para anexos, 5-10 para operações leves)
❌ Evite concorrência ilimitada que pode causar rate limiting

## 🚀 Advanced Features

### Funções Híbridas - Como Funcionam

As funções híbridas (`send_email_from_attachment` e `send_email_with_file`) resolvem uma limitação fundamental do protocolo MCP:

**Problema:** MCP tem limite de tokens para transferir dados Base64 grandes entre cliente e servidor.

**Solução Híbrida:**
1. Arquivo é baixado/lido diretamente no disco pelo servidor
2. Processamento ocorre localmente (sem transferência via MCP)
3. Email é enviado diretamente pela Microsoft Graph API
4. Arquivo temporário é limpo automaticamente (opcional)

**Benefícios:**
- ✅ Sem limitações de tamanho do MCP
- ✅ Performance otimizada (processamento direto)
- ✅ Integridade garantida (validação MD5/SHA256)
- ✅ Automação completa (download + envio em uma operação)

### Sistema de Resumo Inteligente

O `summarize_email` e `summarize_emails_batch` implementam análise avançada:

**Prioridade:** Detecta urgência baseada em palavras-chave (urgente, importante, ASAP, etc.)

**Categorização:** Classifica automaticamente em 8 categorias:
- Reunião
- Projeto
- Financeiro
- RH
- Marketing
- Suporte
- Vendas
- Notificação

**Sentimento:** Analisa tom do email (positivo, neutro, negativo)

**Ação Requerida:** Detecta se email precisa de resposta

**Extração de Dados:** Identifica datas, valores monetários, e informações-chave

## 📚 Additional Resources

### Filtros OData Comuns

```javascript
// Emails não lidos
"isRead eq false"

// Emails de remetente específico
"from/emailAddress/address eq 'exemplo@domain.com'"

// Emails recebidos hoje
"receivedDateTime ge 2024-01-15T00:00:00Z"

// Emails com anexos
"hasAttachments eq true"

// Emails importantes
"importance eq 'high'"

// Combinando filtros (AND)
"isRead eq false and hasAttachments eq true"

// Combinando filtros (OR) - usar $filter na URL
```

### Pastas Padrão (Well-Known Folders)

- `inbox` - Caixa de entrada
- `sentitems` - Itens enviados
- `drafts` - Rascunhos
- `deleteditems` - Itens excluídos
- `junkemail` - Spam/Lixo eletrônico
- `archive` - Arquivo
- `outbox` - Caixa de saída

### Development Commands

```bash
# Build
npm run build          # Compilar TypeScript

# Run
npm start              # Executar servidor compilado
npm run dev            # Desenvolvimento com watch

# Testing
node test-connection.js       # Testar conexão Microsoft Graph
node test-email-functions.js  # Testar funcionalidades de email
node check-permissions.js     # Validar permissões Azure AD
```

## 📄 License

MIT

---

**Última atualização:** Janeiro 2025
**Versão do Servidor:** 2.0.0
**Total de Ferramentas:** 39 (não 15!)
