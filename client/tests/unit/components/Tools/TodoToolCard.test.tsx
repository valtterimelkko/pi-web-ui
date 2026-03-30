import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TodoToolCard } from '../../../../src/components/Tools/TodoToolCard';

describe('TodoToolCard', () => {
  const mockStartTime = Date.now();

  it('renders pending todo action', () => {
    render(
      <TodoToolCard
        name="todo"
        args={{ action: 'list' }}
        startTime={mockStartTime}
      />
    );

    expect(screen.getByText('todo')).toBeInTheDocument();
    expect(screen.getByText('list')).toBeInTheDocument();
    expect(screen.getByText(/Running/)).toBeInTheDocument();
  });

  it('renders todo list result', () => {
    const result = {
      output: '[ ] #1: First task\n[x] #2: Second task',
      isError: false,
    };

    render(
      <TodoToolCard
        name="todo"
        args={{ action: 'list' }}
        result={result}
        startTime={mockStartTime}
      />
    );

    // Should show collapsed view with progress
    expect(screen.getByText('1/2')).toBeInTheDocument();
  });

  it('renders add action', () => {
    const result = {
      output: 'Added todo #3: New task',
      isError: false,
    };

    render(
      <TodoToolCard
        name="todo"
        args={{ action: 'add', text: 'New task' }}
        result={result}
        startTime={mockStartTime}
      />
    );

    expect(screen.getByText('todo')).toBeInTheDocument();
    expect(screen.getByText('add')).toBeInTheDocument();
    expect(screen.getByText('"New task"')).toBeInTheDocument();
  });

  it('renders toggle action', () => {
    const result = {
      output: 'Todo #2 completed',
      isError: false,
    };

    render(
      <TodoToolCard
        name="todo"
        args={{ action: 'toggle', id: 2 }}
        result={result}
        startTime={mockStartTime}
      />
    );

    expect(screen.getByText('todo')).toBeInTheDocument();
    expect(screen.getByText('toggle')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
  });

  it('expands when clicked', () => {
    const result = {
      output: '[ ] #1: First task\n[x] #2: Second task',
      isError: false,
    };

    render(
      <TodoToolCard
        name="todo"
        args={{ action: 'list' }}
        result={result}
        startTime={mockStartTime}
      />
    );

    // Click to expand
    const header = screen.getByText('todo').closest('button');
    fireEvent.click(header!);

    // Should show expanded content
    expect(screen.getByText('Viewing todos')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 completed')).toBeInTheDocument();
  });

  it('shows todo items when expanded', () => {
    const result = {
      output: '[ ] #1: First task\n[x] #2: Second task completed',
      isError: false,
    };

    render(
      <TodoToolCard
        name="todo"
        args={{ action: 'list' }}
        result={result}
        startTime={mockStartTime}
      />
    );

    // Click to expand
    const header = screen.getByText('todo').closest('button');
    fireEvent.click(header!);

    // Should show todo items
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    expect(screen.getByText('First task')).toBeInTheDocument();
    expect(screen.getByText('Second task completed')).toBeInTheDocument();
  });

  it('renders error state', () => {
    const result = {
      output: 'Error: something went wrong',
      isError: true,
    };

    render(
      <TodoToolCard
        name="todo"
        args={{ action: 'toggle', id: 99 }}
        result={result}
        startTime={mockStartTime}
      />
    );

    // Should show todo header even in error state
    expect(screen.getByText('todo')).toBeInTheDocument();
  });

  it('shows clear action', () => {
    const result = {
      output: 'Cleared 3 todos',
      isError: false,
    };

    render(
      <TodoToolCard
        name="todo"
        args={{ action: 'clear' }}
        result={result}
        startTime={mockStartTime}
      />
    );

    expect(screen.getByText('todo')).toBeInTheDocument();
    expect(screen.getByText('clear')).toBeInTheDocument();
  });

  it('shows empty state when no todos', () => {
    const result = {
      output: 'No todos',
      isError: false,
    };

    render(
      <TodoToolCard
        name="todo"
        args={{ action: 'list' }}
        result={result}
        startTime={mockStartTime}
      />
    );

    // Click to expand
    const header = screen.getByText('todo').closest('button');
    fireEvent.click(header!);

    // Should show empty state text (first occurrence)
    expect(screen.getAllByText('No todos')[0]).toBeInTheDocument();
  });

  it('shows progress bar in collapsed state', () => {
    const result = {
      output: '[x] #1: Task 1\n[x] #2: Task 2\n[ ] #3: Task 3',
      isError: false,
    };

    render(
      <TodoToolCard
        name="todo"
        args={{ action: 'list' }}
        result={result}
        startTime={mockStartTime}
      />
    );

    // Should show progress in collapsed header
    expect(screen.getByText('2/3')).toBeInTheDocument();
  });
});
