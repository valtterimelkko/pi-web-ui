import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { ToolProgressIndicator } from '../../../../src/components/Tools/ToolProgressIndicator';

describe('ToolProgressIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  describe('basic rendering', () => {
    it('renders with tool name', () => {
      render(<ToolProgressIndicator toolName="bash" />);
      expect(screen.getByText('bash')).toBeInTheDocument();
    });

    it('shows spinning loader icon', () => {
      render(<ToolProgressIndicator toolName="bash" />);
      
      // Should have a spinning loader icon
      const loader = document.querySelector('.animate-spin');
      expect(loader).toBeInTheDocument();
    });

    it('applies custom className', () => {
      const { container } = render(
        <ToolProgressIndicator toolName="bash" className="custom-class" />
      );
      expect(container.querySelector('.custom-class')).toBeInTheDocument();
    });

    it('shows elapsed time starting at 0s', () => {
      render(<ToolProgressIndicator toolName="bash" />);
      expect(screen.getByText('0s')).toBeInTheDocument();
    });
  });

  describe('tool descriptions', () => {
    it('shows subagent description with agent name and task', () => {
      render(
        <ToolProgressIndicator 
          toolName="subagent" 
          args={{ agent: 'videospecialist', task: 'Analyze video' }}
        />
      );
      
      expect(screen.getByText(/Running videospecialist subagent/)).toBeInTheDocument();
    });

    it('shows bash description with command', () => {
      render(
        <ToolProgressIndicator 
          toolName="bash" 
          args={{ command: 'ffmpeg -i input.mp4 output.mp4' }}
        />
      );
      
      expect(screen.getByText(/Executing: ffmpeg/)).toBeInTheDocument();
    });

    it('shows read description with filename', () => {
      render(
        <ToolProgressIndicator 
          toolName="read" 
          args={{ path: '/path/to/some/file.txt' }}
        />
      );
      
      expect(screen.getByText(/Reading file.txt/)).toBeInTheDocument();
    });

    it('shows web_search description with query', () => {
      render(
        <ToolProgressIndicator 
          toolName="web_search" 
          args={{ query: 'how to edit videos' }}
        />
      );
      
      expect(screen.getByText(/Searching/)).toBeInTheDocument();
    });

    it('shows default description for unknown tools', () => {
      render(<ToolProgressIndicator toolName="unknown_tool" />);
      expect(screen.getByText(/Executing/)).toBeInTheDocument();
    });

    it('handles missing args gracefully', () => {
      render(<ToolProgressIndicator toolName="bash" />);
      expect(screen.getByText(/Executing/)).toBeInTheDocument();
    });

    it('truncates long task descriptions', () => {
      const longTask = 'A'.repeat(100);
      render(
        <ToolProgressIndicator 
          toolName="subagent" 
          args={{ agent: 'test', task: longTask }}
        />
      );
      
      // Should render without crashing and show truncated text
      expect(screen.getByText(/Running test subagent/)).toBeInTheDocument();
    });
  });
});
