import { EventEmitter } from 'events';

export interface PerformanceMetric {
  operation: string;
  startTime: number;
  endTime: number;
  duration: number;
  success: boolean;
  error?: string;
  metadata?: any;
}

export interface SystemMetrics {
  cpuUsage: number;
  memoryUsage: {
    used: number;
    total: number;
    percentage: number;
  };
  responseTime: {
    average: number;
    median: number;
    p95: number;
    p99: number;
  };
  errorRate: number;
  throughput: number;
}

export interface AlertConfig {
  responseTimeThreshold: number; // ms
  errorRateThreshold: number; // percentage
  memoryThreshold: number; // percentage
  cpuThreshold: number; // percentage
  throughputMinThreshold: number; // requests per minute
}

export class PerformanceMonitor extends EventEmitter {
  private metrics: PerformanceMetric[];
  private operationCounters: Map<string, number>;
  private responseTimesHistogram: Map<string, number[]>;
  private alertConfig: AlertConfig;
  private monitoringInterval?: NodeJS.Timeout;
  private startTime: number;

  constructor(alertConfig: Partial<AlertConfig> = {}) {
    super();
    
    this.metrics = [];
    this.operationCounters = new Map();
    this.responseTimesHistogram = new Map();
    this.startTime = Date.now();
    
    this.alertConfig = {
      responseTimeThreshold: 5000, // 5 seconds
      errorRateThreshold: 5, // 5%
      memoryThreshold: 80, // 80%
      cpuThreshold: 80, // 80%
      throughputMinThreshold: 10, // 10 requests per minute
      ...alertConfig
    };

    console.log('📊 PerformanceMonitor initialized with alerts:', this.alertConfig);
  }

