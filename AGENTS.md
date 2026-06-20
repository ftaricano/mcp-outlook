# AGENTS.md -- mcp-outlook

As regras operacionais deste repo sao canonicas em [CLAUDE.md](CLAUDE.md) (fonte unica para Claude/Codex/Hermes). Leia-o antes de tocar em codigo.

TL;DR das invariantes:
- **40 tools exatamente** -- qualquer adicao/remocao exige bump em `EXPECTED_TOOL_COUNT` (smoke-test.js) e na tabela do README
- **Todo input de tool passa por zod** -- `HandlerRegistry.handleTool` valida antes de despachar; nunca bypassar
- **Filesystem so via `pathGuard.resolveSafe()`** -- `path.resolve()` nao valida o allowlist
- **Graph so via `EmailService`** -- chamadas diretas ao SDK bypassam cache e batch helpers
- **Templates HTML escapam inputs** -- nao adicionar bypass de HTML confiavel sem sanitizer e testes

Validar: `npm run build && npm test && npm run smoke`
