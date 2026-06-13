import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DriveModeModelPicker } from '../../../../src/components/DriveMode/DriveModeModelPicker';

vi.mock('../../../../src/store/driveModeStore', () => ({
  DRIVE_MODE_MODELS: [
    { id: 'kimi-coding/kimi-for-coding', displayName: 'Kimi for Coding', sdkType: 'pi' },
    { id: 'zai-coding-plan/glm-5.2', displayName: 'GLM-5.2', sdkType: 'opencode' },
    { id: 'openai-codex/gpt-5.4', displayName: 'Codex / GPT-5.4', sdkType: 'pi' },
    { id: 'openai-codex/gpt-5.5', displayName: 'Codex / GPT-5.5', sdkType: 'pi' },
  ],
}));

describe('DriveModeModelPicker', () => {
  const mockOnSelect = vi.fn();
  const mockOnBack = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders all 4 models', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    expect(screen.getByText('Kimi for Coding')).toBeInTheDocument();
    expect(screen.getByText('GLM-5.2')).toBeInTheDocument();
    expect(screen.getByText('Codex / GPT-5.4')).toBeInTheDocument();
    expect(screen.getByText('Codex / GPT-5.5')).toBeInTheDocument();
  });

  it('each model shows displayName', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    expect(screen.getByText('Kimi for Coding')).toBeInTheDocument();
    expect(screen.getByText('GLM-5.2')).toBeInTheDocument();
  });

  it('each model shows correct SDK badge', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    const piBadges = screen.getAllByText('Pi');
    const ocBadges = screen.getAllByText('OC');
    expect(piBadges.length).toBe(3);
    expect(ocBadges.length).toBe(1);
  });

  it('tapping a model immediately calls onSelect', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText('Kimi for Coding'));
    expect(mockOnSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kimi-coding/kimi-for-coding', displayName: 'Kimi for Coding', sdkType: 'pi' })
    );
  });

  it('tapping a different model calls onSelect with that model', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText('GLM-5.2'));
    expect(mockOnSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'zai-coding-plan/glm-5.2', displayName: 'GLM-5.2', sdkType: 'opencode' })
    );
  });

  it('clicking "Back" calls onBack', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText('Back'));
    expect(mockOnBack).toHaveBeenCalled();
  });
});
