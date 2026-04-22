import { EventEmitter } from 'events';

export interface ParallelTask<T> {
  id: string;
  data: T;
  priority: 'low' | 'normal' | 'high' | 'critical';
  timeout?: number;
  retryCount?: number;
  maxRetries?: number;
}

export interface ProcessingResult<R> {
  taskId: string;
  success: boolean;
  result?: R;
  error?: Error;
  processingTime: number;
  retryCount: number;
}

export interface ProcessorConfig {
  maxConcurrency: number;
  defaultTimeout: number;
  retryDelayMs: number;
  adaptiveConcurrency: boolean;
  priorityQueuing: boolean;
  enableMetrics: boolean;
}

export interface ProcessingMetrics {
  totalProcessed: number;
  successCount: number;
  errorCount: number;
  averageProcessingTime: number;
  currentConcurrency: number;
  queueLength: number;
  throughputPerSecond: number;
}

export class ParallelProcessor<T, R> extends EventEmitter {
  private config: ProcessorConfig;
  private taskQueue: ParallelTask<T>[];
  private priorityQueues: Map<string, ParallelTask<T>[]>;
  private activeTasks: Map<string, Promise<ProcessingResult<R>>>;
  private metrics: ProcessingMetrics;
  private processingFunction: (data: T) => Promise<R>;
  private startTime: number;

  constructor(
    processingFunction: (data: T) => Promise<R>,
    config: Partial<ProcessorConfig> = {}
  ) {
    super();
    
    this.processingFunction = processingFunction;
    this.config = {
      maxConcurrency: 5,
      defaultTimeout: 30000,
      retryDelayMs: 1000,
      adaptiveConcurrency: true,
      priorityQueuing: true,
      enableMetrics: true,
      ...config
    };

    this.taskQueue = [];
    this.priorityQueues = new Map([
      ['critical', []],
      ['high', []],
      ['normal', []],
      ['low', []]
    ]);
    this.activeTasks = new Map();
    this.startTime = Date.now();

    this.metrics = {
      totalProcessed: 0,
      successCount: 0,
      errorCount: 0,
      averageProcessingTime: 0,
      currentConcurrency: 0,
      queueLength: 0,
      throughputPerSecond: 0
    };

    console.error('🔄 ParallelProcessor initialized:', this.config);
  }

  /**
   * Add task to processing queue with intelligent prioritization
   */
  async addTask(task: ParallelTask<T>): Promise<ProcessingResult<R>> {
    return new Promise((resolve, reject) => {
      const enhancedTask = {
        ...task,
        timeout: task.timeout || this.config.defaultTimeout,
        retryCount: 0,
        maxRetries: task.maxRetries || 3
      };

      // Add resolve/reject to task for promise handling
      (enhancedTask as any).resolve = resolve;
      (enhancedTask as any).reject = reject;

      if (this.config.priorityQueuing) {
        this.priorityQueues.get(task.priority)?.push(enhancedTask);
      } else {
        this.taskQueue.push(enhancedTask);
      }

      this.updateMetrics();
      this.emit('task-queued', task.id, task.priority);
      
      // Try to process immediately
      this.processNextTasks();
    });
  }

  /**
   * Add multiple tasks for batch processing
   */
  async addBatch(tasks: ParallelTask<T>[]): Promise<ProcessingResult<R>[]> {
    console.error(`📦 Adding batch of ${tasks.length} tasks for processing`);
    
    const promises = tasks.map(task => this.addTask(task));
    return Promise.all(promises);
  }

