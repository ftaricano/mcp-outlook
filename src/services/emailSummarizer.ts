import { Message } from '@microsoft/microsoft-graph-types';
import { EmailService } from './emailService.js';

export interface EmailSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  priority: 'alta' | 'média' | 'baixa';
  category: string;
  summary: string;
  keyPoints: string[];
  actionRequired: boolean;
  attachments?: string[];
  sentiment: 'positivo' | 'neutro' | 'negativo';
}

export class EmailSummarizer {
  
  async summarizeEmail(email: Message): Promise<EmailSummary> {
    const bodyContent = email.body?.content || '';
    const plainTextBody = this.extractPlainText(bodyContent);
    const subject = email.subject || 'Sem assunto';
    
    return {
      id: email.id || '',
      subject,
      from: email.from?.emailAddress?.address || 'Remetente desconhecido',
      date: this.formatDate(email.receivedDateTime || undefined),
      priority: this.determinePriority(subject, plainTextBody),
      category: this.categorizeEmail(subject, plainTextBody),
      summary: this.generateSummary(plainTextBody, subject),
      keyPoints: this.extractKeyPoints(plainTextBody, subject),
      actionRequired: this.requiresAction(plainTextBody, subject),
      attachments: this.extractAttachments(email),
      sentiment: this.analyzeSentiment(plainTextBody)
    };
  }

  async summarizeEmailsBatch(emailIds: string[], emailService: EmailService): Promise<EmailSummary[]> {
    const summaries: EmailSummary[] = [];
    
    for (const emailId of emailIds) {
      try {
        const email = await emailService.getEmailById(emailId);
        const summary = await this.summarizeEmail(email);
        summaries.push(summary);
      } catch (error) {
        console.error(`Erro ao resumir email ${emailId}:`, error);
        // Continua com os próximos emails mesmo se um falhar
      }
    }
    
    return summaries;
  }

