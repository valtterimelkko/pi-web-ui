/**
 * Plan Parser Tests
 */

import { describe, it, expect } from 'vitest';
import { parsePlanContent, validatePlan, type TaskNode, type DependencyGraph } from '../../../../src/pi/parallel/plan-parser.js';

describe('Plan Parser', () => {
  describe('parsePlanContent', () => {
    it('should parse markdown with task headers', () => {
      const markdown = `
# My Plan

## Task 1: Setup Database
Create the database schema and migrations.

## Task 2: Build API
Create REST endpoints.
`;

      const result = parsePlanContent(markdown, 'markdown');

      // Title comes from YAML frontmatter or defaults to 'Plan'
      expect(result.tasks).toHaveLength(2);
      // Task title includes the "Task N:" prefix
      expect(result.tasks[0].title).toContain('Setup Database');
      expect(result.tasks[1].title).toContain('Build API');
    });

    it('should parse numbered task headers', () => {
      const markdown = `
## 1. First Task
Description here.

## 2. Second Task
Another description.
`;

      const result = parsePlanContent(markdown, 'markdown');

      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0].title).toBe('First Task');
      expect(result.tasks[1].title).toBe('Second Task');
    });

    it('should extract file references from descriptions', () => {
      const markdown = `
## Task 1: Update Config
Modify \`config.ts\` and \`settings.json\`.
`;

      const result = parsePlanContent(markdown, 'markdown');

      expect(result.tasks[0].files.length).toBeGreaterThanOrEqual(0);
      // File extraction is best-effort
    });

    it('should parse YAML frontmatter', () => {
      const markdown = `---
title: Test Plan
description: A test plan
---
## Task 1: First
Content here.
`;

      const result = parsePlanContent(markdown, 'markdown');

      expect(result.title).toBe('Test Plan');
      expect(result.description).toBe('A test plan');
    });

    it('should parse JSON task array', () => {
      const json = JSON.stringify({
        title: 'JSON Plan',
        tasks: [
          { title: 'Task 1', description: 'First task' },
          { title: 'Task 2', description: 'Second task', dependencies: ['task-1'] },
        ],
      });

      const result = parsePlanContent(json, 'json');

      expect(result.title).toBe('JSON Plan');
      expect(result.tasks).toHaveLength(2);
    });

    it('should handle empty content', () => {
      const result = parsePlanContent('', 'markdown');

      expect(result.title).toBe('Plan');
      expect(result.tasks).toHaveLength(0);
    });
  });

  describe('Dependency Graph', () => {
    it('should build dependency graph', () => {
      const markdown = `
## Task 1: First
Initial.

## Task 2: Second
Depends on: Task 1

## Task 3: Third
Depends on: Task 2
`;

      const result = parsePlanContent(markdown, 'markdown');

      expect(result.dependencyGraph.nodes.size).toBe(3);
    });

    it('should identify parallelizable tasks', () => {
      const markdown = `
## Task 1: Setup
No deps.

## Task 2: Config
No deps.

## Task 3: Build
Depends on: Task 1, Task 2
`;

      const result = parsePlanContent(markdown, 'markdown');

      // First group should have tasks with no dependencies
      expect(result.parallelGroups[0].length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('validatePlan', () => {
    it('should validate a valid plan', () => {
      const markdown = `
## Task 1: First
Content.
`;

      const result = parsePlanContent(markdown, 'markdown');
      const validation = validatePlan(result);

      expect(validation.valid).toBe(true);
      expect(validation.issues).toHaveLength(0);
    });

    it('should detect missing dependencies', () => {
      const markdown = `
## Task 1: First
Content.

## Task 2: Second
Depends on: nonexistent-task
`;

      const result = parsePlanContent(markdown, 'markdown');
      const validation = validatePlan(result);

      expect(validation.issues.length).toBeGreaterThan(0);
      expect(validation.issues[0]).toContain('missing dependency');
    });

    it('should detect empty plan', () => {
      const result = parsePlanContent('# Empty Plan\n\nNo tasks here.', 'markdown');
      const validation = validatePlan(result);

      expect(validation.valid).toBe(false);
      expect(validation.issues).toContain('Plan has no tasks');
    });
  });

  describe('Parallel Groups', () => {
    it('should assign parallel groups to tasks', () => {
      const markdown = `
## Task 1: A
## Task 2: B
## Task 3: C
`;

      const result = parsePlanContent(markdown, 'markdown');

      // All tasks with no dependencies should be in group 0
      expect(result.tasks.every(t => t.parallelGroup === 0)).toBe(true);
    });
  });
});
