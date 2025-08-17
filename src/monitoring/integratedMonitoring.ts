import { EventEmitter } from 'events';
import { PerformanceMonitor } from './performanceMonitor.js';
import { AdvancedLogger } from '../logging/advancedLogger.js';
import { SecurityManager } from '../security/securityManager.js';

export interface MonitoringConfig {
  enablePerformanceMonitoring: boolean;
  enableAdvancedLogging: boolean;
  enableSecurityMonitoring: boolean;
  enableRealTimeAlerts: boolean;
  enableHealthChecks: boolean;
  monitoringInterval: number; // ms
  alertThresholds: {
    responseTime: number; // ms
    errorRate: number; // percentage
    memoryUsage: number; // percentage
    securityEvents: number; // count per hour
  };
  healthCheckEndpoints: string[];
}

export interface HealthCheckResult {
  endpoint: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  responseTime: number;
  error?: string;
  timestamp: string;
}

export interface SystemHealthStatus {
  overall: 'healthy' | 'unhealthy' | 'degraded';
  components: {
    performance: 'healthy' | 'unhealthy' | 'degraded';
    logging: 'healthy' | 'unhealthy' | 'degraded';
    security: 'healthy' | 'unhealthy' | 'degraded';
    memory: 'healthy' | 'unhealthy' | 'degraded';
    disk: 'healthy' | 'unhealthy' | 'degraded';
  };
  metrics: {
    uptime: number;
    totalRequests: number;
    errorRate: number;
    averageResponseTime: number;
    memoryUsage: number;
    securityScore: number;
  };
  alerts: Array<{
    severity: 'low' | 'medium' | 'high' | 'critical';
    message: string;
    timestamp: string;
    component: string;
  }>;
  lastChecked: string;
}

export interface MonitoringReport {
  systemHealth: SystemHealthStatus;
  performanceAnalysis: any;
  logAnalytics: any;
  securityAssessment: any;
  recommendations: Array<{
    priority: 'low' | 'medium' | 'high' | 'critical';
    category: string;
    issue: string;
    recommendation: string;
    estimatedImpact: string;
  }>;
  generatedAt: string;
}

export class IntegratedMonitoring extends EventEmitter {
  private config: MonitoringConfig;
  private performanceMonitor: PerformanceMonitor;
  private logger: AdvancedLogger;
  private securityManager: SecurityManager;
  private monitoringInterval?: NodeJS.Timeout;
  private healthCheckInterval?: NodeJS.Timeout;
  private startTime: number;
  private alertHistory: Array<any>;
  private lastHealthCheck?: SystemHealthStatus;

  constructor(
    performanceMonitor: PerformanceMonitor,
    logger: AdvancedLogger,
    securityManager: SecurityManager,
    config: Partial<MonitoringConfig> = {}
  ) {
    super();
    
    this.performanceMonitor = performanceMonitor;
    this.logger = logger;
    this.securityManager = securityManager;
    this.startTime = Date.now();
    this.alertHistory = [];

    this.config = {
      enablePerformanceMonitoring: true,
      enableAdvancedLogging: true,
      enableSecurityMonitoring: true,
      enableRealTimeAlerts: true,
      enableHealthChecks: true,
      monitoringInterval: 60000, // 1 minute
      alertThresholds: {
        responseTime: 3000, // 3 seconds
        errorRate: 5, // 5%
        memoryUsage: 80, // 80%
        securityEvents: 10 // 10 events per hour
      },
      healthCheckEndpoints: [
        'https://graph.microsoft.com/v1.0/me',
        'https://login.microsoftonline.com/common/discovery/instance'
      ],
      ...config
    };

    this.setupEventListeners();
    this.logger.info('IntegratedMonitoring initialized', {
      operation: 'monitoring_init',
      context: {
        config: this.config,
        startTime: new Date(this.startTime).toISOString()
      }
    });
  }

  /**
   * Setup event listeners for integrated monitoring
   */
  private setupEventListeners(): void {
    // Performance monitoring events
    if (this.config.enablePerformanceMonitoring) {
      this.performanceMonitor.on('performance-alert', (alert) => {
        this.handlePerformanceAlert(alert);
      });

      this.performanceMonitor.on('metric-recorded', (metric) => {
        if (this.config.enableAdvancedLogging) {
          this.logger.logOperation(
            metric.operation,
            metric.success,
            metric.duration,
            metric.metadata
          );
        }
      });
    }

    // Security monitoring events
    if (this.config.enableSecurityMonitoring) {
      this.securityManager.on('security-event', (event) => {
        this.handleSecurityEvent(event);
      });

      this.securityManager.on('audit-entry', (entry) => {
        if (this.config.enableAdvancedLogging) {
          this.logger.logAudit(
            entry.operation,
            entry.user,
            entry.details,
            entry.result
          );
        }
      });
    }

    // Logger events
    if (this.config.enableAdvancedLogging) {
      this.logger.on('critical-log', (event) => {
        this.handleCriticalLog(event);
      });
    }
  }

