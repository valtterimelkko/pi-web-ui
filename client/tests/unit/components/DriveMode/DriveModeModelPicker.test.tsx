import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DriveModeModelPicker } from '../../../../src/components/DriveMode/DriveModeModelPicker';

vi.mock('../../../../src/store/driveModeStore', () => ({
  DRIVE_MODE_MODELS: [
    { id: 'kimi-for-coding', displayName: 'Kimi for Coding', sdkType: 'pi' },
    { id: 'zai-coding-plan/glm-5.1', displayName: 'GLM-5.1', sdkType: 'opencode' },
    { id: 'codex/gpt-5.4', displayName: 'Codex / GPT-5.4', sdkType: 'pi' },
    { id: 'codex/gpt-5.5', displayName: 'Codex / GPT-5.5', sdkType: 'pi' },
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
    expect(screen.getByText('GLM-5.1')).toBeInTheDocument();
    expect(screen.getByText('Codex / GPT-5.4')).toBeInTheDocument();
    expect(screen.getByText('Codex / GPT-5.5')).toBeInTheDocument();
  });

  it('each model shows displayName', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    expect(screen.getByText('Kimi for Coding')).toBeInTheDocument();
    expect(screen.getByText('GLM-5.1')).toBeInTheDocument();
  });

  it('each model shows correct SDK badge', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    const piBadges = screen.getAllByText('Pi');
    const ocBadges = screen.getAllByText('OC');
    expect(piBadges.length).toBe(3);
    expect(ocBadges.length).toBe(1);
  });

  it('tapping a model selects it (radio behavior)', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText('Kimi for Coding'));
    const createButton = screen.getByText('Create Session') as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);
  });

  it('only one model selected at a time', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText('Kimi for Coding'));
    fireEvent.click(screen.getByText('GLM-5.1'));
    // After selecting GLM-5.1, clicking Create Session should call onSelect with GLM-5.1
    fireEvent.click(screen.getByText('Create Session'));
    expect(mockOnSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'zai-coding-plan/glm-5.1' })
    );
  });

  it('"Create Session" button disabled until model selected', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    const createButton = screen.getByText('Create Session') as HTMLButtonElement;
    expect(createButton.disabled).toBe(true);
  });

  it('"Create Session" enabled after model selected', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText('Kimi for Coding'));
    const createButton = screen.getByText('Create Session') as HTMLButtonElement;
    expect(createButton.disabled).toBe(false);
  });

  it('clicking "Create Session" calls onSelect with selected model', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText('Kimi for Coding'));
    fireEvent.click(screen.getByText('Create Session'));
    expect(mockOnSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kimi-for-coding', displayName: 'Kimi for Coding', sdkType: 'pi' })
    );
  });

  it('clicking "Back" calls onBack', () => {
    render(<DriveModeModelPicker onSelect={mockOnSelect} onBack={mockOnBack} />);
    fireEvent.click(screen.getByText('Back'));
    expect(mockOnBack).toHaveBeenCalled();
  });
});
