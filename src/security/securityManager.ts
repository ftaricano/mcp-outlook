import crypto from 'crypto';
import { EventEmitter } from 'events';

export interface SecurityConfig {
  enableInputSanitization: boolean;
  enableRateLimiting: boolean;
  enableAuditLogging: boolean;
  enableEncryption: boolean;
  maxAttachmentSize: number; // MB
  allowedMimeTypes: string[];
  blockedDomains: string[];
  sensitiveDataPatterns: RegExp[];
}

export interface SecurityEvent {
  type: 'rate_limit' | 'suspicious_input' | 'blocked_domain' | 'sensitive_data' | 'large_attachment' | 'invalid_mime';
  timestamp: number;
  details: any;
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: string;
}

export interface AuditEntry {
  id: string;
  timestamp: number;
  operation: string;
  user: string;
  details: any;
  result: 'success' | 'failure';
  securityEvents: SecurityEvent[];
}

export class SecurityManager extends EventEmitter {
  private config: SecurityConfig;
  private auditLog: AuditEntry[];
  private rateLimitTracking: Map<string, { count: number; resetTime: number }>;
  private securityEvents: SecurityEvent[];
  private encryptionKey: string;

  constructor(config: Partial<SecurityConfig> = {}) {
    super();
    
    this.config = {
      enableInputSanitization: true,
      enableRateLimiting: true,
      enableAuditLogging: true,
      enableEncryption: true,
      maxAttachmentSize: 25, // 25MB
      allowedMimeTypes: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain',
        'text/csv',
        'image/jpeg',
        'image/png',
        'image/gif',
        'application/zip',
        'application/x-zip-compressed'
      ],
      blockedDomains: [
        'tempmail.org',
        '10minutemail.com',
        'guerrillamail.com',
        'mailinator.com'
      ],
      sensitiveDataPatterns: [
        /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, // Credit cards
        /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
        /\b\d{11}\b/g, // CPF (Brazilian)
        /(?:password|senha|pwd)\s*[:=]\s*\S+/gi, // Passwords
        /(?:token|key|secret)\s*[:=]\s*\S+/gi // API keys
      ],
      ...config
    };

    this.auditLog = [];
    this.rateLimitTracking = new Map();
    this.securityEvents = [];
    this.encryptionKey = this.generateEncryptionKey();

