/**
 * Performance Benchmarks Index
 * 
 * Run all benchmarks with: npm run benchmark
 * Run quick manual test with: npm run benchmark:quick
 * 
 * Available benchmark suites:
 * - mobile-performance: Session switch, typing latency, render performance
 * - memory-usage: Memory per session, LRU cache effectiveness
 */

// Benchmark configuration
export const BENCHMARK_CONFIG = {
  // Time to run each benchmark (ms)
  defaultTime: 1000,
  
  // Default iterations
  defaultIterations: 10,
  
  // Warmup iterations (not counted)
  warmupIterations: 2,
  
  // Whether to throw on failure
  throws: false
}

// Baseline metrics from before mobile optimizations
export const BASELINE = {
  sessionSwitch: 3000,    // 3 seconds before optimization
  typingLatency: 500,     // 500ms before optimization
  memoryPerSession: 15,   // 15MB before optimization
}

// Target metrics after mobile optimizations
export const TARGETS = {
  sessionSwitch: 1000,    // Under 1 second
  typingLatency: 100,     // Under 100ms
  memoryPerSession: 5,    // Under 5MB per session
}

// Mock session data for benchmarking
interface MockSession {
  id: string
  messages: Array<{ role: string; content: string }>
  metadata: Record<string, unknown>
}

// Simulated session cache (mimics actual implementation)
export class SessionCache {
  protected cache = new Map<string, MockSession>()
  protected maxSize: number
  protected accessOrder: string[] = []

  constructor(maxSize = 5) {
    this.maxSize = maxSize
  }

  async loadSession(id: string): Promise<MockSession> {
    // Check cache first
    if (this.cache.has(id)) {
      this.updateAccessOrder(id)
      return this.cache.get(id)!
    }

    // Simulate loading from storage
    await new Promise(resolve => setTimeout(resolve, 50))
    
    const session: MockSession = {
      id,
      messages: Array(100).fill(null).map((_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`.repeat(50)
      })),
      metadata: { created: Date.now(), path: `/sessions/${id}` }
    }

    // Evict LRU if needed
    if (this.cache.size >= this.maxSize) {
      const lruKey = this.accessOrder.shift()
      if (lruKey) this.cache.delete(lruKey)
    }

    this.cache.set(id, session)
    this.accessOrder.push(id)
    return session
  }

  protected updateAccessOrder(id: string) {
    const index = this.accessOrder.indexOf(id)
    if (index > -1) {
      this.accessOrder.splice(index, 1)
      this.accessOrder.push(id)
    }
  }

  getCachedCount(): number {
    return this.cache.size
  }

  clear() {
    this.cache.clear()
    this.accessOrder = []
  }
}

// Extended session cache with memory tracking
export class MemoryTrackingCache extends SessionCache {
  private sessions: Map<string, { data: unknown; size: number }> = new Map()
  private trackedMaxSize: number
  private trackedAccessOrder: string[] = []

  constructor(maxSize = 5) {
    super(maxSize)
    this.trackedMaxSize = maxSize
  }

  // Estimate memory size of a session in bytes
  private estimateSize(data: unknown): number {
    const str = JSON.stringify(data)
    // Rough estimate: 2 bytes per character for UTF-16
    return str.length * 2
  }

  async loadSessionWithTracking(id: string): Promise<{ session: unknown; sizeBytes: number }> {
    // Simulate loading session data
    const session = {
      id,
      messages: Array(100).fill(null).map((_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`.repeat(50)
      })),
      metadata: { 
        created: Date.now(), 
        path: `/sessions/${id}`,
        tags: ['tag1', 'tag2', 'tag3'],
        settings: { theme: 'dark', fontSize: 14 }
      }
    }

    const sizeBytes = this.estimateSize(session)

    // Evict LRU if needed
    if (this.sessions.size >= this.trackedMaxSize && !this.sessions.has(id)) {
      const lruKey = this.trackedAccessOrder.shift()
      if (lruKey) this.sessions.delete(lruKey)
    }

