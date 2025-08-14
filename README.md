# MCP Email Server - Integração com Microsoft Graph

Um servidor MCP (Model Context Protocol) avançado para integração completa com emails do Microsoft Outlook/Exchange via Microsoft Graph API.

## 🚀 Funcionalidades Principais

### 📧 Gestão de Emails
- **Listar emails**: Busca avançada com filtros OData
- **Enviar emails**: Suporte completo a anexos grandes (até 3MB)
- **Responder emails**: Com threading automático
- **Gestão de status**: Marcar como lido/não lido, deletar

### 📎 Gestão de Anexos Avançada
- **Download otimizado**: Salva arquivos grandes diretamente no disco
- **Encoding inteligente**: Base64 com validação de integridade
- **Suporte a múltiplos formatos**: Office, PDF, imagens, etc.
- **Validação automática**: Verificação de tipos MIME e tamanhos

### 🧠 Análise Inteligente
- **Resumos automáticos**: IA analisa conteúdo, prioridade e sentimento
- **Categorização**: Reunião, Projeto, Financeiro, RH, etc.
- **Detecção de ações**: Identifica emails que requerem resposta
- **Extração de dados**: Datas, valores monetários, pontos-chave

### ⚡ Funções Híbridas (Novidade!)
- **Automação completa**: Download + processamento + envio em uma operação
- **Sem limitações de tamanho**: Contorna limitações do protocolo MCP
- **Performance otimizada**: Processamento direto no disco

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
   - `Mail.Read` - Ler emails
   - `Mail.ReadBasic` - Ler informações básicas dos emails
   - `User.Read.All` - Ler perfis de usuário (opcional)

4. Clique em **Grant admin consent** para aprovar as permissões

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

### Configurar no Claude Code

Adicione ao seu arquivo de configuração do Claude Code (`settings.json`):

```json
{
  "mcpServers": {
    "mcp-email": {
      "command": "node",
      "args": ["/caminho/para/mcp-email/dist/index.js"],
      "env": {
        "MICROSOFT_GRAPH_CLIENT_ID": "seu_client_id",
        "MICROSOFT_GRAPH_CLIENT_SECRET": "seu_client_secret",
        "MICROSOFT_GRAPH_TENANT_ID": "seu_tenant_id"
      }
    }
  }
}
```

## 🛠️ Ferramentas Disponíveis

### 📧 Gestão Básica de Emails

#### 1. `list_emails`
Lista emails da caixa de entrada com filtros opcionais.

**Parâmetros:**
- `maxResults` (number): Número máximo de emails (padrão: 10)
- `filter` (string): Filtro OData (ex: "isRead eq false")
- `search` (string): Termo de busca
- `folder` (string): Pasta específica (padrão: "inbox")

**Exemplos:**
```javascript
// Listar emails não lidos
list_emails({ filter: "isRead eq false" })

// Buscar emails de um remetente
list_emails({ filter: "from/emailAddress/address eq 'exemplo@empresa.com'" })

// Buscar por texto
list_emails({ search: "projeto importante" })
```

### 2. `summarize_email`
Cria um resumo detalhado de um email específico.

**Parâmetros:**
- `emailId` (string): ID do email para resumir

### 3. `summarize_emails_batch`
Cria resumos para múltiplos emails.

**Parâmetros:**
- `emailIds` (array): Lista de IDs de emails (opcional)
- `maxResults` (number): Número máximo de emails (padrão: 5)

### ⚡ Funções Híbridas Avançadas

#### 4. `send_email_from_attachment` ⭐ **NOVO**
Função híbrida que baixa anexo de um email e reenvia automaticamente para outros destinatários. **Resolve limitações do MCP para arquivos grandes**.

**Parâmetros:**
- `sourceEmailId` (string): ID do email que contém o anexo
- `attachmentId` (string): ID do anexo a ser reenviado
- `to` (array): Lista de destinatários
- `subject` (string): Assunto do email
- `body` (string): Corpo do email
- `cc` (array, opcional): Destinatários em cópia
- `useTemplate` (boolean, opcional): Usar template HTML elegante
- `keepOriginalFile` (boolean, opcional): Manter arquivo no disco

**Exemplo:**
```javascript
send_email_from_attachment({
  sourceEmailId: "AAMkADcxMDIy...",
  attachmentId: "AAMkADcxMDIy...",
  to: ["cliente@empresa.com"],
  subject: "Relatório Mensal",
  body: "Segue o relatório solicitado em anexo.",
  useTemplate: true
})
```