  /**
   * Process emails in parallel with intelligent batching
   */
  async processEmailsBatch(
    emails: any[],
    operation: (email: any) => Promise<any>,
    options: {
      priority?: 'low' | 'normal' | 'high' | 'critical';
      batchSize?: number;
      timeout?: number;
    } = {}
  ): Promise<ProcessingResult<any>[]> {
    const { priority = 'normal', batchSize = 10, timeout = 15000 } = options;
    
    console.error(`📧 Processing ${emails.length} emails in parallel (batch size: ${batchSize})`);

    // Create processor for email operations
    const emailProcessor = new ParallelProcessor(operation, {
      maxConcurrency: Math.min(batchSize, this.config.maxConcurrency),
      defaultTimeout: timeout,
      adaptiveConcurrency: this.config.adaptiveConcurrency
    });

    // Convert emails to tasks
    const tasks: ParallelTask<any, any>[] = emails.map((email, index) => ({
      id: `email-${email.id || index}`,
      data: email,
      priority,
      timeout
    }));

    try {
      const results = await emailProcessor.addBatch(tasks);
      await emailProcessor.waitForCompletion();
      
      const successCount = results.filter(r => r.success).length;
      console.error(`✅ Email batch processing completed: ${successCount}/${emails.length} successful`);
      
      return results;
    } finally {
      emailProcessor.destroy();
    }
  }

  /**
   * Process attachments with optimized parallel downloading
   */
  async processAttachmentsBatch(
    attachments: any[],
    downloadFunction: (attachment: any) => Promise<any>,
    options: {
      maxConcurrentDownloads?: number;
      sizeLimit?: number; // MB
      timeout?: number;
    } = {}
  ): Promise<ProcessingResult<any>[]> {
    const { 
      maxConcurrentDownloads = 3, 
      sizeLimit = 25,
      timeout = 60000 
    } = options;

    // Filter attachments by size if specified
    const filteredAttachments = sizeLimit 
      ? attachments.filter(att => (att.size || 0) / (1024 * 1024) <= sizeLimit)
      : attachments;

    console.error(`📎 Processing ${filteredAttachments.length} attachments in parallel (max concurrent: ${maxConcurrentDownloads})`);

    // Create specialized processor for downloads
    const downloadProcessor = new ParallelProcessor(downloadFunction, {
      maxConcurrency: maxConcurrentDownloads,
      defaultTimeout: timeout,
      adaptiveConcurrency: false, // Keep stable for downloads
      retryDelayMs: 2000 // Longer retry delay for downloads
    });

    // Prioritize smaller attachments for faster completion
    const sortedAttachments = filteredAttachments.sort((a, b) => (a.size || 0) - (b.size || 0));

    const tasks: ParallelTask<any, any>[] = sortedAttachments.map((attachment, index) => ({
      id: `attachment-${attachment.id || index}`,
      data: attachment,
      priority: (attachment.size || 0) < 1024 * 1024 ? 'high' : 'normal', // Prioritize small files
      timeout,
      maxRetries: 2 // Fewer retries for downloads
    }));

    try {
      const results = await downloadProcessor.addBatch(tasks);
      await downloadProcessor.waitForCompletion();
      
      const successCount = results.filter(r => r.success).length;
      const totalSize = results
        .filter(r => r.success)
        .reduce((sum, r) => sum + ((r.result?.size || 0) / (1024 * 1024)), 0);
      
      console.error(`✅ Attachment batch processing completed: ${successCount}/${filteredAttachments.length} successful, ${totalSize.toFixed(2)}MB downloaded`);
      
      return results;
    } finally {
      downloadProcessor.destroy();
    }
  }

  /**
   * Process search queries in parallel with result merging
   */
  async processSearchQueriesBatch(
    queries: Array<{ query: string; folder?: string; options?: any }>,
    searchFunction: (queryData: any) => Promise<any[]>,
    options: {
      mergeResults?: boolean;
      deduplicate?: boolean;
      maxResultsPerQuery?: number;
    } = {}
  ): Promise<any[]> {
    const { mergeResults = true, deduplicate = true, maxResultsPerQuery = 50 } = options;

    console.error(`🔍 Processing ${queries.length} search queries in parallel`);

    const searchProcessor = new ParallelProcessor(searchFunction, {
      maxConcurrency: Math.min(queries.length, 5),
      defaultTimeout: 10000,
      adaptiveConcurrency: true
    });

    const tasks: ParallelTask<any, any[]>[] = queries.map((queryData, index) => ({
      id: `search-${index}`,
      data: { ...queryData, maxResults: maxResultsPerQuery },
      priority: 'normal'
    }));

    try {
      const results = await searchProcessor.addBatch(tasks);
      await searchProcessor.waitForCompletion();

      if (!mergeResults) {
        return results.map(r => r.result || []);
      }

      // Merge all results
      let allResults: any[] = [];
      for (const result of results) {
        if (result.success && result.result) {
          allResults.push(...result.result);
        }
      }

      // Deduplicate by email ID if requested
      if (deduplicate) {
        const seen = new Set();
        allResults = allResults.filter(email => {
          if (seen.has(email.id)) return false;
          seen.add(email.id);
          return true;
        });
      }

      console.error(`✅ Search batch completed: ${allResults.length} unique results from ${queries.length} queries`);
      return allResults;
    } finally {
      searchProcessor.destroy();
    }
  }

