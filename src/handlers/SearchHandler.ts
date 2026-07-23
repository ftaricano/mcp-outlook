import { BaseHandler, HandlerResult } from './BaseHandler.js';

export class SearchHandler extends BaseHandler {
  /**
   * Handler for advanced email search with multiple criteria
   */
  async handleAdvancedSearch(args: any): Promise<HandlerResult> {
    const {
      query,
      sender,
      subject,
      dateFrom,
      dateTo,
      hasAttachments,
      isRead,
      folder = 'inbox',
      maxResults = 20,
      maxPages = 10,
      scanLimit = 500,
      sortBy = 'receivedDateTime',
      sortOrder = 'desc',
    } = args;

    // At least one search criterion must be provided
    if (
      !query &&
      !sender &&
      !subject &&
      !dateFrom &&
      !dateTo &&
      hasAttachments === undefined &&
      isRead === undefined
    ) {
      return this.formatError('Pelo menos um critério de busca deve ser especificado');
    }

    try {
      const searchResult = await this.emailService.advancedSearchEmailsDetailed({
        query,
        sender,
        subject,
        dateFrom,
        dateTo,
        hasAttachments,
        isRead,
        folder,
        maxResults,
        maxPages,
        scanLimit,
        sortBy,
        sortOrder,
      });
      const results = searchResult.messages;

      if (searchResult.status === 'SEARCH_FAILED') {
        return this.formatStructuredError(
          '❌ A busca falhou antes de produzir um resultado confiável.',
          searchResult
        );
      }

      if (searchResult.status === 'SEARCH_UNTRUSTED') {
        return this.formatStructuredError(
          '❌ O Microsoft Graph aparentou ignorar o termo e a verificação alternativa falhou.',
          searchResult
        );
      }

      if (searchResult.status === 'SEARCH_INCOMPLETE') {
        return this.formatStructuredSuccess(
          `⚠️ Busca inconclusiva: ${searchResult.candidatesScanned} candidato(s) examinados em ` +
            `${searchResult.pagesScanned} página(s), mas ainda havia resultados por paginar.`,
          searchResult
        );
      }

      if (!results || results.length === 0) {
        return this.formatStructuredSuccess(
          '🔍 Nenhum email encontrado após varredura completa dos critérios especificados',
          searchResult
        );
      }

      let result = `🔍 **Busca Avançada** - ${results.length} email(s) encontrado(s)\n\n`;

      // Add search criteria summary
      result += `**Critérios aplicados:**\n`;
      if (query) result += `• Texto: "${query}"\n`;
      if (sender) result += `• Remetente: ${sender}\n`;
      if (subject) result += `• Assunto contém: ${subject}\n`;
      if (dateFrom) result += `• Data de: ${dateFrom}\n`;
      if (dateTo) result += `• Data até: ${dateTo}\n`;
      if (hasAttachments !== undefined)
        result += `• Com anexos: ${hasAttachments ? 'Sim' : 'Não'}\n`;
      if (isRead !== undefined) result += `• Status: ${isRead ? 'Lido' : 'Não lido'}\n`;
      result += `• Pasta: ${folder}\n`;
      result += `• Ordenação: ${sortBy} (${sortOrder})\n\n`;

      // Display results
      result += `📧 **Resultados:**\n\n`;

      results.forEach((email, index) => {
        const read = email.isRead ? '✓' : '○';
        const hasAttachment = email.hasAttachments ? '📎' : '';
        const preview = email.bodyPreview ? email.bodyPreview.substring(0, 80) + '...' : '';

        result += `${index + 1}. [${read}] ${hasAttachment} **${email.subject || '(Sem assunto)'}**\n`;
        result += `   De: ${email.from?.emailAddress?.address || 'Desconhecido'}\n`;
        result += `   Data: ${email.receivedDateTime ? new Date(email.receivedDateTime).toLocaleString('pt-BR') : 'Data desconhecida'}\n`;
        if (preview) {
          result += `   Preview: ${preview}\n`;
        }
        result += `   ID: ${email.id}\n\n`;
      });

      result +=
        `**Evidência da busca:** ${searchResult.strategy}, ` +
        `${searchResult.pagesScanned} página(s), ` +
        `${searchResult.candidatesScanned} candidato(s), ` +
        `confiança ${searchResult.confidence}.\n`;

      return this.formatStructuredSuccess(result, searchResult);
    } catch (error) {
      return this.formatError('Erro na busca avançada', error);
    }
  }

