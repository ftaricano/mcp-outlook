# MCP Email Server - Integração com Microsoft Graph

Um servidor MCP (Model Context Protocol) avançado para integração completa com emails do Microsoft Outlook/Exchange via Microsoft Graph API, oferecendo **39 ferramentas especializadas** organizadas em 8 categorias funcionais.

## 🔑 Multi-Tenant Support

Este servidor suporta múltiplas contas simultaneamente através do MCP Hub:
- **outlook-fernando**: fernando.taricano@cpzseg.com.br (conta principal/trabalho)
- **outlook-faturamento**: faturamento@cpzseg.com.br (conta faturamento corporativo)

Configuração via variável de ambiente `TARGET_USER_EMAIL` no MCP Hub.

## 🚀 Funcionalidades Principais

### 1️⃣ Email Management (3 tools)
- `list_emails` - Busca avançada com filtros OData
- `send_email` - Envio com anexos grandes (até 3MB) e templates HTML
- `reply_to_email` - Resposta com threading automático

### 2️⃣ Status Operations (3 tools)
- `mark_as_read` / `mark_as_unread` - Gestão de status de leitura
- `delete_email` - Exclusão de emails

### 3️⃣ Analysis Tools (3 tools)
- `summarize_email` - Resumo inteligente com análise de prioridade e sentimento
- `summarize_emails_batch` - Resumo em lote com categorização automática
- `list_users` - Listagem de usuários do diretório organizacional

### 4️⃣ Basic Attachment Operations (3 tools)
- `list_attachments` - Listagem de anexos com metadados
- `download_attachment` - Download como Base64
- `download_attachment_to_file` - Download otimizado para disco (arquivos grandes)

### 5️⃣ Advanced Attachment Operations (7 tools)
- `download_all_attachments` - Download em lote com processamento paralelo
- `list_downloaded_files` - Listagem de arquivos baixados
- `get_download_directory_info` - Informações do diretório de downloads
- `cleanup_old_downloads` - Limpeza automática de arquivos antigos
- `export_email_as_attachment` - Exportação de emails como EML/MSG
- `encode_file_for_attachment` - Codificação de arquivos para anexo
- `send_email_from_attachment` ⭐ **HYBRID** - Reenvio automático de anexos
- `send_email_with_file` ⭐ **HYBRID** - Envio com arquivo do disco

### 6️⃣ Folder Management (7 tools)
- `list_folders` - Listagem de pastas com suporte a subpastas
- `create_folder` - Criação de novas pastas
- `move_emails_to_folder` / `copy_emails_to_folder` - Movimentação de emails
- `delete_folder` - Exclusão de pastas
- `get_folder_stats` - Estatísticas detalhadas de pastas
- `organize_emails_by_rules` - Organização automática com regras personalizáveis

### 7️⃣ Advanced Search (6 tools)
- `advanced_search` - Busca multi-critério avançada
- `search_by_sender_domain` - Busca por domínio com análise estatística
- `search_by_attachment_type` - Busca por tipo de anexo
- `find_duplicate_emails` - Detecção de duplicatas
- `search_by_size` - Busca por faixa de tamanho
- `saved_searches` - Gerenciamento de buscas salvas

### 8️⃣ Batch Operations (6 tools)
- `batch_mark_as_read` / `batch_mark_as_unread` - Marcação em lote
- `batch_delete_emails` - Exclusão em lote com controle de permanência
- `batch_move_emails` - Movimentação em lote
- `batch_download_attachments` - Download de anexos em lote otimizado
- `email_cleanup_wizard` ⭐ - Assistente inteligente de limpeza

## 🌟 Destaques

### ⚡ Funções Híbridas Revolucionárias
As funções híbridas (`send_email_from_attachment` e `send_email_with_file`) resolvem limitações fundamentais do protocolo MCP para transferência de arquivos grandes, processando diretamente no disco sem limitações de tokens.

### 🧠 Análise Inteligente de Emails
Sistema avançado de resumo que analisa prioridade, categoria, sentimento, ações requeridas e extrai dados-chave automaticamente.

### 🎨 Templates HTML Profissionais
4 temas elegantes (professional, modern, minimal, corporate) para emails corporativos de alta qualidade.

## Pré-requisitos

### 1. Registrar aplicação no Azure AD