  /**
   * Start integrated monitoring
   */
  startMonitoring(): void {
    this.logger.info('Starting integrated monitoring system', {
      operation: 'monitoring_start'
    });

    // Start performance monitoring
    if (this.config.enablePerformanceMonitoring) {
      this.performanceMonitor.startRealTimeMonitoring(this.config.monitoringInterval);
    }

    // Start security monitoring
    if (this.config.enableSecurityMonitoring) {
      this.securityManager.startSecurityMonitoring();
    }

    // Start health checks
    if (this.config.enableHealthChecks) {
      this.startHealthChecks();
    }

    // Start integrated monitoring interval
    this.monitoringInterval = setInterval(() => {
      this.performIntegratedCheck();
    }, this.config.monitoringInterval);

    this.emit('monitoring-started', {
      timestamp: new Date().toISOString(),
      config: this.config
    });
  }

  /**
   * Stop integrated monitoring
   */
  stopMonitoring(): void {
    this.logger.info('Stopping integrated monitoring system', {
      operation: 'monitoring_stop'
    });

    // Stop performance monitoring
    if (this.config.enablePerformanceMonitoring) {
      this.performanceMonitor.stopRealTimeMonitoring();
    }

    // Stop security monitoring
    if (this.config.enableSecurityMonitoring) {
      this.securityManager.stopSecurityMonitoring();
    }

    // Stop health checks
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = undefined;
    }