  /**
   * Handler for searching emails by sender domain
   */
  async handleSearchBySenderDomain(args: any): Promise<HandlerResult> {
    const { domain, maxResults = 20, includeSubdomains = true, folder = 'inbox', dateRange } = args;

    try {
      const results = await this.emailService.searchEmailsBySenderDomain(domain, {
        maxResults,
        includeSubdomains,
        folder,
        dateRange,
      });

      if (!results || results.length === 0) {
        return this.formatStructuredSuccess(
          `🔍 Nenhum email do domínio ${domain} encontrado dentro do limite examinado.`,
          {
            status: 'SEARCH_INCOMPLETE',
            confidence: 'low',
            warnings: ['bounded_scan_no_match'],
            resultCount: 0,
            results: [],
            domain,
          }
        );
      }

      // Group by sender
      const senderGroups = new Map();
      results.forEach((email) => {
        const senderEmail = email.from?.emailAddress?.address || 'Desconhecido';
        if (!senderGroups.has(senderEmail)) {
          senderGroups.set(senderEmail, []);
        }
        senderGroups.get(senderEmail).push(email);
      });

      let result = `🏢 **Emails do domínio "${domain}"** - ${results.length} email(s) encontrado(s)\n\n`;
      result += `📊 **Estatísticas:**\n`;
      result += `• Total de remetentes únicos: ${senderGroups.size}\n`;
      result += `• Incluir subdomínios: ${includeSubdomains ? 'Sim' : 'Não'}\n`;
      result += `• Pasta: ${folder}\n\n`;

      result += `👥 **Por Remetente:**\n\n`;

      // Sort by email count
      const sortedSenders = Array.from(senderGroups.entries()).sort(
        (a, b) => b[1].length - a[1].length
      );

      sortedSenders.forEach(([sender, emails], index) => {
        result += `${index + 1}. **${sender}** (${emails.length} email${emails.length > 1 ? 's' : ''})\n`;

        // Show last 3 emails from this sender
        const recentEmails = emails.slice(0, 3);
        recentEmails.forEach((email: any) => {
          const read = email.isRead ? '✓' : '○';
          const date = email.receivedDateTime
            ? new Date(email.receivedDateTime).toLocaleDateString('pt-BR')
            : 'N/A';
          result += `   [${read}] ${email.subject || '(Sem assunto)'} - ${date}\n`;
        });

        if (emails.length > 3) {
          result += `   ... e mais ${emails.length - 3} email(s)\n`;
        }
        result += '\n';
      });

      return this.formatStructuredSuccess(result, {
        status: 'FOUND',
        resultCount: results.length,
        results,
        domain,
        includeSubdomains,
      });
    } catch (error) {
      return this.formatError('Erro na busca por domínio', error);
    }
  }

