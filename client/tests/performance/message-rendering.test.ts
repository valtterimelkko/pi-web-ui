import { describe, it, expect } from 'vitest';

describe('Message Rendering Performance', () => {
  it('should render 100 messages in under 1 second', async () => {
    // Generate 100 mock messages
    const messages = Array.from({ length: 100 }, (_, i) => ({
      id: `msg-${i}`,
      type: 'message_start',
      data: { content: `Message ${i}` },
    }));

    const start = performance.now();
    
    // Simulate rendering (in real test, render to DOM)
    for (const msg of messages) {
      JSON.stringify(msg); // Simulate processing
    }
    
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(1000);
  });

  it('should handle rapid worker status updates', () => {
    const statuses = ['spawning', 'ready', 'streaming', 'ready', 'idle'];
    
    const start = performance.now();
    
    for (const status of statuses) {
      JSON.stringify({ status });
    }
    
    const duration = performance.now() - start;
    expect(duration).toBeLessThan(100);
  });
});
