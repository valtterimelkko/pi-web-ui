/**
 * Memory Usage Benchmarks
 * 
 * Measures memory efficiency of the mobile-optimized session handling.
 * Uses performance.memory API where available (Chrome/Chromium).
 * 
 * Run with: npm run benchmark
 */

import { bench, describe, beforeAll, afterAll, expect } from 'vitest'
import { MemoryTrackingCache, BASELINE, TARGETS, bytesToMB } from './index'

// Get current memory usage (Chrome/Chromium only)
function getMemoryUsage(): number {
  // @ts-expect-error - performance.memory is Chrome-specific
  if (typeof performance !== 'undefined' && performance.memory) {
    // @ts-expect-error - performance.memory is Chrome-specific
    return performance.memory.usedJSHeapSize
  }
  // Fallback: estimate based on known data
  return 0
}

// Session cache instance
let memoryCache: MemoryTrackingCache

describe('Memory Usage Benchmarks', () => {
  beforeAll(() => {
    memoryCache = new MemoryTrackingCache(5)
  })

  afterAll(() => {
    memoryCache.clear()
  })

  describe('Per-Session Memory', () => {
    bench(
      'memory-per-small-session',
      async () => {
        memoryCache.clear()
        
        const { sizeBytes } = await memoryCache.loadSessionWithTracking('small-session')
        const sizeMB = bytesToMB(sizeBytes)
        
        // Should be well under 5MB
        expect(sizeMB).toBeLessThan(TARGETS.memoryPerSession)
        
        return sizeMB
      },
      { 
        time: 1000,
        iterations: 10,
        throws: false,
      }
    )

    bench(
      'memory-per-large-session',
      async () => {
        memoryCache.clear()
        
        // Simulate a large session with 500 messages
        const largeSession = {
          id: 'large-session',
          messages: Array(500).fill(null).map((_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `Message ${i} with longer content. `.repeat(20)
          })),
          metadata: { created: Date.now(), path: '/sessions/large' }
        }
        
        const sizeBytes = JSON.stringify(largeSession).length * 2
        const sizeMB = bytesToMB(sizeBytes)
        
        // Large sessions should still be reasonable
        expect(sizeMB).toBeLessThan(10) // 10MB max for large sessions
        
        return sizeMB
      },
      { 
        time: 1000,
        iterations: 5,
        throws: false,
      }
    )

    bench(
      'memory-session-with-code-blocks',
      async () => {
        memoryCache.clear()
        
        // Simulate session with code blocks (larger content)
        const codeSession = {
          id: 'code-session',
          messages: Array(50).fill(null).map((_, i) => ({
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: i % 2 === 0 
              ? 'Can you help me with this code?'
              : '```typescript\n' + 
                'function example() {\n' +
                '  const data = Array(100).fill(null).map((_, i) => ({ id: i }));\n' +
                '  return data.filter(item => item.id % 2 === 0);\n' +
                '}\n' +
                '```'
          })),
          metadata: { created: Date.now(), path: '/sessions/code' }
        }
        
        const sizeBytes = JSON.stringify(codeSession).length * 2
        const sizeMB = bytesToMB(sizeBytes)
        
        return sizeMB
      },
      { 
        time: 1000,
        iterations: 10,
        throws: false,
      }
    )
  })

  describe('LRU Cache Effectiveness', () => {
    bench(
      'lru-cache-eviction',
      async () => {
        memoryCache.clear()
        
        // Load 10 sessions (should evict to 5)
        for (let i = 0; i < 10; i++) {
          await memoryCache.loadSessionWithTracking(`session-${i}`)
        }
        
        const cachedCount = memoryCache.getCachedSessionCount()
        
        // Should only have 5 cached
        expect(cachedCount).toBe(5)
        
        return cachedCount
      },
      { 
        time: 2000,
        iterations: 5,
        throws: false,
      }
    )

    bench(
      'lru-cache-access-order',
      async () => {
        memoryCache.clear()
        
        // Load sessions 0-4
        for (let i = 0; i < 5; i++) {
          await memoryCache.loadSessionWithTracking(`session-${i}`)
        }
        
        // Access session 0 (makes it most recently used)
        await memoryCache.loadSessionWithTracking('session-0')
        
        // Load 3 more sessions (should evict 1, 2, 3)
        for (let i = 5; i < 8; i++) {
          await memoryCache.loadSessionWithTracking(`session-${i}`)
        }
        
        const cachedCount = memoryCache.getCachedSessionCount()
        expect(cachedCount).toBe(5)
        
        return cachedCount
      },
      { 
        time: 2000,
        iterations: 5,
        throws: false,
      }
    )

    bench(
      'lru-cache-memory-bounded',
      async () => {
        memoryCache.clear()
        
        // Load 20 sessions
        for (let i = 0; i < 20; i++) {
          await memoryCache.loadSessionWithTracking(`session-${i}`)
        }
        
        const totalMemory = memoryCache.getTotalMemoryBytes()
        const totalMB = bytesToMB(totalMemory)
        
        // With 5 sessions cached at ~1MB each, should be under 10MB
        expect(totalMB).toBeLessThan(10)
        
        return totalMB
      },
      { 
        time: 3000,
        iterations: 3,
        throws: false,
      }
    )
  })

  describe('Memory Cleanup', () => {
    bench(
      'session-unload-cleanup',
      async () => {
        memoryCache.clear()
        
        // Load a session
        await memoryCache.loadSessionWithTracking('session-to-unload')
        const beforeCount = memoryCache.getCachedSessionCount()
        
        // Clear cache (simulates unmount/cleanup)
        memoryCache.clear()
        const afterCount = memoryCache.getCachedSessionCount()
        
        expect(beforeCount).toBe(1)
        expect(afterCount).toBe(0)
        
        return afterCount
      },
      { 
        time: 1000,
        iterations: 10,
        throws: false,
      }
    )

    bench(
      'repeated-load-unload-cycle',
      async () => {
        memoryCache.clear()
        
        const initialMemory = getMemoryUsage()
        
        // Load and unload sessions repeatedly
        for (let cycle = 0; cycle < 3; cycle++) {
          for (let i = 0; i < 10; i++) {
            await memoryCache.loadSessionWithTracking(`cycle-${cycle}-session-${i}`)
          }
          memoryCache.clear()
        }
        
        const finalMemory = getMemoryUsage()
        
        // Memory should not grow significantly (if we can measure it)
        if (initialMemory > 0 && finalMemory > 0) {
          const growthMB = bytesToMB(finalMemory - initialMemory)
          expect(growthMB).toBeLessThan(5) // Should not grow by more than 5MB
        }
        
        return memoryCache.getCachedSessionCount()
      },
      { 
        time: 5000,
        iterations: 2,
        throws: false,
      }
    )
  })

  describe('Heap Usage (Chrome/Chromium)', () => {
    bench(
      'heap-size-before-after',
      async () => {
        const beforeHeap = getMemoryUsage()
        
        memoryCache.clear()
        
        // Load 5 sessions
        for (let i = 0; i < 5; i++) {
          await memoryCache.loadSessionWithTracking(`heap-test-${i}`)
        }
        
        const afterHeap = getMemoryUsage()
        
        // Calculate growth if we have measurements
        if (beforeHeap > 0 && afterHeap > 0) {
          const heapGrowthMB = bytesToMB(afterHeap - beforeHeap)
          
          // Heap should not grow by more than 10MB for 5 sessions
          expect(heapGrowthMB).toBeLessThan(10)
          
          return heapGrowthMB
        }
        
        // If we can't measure, return tracked estimate
        return bytesToMB(memoryCache.getTotalMemoryBytes())
      },
      { 
        time: 2000,
        iterations: 5,
        throws: false,
      }
    )

    bench(
      'gc-pressure-test',
      async () => {
        memoryCache.clear()
        
        // Create and discard many sessions to test GC behavior
        for (let i = 0; i < 50; i++) {
          await memoryCache.loadSessionWithTracking(`gc-test-${i}`)
          
          // Force cache eviction (triggers cleanup)
          if (i % 10 === 0) {
            memoryCache.clear()
          }
        }
        
        // If we have memory API, trigger GC suggestion
        if (typeof globalThis.gc === 'function') {
          globalThis.gc()
        }
        
        return memoryCache.getCachedSessionCount()
      },
      { 
        time: 5000,
        iterations: 2,
        throws: false,
      }
    )
  })
})

// Export for use in comparison reports
export { BASELINE, TARGETS }