  /**
   * Handler for searching emails with specific attachments
   */
  async handleSearchByAttachmentType(args: any): Promise<HandlerResult> {
    const { fileTypes, maxResults = 20, folder = 'inbox', sizeLimit, dateRange } = args;

    const typesArray = Array.isArray(fileTypes) ? fileTypes : [fileTypes];

    try {
      const results = await this.emailService.searchEmailsByAttachmentType(typesArray, {
        maxResults,
        folder,
        sizeLimit,
        dateRange,
      });

      if (!results || results.length === 0) {
        return this.formatStructuredSuccess(
          `📎 Nenhum email com anexos do tipo ${typesArray.join(', ')} encontrado dentro do limite examinado.`,
          {
            status: 'SEARCH_INCOMPLETE',
            confidence: 'low',
            warnings: ['bounded_scan_no_match'],
            resultCount: 0,
            results: [],
            fileTypes: typesArray,
          }
        );
      }

      // Analyze attachment types
      const attachmentStats = new Map();
      let totalAttachments = 0;

      for (const email of results) {
        const attachments = await this.emailService.listAttachments(email.id!);
        totalAttachments += attachments.length;

        attachments.forEach((att) => {
          const type = att.contentType || 'unknown';
          attachmentStats.set(type, (attachmentStats.get(type) || 0) + 1);
        });
      }

      let result = `📎 **Emails com anexos específicos** - ${results.length} email(s) encontrado(s)\n\n`;
      result += `📊 **Estatísticas:**\n`;
      result += `• Tipos procurados: ${typesArray.join(', ')}\n`;
      result += `• Total de anexos: ${totalAttachments}\n`;
      result += `• Pasta: ${folder}\n`;
      if (sizeLimit) {
        result += `• Limite de tamanho: ${sizeLimit}MB\n`;
      }
      result += '\n';

      result += `📈 **Tipos de anexo encontrados:**\n`;
      const sortedTypes = Array.from(attachmentStats.entries()).sort((a, b) => b[1] - a[1]);

      sortedTypes.forEach(([type, count]) => {
        result += `• ${type}: ${count} anexo(s)\n`;
      });
      result += '\n';

      result += `📧 **Emails encontrados:**\n\n`;

      for (let i = 0; i < Math.min(results.length, 10); i++) {
        const email = results[i];
        const read = email.isRead ? '✓' : '○';
        const date = email.receivedDateTime
          ? new Date(email.receivedDateTime).toLocaleDateString('pt-BR')
          : 'N/A';

        result += `${i + 1}. [${read}] **${email.subject || '(Sem assunto)'}**\n`;
        result += `   De: ${email.from?.emailAddress?.address || 'Desconhecido'}\n`;
        result += `   Data: ${date}\n`;

        // Show attachment details
        const attachments = await this.emailService.listAttachments(email.id!);
        const relevantAttachments = attachments.filter((att) =>
          typesArray.some((type) => att.contentType?.includes(type))
        );

        if (relevantAttachments.length > 0) {
          result += `   📎 Anexos relevantes: ${relevantAttachments.map((att) => att.name).join(', ')}\n`;
        }

        result += `   ID: ${email.id}\n\n`;
      }

      if (results.length > 10) {
        result += `... e mais ${results.length - 10} email(s)\n`;
      }

      return this.formatStructuredSuccess(result, {
        status: 'FOUND',
        resultCount: results.length,
        results,
        fileTypes: typesArray,
        totalAttachments,
        attachmentTypes: Object.fromEntries(attachmentStats),
      });
    } catch (error) {
      return this.formatError('Erro na busca por tipo de anexo', error);
    }
  }

  /**
   * Handler for searching duplicate emails
   */
  async handleFindDuplicateEmails(args: any): Promise<HandlerResult> {
    const {
      criteria = 'subject',
      folder = 'inbox',
      maxResults = 50,
      includeRead = true,
      dateRange,
    } = args;

    try {
      const duplicates = await this.emailService.findDuplicateEmails({
        criteria,
        folder,
        maxResults,
        includeRead,
        dateRange,
      });

      if (!duplicates || duplicates.length === 0) {
        return this.formatStructuredSuccess(
          '🔍 Nenhum email duplicado encontrado dentro do limite examinado.',
          {
            status: 'SEARCH_INCOMPLETE',
            confidence: 'low',
            warnings: ['bounded_scan_no_match'],
            groupCount: 0,
            groups: [],
            criteria,
          }
        );
      }

      let result = `🔄 **Emails Duplicados** - ${duplicates.length} grupo(s) encontrado(s)\n\n`;
      result += `📊 **Critério de duplicação:** ${criteria}\n`;
      result += `📁 **Pasta:** ${folder}\n\n`;

      let totalDuplicateEmails = 0;
      duplicates.forEach((group, index) => {
        totalDuplicateEmails += group.emails.length;

        result += `${index + 1}. **Grupo:** ${group.key}\n`;
        result += `   📧 ${group.emails.length} emails duplicados\n`;

        // Show details of each duplicate
        group.emails.forEach((email: any, emailIndex: number) => {
          const read = email.isRead ? '✓' : '○';
          const date = email.receivedDateTime
            ? new Date(email.receivedDateTime).toLocaleDateString('pt-BR')
            : 'N/A';

          result += `   ${emailIndex + 1}. [${read}] De: ${email.from?.emailAddress?.address || 'Desconhecido'} - ${date}\n`;
          result += `      ID: ${email.id}\n`;
        });

        result += '\n';
      });

      result += `📈 **Resumo:**\n`;
      result += `• Total de emails duplicados: ${totalDuplicateEmails}\n`;
      result += `• Potencial economia de espaço: ~${(totalDuplicateEmails * 0.1).toFixed(1)}MB\n`;
      result += `\n💡 Use 'delete_email' ou 'move_emails_to_folder' para organizar os duplicados`;

      return this.formatStructuredSuccess(result, {
        status: 'FOUND',
        groupCount: duplicates.length,
        groups: duplicates,
        criteria,
        totalDuplicateEmails,
      });
    } catch (error) {
      return this.formatError('Erro na busca por duplicados', error);
    }
  }