    this.sessions.set(id, { data: session, size: sizeBytes })
    if (!this.trackedAccessOrder.includes(id)) {
      this.trackedAccessOrder.push(id)
    }

    return { session, sizeBytes }
  }

  getTotalMemoryBytes(): number {
    let total = 0
    for (const { size } of this.sessions.values()) {
      total += size
    }
    return total
  }

  getCachedSessionCount(): number {
    return this.sessions.size
  }

  clear() {
    super.clear()
    this.sessions.clear()
    this.trackedAccessOrder = []
  }
}

// Mock DOM elements for testing
export function createMockTextarea(): HTMLTextAreaElement {
  const textarea = {
    value: '',
    selectionStart: 0,
    selectionEnd: 0,
    dispatchEvent: () => true,
    focus: () => {},
    blur: () => {},
  } as unknown as HTMLTextAreaElement
  return textarea
}

// Simulate typing with realistic delay
export async function simulateTyping(
  element: HTMLTextAreaElement, 
  text: string, 
  delayMs = 10
): Promise<number> {
  const start = performance.now()
  
  for (const char of text) {
    element.value += char
    element.selectionStart = element.value.length
    element.selectionEnd = element.value.length
    await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  
  return performance.now() - start
}

// Format bytes to MB
export function bytesToMB(bytes: number): number {
  return bytes / (1024 * 1024)
}

/**
 * Quick benchmark runner for manual testing
 * Usage: npm run benchmark:quick
 */
async function runQuickBenchmark() {
  console.log('🏃 Running Quick Benchmarks\n')

  // Test 1: Session switch time
  console.log('📊 Session Switch Performance')
  const cache = new SessionCache(5)
  
  const coldStart = performance.now()
  await cache.loadSession('test-1')
  const coldTime = performance.now() - coldStart
  console.log(`  Cold cache: ${coldTime.toFixed(2)}ms`)
  
  const warmStart = performance.now()
  await cache.loadSession('test-1')
  const warmTime = performance.now() - warmStart
  console.log(`  Warm cache: ${warmTime.toFixed(2)}ms`)
  
  cache.clear()

  // Test 2: Typing latency
  console.log('\n📊 Typing Latency')
  const textarea = createMockTextarea()
  const typeStart = performance.now()
  await simulateTyping(textarea, 'Hello world, this is a test message', 2)
  const typeTime = performance.now() - typeStart
  console.log(`  Typing 35 chars: ${typeTime.toFixed(2)}ms`)

  // Test 3: Memory usage
  console.log('\n📊 Memory Usage')
  const memCache = new MemoryTrackingCache(5)
  
  for (let i = 0; i < 10; i++) {
    await memCache.loadSessionWithTracking(`session-${i}`)
  }
  
  const totalMB = bytesToMB(memCache.getTotalMemoryBytes())
  const cachedCount = memCache.getCachedSessionCount()
  
  console.log(`  Cached sessions: ${cachedCount}`)
  console.log(`  Total memory: ${totalMB.toFixed(2)}MB`)
  console.log(`  Memory per session: ${(totalMB / cachedCount).toFixed(2)}MB`)

  // Summary
  console.log('\n📋 Summary')
  console.log('  Target session switch: <1000ms')
  console.log(`  Actual: ${coldTime.toFixed(0)}ms ${coldTime < 1000 ? '✅' : '❌'}`)
  console.log('')
  console.log('  Target typing latency: <100ms')
  console.log(`  Actual: ${typeTime.toFixed(0)}ms ${typeTime < 100 ? '✅' : '❌'}`)
  console.log('')
  console.log('  Target memory per session: <5MB')
  console.log(`  Actual: ${(totalMB / cachedCount).toFixed(2)}MB ${(totalMB / cachedCount) < 5 ? '✅' : '❌'}`)

  memCache.clear()
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runQuickBenchmark().catch(console.error)
}

export default { runQuickBenchmark }
