import fs from 'fs/promises';
import path from 'path';
import { EventEmitter } from 'events';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  operation?: string;
  user?: string;
  sessionId?: string;
  performanceMetrics?: {
    duration?: number;
    memoryUsage?: number;
    responseTime?: number;
  };
  context?: Record<string, any>;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
  correlationId?: string;
}

export interface LoggerConfig {
  enableFileLogging: boolean;
  enableConsoleLogging: boolean;
  enableStructuredLogging: boolean;
  logLevel: LogLevel;
  logDirectory: string;
  maxFileSize: number; // MB
  maxFiles: number;
  enableRotation: boolean;
  enableCompression: boolean;
  retentionDays: number;
  enablePerformanceLogging: boolean;
  enableAuditTrail: boolean;
}

export interface LogFilter {
  level?: LogLevel[];
  operation?: string[];
  user?: string[];
  timeRange?: {
    start: Date;
    end: Date;
  };
  searchTerm?: string;
}

export class AdvancedLogger extends EventEmitter {
  private config: LoggerConfig;
  private currentLogFile: string;
  private currentFileSize: number;
  private sessionId: string;
  private logQueue: LogEntry[];
  private flushInterval?: NodeJS.Timeout;
  private isInitialized: boolean;

  private static readonly LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    critical: 4
  };

  private static readonly LOG_EMOJIS: Record<LogLevel, string> = {
    debug: '🔍',
    info: 'ℹ️',
    warn: '⚠️',
    error: '❌',
    critical: '🚨'
  };

  constructor(config: Partial<LoggerConfig> = {}) {
    super();
    
    this.config = {
      enableFileLogging: true,
      enableConsoleLogging: true,
      enableStructuredLogging: true,
      logLevel: 'info',
      logDirectory: './logs',
      maxFileSize: 10, // 10MB
      maxFiles: 10,
      enableRotation: true,
      enableCompression: false,
      retentionDays: 30,
      enablePerformanceLogging: true,
      enableAuditTrail: true,
      ...config
    };

    this.currentLogFile = '';
    this.currentFileSize = 0;
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    this.logQueue = [];
    this.isInitialized = false;

    this.initializeLogger();
  }

  /**
   * Initialize logger and create necessary directories
   */
  private async initializeLogger(): Promise<void> {
    try {
      if (this.config.enableFileLogging) {
        await fs.mkdir(this.config.logDirectory, { recursive: true });
        await this.rotateLogFileIfNeeded();
      }

      // Start flush interval for batched writing
      this.flushInterval = setInterval(() => {
        this.flushLogQueue();
      }, 1000); // Flush every second

      this.isInitialized = true;
      
      this.info('AdvancedLogger initialized', {
        operation: 'logger_init',
        context: {
          sessionId: this.sessionId,
          config: this.config
        }
      });
    } catch (error) {
      console.error('Failed to initialize AdvancedLogger:', error);
      this.isInitialized = false;
    }
  }

  /**
   * Log debug message
   */
  debug(message: string, context?: Partial<LogEntry>): void {
    this.log('debug', message, context);
  }

  /**
   * Log info message
   */
  info(message: string, context?: Partial<LogEntry>): void {
    this.log('info', message, context);
  }

  /**
   * Log warning message
   */
  warn(message: string, context?: Partial<LogEntry>): void {
    this.log('warn', message, context);
  }

  /**
   * Log error message
   */
  error(message: string, error?: Error, context?: Partial<LogEntry>): void {
    const errorContext = error ? {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    } : {};

    this.log('error', message, {
      ...context,
      ...errorContext
    });
  }

  /**
   * Log critical message
   */
  critical(message: string, error?: Error, context?: Partial<LogEntry>): void {
    const errorContext = error ? {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      }
    } : {};

    this.log('critical', message, {
      ...context,
      ...errorContext
    });

    // Emit critical event for immediate attention
    this.emit('critical-log', {
      message,
      error,
      context,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Log operation with performance metrics
   */
  logOperation(
    operation: string,
    success: boolean,
    duration: number,
    context?: Record<string, any>
  ): void {
    const level: LogLevel = success ? 'info' : 'error';
    const message = `Operation ${operation} ${success ? 'completed' : 'failed'} in ${duration}ms`;

    this.log(level, message, {
      operation,
      performanceMetrics: {
        duration,
        responseTime: duration,
        memoryUsage: process.memoryUsage().heapUsed
      },
      context
    });
  }

  /**
   * Log audit event
   */
  logAudit(
    operation: string,
    user: string,
    details: Record<string, any>,
    result: 'success' | 'failure'
  ): void {
    if (!this.config.enableAuditTrail) return;

    this.log('info', `Audit: ${operation} - ${result}`, {
      operation: `audit_${operation}`,
      user,
      context: {
        auditType: 'operation',
        result,
        details,
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Core logging method
   */
  private log(level: LogLevel, message: string, context?: Partial<LogEntry>): void {
    // Check if logging level is enabled
    if (AdvancedLogger.LOG_LEVELS[level] < AdvancedLogger.LOG_LEVELS[this.config.logLevel]) {
      return;
    }

    const logEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      sessionId: this.sessionId,
      correlationId: this.generateCorrelationId(),
      ...context
    };

    // Console logging
    if (this.config.enableConsoleLogging) {
      this.logToConsole(logEntry);
    }

    // File logging (queued)
    if (this.config.enableFileLogging && this.isInitialized) {
      this.logQueue.push(logEntry);
    }

    // Emit event for real-time monitoring
    this.emit('log-entry', logEntry);

    // Immediate flush for critical logs
    if (level === 'critical' || level === 'error') {
      this.flushLogQueue();
    }
  }

  /**
   * Log to console with formatting
   */
  private logToConsole(entry: LogEntry): void {
    const emoji = AdvancedLogger.LOG_EMOJIS[entry.level];
    const timestamp = entry.timestamp.split('T')[1].split('.')[0]; // HH:mm:ss
    
    let logMessage = `${emoji} [${timestamp}]`;
    
    if (entry.operation) {
      logMessage += ` [${entry.operation}]`;
    }
    
    if (entry.user) {
      logMessage += ` [${entry.user}]`;
    }
    
    logMessage += ` ${entry.message}`;

    // Performance metrics in console
    if (entry.performanceMetrics?.duration) {
      logMessage += ` (${entry.performanceMetrics.duration}ms)`;
    }

    // Use appropriate console method
    switch (entry.level) {
      case 'debug':
        console.debug(logMessage, entry.context || '');
        break;
      case 'info':
        console.log(logMessage, entry.context || '');
        break;
      case 'warn':
        console.warn(logMessage, entry.context || '');
        break;
      case 'error':
      case 'critical':
        console.error(logMessage, entry.error || entry.context || '');
        break;
    }
  }

  /**
   * Flush log queue to file
   */
  private async flushLogQueue(): Promise<void> {
    if (this.logQueue.length === 0 || !this.config.enableFileLogging) {
      return;
    }

    try {
      const logsToWrite = [...this.logQueue];
      this.logQueue = [];

      let logContent = '';
      
      for (const entry of logsToWrite) {
        if (this.config.enableStructuredLogging) {
          logContent += JSON.stringify(entry) + '\n';
        } else {
          logContent += this.formatPlainTextLog(entry) + '\n';
        }
      }

      await this.writeToFile(logContent);
    } catch (error) {
      console.error('Failed to flush log queue:', error);
      // Re-queue failed logs
      this.logQueue.unshift(...this.logQueue);
    }
  }

  /**
   * Write logs to file with rotation
   */
  private async writeToFile(content: string): Promise<void> {
    await this.rotateLogFileIfNeeded();
    
    await fs.appendFile(this.currentLogFile, content, 'utf8');
    this.currentFileSize += Buffer.byteLength(content, 'utf8');
  }

  /**
   * Rotate log file if needed
   */
  private async rotateLogFileIfNeeded(): Promise<void> {
    const maxSizeBytes = this.config.maxFileSize * 1024 * 1024;
    
    if (!this.currentLogFile || this.currentFileSize >= maxSizeBytes) {
      await this.rotateLogFile();
    }
  }

  /**
   * Rotate to new log file
   */
  private async rotateLogFile(): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const extension = this.config.enableStructuredLogging ? 'jsonl' : 'log';
    const newLogFile = path.join(
      this.config.logDirectory,
      `mcp-email-${timestamp}.${extension}`
    );

    this.currentLogFile = newLogFile;
    this.currentFileSize = 0;

    // Clean up old log files
    if (this.config.enableRotation) {
      await this.cleanupOldLogs();
    }
  }

  /**
   * Clean up old log files
   */
  private async cleanupOldLogs(): Promise<void> {
    try {
      const files = await fs.readdir(this.config.logDirectory);
      const logFiles = files
        .filter(file => file.startsWith('mcp-email-') && (file.endsWith('.log') || file.endsWith('.jsonl')))
        .map(file => ({
          name: file,
          path: path.join(this.config.logDirectory, file),
          stats: null as any
        }));

      // Get file stats
      for (const logFile of logFiles) {
        try {
          logFile.stats = await fs.stat(logFile.path);
        } catch (error) {
          continue; // Skip files we can't stat
        }
      }

      // Sort by creation time (newest first)
      logFiles.sort((a, b) => {
        if (!a.stats || !b.stats) return 0;
        return b.stats.birthtime.getTime() - a.stats.birthtime.getTime();
      });

      // Remove excess files
      if (logFiles.length > this.config.maxFiles) {
        const filesToDelete = logFiles.slice(this.config.maxFiles);
        for (const file of filesToDelete) {
          await fs.unlink(file.path);
          console.log(`🗑️ Deleted old log file: ${file.name}`);
        }
      }

      // Remove files older than retention period
      const retentionCutoff = Date.now() - (this.config.retentionDays * 24 * 60 * 60 * 1000);
      for (const file of logFiles) {
        if (file.stats && file.stats.birthtime.getTime() < retentionCutoff) {
          await fs.unlink(file.path);
          console.log(`🗑️ Deleted expired log file: ${file.name}`);
        }
      }
    } catch (error) {
      console.error('Failed to cleanup old logs:', error);
    }
  }

  /**
   * Format log entry as plain text
   */
  private formatPlainTextLog(entry: LogEntry): string {
    let formatted = `[${entry.timestamp}] [${entry.level.toUpperCase()}]`;
    
    if (entry.operation) {
      formatted += ` [${entry.operation}]`;
    }
    
    if (entry.user) {
      formatted += ` [${entry.user}]`;
    }
    
    formatted += ` ${entry.message}`;
    
    if (entry.performanceMetrics?.duration) {
      formatted += ` (${entry.performanceMetrics.duration}ms)`;
    }
    
    if (entry.error) {
      formatted += ` ERROR: ${entry.error.message}`;
      if (entry.error.stack) {
        formatted += `\nStack: ${entry.error.stack}`;
      }
    }
    
    if (entry.context) {
      formatted += ` Context: ${JSON.stringify(entry.context)}`;
    }
    
    return formatted;
  }

  /**
   * Generate correlation ID for request tracking
   */
  private generateCorrelationId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Search logs with filters
   */
  async searchLogs(filter: LogFilter, limit: number = 1000): Promise<LogEntry[]> {
    if (!this.config.enableFileLogging || !this.config.enableStructuredLogging) {
      throw new Error('Log search requires file logging and structured logging to be enabled');
    }

    try {
      const files = await fs.readdir(this.config.logDirectory);
      const logFiles = files
        .filter(file => file.startsWith('mcp-email-') && file.endsWith('.jsonl'))
        .sort()
        .reverse(); // Newest first

      const results: LogEntry[] = [];
      let found = 0;

      for (const file of logFiles) {
        if (found >= limit) break;

        const filePath = path.join(this.config.logDirectory, file);
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.trim().split('\n');

        for (const line of lines) {
          if (found >= limit) break;
          if (!line.trim()) continue;

          try {
            const entry: LogEntry = JSON.parse(line);
            if (this.matchesFilter(entry, filter)) {
              results.push(entry);
              found++;
            }
          } catch (error) {
            continue; // Skip malformed entries
          }
        }
      }

      return results;
    } catch (error) {
      console.error('Failed to search logs:', error);
      return [];
    }
  }

  /**
   * Check if log entry matches filter
   */
  private matchesFilter(entry: LogEntry, filter: LogFilter): boolean {
    // Level filter
    if (filter.level && !filter.level.includes(entry.level)) {
      return false;
    }

    // Operation filter
    if (filter.operation && entry.operation && !filter.operation.includes(entry.operation)) {
      return false;
    }

    // User filter
    if (filter.user && entry.user && !filter.user.includes(entry.user)) {
      return false;
    }

    // Time range filter
    if (filter.timeRange) {
      const entryTime = new Date(entry.timestamp);
      if (entryTime < filter.timeRange.start || entryTime > filter.timeRange.end) {
        return false;
      }
    }

    // Search term filter
    if (filter.searchTerm) {
      const searchableText = JSON.stringify(entry).toLowerCase();
      if (!searchableText.includes(filter.searchTerm.toLowerCase())) {
        return false;
      }
    }

    return true;
  }

  /**
   * Generate log analytics report
   */
  async generateLogAnalytics(timeWindow: number = 3600000): Promise<{
    summary: {
      totalLogs: number;
      logsByLevel: Record<LogLevel, number>;
      operationStats: Record<string, number>;
      errorRate: number;
      topErrors: Array<{ message: string; count: number }>;
    };
    timeline: Array<{
      timestamp: string;
      count: number;
      errorCount: number;
    }>;
    recommendations: string[];
  }> {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - timeWindow);
    
    const logs = await this.searchLogs({
      timeRange: { start: startTime, end: endTime }
    }, 10000);

    // Calculate summary statistics
    const logsByLevel: Record<LogLevel, number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
      critical: 0
    };

    const operationStats: Record<string, number> = {};
    const errorMessages: Record<string, number> = {};
    let errorCount = 0;

    for (const log of logs) {
      logsByLevel[log.level]++;
      
      if (log.operation) {
        operationStats[log.operation] = (operationStats[log.operation] || 0) + 1;
      }
      
      if (log.level === 'error' || log.level === 'critical') {
        errorCount++;
        const errorMsg = log.error?.message || log.message;
        errorMessages[errorMsg] = (errorMessages[errorMsg] || 0) + 1;
      }
    }

    const topErrors = Object.entries(errorMessages)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .map(([message, count]) => ({ message, count }));

    // Generate timeline (hourly buckets)
    const timeline: Array<{ timestamp: string; count: number; errorCount: number }> = [];
    const bucketSize = 3600000; // 1 hour
    const buckets = Math.ceil(timeWindow / bucketSize);

    for (let i = 0; i < buckets; i++) {
      const bucketStart = new Date(startTime.getTime() + (i * bucketSize));
      const bucketEnd = new Date(bucketStart.getTime() + bucketSize);
      
      const bucketLogs = logs.filter(log => {
        const logTime = new Date(log.timestamp);
        return logTime >= bucketStart && logTime < bucketEnd;
      });

      const bucketErrors = bucketLogs.filter(log => 
        log.level === 'error' || log.level === 'critical'
      ).length;

      timeline.push({
        timestamp: bucketStart.toISOString(),
        count: bucketLogs.length,
        errorCount: bucketErrors
      });
    }

    // Generate recommendations
    const recommendations: string[] = [];
    
    const errorRate = logs.length > 0 ? (errorCount / logs.length) * 100 : 0;
    
    if (errorRate > 10) {
      recommendations.push('High error rate detected - investigate recurring issues');
    }
    
    if (logsByLevel.critical > 0) {
      recommendations.push('Critical errors detected - immediate attention required');
    }
    
    if (logsByLevel.warn > logsByLevel.info) {
      recommendations.push('High warning ratio - review system health');
    }

    const topOperations = Object.entries(operationStats)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 5);
    
    if (topOperations.length > 0 && topOperations[0][1] > logs.length * 0.5) {
      recommendations.push(`Operation '${topOperations[0][0]}' dominates logs - consider optimization`);
    }

    return {
      summary: {
        totalLogs: logs.length,
        logsByLevel,
        operationStats,
        errorRate,
        topErrors
      },
      timeline,
      recommendations
    };
  }

  /**
   * Get current logger status
   */
  getStatus(): {
    isInitialized: boolean;
    sessionId: string;
    config: LoggerConfig;
    queueSize: number;
    currentLogFile: string;
    currentFileSize: number;
  } {
    return {
      isInitialized: this.isInitialized,
      sessionId: this.sessionId,
      config: this.config,
      queueSize: this.logQueue.length,
      currentLogFile: this.currentLogFile,
      currentFileSize: this.currentFileSize
    };
  }

  /**
   * Destroy logger and cleanup
   */
  async destroy(): Promise<void> {
    // Flush remaining logs
    await this.flushLogQueue();
    
    // Clear intervals
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
    }
    
    // Clean up
    this.logQueue = [];
    this.removeAllListeners();
    
    this.info('AdvancedLogger destroyed', {
      operation: 'logger_destroy',
      context: { sessionId: this.sessionId }
    });
  }
}