  /**
   * Handler for searching emails by size range
   */
  async handleSearchBySize(args: any): Promise<HandlerResult> {
    const {
      minSizeMB,
      maxSizeMB,
      folder = 'inbox',
      maxResults = 20,
      includeAttachments = true,
    } = args;

    if (!minSizeMB && !maxSizeMB) {
      return this.formatError('Especifique pelo menos minSizeMB ou maxSizeMB');
    }

    try {
      const results = await this.emailService.searchEmailsBySize({
        minSizeMB,
        maxSizeMB,
        folder,
        maxResults,
        includeAttachments,
      });

      if (!results || results.length === 0) {
        const sizeRange = `${minSizeMB || 0}MB - ${maxSizeMB || '∞'}MB`;
        return this.formatStructuredSuccess(
          `📏 Nenhum email no intervalo de tamanho ${sizeRange} encontrado dentro do limite examinado.`,
          {
            status: 'SEARCH_INCOMPLETE',
            confidence: 'low',
            warnings: ['bounded_scan_no_match'],
            resultCount: 0,
            results: [],
            minSizeMB: minSizeMB ?? 0,
            maxSizeMB: maxSizeMB ?? null,
          }
        );
      }

      // Calculate total size (Microsoft Graph doesn't expose size directly, estimate based on content)
      const totalSizeMB = results.length * 0.05; // Estimate 50KB per email

      let result = `📏 **Emails por Tamanho** - ${results.length} email(s) encontrado(s)\n\n`;
      result += `📊 **Critérios:**\n`;
      if (minSizeMB) result += `• Tamanho mínimo: ${minSizeMB}MB\n`;
      if (maxSizeMB) result += `• Tamanho máximo: ${maxSizeMB}MB\n`;
      result += `• Pasta: ${folder}\n`;
      result += `• Incluir anexos: ${includeAttachments ? 'Sim' : 'Não'}\n`;
      result += `• Tamanho total: ${totalSizeMB.toFixed(2)}MB\n\n`;

      result += `📧 **Emails encontrados:**\n\n`;

      // Sort by received date (most recent first) since size is not available
      results.sort((a, b) => {
        const dateA = new Date(a.receivedDateTime || 0);
        const dateB = new Date(b.receivedDateTime || 0);
        return dateB.getTime() - dateA.getTime();
      });

      results.forEach((email, index) => {
        const read = email.isRead ? '✓' : '○';
        const hasAttachment = email.hasAttachments ? '📎' : '';
        const estimatedSizeMB = hasAttachment ? '0.2-1.0' : '0.01-0.05'; // Estimate based on attachments
        const date = email.receivedDateTime
          ? new Date(email.receivedDateTime).toLocaleDateString('pt-BR')
          : 'N/A';

        result += `${index + 1}. [${read}] ${hasAttachment} **${email.subject || '(Sem assunto)'}**\n`;
        result += `   De: ${email.from?.emailAddress?.address || 'Desconhecido'}\n`;
        result += `   Data: ${date}\n`;
        result += `   Tamanho estimado: ${estimatedSizeMB}MB\n`;
        result += `   ID: ${email.id}\n\n`;
      });

      return this.formatStructuredSuccess(result, {
        status: 'FOUND',
        resultCount: results.length,
        results,
        minSizeMB: minSizeMB ?? 0,
        maxSizeMB: maxSizeMB ?? null,
      });
    } catch (error) {
      return this.formatError('Erro na busca por tamanho', error);
    }
  }

