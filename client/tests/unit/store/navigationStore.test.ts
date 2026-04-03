import { describe, it, expect, beforeEach } from 'vitest';
import { useNavigationStore } from '../../../src/store/navigationStore';

describe('navigationStore', () => {
  beforeEach(() => {
    useNavigationStore.setState({ activeTab: 'chat', isMobile: false });
  });

  it('should have chat as default active tab', () => {
    const { activeTab } = useNavigationStore.getState();
    expect(activeTab).toBe('chat');
  });

  it('should switch to shell tab', () => {
    const { setActiveTab } = useNavigationStore.getState();
    setActiveTab('shell');
    expect(useNavigationStore.getState().activeTab).toBe('shell');
  });

  it('should switch to git tab', () => {
    const { setActiveTab } = useNavigationStore.getState();
    setActiveTab('git');
    expect(useNavigationStore.getState().activeTab).toBe('git');
  });

  it('should switch to files tab', () => {
    const { setActiveTab } = useNavigationStore.getState();
    setActiveTab('files');
    expect(useNavigationStore.getState().activeTab).toBe('files');
  });

  it('should update isMobile', () => {
    const { setIsMobile } = useNavigationStore.getState();
    setIsMobile(true);
    expect(useNavigationStore.getState().isMobile).toBe(true);
  });
});