  /**
   * Process next available tasks with intelligent scheduling
   */
  private async processNextTasks(): Promise<void> {
    // Check if we can start more tasks
    while (this.activeTasks.size < this.getCurrentConcurrencyLimit() && this.hasQueuedTasks()) {
      const nextTask = this.getNextTask();
      if (!nextTask) break;

      const taskPromise = this.processTask(nextTask);
      this.activeTasks.set(nextTask.id, taskPromise);

      // Handle task completion
      taskPromise
        .then(result => this.handleTaskCompletion(nextTask, result))
        .catch(error => this.handleTaskError(nextTask, error))
        .finally(() => {
          this.activeTasks.delete(nextTask.id);
          this.processNextTasks(); // Try to start more tasks
        });
    }

    this.updateMetrics();
  }

  /**
   * Process individual task with timeout and retry logic
   */
  private async processTask(task: ParallelTask<T>): Promise<ProcessingResult<R>> {
    const startTime = Date.now();
    
    try {
      this.emit('task-started', task.id);
      
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Task timeout')), task.timeout);
      });

      // Race between actual processing and timeout
      const result = await Promise.race([
        this.processingFunction(task.data),
        timeoutPromise
      ]);

      const processingTime = Date.now() - startTime;
      
      const processResult: ProcessingResult<R> = {
        taskId: task.id,
        success: true,
        result,
        processingTime,
        retryCount: task.retryCount || 0
      };