#### 5. `send_email_with_file` ⭐ **NOVO**
Envia email com arquivo já baixado do disco. **Ideal para automação com arquivos grandes**.

**Parâmetros:**
- `filePath` (string): Caminho absoluto para o arquivo no disco
- `to` (array): Lista de destinatários
- `subject` (string): Assunto do email
- `body` (string): Corpo do email
- `cc` (array, opcional): Destinatários em cópia
- `useTemplate` (boolean, opcional): Usar template HTML
- `customFilename` (string, opcional): Nome personalizado para o anexo

**Exemplo:**
```javascript
send_email_with_file({
  filePath: "/path/to/documento.pdf",
  to: ["equipe@empresa.com"],
  subject: "Documento Importante",
  body: "Documento em anexo para revisão.",
  useTemplate: true,
  customFilename: "Documento_Final.pdf"
})
```

### 📎 Gestão de Anexos

#### 6. `download_attachment_to_file`
Download otimizado de anexos grandes - salva diretamente no disco evitando limitações de token.

#### 7. `encode_file_for_attachment`
Codifica arquivo do sistema de arquivos para Base64 - resolve problema de anexos com 0KB.

#### 8. `list_attachments`, `download_attachment`
Listagem e download básico de anexos.

### 📝 Outras Ferramentas

#### 9-13. Gestão Completa
- `send_email` - Envio básico com anexos
- `reply_to_email` - Resposta com threading
- `mark_as_read/unread` - Gestão de status
- `delete_email` - Exclusão segura
- `list_users` - Listagem de usuários da organização

## ⚡ Vantagens das Funções Híbridas

### 🚀 **Performance Superior**
- **Zero limitações de tamanho**: Funciona com arquivos de qualquer tamanho
- **Processamento direto**: Não transfere Base64 via protocolo MCP
- **Cache inteligente**: Arquivos ficam no disco para reuso
- **Validação automática**: Integridade garantida

### 🔄 **Automação Completa**
- **Workflow unificado**: Download + processamento + envio em uma operação
- **Sem intervenção manual**: Processo totalmente automatizado
- **Flexibilidade total**: Pode processar arquivo antes de reenviar
- **Limpeza automática**: Remove arquivos temporários opcionalmente

### 💪 **Robustez**
- **Tratamento de erros**: Recuperação automática em falhas
- **Validação de tipos**: Suporte a todos os formatos Office, PDF, imagens
- **Compatibilidade**: Funciona com Microsoft Graph API sem limitações

## Filtros Avançados

### Filtros OData Comuns

```javascript
// Emails não lidos
"isRead eq false"

// Emails de um remetente específico
"from/emailAddress/address eq 'exemplo@domain.com'"

// Emails recebidos hoje
"receivedDateTime ge 2024-01-15T00:00:00Z"

// Emails com anexos
"hasAttachments eq true"

// Emails importantes
"importance eq 'high'"

// Combinando filtros
"isRead eq false and hasAttachments eq true"
```

### Pastas Disponíveis

- `inbox` - Caixa de entrada
- `sentitems` - Itens enviados
- `drafts` - Rascunhos
- `deleteditems` - Itens excluídos
- `junkemail` - Spam

## Resumos Inteligentes

O sistema de resumo analisa:

- **Prioridade**: Alta, média ou baixa baseada em palavras-chave
- **Categoria**: Reunião, Projeto, Financeiro, RH, etc.
- **Pontos-chave**: Lista de informações importantes
- **Ação necessária**: Se o email requer alguma ação
- **Sentimento**: Positivo, neutro ou negativo
- **Anexos**: Lista de arquivos anexados

## Troubleshooting

### Erro de autenticação
- Verifique se as credenciais estão corretas no `.env`
- Confirme que as permissões foram concedidas no Azure AD
- Verifique se o client secret não expirou

### Erro de permissões
- Certifique-se de que concedeu as permissões necessárias
- Clique em "Grant admin consent" no Azure Portal

### Emails não são encontrados
- Verifique se o filtro OData está correto
- Confirme que há emails na pasta especificada
- Teste sem filtros primeiro

## Desenvolvimento

### Estrutura do projeto
```
src/
├── auth/
│   └── graphAuth.ts      # Autenticação Microsoft Graph
├── services/
│   ├── emailService.ts   # Serviços de email
│   └── emailSummarizer.ts # Sistema de resumos
└── index.ts             # Servidor MCP principal
```

### Executar em modo desenvolvimento
```bash
npm run dev
```

## Licença

MIT