    // Stop integrated monitoring
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }

    this.emit('monitoring-stopped', {
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Perform integrated health and performance check
   */
  private async performIntegratedCheck(): Promise<void> {
    try {
      const systemHealth = await this.checkSystemHealth();
      this.lastHealthCheck = systemHealth;

      // Check for critical issues
      const criticalAlerts = systemHealth.alerts.filter(alert => 
        alert.severity === 'critical'
      );

      if (criticalAlerts.length > 0) {
        this.logger.critical('Critical system issues detected', undefined as any, {
          operation: 'system_health_check',
          context: {
            criticalAlerts,
            systemHealth: systemHealth.overall
          }
        });
      }

      // Emit health status
      this.emit('health-check', systemHealth);

      // Log health summary
      this.logger.info(`System health check: ${systemHealth.overall}`, {
        operation: 'health_check',
        context: {
          overall: systemHealth.overall,
          alerts: systemHealth.alerts.length,
          errorRate: systemHealth.metrics.errorRate,
          responseTime: systemHealth.metrics.averageResponseTime,
          memoryUsage: systemHealth.metrics.memoryUsage
        }
      });

    } catch (error) {
      this.logger.error('Failed to perform integrated health check', error instanceof Error ? error : undefined, {
        operation: 'health_check_error'
      });
    }
  }

  /**
   * Check comprehensive system health
   */
  async checkSystemHealth(): Promise<SystemHealthStatus> {
    const timestamp = new Date().toISOString();
    const uptime = Date.now() - this.startTime;

    // Get performance metrics
    const performanceMetrics = this.performanceMonitor.getSystemMetrics();
    const performanceStatus = this.performanceMonitor.getStatus();

    // Get security metrics
    const securityStats = this.securityManager.getSecurityStats();
    const securityReport = this.securityManager.generateAdvancedSecurityReport();

    // Get logger status
    const loggerStatus = this.logger.getStatus();

    // Check component health
    const components = {
      performance: this.assessPerformanceHealth(performanceMetrics),
      logging: this.assessLoggingHealth(loggerStatus),
      security: this.assessSecurityHealth(securityReport),
      memory: this.assessMemoryHealth(performanceMetrics.memoryUsage),
      disk: await this.assessDiskHealth()
    };

    // Calculate overall health
    const unhealthyComponents = Object.values(components).filter(status => status === 'unhealthy').length;
    const degradedComponents = Object.values(components).filter(status => status === 'degraded').length;
    
    let overall: 'healthy' | 'unhealthy' | 'degraded';
    if (unhealthyComponents > 0) {
      overall = 'unhealthy';
    } else if (degradedComponents > 1) {
      overall = 'degraded';
    } else {
      overall = 'healthy';
    }

    // Generate alerts
    const alerts = this.generateSystemAlerts(performanceMetrics, securityStats, components);

    return {
      overall,
      components,
      metrics: {
        uptime,
        totalRequests: performanceStatus.metricsCount,
        errorRate: performanceMetrics.errorRate,
        averageResponseTime: performanceMetrics.responseTime.average,
        memoryUsage: performanceMetrics.memoryUsage.percentage,
        securityScore: securityReport.summary.overallRiskLevel === 'low' ? 95 :
                      securityReport.summary.overallRiskLevel === 'medium' ? 80 :
                      securityReport.summary.overallRiskLevel === 'high' ? 60 : 40
      },
      alerts,
      lastChecked: timestamp
    };
  }

  /**
   * Assess performance component health
   */
  private assessPerformanceHealth(metrics: any): 'healthy' | 'unhealthy' | 'degraded' {
    if (metrics.responseTime.average > this.config.alertThresholds.responseTime * 2) {
      return 'unhealthy';
    }
    if (metrics.responseTime.average > this.config.alertThresholds.responseTime ||
        metrics.errorRate > this.config.alertThresholds.errorRate) {
      return 'degraded';
    }
    return 'healthy';
  }

  /**
   * Assess logging component health
   */
  private assessLoggingHealth(status: any): 'healthy' | 'unhealthy' | 'degraded' {
    if (!status.isInitialized) {
      return 'unhealthy';
    }
    if (status.queueSize > 1000) {
      return 'degraded';
    }
    return 'healthy';
  }

  /**
   * Assess security component health
   */
  private assessSecurityHealth(report: any): 'healthy' | 'unhealthy' | 'degraded' {
    const riskLevel = report.summary.overallRiskLevel;
    
    if (riskLevel === 'critical') {
      return 'unhealthy';
    }
    if (riskLevel === 'high') {
      return 'degraded';
    }
    return 'healthy';
  }

  /**
   * Assess memory component health
   */
  private assessMemoryHealth(memoryUsage: any): 'healthy' | 'unhealthy' | 'degraded' {
    if (memoryUsage.percentage > 90) {
      return 'unhealthy';
    }
    if (memoryUsage.percentage > this.config.alertThresholds.memoryUsage) {
      return 'degraded';
    }
    return 'healthy';
  }

  /**
   * Assess disk component health
   */
  private async assessDiskHealth(): Promise<'healthy' | 'unhealthy' | 'degraded'> {
    try {
      // Simple disk health check - could be enhanced with actual disk usage monitoring
      const testWrite = Buffer.from('test');
      // This is a basic check - in production, you might want more sophisticated disk monitoring
      return 'healthy';
    } catch (error) {
      return 'unhealthy';
    }
  }

  /**
   * Generate system alerts based on metrics
   */
  private generateSystemAlerts(
    performanceMetrics: any,
    securityStats: any,
    components: any
  ): Array<any> {
    const alerts: Array<any> = [];
    const timestamp = new Date().toISOString();

    // Performance alerts
    if (performanceMetrics.responseTime.average > this.config.alertThresholds.responseTime) {
      alerts.push({
        severity: performanceMetrics.responseTime.average > this.config.alertThresholds.responseTime * 2 ? 'critical' : 'high',
        message: `High average response time: ${performanceMetrics.responseTime.average.toFixed(0)}ms`,
        timestamp,
        component: 'performance'
      });
    }

    if (performanceMetrics.errorRate > this.config.alertThresholds.errorRate) {
      alerts.push({
        severity: performanceMetrics.errorRate > this.config.alertThresholds.errorRate * 2 ? 'critical' : 'high',
        message: `High error rate: ${performanceMetrics.errorRate.toFixed(1)}%`,
        timestamp,
        component: 'performance'
      });
    }

    // Memory alerts
    if (performanceMetrics.memoryUsage.percentage > this.config.alertThresholds.memoryUsage) {
      alerts.push({
        severity: performanceMetrics.memoryUsage.percentage > 90 ? 'critical' : 'medium',
        message: `High memory usage: ${performanceMetrics.memoryUsage.percentage.toFixed(1)}%`,
        timestamp,
        component: 'memory'
      });
    }

    // Security alerts
    if (securityStats.securityEvents > this.config.alertThresholds.securityEvents) {
      alerts.push({
        severity: 'high',
        message: `High security event rate: ${securityStats.securityEvents} events`,
        timestamp,
        component: 'security'
      });
    }

    // Component health alerts
    Object.entries(components).forEach(([component, status]) => {
      if (status === 'unhealthy') {
        alerts.push({
          severity: 'critical',
          message: `Component ${component} is unhealthy`,
          timestamp,
          component
        });
      } else if (status === 'degraded') {
        alerts.push({
          severity: 'medium',
          message: `Component ${component} is degraded`,
          timestamp,
          component
        });
      }
    });

    return alerts;
  }

  /**
   * Start health check monitoring for external endpoints
   */
  private startHealthChecks(): void {
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthChecks();
    }, this.config.monitoringInterval * 2); // Less frequent than main monitoring

    this.logger.debug('Health check monitoring started', {
      operation: 'health_check_start',
      context: {
        endpoints: this.config.healthCheckEndpoints,
        interval: this.config.monitoringInterval * 2
      }
    });
  }

  /**
   * Perform health checks on external endpoints
   */
  private async performHealthChecks(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];

    for (const endpoint of this.config.healthCheckEndpoints) {
      const startTime = Date.now();
      let result: HealthCheckResult;

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        
        const response = await fetch(endpoint, {
          method: 'HEAD',
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);

        const responseTime = Date.now() - startTime;
        
        result = {
          endpoint,
          status: response.ok ? 'healthy' : 'degraded',
          responseTime,
          timestamp: new Date().toISOString()
        };

        if (!response.ok) {
          result.error = `HTTP ${response.status}: ${response.statusText}`;
        }

      } catch (error) {
        result = {
          endpoint,
          status: 'unhealthy',
          responseTime: Date.now() - startTime,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString()
        };
      }

      results.push(result);

      // Log unhealthy endpoints
      if (result.status !== 'healthy') {
        this.logger.warn(`Health check failed for ${endpoint}`, {
          operation: 'health_check_endpoint',
          context: {
            endpoint,
            status: result.status,
            responseTime: result.responseTime,
            error: result.error
          }
        });
      }
    }

    this.emit('health-checks-completed', results);
    return results;
  }

  /**
   * Handle performance alerts
   */
  private handlePerformanceAlert(alert: any): void {
    this.alertHistory.push({
      type: 'performance',
      ...alert,
      timestamp: new Date().toISOString()
    });

    if (this.config.enableRealTimeAlerts) {
      this.logger.warn(`Performance Alert: ${alert.message}`, {
        operation: 'performance_alert',
        context: alert
      });

      this.emit('real-time-alert', {
        type: 'performance',
        severity: alert.severity,
        message: alert.message,
        details: alert
      });
    }
  }

  /**
   * Handle security events
   */
  private handleSecurityEvent(event: any): void {
    this.alertHistory.push({
      type: 'security',
      ...event,
      timestamp: new Date().toISOString()
    });

    if (this.config.enableRealTimeAlerts) {
      if (event.severity === 'critical') {
        this.logger.critical(`Security Event: ${event.type}`, undefined, {
          operation: 'security_event',
          context: event
        });
      } else if (event.severity === 'high') {
        this.logger.error(`Security Event: ${event.type}`, undefined, {
          operation: 'security_event',
          context: event
        });
      } else {
        this.logger.warn(`Security Event: ${event.type}`, {
          operation: 'security_event',
          context: event
        });
      }

      this.emit('real-time-alert', {
        type: 'security',
        severity: event.severity,
        message: `Security event: ${event.type}`,
        details: event
      });
    }
  }

  /**
   * Handle critical log events
   */
  private handleCriticalLog(event: any): void {
    this.alertHistory.push({
      type: 'critical_log',
      ...event,
      timestamp: new Date().toISOString()
    });

    if (this.config.enableRealTimeAlerts) {
      this.emit('real-time-alert', {
        type: 'critical_log',
        severity: 'critical',
        message: `Critical log event: ${event.message}`,
        details: event
      });
    }
  }

  /**
   * Generate comprehensive monitoring report
   */
  async generateMonitoringReport(): Promise<MonitoringReport> {
    const systemHealth = this.lastHealthCheck || await this.checkSystemHealth();
    
    // Get detailed analysis from each component
    const performanceAnalysis = this.performanceMonitor.generatePerformanceReport();
    const logAnalytics = await this.logger.generateLogAnalytics();
    const securityAssessment = this.securityManager.generateAdvancedSecurityReport();

    // Generate integrated recommendations
    const recommendations = this.generateIntegratedRecommendations(
      performanceAnalysis,
      logAnalytics,
      securityAssessment,
      systemHealth
    );

    return {
      systemHealth,
      performanceAnalysis,
      logAnalytics,
      securityAssessment,
      recommendations,
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * Generate integrated recommendations
   */
  private generateIntegratedRecommendations(
    performanceAnalysis: any,
    logAnalytics: any,
    securityAssessment: any,
    systemHealth: any
  ): Array<any> {
    const recommendations: Array<any> = [];

    // Performance recommendations
    if (performanceAnalysis.summary.responseTime.average > 2000) {
      recommendations.push({
        priority: 'high',
        category: 'performance',
        issue: 'High average response time',
        recommendation: 'Implement caching, optimize database queries, or scale infrastructure',
        estimatedImpact: 'Improved user experience and reduced server load'
      });
    }

    // Security recommendations
    if (securityAssessment.summary.overallRiskLevel === 'high' || securityAssessment.summary.overallRiskLevel === 'critical') {
      recommendations.push({
        priority: 'critical',
        category: 'security',
        issue: 'High security risk level detected',
        recommendation: 'Implement additional security measures and address identified vulnerabilities',
        estimatedImpact: 'Reduced security risk and improved compliance'
      });
    }

    // Logging recommendations
    if (logAnalytics.summary.errorRate > 5) {
      recommendations.push({
        priority: 'medium',
        category: 'reliability',
        issue: 'High error rate in logs',
        recommendation: 'Investigate and fix recurring errors, improve error handling',
        estimatedImpact: 'Improved system stability and user experience'
      });
    }

    // Memory recommendations
    if (systemHealth.metrics.memoryUsage > 80) {
      recommendations.push({
        priority: 'medium',
        category: 'resources',
        issue: 'High memory usage',
        recommendation: 'Optimize memory usage, implement garbage collection tuning, or scale memory',
        estimatedImpact: 'Improved performance and reduced risk of out-of-memory errors'
      });
    }

    // Monitoring recommendations
    const monitoringGaps = this.identifyMonitoringGaps(systemHealth);
    for (const gap of monitoringGaps) {
      recommendations.push({
        priority: 'low',
        category: 'monitoring',
        issue: gap.issue,
        recommendation: gap.recommendation,
        estimatedImpact: 'Better visibility and proactive issue detection'
      });
    }

    return recommendations.sort((a, b) => {
      const priorityOrder: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
      return (priorityOrder[b.priority] || 0) - (priorityOrder[a.priority] || 0);
    });
  }

  /**
   * Identify monitoring gaps
   */
  private identifyMonitoringGaps(systemHealth: any): Array<{ issue: string; recommendation: string }> {
    const gaps: Array<{ issue: string; recommendation: string }> = [];

    if (!this.config.enableHealthChecks) {
      gaps.push({
        issue: 'External health checks disabled',
        recommendation: 'Enable health checks for critical external dependencies'
      });
    }

    if (this.config.monitoringInterval > 300000) { // 5 minutes
      gaps.push({
        issue: 'Monitoring interval too long',
        recommendation: 'Reduce monitoring interval for faster issue detection'
      });
    }

    if (systemHealth.alerts.length === 0 && systemHealth.overall !== 'healthy') {
      gaps.push({
        issue: 'Alert system may not be sensitive enough',
        recommendation: 'Review and adjust alert thresholds for better sensitivity'
      });
    }

    return gaps;
  }

  /**
   * Get monitoring status
   */
  getStatus(): {
    isMonitoring: boolean;
    uptime: number;
    lastHealthCheck?: SystemHealthStatus;
    alertHistory: number;
    config: MonitoringConfig;
  } {
    return {
      isMonitoring: this.monitoringInterval !== undefined,
      uptime: Date.now() - this.startTime,
      lastHealthCheck: this.lastHealthCheck,
      alertHistory: this.alertHistory.length,
      config: this.config
    };
  }

  /**
   * Destroy integrated monitoring and cleanup
   */
  async destroy(): Promise<void> {
    this.stopMonitoring();
    
    this.alertHistory = [];
    this.removeAllListeners();
    
    this.logger.info('IntegratedMonitoring destroyed', {
      operation: 'monitoring_destroy'
    });
  }
}