  /**
   * Handler for saved search operations
   */
  async handleSavedSearches(args: any): Promise<HandlerResult> {
    const { action, name, searchCriteria } = args;

    try {
      switch (action) {
        case 'save':
          if (!name || !searchCriteria) {
            return this.formatError('Nome e critérios de busca são obrigatórios para salvar');
          }

          await this.emailService.saveSearchCriteria(name, searchCriteria);
          return this.formatStructuredSuccess(
            `💾 Busca salva: "${name}"\n\nCritérios salvos:\n${JSON.stringify(searchCriteria, null, 2)}`,
            {
              action: 'save',
              status: 'SAVED',
              name,
              criteria: searchCriteria,
            }
          );

        case 'list':
          const savedSearches = await this.emailService.listSavedSearches();

          if (savedSearches.length === 0) {
            return this.formatStructuredSuccess('📂 Nenhuma busca salva encontrada', {
              action: 'list',
              status: 'NOT_FOUND',
              savedSearches: [],
            });
          }

          let result = `📂 **Buscas Salvas** (${savedSearches.length}):\n\n`;
          savedSearches.forEach((search, index) => {
            result += `${index + 1}. **${search.name}**\n`;
            result += `   Criada: ${search.created}\n`;
            result += `   Critérios: ${Object.keys(search.criteria).join(', ')}\n\n`;
          });

          return this.formatStructuredSuccess(result, {
            action: 'list',
            status: 'FOUND',
            savedSearches,
          });

        case 'execute':
          if (!name) {
            return this.formatError('Nome da busca é obrigatório para executar');
          }

          const searchResult = await this.emailService.executeSavedSearch(name);

          if (!searchResult) {
            return this.formatError(`Busca salva "${name}" não encontrada`);
          }

          if (searchResult.evidence.status === 'SEARCH_INCOMPLETE') {
            return this.formatStructuredSuccess(
              `⚠️ Busca salva "${name}" inconclusiva dentro dos limites examinados.`,
              {
                action: 'execute',
                status: searchResult.evidence.status,
                name,
                criteria: searchResult.criteria,
                resultCount: 0,
                results: [],
                evidence: searchResult.evidence,
              }
            );
          }

          if (
            searchResult.evidence.status === 'SEARCH_FAILED' ||
            searchResult.evidence.status === 'SEARCH_UNTRUSTED'
          ) {
            return this.formatStructuredError(
              `❌ Busca salva "${name}" não produziu resultado confiável.`,
              {
                action: 'execute',
                status: searchResult.evidence.status,
                name,
                criteria: searchResult.criteria,
                resultCount: 0,
                results: [],
                evidence: searchResult.evidence,
              }
            );
          }

          let execResult = `🔍 **Executando busca salva: "${name}"**\n\n`;
          execResult += `📧 ${searchResult.emails.length} email(s) encontrado(s)\n\n`;

          searchResult.emails.slice(0, 10).forEach((email, index) => {
            const read = email.isRead ? '✓' : '○';
            execResult += `${index + 1}. [${read}] ${email.subject || '(Sem assunto)'}\n`;
            execResult += `   De: ${email.from?.emailAddress?.address || 'Desconhecido'}\n\n`;
          });

          if (searchResult.emails.length > 10) {
            execResult += `... e mais ${searchResult.emails.length - 10} email(s)\n`;
          }

          return this.formatStructuredSuccess(execResult, {
            action: 'execute',
            status: searchResult.emails.length > 0 ? 'FOUND' : 'NOT_FOUND',
            name,
            criteria: searchResult.criteria,
            resultCount: searchResult.emails.length,
            results: searchResult.emails,
            evidence: searchResult.evidence,
          });

        case 'delete':
          if (!name) {
            return this.formatError('Nome da busca é obrigatório para deletar');
          }

          const deleted = await this.emailService.deleteSavedSearch(name);
          return this.formatStructuredSuccess(
            deleted
              ? `🗑️ Busca salva "${name}" deletada com sucesso`
              : `📂 Busca salva "${name}" não encontrada`,
            {
              action: 'delete',
              status: deleted ? 'DELETED' : 'NOT_FOUND',
              name,
            }
          );

        default:
          return this.formatError('Ação inválida. Use: save, list, execute, delete');
      }
    } catch (error) {
      return this.formatError('Erro nas buscas salvas', error);
    }
  }
}