    console.error('🔒 SecurityManager initialized with enhanced protection');
  }

  /**
   * Sanitize input data to prevent injection attacks
   */
  sanitizeInput(input: any): any {
    if (!this.config.enableInputSanitization) {
      return input;
    }

    if (typeof input === 'string') {
      return this.sanitizeString(input);
    } else if (Array.isArray(input)) {
      return input.map(item => this.sanitizeInput(item));
    } else if (typeof input === 'object' && input !== null) {
      const sanitized: any = {};
      for (const [key, value] of Object.entries(input)) {
        sanitized[this.sanitizeString(key)] = this.sanitizeInput(value);
      }
      return sanitized;
    }

    return input;
  }

  /**
   * Sanitize string to prevent XSS and injection attacks
   */
  private sanitizeString(str: string): string {
    return str
      .replace(/[<>]/g, '') // Remove potential HTML tags
      .replace(/['"]/g, '') // Remove quotes
      .replace(/javascript:/gi, '') // Remove javascript: protocol
      .replace(/on\w+=/gi, '') // Remove event handlers
      .trim();
  }

  /**
   * Validate email addresses and domains
   */
  validateEmailSecurity(email: string): {
    isValid: boolean;
    isBlocked: boolean;
    reasons: string[];
  } {
    const reasons: string[] = [];
    let isValid = true;
    let isBlocked = false;

    // Basic email format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      isValid = false;
      reasons.push('Invalid email format');
    }

    // Check against blocked domains
    const domain = email.split('@')[1]?.toLowerCase();
    if (domain && this.config.blockedDomains.includes(domain)) {
      isBlocked = true;
      reasons.push(`Blocked domain: ${domain}`);
      
      this.recordSecurityEvent({
        type: 'blocked_domain',
        timestamp: Date.now(),
        details: { email, domain },
        severity: 'medium',
        source: 'email_validation'
      });
    }

    return { isValid, isBlocked, reasons };
  }

  /**
   * Validate attachment security
   */
  validateAttachmentSecurity(attachment: {
    name: string;
    contentType: string;
    size?: number;
    content?: string;
  }): {
    isValid: boolean;
    reasons: string[];
    securityScore: number;
  } {
    const reasons: string[] = [];
    let isValid = true;
    let securityScore = 100;

    // Check file size
    if (attachment.size && attachment.size > this.config.maxAttachmentSize * 1024 * 1024) {
      isValid = false;
      securityScore -= 30;
      reasons.push(`File too large: ${(attachment.size / (1024 * 1024)).toFixed(1)}MB > ${this.config.maxAttachmentSize}MB`);
      
      this.recordSecurityEvent({
        type: 'large_attachment',
        timestamp: Date.now(),
        details: { 
          filename: attachment.name, 
          size: attachment.size,
          limit: this.config.maxAttachmentSize * 1024 * 1024
        },
        severity: 'medium',
        source: 'attachment_validation'
      });
    }

    // Check MIME type
    if (!this.config.allowedMimeTypes.includes(attachment.contentType)) {
      isValid = false;
      securityScore -= 50;
      reasons.push(`Blocked MIME type: ${attachment.contentType}`);
      
      this.recordSecurityEvent({
        type: 'invalid_mime',
        timestamp: Date.now(),
        details: { 
          filename: attachment.name, 
          mimeType: attachment.contentType 
        },
        severity: 'high',
        source: 'attachment_validation'
      });
    }

    // Check for dangerous file extensions
    const dangerousExtensions = ['.exe', '.scr', '.bat', '.cmd', '.com', '.pif', '.vbs', '.js'];
    const extension = attachment.name.toLowerCase().split('.').pop();
    if (extension && dangerousExtensions.includes(`.${extension}`)) {
      isValid = false;
      securityScore -= 70;
      reasons.push(`Dangerous file extension: .${extension}`);
      
      this.recordSecurityEvent({
        type: 'suspicious_input',
        timestamp: Date.now(),
        details: { 
          filename: attachment.name, 
          extension: extension 
        },
        severity: 'critical',
        source: 'attachment_validation'
      });
    }

    // Scan content for suspicious patterns if available
    if (attachment.content) {
      const suspiciousContent = this.scanForSensitiveData(attachment.content);
      if (suspiciousContent.length > 0) {
        securityScore -= 40;
        reasons.push(`Potentially sensitive content detected: ${suspiciousContent.length} pattern(s)`);
      }
    }

    return { isValid, reasons, securityScore };
  }

  /**
   * Scan content for sensitive data patterns
   */
  scanForSensitiveData(content: string): Array<{ pattern: string; matches: number }> {
    const findings: Array<{ pattern: string; matches: number }> = [];

    for (const pattern of this.config.sensitiveDataPatterns) {
      const matches = content.match(pattern);
      if (matches && matches.length > 0) {
        findings.push({
          pattern: pattern.toString(),
          matches: matches.length
        });

        this.recordSecurityEvent({
          type: 'sensitive_data',
          timestamp: Date.now(),
          details: { 
            pattern: pattern.toString(), 
            matchCount: matches.length 
          },
          severity: 'high',
          source: 'content_scanning'
        });
      }
    }

    return findings;
  }

  /**
   * Rate limiting for operations
   */
  checkRateLimit(identifier: string, limit: number, windowMs: number): {
    allowed: boolean;
    remaining: number;
    resetTime: number;
  } {
    if (!this.config.enableRateLimiting) {
      return { allowed: true, remaining: limit, resetTime: Date.now() + windowMs };
    }

    const now = Date.now();
    const tracking = this.rateLimitTracking.get(identifier);

    if (!tracking || now > tracking.resetTime) {
      // Reset or initialize tracking
      this.rateLimitTracking.set(identifier, {
        count: 1,
        resetTime: now + windowMs
      });
      return { allowed: true, remaining: limit - 1, resetTime: now + windowMs };
    }

    if (tracking.count >= limit) {
      this.recordSecurityEvent({
        type: 'rate_limit',
        timestamp: now,
        details: { 
          identifier, 
          limit, 
          current: tracking.count 
        },
        severity: 'medium',
        source: 'rate_limiting'
      });

      return { 
        allowed: false, 
        remaining: 0, 
        resetTime: tracking.resetTime 
      };
    }

    tracking.count++;
    return { 
      allowed: true, 
      remaining: limit - tracking.count, 
      resetTime: tracking.resetTime 
    };
  }

  /**
   * Create audit entry for operations
   */
  createAuditEntry(operation: string, user: string, details: any, result: 'success' | 'failure'): string {
    if (!this.config.enableAuditLogging) {
      return '';
    }

    const auditId = crypto.randomUUID();
    const auditEntry: AuditEntry = {
      id: auditId,
      timestamp: Date.now(),
      operation,
      user: user || 'system',
      details: this.sanitizeInput(details),
      result,
      securityEvents: [...this.securityEvents] // Capture current security events
    };

    this.auditLog.push(auditEntry);
    
    // Clear security events after capturing them
    this.securityEvents = [];

    // Trim audit log if it gets too large (keep last 10000 entries)
    if (this.auditLog.length > 10000) {
      this.auditLog = this.auditLog.slice(-10000);
    }

    this.emit('audit-entry', auditEntry);
    return auditId;
  }

  /**
   * Encrypt sensitive data
   */
  encryptData(data: string): string {
    if (!this.config.enableEncryption) {
      return data;
    }

    try {
      const cipher = crypto.createCipher('aes-256-cbc', this.encryptionKey);
      let encrypted = cipher.update(data, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return encrypted;
    } catch (error) {
      console.error('❌ Encryption failed:', error);
      return data;
    }
  }

  /**
   * Decrypt sensitive data
   */
  decryptData(encryptedData: string): string {
    if (!this.config.enableEncryption) {
      return encryptedData;
    }

    try {
      const decipher = crypto.createDecipher('aes-256-cbc', this.encryptionKey);
      let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (error) {
      console.error('❌ Decryption failed:', error);
      return encryptedData;
    }
  }

  /**
   * Generate secure token for operations
   */
  generateSecureToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Validate operation permissions
   */
  validatePermissions(operation: string, user: string, _context: any): {
    allowed: boolean;
    reason?: string;
  } {
    // Basic permission checking - can be extended
    const restrictedOperations = ['delete_email', 'send_email', 'batch_delete_emails'];
    
    if (restrictedOperations.includes(operation)) {
      // Add additional permission checks here
      const rateLimit = this.checkRateLimit(`${user}:${operation}`, 10, 60000); // 10 per minute
      
      if (!rateLimit.allowed) {
        return { 
          allowed: false, 
          reason: `Rate limit exceeded for ${operation}. Try again in ${Math.ceil((rateLimit.resetTime - Date.now()) / 1000)}s` 
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Record security event
   */
  private recordSecurityEvent(event: SecurityEvent): void {
    this.securityEvents.push(event);
    this.emit('security-event', event);
    
    if (event.severity === 'critical') {
      console.warn('🚨 Critical security event:', event);
    }
  }

  /**
   * Generate encryption key
   */
  private generateEncryptionKey(): string {
    return process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
  }

  /**
   * Get security statistics
   */
  getSecurityStats(): {
    auditEntries: number;
    securityEvents: number;
    rateLimitedRequests: number;
    blockedAttachments: number;
    sensitivDataDetections: number;
  } {
    const securityEventsByType = this.auditLog.reduce((acc, entry) => {
      entry.securityEvents.forEach(event => {
        acc[event.type] = (acc[event.type] || 0) + 1;
      });
      return acc;
    }, {} as Record<string, number>);

    return {
      auditEntries: this.auditLog.length,
      securityEvents: this.securityEvents.length,
      rateLimitedRequests: securityEventsByType.rate_limit || 0,
      blockedAttachments: (securityEventsByType.large_attachment || 0) + (securityEventsByType.invalid_mime || 0),
      sensitivDataDetections: securityEventsByType.sensitive_data || 0
    };
  }

  /**
   * Get recent audit entries
   */
  getRecentAuditEntries(limit: number = 100): AuditEntry[] {
    return this.auditLog.slice(-limit);
  }

  /**
   * Get security events by severity
   */
  getSecurityEventsBySeverity(severity: 'low' | 'medium' | 'high' | 'critical'): SecurityEvent[] {
    return this.auditLog
      .flatMap(entry => entry.securityEvents)
      .filter(event => event.severity === severity);
  }

  /**
   * Clear old audit entries
   */
  clearOldAuditEntries(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number { // 30 days
    const cutoffTime = Date.now() - maxAgeMs;
    const initialLength = this.auditLog.length;
    
    this.auditLog = this.auditLog.filter(entry => entry.timestamp > cutoffTime);
    
    const removed = initialLength - this.auditLog.length;
    if (removed > 0) {
      console.error(`🧹 Cleared ${removed} old audit entries`);
    }
    
    return removed;
  }

  /**
   * Export security report
   */
  generateSecurityReport(): {
    summary: any;
    recentEvents: SecurityEvent[];
    recentAudits: AuditEntry[];
    recommendations: string[];
  } {
    const stats = this.getSecurityStats();
    const criticalEvents = this.getSecurityEventsBySeverity('critical');
    const highEvents = this.getSecurityEventsBySeverity('high');
    
    const recommendations: string[] = [];
    
    if (criticalEvents.length > 0) {
      recommendations.push(`Investigate ${criticalEvents.length} critical security events immediately`);
    }
    
    if (highEvents.length > 10) {
      recommendations.push('High number of high-severity events detected. Review security policies');
    }
    
    if (stats.rateLimitedRequests > 100) {
      recommendations.push('Consider adjusting rate limits or investigating suspicious activity');
    }

    return {
      summary: {
        ...stats,
        criticalEvents: criticalEvents.length,
        highEvents: highEvents.length,
        reportGeneratedAt: new Date().toISOString()
      },
      recentEvents: this.securityEvents.slice(-50),
      recentAudits: this.getRecentAuditEntries(50),
      recommendations
    };
  }

  /**
   * Advanced threat detection based on behavioral patterns
   */
  detectAnomalousActivity(operation: string, user: string, context: any): {
    isAnomalous: boolean;
    riskScore: number;
    reasons: string[];
    recommendations: string[];
  } {
    const reasons: string[] = [];
    const recommendations: string[] = [];
    let riskScore = 0;

    // Check for unusual operation frequency
    const recentOperations = this.auditLog
      .filter(entry => 
        entry.user === user && 
        entry.operation === operation &&
        Date.now() - entry.timestamp < 3600000 // Last hour
      );

    if (recentOperations.length > 20) {
      riskScore += 30;
      reasons.push('Unusually high operation frequency');
      recommendations.push('Consider implementing stricter rate limiting');
    }

    // Check for operations outside normal hours
    const currentHour = new Date().getHours();
    if (currentHour < 6 || currentHour > 22) {
      riskScore += 15;
      reasons.push('Operation outside normal business hours');
      recommendations.push('Review access patterns for off-hours activity');
    }

    // Check for sensitive data patterns in context
    if (context && typeof context === 'object') {
      const contextString = JSON.stringify(context);
      const sensitiveMatches = this.scanForSensitiveData(contextString);
      
      if (sensitiveMatches.length > 0) {
        riskScore += 25;
        reasons.push('Sensitive data detected in operation context');
        recommendations.push('Implement data loss prevention (DLP) policies');
      }
    }

    // Check for bulk operations that might indicate data exfiltration
    if (operation.includes('batch') || operation.includes('bulk')) {
      if (context?.emailIds?.length > 50) {
        riskScore += 20;
        reasons.push('Large bulk operation detected');
        recommendations.push('Monitor bulk operations for data exfiltration patterns');
      }
    }

    // Check for rapid geographic location changes (if available)
    // This would require IP geolocation data
    
    return {
      isAnomalous: riskScore > 40,
      riskScore,
      reasons,
      recommendations
    };
  }

  /**
   * Advanced email security validation
   */
  validateEmailSecurityAdvanced(emailData: {
    to?: string[];
    cc?: string[];
    bcc?: string[];
    subject?: string;
    body?: string;
    attachments?: any[];
  }): {
    isSecure: boolean;
    securityScore: number;
    issues: Array<{ severity: 'low' | 'medium' | 'high' | 'critical'; message: string }>;
    recommendations: string[];
  } {
    const issues: Array<{ severity: 'low' | 'medium' | 'high' | 'critical'; message: string }> = [];
    const recommendations: string[] = [];
    let securityScore = 100;

    // Validate recipients
    const allRecipients = [
      ...(emailData.to || []),
      ...(emailData.cc || []),
      ...(emailData.bcc || [])
    ];

    for (const recipient of allRecipients) {
      const validation = this.validateEmailSecurity(recipient);
      if (!validation.isValid) {
        securityScore -= 20;
        issues.push({
          severity: 'high',
          message: `Invalid recipient email: ${recipient}`
        });
      }
      if (validation.isBlocked) {
        securityScore -= 30;
        issues.push({
          severity: 'critical',
          message: `Blocked domain recipient: ${recipient}`
        });
      }
    }

    // Check for external recipients
    const internalDomains = ['cpzseg.com.br']; // Configure based on organization
    const externalRecipients = allRecipients.filter(email => {
      const domain = email.split('@')[1]?.toLowerCase();
      return domain && !internalDomains.includes(domain);
    });

    if (externalRecipients.length > 0) {
      securityScore -= 10;
      issues.push({
        severity: 'medium',
        message: `External recipients detected: ${externalRecipients.length} recipients`
      });
      recommendations.push('Review external recipient access policies');
    }

    // Validate subject line
    if (emailData.subject && typeof emailData.subject === 'string') {
      const suspiciousKeywords = [
        'urgent', 'immediate', 'confidential', 'secret', 'password', 'credentials',
        'verify account', 'update payment', 'suspended account'
      ];
      
      const foundKeywords = suspiciousKeywords.filter(keyword => 
        emailData.subject!.toLowerCase().includes(keyword)
      );

      if (foundKeywords.length > 0) {
        securityScore -= 15;
        issues.push({
          severity: 'medium',
          message: `Suspicious keywords in subject: ${foundKeywords.join(', ')}`
        });
        recommendations.push('Review subject line for potential phishing indicators');
      }
    }

    // Scan email body for sensitive data
    if (emailData.body) {
      const sensitiveData = this.scanForSensitiveData(emailData.body);
      if (sensitiveData.length > 0) {
        securityScore -= 25;
        issues.push({
          severity: 'high',
          message: `Sensitive data patterns detected: ${sensitiveData.length} pattern(s)`
        });
        recommendations.push('Implement data loss prevention for email content');
      }

      // Check for malicious links
      const urlRegex = /https?:\/\/[^\s]+/gi;
      const urls = emailData.body.match(urlRegex) || [];
      
      for (const url of urls) {
        if (this.isUrlSuspicious(url)) {
          securityScore -= 20;
          issues.push({
            severity: 'high',
            message: `Suspicious URL detected: ${url}`
          });
          recommendations.push('Implement URL filtering and sandboxing');
        }
      }
    }

    // Validate attachments
    if (emailData.attachments && emailData.attachments.length > 0) {
      for (const attachment of emailData.attachments) {
        const attachmentValidation = this.validateAttachmentSecurity(attachment);
        if (!attachmentValidation.isValid) {
          securityScore -= 15;
          issues.push({
            severity: 'medium',
            message: `Insecure attachment: ${attachment.name}`
          });
        }
        if (attachmentValidation.securityScore < 50) {
          securityScore -= 10;
          issues.push({
            severity: 'low',
            message: `Low security score attachment: ${attachment.name}`
          });
        }
      }
    }

    return {
      isSecure: securityScore >= 70,
      securityScore: Math.max(0, securityScore),
      issues,
      recommendations
    };
  }

  /**
   * Check if URL is suspicious
   */
  private isUrlSuspicious(url: string): boolean {
    try {
      const urlObj = new URL(url);
      
      // Check for suspicious domains
      const suspiciousDomains = [
        'bit.ly', 'tinyurl.com', 'short.link', 't.co',
        'suspicious-domain.com', 'phishing-site.net'
      ];
      
      if (suspiciousDomains.some(domain => urlObj.hostname.includes(domain))) {
        return true;
      }

      // Check for suspicious patterns
      const suspiciousPatterns = [
        /[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}/, // IP addresses
        /[a-z]{10,}\.tk|\.ml|\.ga|\.cf/, // Suspicious TLDs
        /[a-z]+-[a-z]+-[a-z]+\.com/ // Domain generation algorithm patterns
      ];

      return suspiciousPatterns.some(pattern => pattern.test(urlObj.hostname));
    } catch {
      // Invalid URL
      return true;
    }
  }

  /**
   * Generate comprehensive security report with recommendations
   */
  generateAdvancedSecurityReport(): {
    summary: any;
    threatAnalysis: any;
    complianceStatus: any;
    recommendations: Array<{ priority: string; category: string; action: string }>;
    riskMatrix: any;
  } {
    const baseReport = this.generateSecurityReport();
    const recommendations: Array<{ priority: string; category: string; action: string }> = [];

    // Analyze threat patterns
    const threatAnalysis = {
      anomalousActivities: 0,
      suspiciousPatterns: 0,
      externalRecipients: 0,
      sensitiveDataExposure: 0
    };

    // Check recent audit entries for threats
    const recentEntries = this.getRecentAuditEntries(100);
    for (const entry of recentEntries) {
      // Count security events by type
      for (const event of entry.securityEvents) {
        switch (event.type) {
          case 'suspicious_input':
            threatAnalysis.suspiciousPatterns++;
            break;
          case 'sensitive_data':
            threatAnalysis.sensitiveDataExposure++;
            break;
          case 'blocked_domain':
            threatAnalysis.externalRecipients++;
            break;
        }
      }
    }

    // Generate compliance status
    const complianceStatus = {
      dataProtection: threatAnalysis.sensitiveDataExposure < 5 ? 'compliant' : 'needs_attention',
      accessControl: baseReport.summary.rateLimitedRequests < 50 ? 'compliant' : 'needs_attention',
      auditLogging: baseReport.summary.auditEntries > 0 ? 'compliant' : 'non_compliant',
      encryption: this.config.enableEncryption ? 'compliant' : 'non_compliant'
    };

    // Generate recommendations based on analysis
    if (threatAnalysis.sensitiveDataExposure > 5) {
      recommendations.push({
        priority: 'high',
        category: 'data_protection',
        action: 'Implement advanced data loss prevention (DLP) policies'
      });
    }

    if (baseReport.summary.rateLimitedRequests > 100) {
      recommendations.push({
        priority: 'medium',
        category: 'access_control',
        action: 'Review and tighten rate limiting policies'
      });
    }

    if (!this.config.enableEncryption) {
      recommendations.push({
        priority: 'critical',
        category: 'encryption',
        action: 'Enable data encryption for sensitive information'
      });
    }

    if (threatAnalysis.suspiciousPatterns > 10) {
      recommendations.push({
        priority: 'high',
        category: 'threat_detection',
        action: 'Implement advanced threat detection and response procedures'
      });
    }

    // Risk matrix calculation
    const riskMatrix = {
      dataLeakage: this.calculateRiskLevel(threatAnalysis.sensitiveDataExposure, 10),
      unauthorizedAccess: this.calculateRiskLevel(baseReport.summary.rateLimitedRequests, 200),
      maliciousContent: this.calculateRiskLevel(threatAnalysis.suspiciousPatterns, 20),
      complianceViolation: Object.values(complianceStatus).filter(status => status !== 'compliant').length
    };

    return {
      summary: {
        ...baseReport.summary,
        ...threatAnalysis,
        overallRiskLevel: this.calculateOverallRisk(riskMatrix)
      },
      threatAnalysis,
      complianceStatus,
      recommendations,
      riskMatrix
    };
  }

  /**
   * Calculate risk level based on threshold
   */
  private calculateRiskLevel(current: number, threshold: number): 'low' | 'medium' | 'high' | 'critical' {
    const ratio = current / threshold;
    if (ratio < 0.25) return 'low';
    if (ratio < 0.5) return 'medium';
    if (ratio < 0.75) return 'high';
    return 'critical';
  }

  /**
   * Calculate overall risk level
   */
  private calculateOverallRisk(riskMatrix: any): 'low' | 'medium' | 'high' | 'critical' {
    const riskLevels = Object.values(riskMatrix);
    const criticalCount = riskLevels.filter(level => level === 'critical').length;
    const highCount = riskLevels.filter(level => level === 'high').length;

    if (criticalCount > 0) return 'critical';
    if (highCount > 1) return 'high';
    if (highCount > 0) return 'medium';
    return 'low';
  }

  /**
   * Real-time security monitoring
   */
  startSecurityMonitoring(): void {
    // Monitor for unusual patterns every 5 minutes
    const monitoringInterval = setInterval(() => {
      this.performSecurityCheck();
    }, 5 * 60 * 1000);

    // Store interval for cleanup
    (this as any).monitoringInterval = monitoringInterval;
    
    console.error('🛡️ Real-time security monitoring started');
  }

  /**
   * Perform automated security check
   */
  private performSecurityCheck(): void {
    try {
      const report = this.generateAdvancedSecurityReport();
      
      // Check for critical risks
      if (report.summary.overallRiskLevel === 'critical') {
        this.recordSecurityEvent({
          type: 'suspicious_input',
          timestamp: Date.now(),
          details: { 
            riskLevel: 'critical',
            recommendations: report.recommendations.filter(r => r.priority === 'critical')
          },
          severity: 'critical',
          source: 'automated_monitoring'
        });
        
        console.warn('🚨 CRITICAL SECURITY ALERT: Immediate attention required');
      }

      // Log security status
      console.error(`🔍 Security check completed - Risk Level: ${report.summary.overallRiskLevel}`);
    } catch (error) {
      console.error('❌ Security monitoring error:', error);
    }
  }

  /**
   * Stop security monitoring
   */
  stopSecurityMonitoring(): void {
    const interval = (this as any).monitoringInterval;
    if (interval) {
      clearInterval(interval);
      delete (this as any).monitoringInterval;
      console.error('🛡️ Security monitoring stopped');
    }
  }

  /**
   * Destroy security manager and clean up
   */
  destroy(): void {
    this.stopSecurityMonitoring();
    this.auditLog = [];
    this.rateLimitTracking.clear();
    this.securityEvents = [];
    this.removeAllListeners();
    console.error('🔒 SecurityManager destroyed');
  }
}