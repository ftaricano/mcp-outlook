# Spec — Alinhar invariantes doc↔código: remover robustez morta + fechar secret-leak

**Data:** 2026-06-13
**Branch:** `feat/align-invariants-remove-deadcode`
**Goal (Linear):** [JAR-316](https://linear.app/jarvis-ferd/issue/JAR-316/mcp-outlook-alinhar-invariantes-doc-codigo-remover)
**Origem:** project-improver F5 — melhoria #1 do menu, decisões travadas na F4.

> Este spec é o **contrato**. A implementação (TDD) é avaliada *contra ele* no review (Codex senior / fallback Claude reviewer). Escopo divergente → re-formalizar antes de seguir.

## Objetivo

Eliminar o gap entre invariantes **documentados** e o **código real** do `mcp-outlook`:

1. Remover ~700 LOC de dead code que anuncia proteções inexistentes (`RateLimiter`, `ErrorHandler`).
2. Corrigir doc (`CLAUDE.md` invariante #4 + README) para creditar a fonte **real** de retry/throttle: o default middleware do Graph SDK.
3. Fechar um **secret-leak real e vivo**: o `formatError` em uso emite `error.message` cru no output MCP — extrair e aplicar mascaramento de segredo.
4. Remover o `validateRequiredArgs` no-op (Zod já valida no dispatch), **preservando** o comportamento de rejeição de entrada vazia.

## Contexto / evidência (verificado, não de memória)

- `RateLimiter.ts` e `ErrorHandler.ts`: **zero imports em `src/`** (só os próprios testes). `grep -rn "RateLimiter\|ErrorHandler" src/ --include="*.ts" | grep -v test` → vazio.
- `src/auth/graphAuth.ts:87` usa `Client.initWithMiddleware({ authProvider: this })` sem cadeia custom → usa a **default middleware chain** do SDK, que instancia `RetryHandler` (`node_modules/@microsoft/microsoft-graph-client/lib/src/middleware/MiddlewareFactory.js:42`). O RetryHandler respeita o header `Retry-After` em 429/503. Logo: **retry já existe e é superior** ao `RateLimiter.executeWithRetry` (`RateLimiter.ts:82-86`), que ignora `Retry-After` e usa backoff calculado. Wire-up seria **retry duplicado e pior**.
- `src/handlers/BaseHandler.ts:32` (`formatError`, em uso por ~94 sites): emite `` `❌ ${message}: ${errorMessage}` `` com `error.message` **cru**. Se um erro do Graph trouxer token/email na mensagem, vaza pro cliente MCP.
- `src/utils/ErrorHandler.ts:350` (`createSafeErrorMessage`): mascara email/token/senha por regex — **nunca é chamado** (nem pelo próprio `formatForMCP`).
- Precedente do repo: `BaseHandler.ts:16-22` documenta que um `SecurityManager`/`MCPBestPractices` já foi **deletado** no "P0 cleanup" *"to stop advertising security features that did not exist."* A régua local é deletar o que mente.
- `validateRequiredArgs` (`BaseHandler.ts:57`): comentário admite ser "effectively a no-op"; 28 call-sites nos 6 handlers (Folder 6, Batch 5, Email 7, Attachment 6, Hybrid 2, Search 2). **Sutileza:** ele rejeita string vazia (`v === ''`) e `null`/`undefined` — o Zod só rejeita `''` se o campo tiver `.min(1)`. Remover o helper **sem** endurecer os schemas afrouxaria a validação.

## Escopo (o que muda)

1. **Deletar** `src/utils/RateLimiter.ts` + `tests/utils/RateLimiter.test.ts`.
2. **Deletar** `src/utils/ErrorHandler.ts` (359 LOC; sem teste dedicado — confirmar antes).
3. **Extrair** `redactSecrets(message: string): string` (regex de email / token base64 ≥20 / `password:=`) num módulo pequeno (`src/utils/redactSecrets.ts`) e **aplicá-lo no `BaseHandler.formatError`** ao montar o texto de erro. Assinatura de `formatError` inalterada.
4. **Remover** `validateRequiredArgs` de `BaseHandler` + os 28 call-sites. **Pré-requisito:** auditar, para cada campo passado ao helper, o schema zod correspondente em `src/schemas/toolSchemas.ts`; onde um campo `required` aceitar `''` (string) ou `[]` (array), **adicionar `.min(1)`** antes de remover o call-site. Endurecer, nunca afrouxar.
5. **Corrigir `CLAUDE.md`** invariante #4: declarar que **retry/throttling vêm do default middleware do Graph SDK** (`initWithMiddleware`) e caching do `CacheManager`; remover a implicação de rate-limiter/error-contract custom.
6. **Corrigir README** linhas 153, 159, 167, 201: remover "rate limiting" custom; creditar o retry/backoff ao SDK middleware; tirar "rate limiter" da lista de utils.

## Critério de pronto (testável — cada item é um comando/observação)

- [ ] `npm run build` limpo (tsc, strict).
- [ ] `npm test` verde; suite **não regride** (baseline: 235 passed / 1 skipped) — exceto a remoção esperada do `RateLimiter.test.ts`.
- [ ] `npm run smoke` verde — **40 tools mantidos** (esta mudança não toca a contagem).
- [ ] `npm run lint` e `npm run format:check` verdes.
- [ ] `grep -rn "RateLimiter\|ErrorHandler\|validateRequiredArgs" src/` → **zero** ocorrências.
- [ ] Novo teste `tests/utils/redactSecrets.test.ts`: mascara email→`[email]`, token base64≥20→`[token]`, `password: x`→hidden, e **deixa string limpa intacta**.
- [ ] Teste de não-vazamento: `formatError('falhou', new Error('token AKIA...<base64> de a@b.com'))` produz texto **sem** o token nem o email crus.
- [ ] Teste de validação preservada: para ≥3 campos antes cobertos pelo helper (1 string ex. `folderName`, 1 array ex. `emailIds`), input `''`/`[]` é **rejeitado** pela validação zod via `HandlerRegistry.handleTool` (mensagem de erro de validação).
- [ ] Doc: `grep -niE "rate.?limit" README.md CLAUDE.md` não afirma rate-limiting custom (só credita SDK ou caching real).

## Interfaces / contratos tocados

- `BaseHandler.formatError(message, error?)`: **assinatura inalterada** → `HandlerResult`. Muda só o comportamento observável: texto de erro mascarado.
- `BaseHandler`: remove o método `validateRequiredArgs`. Handlers param de chamá-lo.
- `src/schemas/toolSchemas.ts`: possíveis adições de `.min(1)` em campos string/array `required` (endurecimento). Documentar no PR **quais** campos mudaram.
- `src/utils/redactSecrets.ts`: novo módulo público interno (1 função pura).
- `CLAUDE.md` / `README.md`: texto dos invariantes.

## Out of scope (explícito)

- ❌ Quebrar o god-object `EmailService` (menu #7).
- ❌ Tool registry data-driven / `z.infer` (menu #3).
- ❌ Mexer no coverage threshold/escopo (menu #2).
- ❌ Adicionar/remover tool ou mudar a contagem de 40.
- ❌ Tocar `pathGuard`/`odataFilters`/templates (já hardened nos rounds 1-2).
- ❌ Adicionar throttle preventivo client-side (`checkRateLimit` é descartado junto — decisão F4).

## Riscos

1. **(MÉDIO — foco do review) Afrouxar validação** ao remover `validateRequiredArgs`. Mitigação: auditoria campo-a-campo + `.min(1)` + teste de rejeição de vazio. É o ponto que o Codex deve provar.
2. **(BAIXO) `redactSecrets` sobre-mascarar**: o regex de token (base64 ≥20) pode mascarar IDs longos de mensagem/anexo no texto de **erro**. Aceitável (fail-safe: mascarar a mais num erro não quebra função). Documentar; restringir o regex se ficar ruidoso.
3. **(BAIXO) Import dinâmico de `ErrorHandler`/`RateLimiter`**: improvável (grep limpo). `npm run build` + `smoke` confirmam.

## Plano de teste (TDD red→green)

1. (RED) `redactSecrets.test.ts` — casos email/token/password/limpo.
2. (GREEN) implementar `redactSecrets` + plugar no `formatError`. Teste de não-vazamento.
3. (RED) teste de validação: campo string `''` e array `[]` rejeitados via `HandlerRegistry`.
4. (GREEN) endurecer schemas (`.min(1)`) onde faltar; remover `validateRequiredArgs` + 28 call-sites.
5. Deletar `RateLimiter`/`ErrorHandler` + teste órfão.
6. Corrigir `CLAUDE.md` + README.
7. `build` + `test` + `smoke` + `lint` + `format:check` + grep de confirmação.

## Pontos de atenção para o gate (Codex senior / fallback)

- Provar **campo a campo** que nenhuma validação foi afrouxada (risco #1).
- Confirmar que nenhum retry/throttle **real** foi perdido (o SDK middleware cobre — citar evidência).
- `redactSecrets` aplicado em **todos** os caminhos de erro do `formatError`, não em alguns.
