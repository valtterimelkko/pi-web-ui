# Performance Benchmarks

This folder contains benchmark suites for Pi Web UI frontend performance.

## What These Benchmarks Cover

The current suites focus mainly on:
- session switching behaviour
- typing latency
- render performance
- cache/memory behaviour
- mobile-oriented performance scenarios

Files:
- `mobile-performance.ts`
- `memory-usage.ts`
- `comparison.ts`
- `index.ts`

## Run Benchmarks

### Full benchmark pass
```bash
npm run benchmark
```

### Quick benchmark pass
```bash
npm run benchmark:quick
```

## Output

Results are typically written to:
- console output
- `tests/benchmarks/results/`

## Interpreting Results

Treat these as **engineering benchmarks**, not as a full substitute for real device or full E2E testing.

Use them to compare:
- before/after performance changes
- session-cache behaviour
- render regressions
- mobile-oriented UI improvements

## Notes

- Some memory metrics depend on browser/runtime support.
- Benchmark numbers can vary between local machines and CI.
- Re-run several times before drawing strong conclusions from small deltas.

## Adding New Benchmarks

1. Add a new benchmark file in `tests/benchmarks/`
2. Use the project's benchmark tooling/config in this folder
3. Keep the benchmark narrowly focused and reproducible
4. Update this README if the benchmark category changes meaningfully