  /**
   * Start monitoring an operation
   */
  startOperation(operation: string, metadata?: any): string {
    const operationId = `${operation}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Store operation start time
    (this as any)[`start_${operationId}`] = {
      operation,
      startTime: Date.now(),
      metadata
    };

    return operationId;
  }

  /**
   * End monitoring an operation
   */
  endOperation(operationId: string, success: boolean = true, error?: string): PerformanceMetric | null {
    const startData = (this as any)[`start_${operationId}`];
    if (!startData) {
      console.warn(`⚠️ Operation ${operationId} not found in monitoring`);
      return null;
    }

    const endTime = Date.now();
    const duration = endTime - startData.startTime;

    const metric: PerformanceMetric = {
      operation: startData.operation,
      startTime: startData.startTime,
      endTime,
      duration,
      success,
      error,
      metadata: startData.metadata
    };

    // Store metric
    this.metrics.push(metric);
    
    // Update counters
    const currentCount = this.operationCounters.get(startData.operation) || 0;
    this.operationCounters.set(startData.operation, currentCount + 1);

    // Update response time histogram
    if (!this.responseTimesHistogram.has(startData.operation)) {
      this.responseTimesHistogram.set(startData.operation, []);
    }
    this.responseTimesHistogram.get(startData.operation)!.push(duration);

    // Cleanup start data
    delete (this as any)[`start_${operationId}`];

    // Keep only last 10000 metrics to prevent memory leaks
    if (this.metrics.length > 10000) {
      this.metrics = this.metrics.slice(-10000);
    }

    // Check for alerts
    this.checkAlerts(metric);

    this.emit('metric-recorded', metric);
    return metric;
  }

  /**
   * Measure execution time of a function
   */
  async measureOperation<T>(
    operation: string, 
    fn: () => Promise<T>, 
    metadata?: any
  ): Promise<T> {
    const operationId = this.startOperation(operation, metadata);
    
    try {
      const result = await fn();
      this.endOperation(operationId, true);
      return result;
    } catch (error) {
      this.endOperation(operationId, false, error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  }

  /**
   * Get comprehensive system metrics
   */
  getSystemMetrics(timeWindow: number = 3600000): SystemMetrics { // 1 hour default
    const cutoffTime = Date.now() - timeWindow;
    const recentMetrics = this.metrics.filter(m => m.startTime > cutoffTime);
    
    if (recentMetrics.length === 0) {
      return {
        cpuUsage: 0,
        memoryUsage: { used: 0, total: 0, percentage: 0 },
        responseTime: { average: 0, median: 0, p95: 0, p99: 0 },
        errorRate: 0,
        throughput: 0
      };
    }

    // Calculate response time statistics
    const responseTimes = recentMetrics.map(m => m.duration).sort((a, b) => a - b);
    const responseTimeStats = {
      average: responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length,
      median: responseTimes[Math.floor(responseTimes.length / 2)] || 0,
      p95: responseTimes[Math.floor(responseTimes.length * 0.95)] || 0,
      p99: responseTimes[Math.floor(responseTimes.length * 0.99)] || 0
    };

    // Calculate error rate
    const errorCount = recentMetrics.filter(m => !m.success).length;
    const errorRate = (errorCount / recentMetrics.length) * 100;

    // Calculate throughput (requests per minute)
    const timeWindowMinutes = timeWindow / 60000;
    const throughput = recentMetrics.length / timeWindowMinutes;

    // Get system memory usage
    const memUsage = process.memoryUsage();
    const memoryUsage = {
      used: memUsage.heapUsed,
      total: memUsage.heapTotal,
      percentage: (memUsage.heapUsed / memUsage.heapTotal) * 100
    };

    // Get CPU usage (simplified estimation)
    const cpuUsage = this.estimateCpuUsage();

    return {
      cpuUsage,
      memoryUsage,
      responseTime: responseTimeStats,
      errorRate,
      throughput
    };
  }

  /**
   * Get operation-specific statistics
   */
  getOperationStats(operation: string, timeWindow: number = 3600000): {
    totalCount: number;
    recentCount: number;
    successRate: number;
    averageResponseTime: number;
    recentMetrics: PerformanceMetric[];
  } {
    const cutoffTime = Date.now() - timeWindow;
    const allMetrics = this.metrics.filter(m => m.operation === operation);
    const recentMetrics = allMetrics.filter(m => m.startTime > cutoffTime);
    
    const totalCount = this.operationCounters.get(operation) || 0;
    const recentCount = recentMetrics.length;
    
    const successCount = recentMetrics.filter(m => m.success).length;
    const successRate = recentCount > 0 ? (successCount / recentCount) * 100 : 0;
    
    const totalResponseTime = recentMetrics.reduce((sum, m) => sum + m.duration, 0);
    const averageResponseTime = recentCount > 0 ? totalResponseTime / recentCount : 0;

    return {
      totalCount,
      recentCount,
      successRate,
      averageResponseTime,
      recentMetrics
    };
  }

  /**
   * Check for performance alerts
   */
  private checkAlerts(metric: PerformanceMetric): void {
    const alerts: string[] = [];

    // Response time alert
    if (metric.duration > this.alertConfig.responseTimeThreshold) {
      alerts.push(`High response time: ${metric.duration}ms for ${metric.operation}`);
    }

    // Get recent system metrics for other alerts
    const systemMetrics = this.getSystemMetrics(300000); // 5 minutes

    // Memory usage alert
    if (systemMetrics.memoryUsage.percentage > this.alertConfig.memoryThreshold) {
      alerts.push(`High memory usage: ${systemMetrics.memoryUsage.percentage.toFixed(1)}%`);
    }

    // CPU usage alert
    if (systemMetrics.cpuUsage > this.alertConfig.cpuThreshold) {
      alerts.push(`High CPU usage: ${systemMetrics.cpuUsage.toFixed(1)}%`);
    }

    // Error rate alert
    if (systemMetrics.errorRate > this.alertConfig.errorRateThreshold) {
      alerts.push(`High error rate: ${systemMetrics.errorRate.toFixed(1)}%`);
    }

    // Low throughput alert
    if (systemMetrics.throughput < this.alertConfig.throughputMinThreshold) {
      alerts.push(`Low throughput: ${systemMetrics.throughput.toFixed(1)} req/min`);
    }

    // Emit alerts
    for (const alert of alerts) {
      this.emit('performance-alert', {
        message: alert,
        metric,
        systemMetrics,
        timestamp: Date.now(),
        severity: this.getAlertSeverity(alert)
      });
    }
  }

  /**
   * Determine alert severity
   */
  private getAlertSeverity(alert: string): 'low' | 'medium' | 'high' | 'critical' {
    if (alert.includes('CPU') || alert.includes('memory')) {
      return 'high';
    }
    if (alert.includes('error rate')) {
      return 'critical';
    }
    if (alert.includes('response time')) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Estimate CPU usage (simplified)
   */
  private estimateCpuUsage(): number {
    const usage = process.cpuUsage();
    const totalUsage = usage.user + usage.system;
    
    // Convert to percentage (very rough estimation)
    // This is a simplified calculation and may not be accurate
    const estimatedPercentage = Math.min((totalUsage / 1000000) * 100, 100);
    return estimatedPercentage;
  }

  /**
   * Start real-time monitoring
   */
  startRealTimeMonitoring(intervalMs: number = 60000): void { // 1 minute default
    this.stopRealTimeMonitoring(); // Stop existing monitoring

    this.monitoringInterval = setInterval(() => {
      try {
        const systemMetrics = this.getSystemMetrics();
        
        this.emit('system-metrics', {
          timestamp: Date.now(),
          metrics: systemMetrics,
          uptime: Date.now() - this.startTime
        });

        // Log critical issues
        if (systemMetrics.errorRate > this.alertConfig.errorRateThreshold) {
          console.warn(`🚨 High error rate detected: ${systemMetrics.errorRate.toFixed(1)}%`);
        }

        if (systemMetrics.memoryUsage.percentage > this.alertConfig.memoryThreshold) {
          console.warn(`🚨 High memory usage: ${systemMetrics.memoryUsage.percentage.toFixed(1)}%`);
        }

      } catch (error) {
        console.error('❌ Error in real-time monitoring:', error);
      }
    }, intervalMs);

    console.log(`📊 Real-time monitoring started (interval: ${intervalMs}ms)`);
  }

  /**
   * Stop real-time monitoring
   */
  stopRealTimeMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
      console.log('📊 Real-time monitoring stopped');
    }
  }

  /**
   * Generate performance report
   */
  generatePerformanceReport(timeWindow: number = 3600000): {
    summary: SystemMetrics;
    operationBreakdown: Array<{
      operation: string;
      stats: any;
    }>;
    topSlowOperations: Array<{
      operation: string;
      averageTime: number;
      count: number;
    }>;
    errorAnalysis: Array<{
      operation: string;
      errorCount: number;
      errorRate: number;
      commonErrors: string[];
    }>;
    recommendations: string[];
  } {
    const summary = this.getSystemMetrics(timeWindow);
    const operations = Array.from(this.operationCounters.keys());
    
    // Operation breakdown
    const operationBreakdown = operations.map(operation => ({
      operation,
      stats: this.getOperationStats(operation, timeWindow)
    }));

    // Top slow operations
    const topSlowOperations = operationBreakdown
      .map(({ operation, stats }) => ({
        operation,
        averageTime: stats.averageResponseTime,
        count: stats.recentCount
      }))
      .filter(op => op.count > 0)
      .sort((a, b) => b.averageTime - a.averageTime)
      .slice(0, 10);

    // Error analysis
    const cutoffTime = Date.now() - timeWindow;
    const recentMetrics = this.metrics.filter(m => m.startTime > cutoffTime);
    
    const errorAnalysis = operations.map(operation => {
      const opMetrics = recentMetrics.filter(m => m.operation === operation);
      const errorMetrics = opMetrics.filter(m => !m.success);
      
      const commonErrors = errorMetrics
        .map(m => m.error || 'Unknown error')
        .reduce((acc, error) => {
          acc[error] = (acc[error] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);

      return {
        operation,
        errorCount: errorMetrics.length,
        errorRate: opMetrics.length > 0 ? (errorMetrics.length / opMetrics.length) * 100 : 0,
        commonErrors: Object.entries(commonErrors)
          .sort(([,a], [,b]) => b - a)
          .slice(0, 5)
          .map(([error]) => error)
      };
    }).filter(analysis => analysis.errorCount > 0);

    // Generate recommendations
    const recommendations: string[] = [];
    
    if (summary.responseTime.average > 2000) {
      recommendations.push('Consider optimizing slow operations or implementing caching');
    }
    
    if (summary.errorRate > 2) {
      recommendations.push('Investigate and fix recurring errors to improve reliability');
    }
    
    if (summary.memoryUsage.percentage > 70) {
      recommendations.push('Monitor memory usage and consider implementing memory optimization');
    }
    
    if (summary.throughput < 5) {
      recommendations.push('Consider scaling resources or optimizing performance bottlenecks');
    }

    const slowOperations = topSlowOperations.filter(op => op.averageTime > 1000);
    if (slowOperations.length > 0) {
      recommendations.push(`Optimize slow operations: ${slowOperations.map(op => op.operation).join(', ')}`);
    }

    return {
      summary,
      operationBreakdown,
      topSlowOperations,
      errorAnalysis,
      recommendations
    };
  }

  /**
   * Clear metrics and reset counters
   */
  reset(): void {
    this.metrics = [];
    this.operationCounters.clear();
    this.responseTimesHistogram.clear();
    this.startTime = Date.now();
    console.log('📊 PerformanceMonitor reset completed');
  }

  /**
   * Get current monitoring status
   */
  getStatus(): {
    isMonitoring: boolean;
    metricsCount: number;
    operationsTracked: number;
    uptime: number;
    alertConfig: AlertConfig;
  } {
    return {
      isMonitoring: this.monitoringInterval !== undefined,
      metricsCount: this.metrics.length,
      operationsTracked: this.operationCounters.size,
      uptime: Date.now() - this.startTime,
      alertConfig: this.alertConfig
    };
  }

  /**
   * Destroy monitor and cleanup
   */
  destroy(): void {
    this.stopRealTimeMonitoring();
    this.reset();
    this.removeAllListeners();
    console.log('📊 PerformanceMonitor destroyed');
  }
}