# Performance Benchmarks

This directory contains performance benchmarks for measuring mobile improvements in the Pi Web UI.

## Quick Start

Run all benchmarks:
```bash
npm run benchmark
```

Run quick manual benchmarks:
```bash
npm run benchmark:quick
```

## Benchmark Suites

### Mobile Performance (`mobile-performance.ts`)

Measures key performance metrics for mobile optimization:

- **Session Switch Performance**
  - Cold cache switch time
  - Warm cache switch time
  - Switch with large message list

- **Typing Latency**
  - Short message typing
  - Medium message typing
  - Long message typing

- **Render Performance**
  - Message list with 50 items
  - Message list with 500 items

- **Touch Interaction**
  - Button tap response time
  - Scroll performance

### Memory Usage (`memory-usage.ts`)

Measures memory efficiency:

- **Per-Session Memory**
  - Small session memory footprint
  - Large session memory footprint
  - Sessions with code blocks

- **LRU Cache Effectiveness**
  - Cache eviction behavior
  - Access order preservation
  - Memory bounding

- **Memory Cleanup**
  - Session unload cleanup
  - Repeated load/unload cycles

- **Heap Usage** (Chrome/Chromium only)
  - Heap size before/after
  - GC pressure testing

## Targets vs Baseline

| Metric | Baseline (Before) | Target (After) | Improvement |
|--------|-------------------|----------------|-------------|
| Session Switch (cold) | 3000ms | 1000ms | 66% |
| Session Switch (warm) | 500ms | 100ms | 80% |
| Typing Latency | 500ms | 100ms | 80% |
| Memory per Session | 15MB | 5MB | 66% |
| Cached Sessions Max | 10 | 5 | 50% |

## Output

Benchmark results are saved to:
- Console output (human-readable)
- `results/benchmark-results.json` (machine-readable)

## Notes

- These are **synthetic benchmarks** - real mobile testing should be done on actual devices
- Memory benchmarks use `performance.memory` API (Chrome/Chromium only)
- Some benchmarks may have different results in CI vs local development
- Run multiple times for consistent results

## Adding New Benchmarks

1. Create a new file in `tests/benchmarks/`
2. Use `bench()` from vitest for benchmarking
3. Export baseline and target metrics
4. Update this README

Example:
```typescript
import { bench, describe } from 'vitest'

describe('My Benchmark', () => {
  bench('my-test', async () => {
    // Your benchmark code
  }, { time: 1000, iterations: 10 })
})
```