      this.emit('task-completed', task.id, processingTime);
      return processResult;
    } catch (error) {
      const processingTime = Date.now() - startTime;
      const processResult: ProcessingResult<R> = {
        taskId: task.id,
        success: false,
        error: error instanceof Error ? error : new Error('Unknown error'),
        processingTime,
        retryCount: task.retryCount || 0
      };

      this.emit('task-failed', task.id, error);
      return processResult;
    }
  }

  /**
   * Handle successful task completion
   */
  private handleTaskCompletion(task: ParallelTask<T>, result: ProcessingResult<R>): void {
    const taskWithResolver = task as any;
    taskWithResolver.resolve?.(result);
    
    this.metrics.totalProcessed++;
    if (result.success) {
      this.metrics.successCount++;
    } else {
      this.metrics.errorCount++;
    }

    this.updateAverageProcessingTime(result.processingTime);
  }

  /**
   * Handle task errors with retry logic
   */
  private async handleTaskError(task: ParallelTask<T>, error: any): Promise<void> {
    const currentRetries = task.retryCount || 0;
    
    if (currentRetries < (task.maxRetries || 3)) {
      // Retry the task
      task.retryCount = currentRetries + 1;
      
      console.error(`🔄 Retrying task ${task.id} (attempt ${task.retryCount}/${task.maxRetries})`);
      
      // Add delay before retry
      await new Promise(resolve => setTimeout(resolve, this.config.retryDelayMs * task.retryCount!));
      
      // Re-queue the task
      if (this.config.priorityQueuing) {
        this.priorityQueues.get(task.priority)?.unshift(task); // High priority for retries
      } else {
        this.taskQueue.unshift(task);
      }
      
      this.emit('task-retry', task.id, task.retryCount);
    } else {
      // Max retries exceeded
      const result: ProcessingResult<R> = {
        taskId: task.id,
        success: false,
        error: error instanceof Error ? error : new Error('Max retries exceeded'),
        processingTime: 0,
        retryCount: currentRetries
      };

      const taskWithResolver = task as any;
      taskWithResolver.resolve?.(result);
      
      this.metrics.totalProcessed++;
      this.metrics.errorCount++;
      
      this.emit('task-failed-permanently', task.id, error);
    }
  }

  /**
   * Get next task from queue based on priority
   */
  private getNextTask(): ParallelTask<T> | null {
    if (this.config.priorityQueuing) {
      // Check priority queues in order
      for (const priority of ['critical', 'high', 'normal', 'low']) {
        const queue = this.priorityQueues.get(priority);
        if (queue && queue.length > 0) {
          return queue.shift()!;
        }
      }
      return null;
    } else {
      return this.taskQueue.shift() || null;
    }
  }

  /**
   * Check if there are queued tasks
   */
  private hasQueuedTasks(): boolean {
    if (this.config.priorityQueuing) {
      return Array.from(this.priorityQueues.values()).some(queue => queue.length > 0);
    }
    return this.taskQueue.length > 0;
  }

  /**
   * Get current concurrency limit with adaptive adjustment
   */
  private getCurrentConcurrencyLimit(): number {
    if (!this.config.adaptiveConcurrency) {
      return this.config.maxConcurrency;
    }

    // Adaptive concurrency based on success rate and processing time
    const successRate = this.metrics.totalProcessed > 0 
      ? this.metrics.successCount / this.metrics.totalProcessed 
      : 1;

    if (successRate > 0.95 && this.metrics.averageProcessingTime < 5000) {
      // High success rate and fast processing - increase concurrency
      return Math.min(this.config.maxConcurrency * 1.5, this.config.maxConcurrency + 3);
    } else if (successRate < 0.8 || this.metrics.averageProcessingTime > 15000) {
      // Low success rate or slow processing - decrease concurrency
      return Math.max(Math.floor(this.config.maxConcurrency * 0.7), 1);
    }

    return this.config.maxConcurrency;
  }

  /**
   * Update processing metrics
   */
  private updateMetrics(): void {
    this.metrics.currentConcurrency = this.activeTasks.size;
    this.metrics.queueLength = this.getQueueLength();
    
    const runtimeSeconds = (Date.now() - this.startTime) / 1000;
    this.metrics.throughputPerSecond = runtimeSeconds > 0 ? this.metrics.totalProcessed / runtimeSeconds : 0;
  }

  /**
   * Update average processing time
   */
  private updateAverageProcessingTime(newTime: number): void {
    if (this.metrics.totalProcessed === 1) {
      this.metrics.averageProcessingTime = newTime;
    } else {
      // Exponential moving average
      this.metrics.averageProcessingTime = 
        (this.metrics.averageProcessingTime * 0.9) + (newTime * 0.1);
    }
  }

  /**
   * Get total queue length across all priority queues
   */
  private getQueueLength(): number {
    if (this.config.priorityQueuing) {
      return Array.from(this.priorityQueues.values())
        .reduce((total, queue) => total + queue.length, 0);
    }
    return this.taskQueue.length;
  }

  /**
   * Wait for all tasks to complete
   */
  async waitForCompletion(): Promise<void> {
    while (this.activeTasks.size > 0 || this.hasQueuedTasks()) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Get current processing metrics
   */
  getMetrics(): ProcessingMetrics {
    this.updateMetrics();
    return { ...this.metrics };
  }

  /**
   * Clear all queues and stop processing
   */
  clear(): void {
    this.taskQueue = [];
    this.priorityQueues.forEach(queue => queue.length = 0);
    
    // Reject all active tasks
    for (const [_taskId, taskPromise] of this.activeTasks.entries()) {
      taskPromise.catch(() => {}); // Ignore errors
    }
    this.activeTasks.clear();

    this.metrics = {
      totalProcessed: 0,
      successCount: 0,
      errorCount: 0,
      averageProcessingTime: 0,
      currentConcurrency: 0,
      queueLength: 0,
      throughputPerSecond: 0
    };

    console.error('🧹 ParallelProcessor cleared');
  }

  /**
   * Destroy processor and clean up resources
   */
  destroy(): void {
    this.clear();
    this.removeAllListeners();
    console.error('💥 ParallelProcessor destroyed');
  }
}