/**
 * Benchmark Comparison Report Generator
 * 
 * Compares benchmark results against baseline metrics to show
 * improvement from mobile optimizations.
 */

import { BASELINE, TARGETS } from './mobile-performance'

export interface BenchmarkResult {
  name: string
  mean: number
  median: number
  min: number
  max: number
  stddev: number
  iterations: number
}

export interface ComparisonReport {
  benchmark: string
  baseline: number
  target: number
  actual: number
  improvement: number
  percentImprovement: number
  meetsTarget: boolean
  status: 'excellent' | 'good' | 'needs-work' | 'regression'
}

/**
 * Generate a comparison report for a benchmark result
 */
export function generateComparison(
  benchmarkName: string,
  result: BenchmarkResult,
  baseline: number = BASELINE.sessionSwitch,
  target: number = TARGETS.sessionSwitch
): ComparisonReport {
  const actual = result.mean
  const improvement = baseline - actual
  const percentImprovement = (improvement / baseline) * 100
  const meetsTarget = actual <= target

  let status: ComparisonReport['status']
  if (actual <= target * 0.5) {
    status = 'excellent'
  } else if (meetsTarget) {
    status = 'good'
  } else if (actual <= baseline) {
    status = 'needs-work'
  } else {
    status = 'regression'
  }

  return {
    benchmark: benchmarkName,
    baseline,
    target,
    actual,
    improvement,
    percentImprovement,
    meetsTarget,
    status
  }
}

/**
 * Format a comparison report as a string
 */
export function formatReport(report: ComparisonReport): string {
  const statusEmoji = {
    excellent: '✅',
    good: '👍',
    'needs-work': '⚠️',
    regression: '❌'
  }

  const lines = [
    `### ${report.benchmark}`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Baseline | ${report.baseline.toFixed(2)}ms |`,
    `| Target | ${report.target.toFixed(2)}ms |`,
    `| Actual | ${report.actual.toFixed(2)}ms |`,
    `| Improvement | ${report.improvement.toFixed(2)}ms (${report.percentImprovement.toFixed(1)}%) |`,
    `| Status | ${statusEmoji[report.status]} ${report.status} |`,
    ''
  ]

  return lines.join('\n')
}

/**
 * Generate a summary report for all benchmarks
 */
export function generateSummaryReport(reports: ComparisonReport[]): string {
  const lines = [
    '# Mobile Performance Benchmark Results',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Summary',
    ''
  ]

  // Count by status
  const counts = {
    excellent: reports.filter(r => r.status === 'excellent').length,
    good: reports.filter(r => r.status === 'good').length,
    'needs-work': reports.filter(r => r.status === 'needs-work').length,
    regression: reports.filter(r => r.status === 'regression').length
  }

  lines.push(`- ✅ Excellent: ${counts.excellent}`)
  lines.push(`- 👍 Good: ${counts.good}`)
  lines.push(`- ⚠️ Needs Work: ${counts['needs-work']}`)
  lines.push(`- ❌ Regression: ${counts.regression}`)
  lines.push('')

  // Overall pass rate
  const passRate = ((counts.excellent + counts.good) / reports.length) * 100
  lines.push(`**Pass Rate: ${passRate.toFixed(1)}%**`)
  lines.push('')

  // Individual reports
  lines.push('## Detailed Results')
  lines.push('')

  for (const report of reports) {
    lines.push(formatReport(report))
  }

  return lines.join('\n')
}

/**
 * Baseline metrics for comparison
 */
export const BASELINE_METRICS = {
  // Session performance
  sessionSwitchCold: 3000,
  sessionSwitchWarm: 500,
  sessionSwitchWithMessages: 3500,
  
  // Typing performance
  typingShort: 500,
  typingMedium: 1000,
  typingLong: 2000,
  
  // Memory performance
  memoryPerSession: 15, // MB
  memoryPerLargeSession: 30, // MB
  cachedSessionsMax: 10,
  
  // Render performance
  render50Items: 100,
  render500Items: 500,
  
  // Touch interaction
  tapResponse: 100,
  scrollPerformance: 100
}

/**
 * Target metrics after optimization
 */
export const TARGET_METRICS = {
  // Session performance
  sessionSwitchCold: 1000,
  sessionSwitchWarm: 100,
  sessionSwitchWithMessages: 1500,
  
  // Typing performance
  typingShort: 100,
  typingMedium: 200,
  typingLong: 500,
  
  // Memory performance
  memoryPerSession: 5, // MB
  memoryPerLargeSession: 10, // MB
  cachedSessionsMax: 5,
  
  // Render performance
  render50Items: 50,
  render500Items: 100,
  
  // Touch interaction
  tapResponse: 50,
  scrollPerformance: 50
}

export default {
  generateComparison,
  formatReport,
  generateSummaryReport,
  BASELINE_METRICS,
  TARGET_METRICS
}
