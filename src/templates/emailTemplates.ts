/**
 * Sistema de Templates HTML para emails elegantes e responsivos
 * Compatível com todos os principais clientes de email (Outlook, Gmail, Apple Mail, etc.)
 */

export interface EmailTemplateOptions {
  theme?: 'professional' | 'modern' | 'minimal' | 'corporate';
  showHeader?: boolean;
  showFooter?: boolean;
  accentColor?: string;
  logoUrl?: string;
  companyName?: string;
}

export interface EmailContent {
  title?: string;
  body: string;
  signature?: string;
  attachmentList?: string[];
  metadata?: {
    sender?: string;
    date?: string;
    originalSubject?: string;
  };
}

export class EmailTemplateEngine {
  
  /**
   * Template principal responsivo compatível com todos os clientes
   */
  private getBaseTemplate(): string {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:AllowPNG/>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style type="text/css">
    /* Reset e base */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    img { border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    table { border-collapse: collapse !important; }
    body, #bodyTable { height: 100% !important; margin: 0; padding: 0; width: 100% !important; }
    
    /* Responsivo */
    @media only screen and (max-width: 640px) {
      .email-container { width: 100% !important; }
      .content-padding { padding: 15px !important; }
      .mobile-center { text-align: center !important; }
      .mobile-stack { display: block !important; width: 100% !important; }
    }
    
    /* Dark mode */
    @media (prefers-color-scheme: dark) {
      .dark-bg { background-color: #1a1a1a !important; }
      .dark-text { color: #ffffff !important; }
      .dark-border { border-color: #333333 !important; }
    }
    
    /* Outlook específico */
    <!--[if mso]>
    .outlook-font { font-family: Arial, sans-serif !important; }
    <![endif]-->
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f4f4;">
  <!--[if mso | IE]>
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f4f4f4;">
  <tr><td>
  <![endif]-->
  
  <div style="background-color: #f4f4f4; padding: 20px 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      <tr>
        <td align="center">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" class="email-container" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            {{HEADER}}
            {{CONTENT}}
            {{FOOTER}}
          </table>
        </td>
      </tr>
    </table>
  </div>
  
  <!--[if mso | IE]>
  </td></tr>
  </table>
  <![endif]-->
</body>
</html>`;
  }

  /**
   * Template para envio de emails novos
   */
  public formatNewEmail(content: EmailContent, options: EmailTemplateOptions = {}): string {
    const theme = this.getTheme(options.theme || 'professional');
    let template = this.getBaseTemplate();
    
    // Substituir componentes
    template = template.replace('{{HEADER}}', options.showHeader !== false ? this.getHeader(theme, options) : '');
    template = template.replace('{{CONTENT}}', this.getMainContent(content, theme));
    template = template.replace('{{FOOTER}}', options.showFooter !== false ? this.getFooter(theme, options) : '');
    
    return template;
  }

  /**
   * Template para emails de resposta/encaminhamento
   */
  public formatReplyEmail(content: EmailContent, originalContent: EmailContent, options: EmailTemplateOptions = {}): string {
    const theme = this.getTheme(options.theme || 'professional');
    let template = this.getBaseTemplate();
    
    // Conteúdo da resposta
    const replyContent = this.getMainContent(content, theme);
    
    // Conteúdo original com separador
    const originalSection = this.getOriginalEmailSection(originalContent, theme);
    
    const combinedContent = `${replyContent}${originalSection}`;
    
    template = template.replace('{{HEADER}}', options.showHeader !== false ? this.getHeader(theme, options) : '');
    template = template.replace('{{CONTENT}}', combinedContent);
    template = template.replace('{{FOOTER}}', options.showFooter !== false ? this.getFooter(theme, options) : '');
    
    return template;
  }

  /**
   * Temas de cores e estilos
   */
  private getTheme(themeName: string) {
    const themes = {
      professional: {
        primary: '#2c5aa0',
        secondary: '#f8f9fa',
        accent: '#28a745',
        text: '#333333',
        textLight: '#666666',
        border: '#e9ecef'
      },
      modern: {
        primary: '#6366f1',
        secondary: '#f1f5f9',
        accent: '#10b981',
        text: '#1e293b',
        textLight: '#64748b',
        border: '#e2e8f0'
      },
      minimal: {
        primary: '#000000',
        secondary: '#fafafa',
        accent: '#0070f3',
        text: '#000000',
        textLight: '#666666',
        border: '#eaeaea'
      },
      corporate: {
        primary: '#1a365d',
        secondary: '#f7fafc',
        accent: '#3182ce',
        text: '#2d3748',
        textLight: '#718096',
        border: '#e2e8f0'
      }
    };
    
    return themes[themeName as keyof typeof themes] || themes.professional;
  }

  /**
   * Header do email
   */
  private getHeader(theme: any, options: EmailTemplateOptions): string {
    const logoSection = options.logoUrl ? `
      <img src="${options.logoUrl}" alt="${options.companyName || 'Logo'}" style="height: 40px; display: block;">
    ` : '';
    
    const companySection = options.companyName && !options.logoUrl ? `
      <h2 style="margin: 0; color: ${theme.primary}; font-size: 24px; font-weight: 600;">
        ${options.companyName}
      </h2>
    ` : '';
    
    return `
    <tr>
      <td style="padding: 30px 40px 20px 40px; border-bottom: 1px solid ${theme.border};" class="content-padding">
        <div style="text-align: center;">
          ${logoSection}
          ${companySection}
        </div>
      </td>
    </tr>`;
  }

  /**
   * Conteúdo principal
   */
  private getMainContent(content: EmailContent, theme: any): string {
    const titleSection = content.title ? `
      <h1 style="margin: 0 0 20px 0; color: ${theme.text}; font-size: 28px; font-weight: 600; line-height: 1.3;">
        ${content.title}
      </h1>
    ` : '';

    const attachmentSection = content.attachmentList && content.attachmentList.length > 0 ? `
      <div style="margin: 20px 0; padding: 15px; background-color: ${theme.secondary}; border-left: 3px solid ${theme.accent}; border-radius: 4px;">
        <h3 style="margin: 0 0 10px 0; color: ${theme.text}; font-size: 16px; font-weight: 600;">
          📎 Anexos (${content.attachmentList.length})
        </h3>
        <ul style="margin: 0; padding-left: 20px; color: ${theme.textLight};">
          ${content.attachmentList.map(attachment => `<li style="margin: 5px 0;">${attachment}</li>`).join('')}
        </ul>
      </div>
    ` : '';

    const signatureSection = content.signature ? `
      <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid ${theme.border};">
        <div style="color: ${theme.textLight}; font-size: 14px; line-height: 1.5;">
          ${content.signature}
        </div>
      </div>
    ` : '';

    return `
    <tr>
      <td style="padding: 40px;" class="content-padding">
        ${titleSection}
        <div style="color: ${theme.text}; font-size: 16px; line-height: 1.6; margin-bottom: 20px;">
          ${this.formatBodyContent(content.body)}
        </div>
        ${attachmentSection}
        ${signatureSection}
      </td>
    </tr>`;
  }

  /**
   * Seção do email original (para respostas/encaminhamentos)
   */
  private getOriginalEmailSection(originalContent: EmailContent, theme: any): string {
    const metadata = originalContent.metadata;
    const metadataSection = metadata ? `
      <div style="margin-bottom: 15px; padding: 10px; background-color: ${theme.secondary}; border-radius: 4px;">
        <div style="font-size: 13px; color: ${theme.textLight};">
          ${metadata.sender ? `<strong>De:</strong> ${metadata.sender}<br>` : ''}
          ${metadata.date ? `<strong>Data:</strong> ${metadata.date}<br>` : ''}
          ${metadata.originalSubject ? `<strong>Assunto:</strong> ${metadata.originalSubject}` : ''}
        </div>
      </div>
    ` : '';

    const attachmentSection = originalContent.attachmentList && originalContent.attachmentList.length > 0 ? `
      <div style="margin: 15px 0; padding: 10px; background-color: ${theme.secondary}; border-radius: 4px;">
        <div style="font-size: 13px; color: ${theme.textLight};">
          <strong>📎 Anexos originais:</strong> ${originalContent.attachmentList.join(', ')}
        </div>
      </div>
    ` : '';

    return `
    <tr>
      <td style="padding: 0 40px 40px 40px;" class="content-padding">
        <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid ${theme.border};">
          <h3 style="margin: 0 0 15px 0; color: ${theme.textLight}; font-size: 16px; font-weight: 600;">
            ↩️ Email Original
          </h3>
          ${metadataSection}
          <div style="color: ${theme.textLight}; font-size: 14px; line-height: 1.5; border-left: 3px solid ${theme.border}; padding-left: 15px;">
            ${this.formatBodyContent(originalContent.body)}
          </div>
          ${attachmentSection}
        </div>
      </td>
    </tr>`;
  }

  /**
   * Footer do email
   */
  private getFooter(theme: any, options: EmailTemplateOptions): string {
    const currentYear = new Date().getFullYear();
    const companyName = options.companyName || 'Sua Empresa';
    
    return `
    <tr>
      <td style="padding: 20px 40px; background-color: ${theme.secondary}; border-top: 1px solid ${theme.border}; text-align: center;" class="content-padding">
        <div style="color: ${theme.textLight}; font-size: 12px; line-height: 1.4;">
          <p style="margin: 0 0 5px 0;">
            Este email foi enviado via sistema automatizado
          </p>
          <p style="margin: 0;">
            © ${currentYear} ${companyName}. Todos os direitos reservados.
          </p>
        </div>
      </td>
    </tr>`;
  }

  /**
   * Formata o conteúdo do corpo do email
   */
  private formatBodyContent(body: string): string {
    // Converter quebras de linha em parágrafos HTML
    const paragraphs = body.split('\n\n').filter(p => p.trim());
    
    return paragraphs.map(paragraph => {
      // Converter quebras simples em <br>
      const formatted = paragraph.replace(/\n/g, '<br>');
      return `<p style="margin: 0 0 15px 0;">${formatted}</p>`;
    }).join('');
  }

  /**
   * Template simples para casos onde não se quer formatação complexa
   */
  public formatSimpleEmail(body: string): string {
    return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #333333; max-width: 600px; margin: 0 auto; padding: 20px;">
      ${this.formatBodyContent(body)}
    </div>`;
  }

  /**
   * Valida se o HTML está bem formatado (básico)
   */
  public validateTemplate(html: string): { valid: boolean; warnings: string[] } {
    const warnings: string[] = [];
    
    // Verificações básicas
    if (!html.includes('<!DOCTYPE html>')) {
      warnings.push('DOCTYPE não encontrado - pode haver problemas de renderização');
    }
    
    if (!html.includes('charset=')) {
      warnings.push('Charset não especificado - caracteres especiais podem não aparecer corretamente');
    }
    
    if (!html.includes('viewport')) {
      warnings.push('Meta viewport ausente - pode não ser responsivo em dispositivos móveis');
    }
    
    // Verificar se tem muito CSS inline (limite para alguns clientes)
    const cssMatches = html.match(/style="/g);
    if (cssMatches && cssMatches.length > 50) {
      warnings.push('Muito CSS inline - considere simplificar para melhor compatibilidade');
    }
    
    return {
      valid: warnings.length === 0,
      warnings
    };
  }
}

// Instância exportada pronta para uso
export const emailTemplateEngine = new EmailTemplateEngine();