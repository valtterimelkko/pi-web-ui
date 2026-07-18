/**
 * Mobile Performance Benchmarks
 * 
 * Measures key performance metrics for mobile optimization.
 * These are synthetic benchmarks - real mobile testing should be done on actual devices.
 * 
 * Run with: npm run benchmark
 */

import { bench, describe, beforeAll, afterAll } from 'vitest'
import { 
  SessionCache, 
  createMockTextarea, 
  simulateTyping,
  BASELINE,
  TARGETS 
} from './index'

// Session cache instance
let sessionCache = new SessionCache(5)

describe('Mobile Performance Benchmarks', () => {
  beforeAll(() => {
    sessionCache = new SessionCache(5)
  })

  afterAll(() => {
    sessionCache.clear()
  })

  describe('Session Switch Performance', () => {
    bench(
      'session-switch-cold-cache',
      async () => {
        sessionCache.clear()
        await sessionCache.loadSession('session-cold')
      },
      { 
        time: 1000,  // Run for 1 second
        iterations: 10,
        throws: false,
      }
    )

    bench(
      'session-switch-warm-cache',
      async () => {
        // Pre-load to warm cache
        await sessionCache.loadSession('session-warm')
        // Second access should be cached
        await sessionCache.loadSession('session-warm')
      },
      { 
        time: 1000,
        iterations: 20,
        throws: false,
      }
    )

    bench(
      'session-switch-with-messages',
      async () => {
        sessionCache.clear()
        // Load session with 100 messages
        await sessionCache.loadSession('session-large')
      },
      { 
        time: 1000,
        iterations: 10,
        throws: false,
      }
    )
  })

  describe('Typing Latency', () => {
    bench(
      'typing-short-message',
      async () => {
        const textarea = createMockTextarea()
        await simulateTyping(textarea, 'Hello world', 5)
      },
      { 
        time: 1000,
        iterations: 10,
        throws: false,
      }
    )

    bench(
      'typing-medium-message',
      async () => {
        const textarea = createMockTextarea()
        await simulateTyping(textarea, 'This is a medium length message for testing', 5)
      },
      { 
        time: 2000,
        iterations: 5,
        throws: false,
      }
    )

    bench(
      'typing-long-message',
      async () => {
        const textarea = createMockTextarea()
        const longText = 'This is a longer message. '.repeat(20)
        await simulateTyping(textarea, longText, 2)
      },
      { 
        time: 5000,
        iterations: 3,
        throws: false,
      }
    )
  })

  describe('Render Performance', () => {
    bench(
      'message-list-50-items',
      async () => {
        // Simulate rendering 50 messages
        const messages = Array(50).fill(null).map((_, i) => ({
          id: `msg-${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}`.repeat(10)
        }))
        
        // Simulate virtualization overhead
        const visibleStart = 0
        const visibleEnd = 10
        const visibleMessages = messages.slice(visibleStart, visibleEnd)
        
        await new Promise(resolve => setTimeout(resolve, 10))
        return visibleMessages.length
      },
      { 
        time: 1000,
        iterations: 20,
        throws: false,
      }
    )

    bench(
      'message-list-500-items',
      async () => {
        // Simulate rendering 500 messages (large session)
        const messages = Array(500).fill(null).map((_, i) => ({
          id: `msg-${i}`,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${i}`.repeat(10)
        }))
        
        // Simulate virtualization - only render visible portion
        const visibleStart = 200
        const visibleEnd = 220
        const visibleMessages = messages.slice(visibleStart, visibleEnd)
        
        await new Promise(resolve => setTimeout(resolve, 10))
        return visibleMessages.length
      },
      { 
        time: 1000,
        iterations: 10,
        throws: false,
      }
    )
  })

  describe('Touch Interaction Latency', () => {
    bench(
      'button-tap-response',
      async () => {
        // Simulate touch event processing
        const start = performance.now()
        
        // Simulate event handler execution
        await new Promise(resolve => setTimeout(resolve, 16)) // ~1 frame
        
        return performance.now() - start
      },
      { 
        time: 1000,
        iterations: 30,
        throws: false,
      }
    )

    bench(
      'scroll-performance',
      async () => {
        // Simulate scroll event handling
        let scrollY = 0
        const scrollEvents = 60 // 60fps scroll
        
        for (let i = 0; i < scrollEvents; i++) {
          scrollY += 10
          // Simulate scroll handler
          await new Promise(resolve => setTimeout(resolve, 1))
        }
        
        return scrollY
      },
      { 
        time: 2000,
        iterations: 5,
        throws: false,
      }
    )
  })
})

// Re-export for use in other benchmark files
export { BASELINE, TARGETS }
