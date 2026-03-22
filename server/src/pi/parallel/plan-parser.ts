/**
 * Plan Parser - Parse modular plans and identify parallelizable tasks
 *
 * Supports multiple plan formats:
 * - Markdown with YAML frontmatter (Pi's existing plan format)
 * - Plain Markdown with task headers
 * - JSON Task Array
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface TaskNode {
  id: string;
  title: string;
  description: string;
  files: string[];
  dependencies: string[];
  estimatedComplexity: 'low' | 'medium' | 'high';
  agent?: string;
  parallelGroup?: number;
}

export interface ParsedPlan {
  title: string;
  description?: string;
  tasks: TaskNode[];
  dependencyGraph: DependencyGraph;
  parallelGroups: TaskNode[][];
}

export interface DependencyGraph {
  nodes: Map<string, TaskNode>;
  edges: Map<string, string[]>;  // taskId -> dependent taskIds
}

/**
 * Generate a unique task ID
 */
function generateTaskId(title: string, index: number): string {
  const sanitized = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 30);
  return `task-${index + 1}-${sanitized}`;
}

/**
 * Extract file references from text
 */
function extractFiles(text: string): string[] {
  const filePatterns = [
    // Code files in backticks
    /`([^`]+\.[a-z]{1,10})`/gi,
    // File paths
    /(?:^|\s|[:(])(\.?\/?[a-zA-Z0-9_\-./]+\.[a-z]{1,10})/gi,
    // Files in "files:" sections
    /(?:files?:|modifies?:|affects?:)\s*\n([\s\S]*?)(?=\n\n|\n#|$)/gi,
  ];
  
  const files = new Set<string>();
  
  for (const pattern of filePatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const file = match[1].trim();
      // Filter out obvious non-files
      if (file.length > 2 && !file.includes('://') && !file.startsWith('$')) {
        files.add(file);
      }
    }
  }
  
  return Array.from(files);
}

/**
 * Parse YAML frontmatter from markdown
 */
function parseYamlFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  
  const yamlContent = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};
  
  // Simple YAML parsing (key: value)
  for (const line of yamlContent.split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      
      // Handle arrays (simple)
      if (value.startsWith('[') && value.endsWith(']')) {
        frontmatter[key] = value
          .slice(1, -1)
          .split(',')
          .map(s => s.trim().replace(/^["']|["']$/g, ''));
      } else if (value === 'true' || value === 'false') {
        frontmatter[key] = value === 'true';
      } else if (!isNaN(Number(value))) {
        frontmatter[key] = Number(value);
      } else {
        frontmatter[key] = value.replace(/^["']|["']$/g, '');
      }
    }
  }
  
  return { frontmatter, body };
}

/**
 * Parse markdown tasks with headers
 */
function parseMarkdownTasks(body: string): TaskNode[] {
  const tasks: TaskNode[] = [];
  const lines = body.split('\n');
  
  let currentTask: Partial<TaskNode> | null = null;
  let taskIndex = 0;
  let currentSection: string[] = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Task header (## or ### followed by "Task" or numbered)
    const taskMatch = line.match(/^#{2,4}\s*(?:Task\s*)?(\d+\.?\s*)?(.+)$/i);
    
    if (taskMatch) {
      // Save previous task
      if (currentTask && currentTask.title) {
        currentTask.description = currentSection.join('\n').trim();
        currentTask.files = extractFiles(currentTask.description);
        tasks.push(currentTask as TaskNode);
      }
      
      // Start new task
      const title = taskMatch[2].trim();
      currentTask = {
        id: generateTaskId(title, taskIndex),
        title,
        description: '',
        files: [],
        dependencies: [],
        estimatedComplexity: 'medium',
      };
      taskIndex++;
      currentSection = [];
    } else if (currentTask) {
      // Check for explicit dependencies
      const depMatch = line.match(/(?:depends\s*(?:on)?|dependencies?):\s*(.+)$/i);
      if (depMatch) {
        const deps = depMatch[1]
          .split(/[,;]/)
          .map(d => d.trim().replace(/^["']|["']$/g, ''));
        currentTask.dependencies = deps;
      } else {
        currentSection.push(line);
      }
    }
  }
  
  // Save last task
  if (currentTask && currentTask.title) {
    currentTask.description = currentSection.join('\n').trim();
    currentTask.files = extractFiles(currentTask.description);
    tasks.push(currentTask as TaskNode);
  }
  
  return tasks;
}

/**
 * Parse JSON task array
 */
function parseJsonTasks(json: unknown): TaskNode[] {
  if (!Array.isArray(json)) {
    throw new Error('JSON plan must be an array of tasks');
  }
  
  return json.map((task, index) => ({
    id: task.id || generateTaskId(task.title || `Task ${index + 1}`, index),
    title: task.title || `Task ${index + 1}`,
    description: task.description || task.task || '',
    files: task.files || task.modifies || [],
    dependencies: task.dependencies || task.dependsOn || [],
    estimatedComplexity: task.complexity || task.estimatedComplexity || 'medium',
    agent: task.agent,
  }));
}

/**
 * Build dependency graph from tasks
 */
function buildDependencyGraph(tasks: TaskNode[]): DependencyGraph {
  const nodes = new Map<string, TaskNode>();
  const edges = new Map<string, string[]>();
  
  // Add all nodes
  for (const task of tasks) {
    nodes.set(task.id, task);
    edges.set(task.id, []);
  }
  
  // Build edges (task -> tasks that depend on it)
  for (const task of tasks) {
    for (const depId of task.dependencies) {
      // Find actual task ID from partial match
      const actualDepId = findTaskId(tasks, depId);
      if (actualDepId && edges.has(actualDepId)) {
        edges.get(actualDepId)!.push(task.id);
      }
    }
  }
  
  return { nodes, edges };
}

/**
 * Find task ID from partial match
 */
function findTaskId(tasks: TaskNode[], partialId: string): string | null {
  // Exact match
  if (tasks.some(t => t.id === partialId)) {
    return partialId;
  }
  
  // Partial match
  const lowerPartial = partialId.toLowerCase();
  for (const task of tasks) {
    if (
      task.id.toLowerCase().includes(lowerPartial) ||
      task.title.toLowerCase().includes(lowerPartial)
    ) {
      return task.id;
    }
  }
  
  // Number match (e.g., "1" -> "task-1-...")
  const numMatch = partialId.match(/^(\d+)$/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    const task = tasks[num - 1];
    if (task) return task.id;
  }
  
  return null;
}

/**
 * Analyze parallelizability using topological sort with level grouping
 */
function analyzeParallelizability(graph: DependencyGraph): TaskNode[][] {
  const { nodes, edges } = graph;
  const groups: TaskNode[][] = [];
  
  // Calculate in-degree for each node
  const inDegree = new Map<string, number>();
  for (const [taskId] of nodes) {
    inDegree.set(taskId, 0);
  }
  
  for (const task of Array.from(nodes.values())) {
    for (const depId of task.dependencies) {
      const actualDepId = findTaskId(Array.from(nodes.values()), depId);
      if (actualDepId && inDegree.has(actualDepId)) {
        // This is a dependency, so increment dependent's in-degree
      }
    }
  }
  
  // Recalculate: count how many dependencies each task has
  for (const task of Array.from(nodes.values())) {
    const validDeps = task.dependencies
      .map(d => findTaskId(Array.from(nodes.values()), d))
      .filter((d): d is string => d !== null && nodes.has(d));
    inDegree.set(task.id, validDeps.length);
  }
  
  // Process nodes level by level
  const processed = new Set<string>();
  const remaining = new Set(nodes.keys());
  
  while (remaining.size > 0) {
    // Find all nodes with no unprocessed dependencies
    const level: TaskNode[] = [];
    
    for (const taskId of remaining) {
      const task = nodes.get(taskId)!;
      const validDeps = task.dependencies
        .map(d => findTaskId(Array.from(nodes.values()), d))
        .filter((d): d is string => d !== null);
      
      const allDepsProcessed = validDeps.every(depId => 
        processed.has(depId) || !nodes.has(depId)
      );
      
      if (allDepsProcessed) {
        level.push(task);
      }
    }
    
    if (level.length === 0) {
      // Circular dependency or error - just add remaining
      for (const taskId of remaining) {
        level.push(nodes.get(taskId)!);
      }
    }
    
    // Mark as processed
    for (const task of level) {
      processed.add(task.id);
      remaining.delete(task.id);
      task.parallelGroup = groups.length;
    }
    
    groups.push(level);
  }
  
  return groups;
}

/**
 * Parse a plan file
 */
export async function parsePlanFile(filePath: string): Promise<ParsedPlan> {
  const content = await fs.readFile(filePath, 'utf-8');
  const ext = path.extname(filePath).toLowerCase();
  
  let tasks: TaskNode[];
  let title = path.basename(filePath, ext);
  let description: string | undefined;
  
  if (ext === '.json') {
    const json = JSON.parse(content);
    if (json.tasks) {
      title = json.title || title;
      description = json.description;
      tasks = parseJsonTasks(json.tasks);
    } else {
      tasks = parseJsonTasks(json);
    }
  } else {
    // Markdown
    const { frontmatter, body } = parseYamlFrontmatter(content);
    
    title = (frontmatter.title as string) || title;
    description = frontmatter.description as string;
    
    // Check if frontmatter has tasks
    if (frontmatter.tasks && Array.isArray(frontmatter.tasks)) {
      tasks = parseJsonTasks(frontmatter.tasks);
    } else {
      tasks = parseMarkdownTasks(body);
    }
  }
  
  // Build dependency graph
  const dependencyGraph = buildDependencyGraph(tasks);
  
  // Analyze parallelizability
  const parallelGroups = analyzeParallelizability(dependencyGraph);
  
  return {
    title,
    description,
    tasks,
    dependencyGraph,
    parallelGroups,
  };
}

/**
 * Parse plan content directly (without file)
 */
export function parsePlanContent(content: string, format: 'markdown' | 'json' = 'markdown'): ParsedPlan {
  let tasks: TaskNode[];
  let title = 'Plan';
  let description: string | undefined;
  
  if (format === 'json') {
    const json = JSON.parse(content);
    if (json.tasks) {
      title = json.title || title;
      description = json.description;
      tasks = parseJsonTasks(json.tasks);
    } else {
      tasks = parseJsonTasks(json);
    }
  } else {
    const { frontmatter, body } = parseYamlFrontmatter(content);
    
    title = (frontmatter.title as string) || title;
    description = frontmatter.description as string;
    
    if (frontmatter.tasks && Array.isArray(frontmatter.tasks)) {
      tasks = parseJsonTasks(frontmatter.tasks);
    } else {
      tasks = parseMarkdownTasks(body);
    }
  }
  
  const dependencyGraph = buildDependencyGraph(tasks);
  const parallelGroups = analyzeParallelizability(dependencyGraph);
  
  return {
    title,
    description,
    tasks,
    dependencyGraph,
    parallelGroups,
  };
}

/**
 * Validate a plan for common issues
 */
export function validatePlan(plan: ParsedPlan): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  
  if (plan.tasks.length === 0) {
    issues.push('Plan has no tasks');
  }
  
  // Check for circular dependencies
  const visited = new Set<string>();
  const recursionStack = new Set<string>();
  
  function hasCycle(taskId: string): boolean {
    if (recursionStack.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    
    visited.add(taskId);
    recursionStack.add(taskId);
    
    const task = plan.dependencyGraph.nodes.get(taskId);
    if (task) {
      for (const depId of task.dependencies) {
        const actualDepId = findTaskId(plan.tasks, depId);
        if (actualDepId && hasCycle(actualDepId)) {
          return true;
        }
      }
    }
    
    recursionStack.delete(taskId);
    return false;
  }
  
  for (const task of plan.tasks) {
    if (hasCycle(task.id)) {
      issues.push(`Circular dependency detected involving task: ${task.title}`);
      break;
    }
  }
  
  // Check for missing dependencies
  for (const task of plan.tasks) {
    for (const depId of task.dependencies) {
      const actualDepId = findTaskId(plan.tasks, depId);
      if (!actualDepId) {
        issues.push(`Task "${task.title}" has missing dependency: ${depId}`);
      }
    }
  }
  
  return {
    valid: issues.length === 0,
    issues,
  };
}
