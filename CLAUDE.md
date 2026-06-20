# CLAUDE.md -- mcp-outlook

End-user docs (tool catalog, setup, troubleshooting) em [README.md](README.md) -- nao duplicar aqui.

## O que e

MCP server expondo operacoes de email via Microsoft Graph como 40 ferramentas stdio, mais CLI `outlook` standalone. Auth via Azure AD client-credentials (sem login de usuario). Single-mailbox por processo -- `TARGET_USER_EMAIL` fixa a caixa alvo. Consumido por Claude/Codex/Hermes via MCP e pelo `outlook` CLI.

## Stack & estrutura

TypeScript + Node >=20 + @microsoft/microsoft-graph-client + @azure/msal-node + zod + Vitest

```
src/
  config/     env validado por zod, falha rapido
  auth/       MSAL client-credentials (graphAuth.ts)
  security/   pathGuard -- filesystem allowlist (DOWNLOAD_DIR, MCP_EMAIL_UPLOAD_DIRS)
  services/   Graph wrapper: response cache, batch helpers (retry via SDK middleware)
  schemas/    zod schema por ferramenta + conversor jsonSchema
  handlers/   uma classe por dominio; HandlerRegistry roteia por tool name
  templates/  4 temas HTML de email
  utils/      fileManager, attachmentValidator, secret redaction
scripts/
  smoke-test.js          valida contagem de 40 tools
  live-readonly-smoke.js smoke com creds reais (nao corre em CI)
  live-writes-smoke.js   smoke de escrita com creds reais
```

Dominios de handler: `Email`, `Attachment`, `Hybrid` (large-file), `Folder`, `Search`, `Batch`. Ao adicionar uma tool, fique no dominio correto.

## Como rodar / validar

```bash
# build + testes + smoke (obrigatorio antes de PR)
npm run build && npm test && npm run smoke

# cobertura (thresholds: 40% linhas/funcoes/branches)
npm run test:coverage

# typecheck + lint
npm run typecheck && npm run lint

# arquivo especifico (hotfix loop -- rodar o arquivo mais estreito primeiro, nao a suite completa)
npm test -- tests/path/file.test.ts
```

### Testing gates

| Comando | Gate |
|---|---|
| `npm run build && npm test && npm run smoke` | pre-PR -- todos devem passar |
| `npm run test:coverage` | enforces coverage thresholds |
| `node scripts/live-readonly-smoke.js` | smoke de leitura com creds reais -- nao corre em CI |
| `node scripts/live-writes-smoke.js` | smoke de escrita com creds reais -- nao corre em CI |

## Invariantes / regras criticas

Estas sao enforced por CI ou por design. Nao regredir.

1. **40 tools exatamente.** `scripts/smoke-test.js:21` hardcodes `EXPECTED_TOOL_COUNT`. Ao adicionar/remover tool, bump essa constante e a tabela de tools no [README.md](README.md).
2. **Toda tool tem zod schema.** `src/schemas/toolSchemas.ts` e o gate -- `HandlerRegistry.handleTool` roda `validateToolInput` antes de despachar. Nenhum metodo handler executa em args nao-validados.
3. **Acesso a filesystem vai pelo `pathGuard`.** Handlers nunca chamam `fs.readFile` / `fs.writeFile` em paths fornecidos pelo caller diretamente; `src/services/fileManager.ts` e `src/services/emailService.ts` ja roteiam por `pathGuard.resolveSafe()`. Qualquer codigo novo que toque arquivos deve usar a mesma porta.
4. **Chamadas Graph vao pelo `EmailService`.** Sem `Client.api()` direto em handlers -- isso bypassa response caching (`CacheManager`) e os batch helpers. Retry/throttling (429 + `Retry-After`) **nao e custom**: vem do middleware chain do Graph SDK (`Client.initWithMiddleware` em `src/auth/graphAuth.ts`), que inclui o SDK `RetryHandler`. Nao ha rate limiter proprio.
5. **Inputs de template HTML sao escapados por padrao.** `src/templates/` deve manter escaping de campos controlados pelo usuario antes de renderizar. Nao adicionar bypass de HTML confiavel sem sanitizer explicito e testes.

## Gotchas

- `live-readonly-smoke.js` e `live-writes-smoke.js` requerem creds reais e NAO rodam em CI -- use so em dev local com `.env` configurado.
- `path.resolve()` NAO garante o allowlist de filesystem -- sempre `pathGuard.resolveSafe()`.
- Retry 429 vem do SDK `RetryHandler`, nao de codigo proprio -- nao reimplementar.

## Como adicionar uma tool

1. zod schema -> `src/schemas/toolSchemas.ts`
2. metodo handler na classe de dominio correta em `src/handlers/` -- fique no dominio certo
3. case branch em `HandlerRegistry.handleTool`
4. teste unitario em `tests/schemas/toolSchemas.test.ts` (validacao) + teste do handler
5. bump `EXPECTED_TOOL_COUNT` em [scripts/smoke-test.js](scripts/smoke-test.js)
6. adicionar linha na tabela de tools em [README.md](README.md)

## Workflow para mudancas nao-triviais

Referencia canonica: secao [Development workflow](README.md#development-workflow) do README -- plan -> execute task-by-task -> verify diff. Aplicar sempre que a mudanca tocar `src/security/`, credenciais, Graph permission scopes ou abranger multiplos arquivos.

## Anti-patterns

- `fetch()` direto para `graph.microsoft.com` -- rotear pelo `EmailService`.
- `path.resolve()` como passo de "seguranca" -- nao segue symlinks nem valida o allowlist. Usar `pathGuard.resolveSafe(path, 'read' | 'write')`.
- Payloads Base64 >500 KB via `send_email` -- usar as hybrid tools (`send_email_from_attachment`, `send_email_with_file`).
- Linhas de atribuicao AI (`Co-Authored-By: Claude`, `Generated with Claude Code`) em commits ou PRs.
- Comentarios que descrevem o que o codigo faz -- comentar so quando o "por que" nao e obvio.