  private extractPlainText(htmlContent: string): string {
    return htmlContent
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 2000); // Limita o tamanho para processamento eficiente
  }

  private formatDate(dateString?: string): string {
    if (!dateString) return 'Data desconhecida';
    
    const date = new Date(dateString);
    return date.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  private determinePriority(subject: string, body: string): 'alta' | 'média' | 'baixa' {
    const highPriorityWords = [
      'urgente', 'critical', 'importante', 'asap', 'emergência',
      'prazo', 'deadline', 'imediato', 'prioridade alta'
    ];
    
    const mediumPriorityWords = [
      'reunião', 'meeting', 'revisão', 'feedback', 'aprovação',
      'pendente', 'aguardando', 'confirmar'
    ];

    const text = (subject + ' ' + body).toLowerCase();

    if (highPriorityWords.some(word => text.includes(word))) {
      return 'alta';
    } else if (mediumPriorityWords.some(word => text.includes(word))) {
      return 'média';
    }
    
    return 'baixa';
  }

  private categorizeEmail(subject: string, body: string): string {
    const text = (subject + ' ' + body).toLowerCase();
    
    const categories = [
      { name: 'Reunião', keywords: ['reunião', 'meeting', 'chamada', 'videoconferência'] },
      { name: 'Projeto', keywords: ['projeto', 'task', 'entrega', 'desenvolvimento'] },
      { name: 'Financeiro', keywords: ['orçamento', 'pagamento', 'fatura', 'custo'] },
      { name: 'RH', keywords: ['recursos humanos', 'contratação', 'folha', 'benefícios'] },
      { name: 'Marketing', keywords: ['marketing', 'campanha', 'promoção', 'evento'] },
      { name: 'Suporte', keywords: ['suporte', 'problema', 'bug', 'erro', 'ajuda'] },
      { name: 'Vendas', keywords: ['venda', 'cliente', 'proposta', 'contrato'] },
      { name: 'Notificação', keywords: ['notificação', 'alerta', 'lembrete', 'aviso'] }
    ];

    for (const category of categories) {
      if (category.keywords.some(keyword => text.includes(keyword))) {
        return category.name;
      }
    }

    return 'Geral';
  }

  private generateSummary(body: string, subject: string): string {
    if (body.length < 100) {
      return body;
    }

    // Pega as primeiras 2-3 sentenças que contenham informação relevante
    const sentences = body.split(/[.!?]+/).filter(s => s.trim().length > 10);
    let summary = sentences.slice(0, 3).join('. ').trim();
    
    if (summary.length > 300) {
      summary = summary.substring(0, 300) + '...';
    }
    
    return summary || 'Resumo não disponível';
  }

  private extractKeyPoints(body: string, subject: string): string[] {
    const keyPoints: string[] = [];
    
    // Busca por listas numeradas ou com bullets
    const listMatches = body.match(/(?:^\s*[-•*]\s+.+$|^\s*\d+[\.)]\s+.+$)/gm);
    if (listMatches) {
      keyPoints.push(...listMatches.map(item => item.trim()).slice(0, 5));
    }
    
    // Busca por datas
    const dateMatches = body.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b\d{1,2} de \w+ de \d{4}\b/g);
    if (dateMatches) {
      keyPoints.push(`Datas mencionadas: ${dateMatches.slice(0, 3).join(', ')}`);
    }
    
    // Busca por valores monetários
    const moneyMatches = body.match(/R\$\s*\d+(?:[\.,]\d{3})*(?:[\.,]\d{2})?|\$\s*\d+(?:[\.,]\d{3})*(?:[\.,]\d{2})?/g);
    if (moneyMatches) {
      keyPoints.push(`Valores: ${moneyMatches.slice(0, 3).join(', ')}`);
    }

    // Se não encontrou pontos específicos, pega sentenças importantes
    if (keyPoints.length === 0) {
      const sentences = body.split(/[.!?]+/).filter(s => s.trim().length > 20);
      const importantSentences = sentences.filter(sentence => {
        const lowerSentence = sentence.toLowerCase();
        return lowerSentence.includes('importante') ||
               lowerSentence.includes('necessário') ||
               lowerSentence.includes('preciso') ||
               lowerSentence.includes('deve');
      });
      keyPoints.push(...importantSentences.slice(0, 3));
    }
    
    return keyPoints.slice(0, 5);
  }

  private requiresAction(body: string, subject: string): boolean {
    const actionWords = [
      'favor', 'por favor', 'solicito', 'preciso', 'necessário',
      'confirme', 'responda', 'envie', 'aprove', 'revise',
      'urgente', 'prazo', 'deadline', 'aguardando', 'pendente'
    ];
    
    const text = (subject + ' ' + body).toLowerCase();
    return actionWords.some(word => text.includes(word));
  }

  private extractAttachments(email: Message): string[] | undefined {
    if (!email.hasAttachments || !email.attachments) {
      return undefined;
    }
    
    return email.attachments
      .map((att: any) => att.name)
      .filter(Boolean)
      .slice(0, 10);
  }

  private analyzeSentiment(body: string): 'positivo' | 'neutro' | 'negativo' {
    const positiveWords = [
      'obrigado', 'parabéns', 'excelente', 'ótimo', 'sucesso',
      'aprovado', 'satisfeito', 'feliz', 'positivo'
    ];
    
    const negativeWords = [
      'problema', 'erro', 'falha', 'atrasado', 'cancelado',
      'rejeitado', 'insatisfeito', 'preocupado', 'urgente'
    ];
    
    const text = body.toLowerCase();
    
    const positiveCount = positiveWords.filter(word => text.includes(word)).length;
    const negativeCount = negativeWords.filter(word => text.includes(word)).length;
    
    if (positiveCount > negativeCount) return 'positivo';
    if (negativeCount > positiveCount) return 'negativo';
    return 'neutro';
  }
}