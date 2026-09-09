import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CollapsibleToolCard } from '../../../../src/components/Tools/CollapsibleToolCard';

/**
 * F8/F9 card parity: agy tools must render with the same display names,
 * icons and primary args as their pi equivalents, and the agy
 * background-command lifecycle must read as a background process.
 */

describe('CollapsibleToolCard — antigravity parity', () => {
  it('renders run_command as a Shell card with the CommandLine primary arg', () => {
    render(
      <CollapsibleToolCard
        name="run_command"
        args={{ CommandLine: 'python3 -m unittest -v test_calc' }}
        result={{ output: 'test_add ... ok\nOK', isError: false }}
      />,
    );
    expect(screen.getByText(/Using Shell/)).toBeTruthy();
    expect(screen.getByText('python3 -m unittest -v test_calc')).toBeTruthy();
  });

  it('renders write_to_file as a Write card with the TargetFile primary arg', () => {
    render(
      <CollapsibleToolCard
        name="write_to_file"
        args={{ TargetFile: '/tmp/agy-stub/hello.txt', Content: 'hello\n' }}
        result={{ output: 'Wrote /tmp/agy-stub/hello.txt', isError: false }}
      />,
    );
    expect(screen.getByText(/Using Write/)).toBeTruthy();
    expect(screen.getByText('/tmp/agy-stub/hello.txt')).toBeTruthy();
  });

  it('renders command_status as a Background process card (F9)', () => {
    render(
      <CollapsibleToolCard
        name="command_status"
        args={{ JobId: '42' }}
        result={{ output: 'job 42: passed', isError: false }}
      />,
    );
    expect(screen.getByText(/Using Background process/)).toBeTruthy();
  });

  it('shows live args the moment they arrive on the end event (agy flow)', () => {
    render(
      <CollapsibleToolCard
        name="run_command"
        args={{ CommandLine: 'npm test' }}
        result={null}
      />,
    );
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText(/Running/)).toBeTruthy();
  });
});