1. Acesse o [Azure Portal](https://portal.azure.com)
2. Vá para **Azure Active Directory** > **App registrations**
3. Clique em **New registration**
4. Configure:
   - **Name**: MCP Email Server
   - **Supported account types**: Accounts in this organizational directory only
   - **Redirect URI**: Deixe em branco (não é necessário para Client Credentials flow)

### 2. Configurar permissões

1. Na aplicação criada, vá para **API permissions**
2. Clique em **Add a permission** > **Microsoft Graph** > **Application permissions**
3. Adicione as seguintes permissões:
   - `Mail.ReadWrite` - Gerenciamento completo de emails
   - `Mail.Send` - Envio de emails
   - `User.Read.All` - Ler perfis de usuário (opcional)
   - `Files.ReadWrite.All` - Operações com anexos (opcional)

4. Clique em **Grant admin consent** para aprovar as permissões

**Importante:** As permissões `Mail.ReadWrite` e `Mail.Send` são OBRIGATÓRIAS para o funcionamento completo do servidor.

### 3. Criar client secret

1. Vá para **Certificates & secrets**
2. Clique em **New client secret**
3. Adicione uma descrição e escolha a validade
4. **Copie o valor do secret imediatamente** (não será mostrado novamente)

## Instalação

1. Clone ou baixe este projeto
2. Instale as dependências:
```bash
npm install
```

3. Configure as variáveis de ambiente:
```bash
cp .env.example .env
```

4. Edite o arquivo `.env` com suas credenciais:
```env
MICROSOFT_GRAPH_CLIENT_ID=your_client_id_here
MICROSOFT_GRAPH_CLIENT_SECRET=your_client_secret_here
MICROSOFT_GRAPH_TENANT_ID=your_tenant_id_here
```

5. Compile o TypeScript:
```bash
npm run build
```

## Uso

### Executar o servidor
```bash
npm start
```

### Configurar no MCP Hub (Recomendado)

**⚠️ IMPORTANTE:** Este servidor deve ser acessado APENAS através do MCP Hub. Configure no arquivo `hub-config.json`:

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

### Uso via MCP Hub Intelligence

```typescript
// ✅ CORRETO: Usar busca inteligente em português
smart-search({ query: "buscar emails não lidos", context: "trabalho" })
// IA retorna: outlook-fernando tools com alta confiança

call-tool("outlook-fernando", "list_emails", {
  filter: "isRead eq false",
  limit: 10
})

// ❌ ERRADO: NUNCA tente usar APIs diretas
// import { Client } from '@microsoft/microsoft-graph-client';
```

## 🛠️ Ferramentas Disponíveis (39 Total)

**Para documentação completa de todas as 39 ferramentas, consulte:** `/Users/fernandotaricano/mcp/mcp-email/CLAUDE.md`

### Resumo por Categoria

**1️⃣ Email Management (3 tools):** list_emails, send_email, reply_to_email
**2️⃣ Status Operations (3 tools):** mark_as_read, mark_as_unread, delete_email
**3️⃣ Analysis Tools (3 tools):** summarize_email, summarize_emails_batch, list_users
**4️⃣ Basic Attachments (3 tools):** list_attachments, download_attachment, download_attachment_to_file
**5️⃣ Advanced Attachments (7 tools):** download_all_attachments, send_email_from_attachment ⭐, send_email_with_file ⭐, etc.
**6️⃣ Folder Management (7 tools):** list_folders, create_folder, organize_emails_by_rules, etc.
**7️⃣ Advanced Search (6 tools):** advanced_search, search_by_sender_domain, find_duplicate_emails, etc.
**8️⃣ Batch Operations (6 tools):** batch_mark_as_read, batch_delete_emails, email_cleanup_wizard ⭐, etc.

### Exemplos de Uso

#### Buscar Emails Não Lidos
```typescript
call-tool("outlook-fernando", "list_emails", {
  filter: "isRead eq false",
  limit: 10
})
```

#### Enviar Email com Template Profissional
```typescript
call-tool("outlook-fernando", "send_email", {
  to: ["cliente@empresa.com"],
  subject: "Proposta Comercial",
  body: "Segue nossa proposta em anexo.",
  useTemplate: true,
  templateTheme: "professional"
})
```

#### Reenviar Anexo Automaticamente (Hybrid Function)
```typescript
call-tool("outlook-fernando", "send_email_from_attachment", {
  sourceEmailId: "AAMkADcxMDIy...",
  attachmentId: "AAMkADcxMDIy...",
  to: ["outro-cliente@empresa.com"],
  subject: "Relatório Solicitado",
  body: "Segue o relatório em anexo.",
  useTemplate: true
})
```

## 📚 Documentação Adicional

### Documentação Completa
Para referência completa de todas as 39 ferramentas com parâmetros detalhados, exemplos de uso, troubleshooting e best practices, consulte:

**📖 [CLAUDE.md - Documentação Completa para Claude Code](/Users/fernandotaricano/mcp/mcp-email/CLAUDE.md)**

### Links Úteis
- **Azure AD Setup:** Configuração de aplicativo e permissões
- **Microsoft Graph API:** [Documentação oficial](https://docs.microsoft.com/en-us/graph/)
- **OData Filters:** Sintaxe de filtros avançados
- **MCP Hub:** Integração com o hub centralizado


## 🎯 Troubleshooting Rápido

### Erro de Autenticação
1. Verifique credenciais no `hub-config.json`
2. Confirme permissões concedidas no Azure AD
3. Verifique expiração do client secret
4. Teste: `node test-connection.js`

### Anexos com 0KB
Use funções híbridas: `send_email_from_attachment` ou `send_email_with_file`

### Performance
- Use operações em lote (`batch_*` tools)
- Configure `maxConcurrent` adequadamente
- Implemente paginação com `skip` e `limit`

**Para troubleshooting completo, consulte CLAUDE.md**

## 🛠️ Desenvolvimento

### Estrutura do Projeto
```
src/
├── handlers/           # Handler Registry modular
├── auth/              # Microsoft Graph authentication
├── services/          # Email service e FileManager
├── security/          # Security Manager
├── monitoring/        # Performance monitoring
├── logging/           # Advanced logging
└── index.ts          # MCP server entry point
```

### Commands
```bash
npm run build          # Compilar TypeScript
npm start              # Executar servidor compilado
npm run dev            # Desenvolvimento com watch
node test-connection.js       # Testar Microsoft Graph
node test-email-functions.js  # Testar funcionalidades
node check-permissions.js     # Validar permissões Azure AD
```

## Licença

MIT