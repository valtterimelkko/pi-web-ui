import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TabPanel } from '../../../../src/components/Navigation/TabContent';
import { useNavigationStore } from '../../../../src/store/navigationStore';

describe('TabPanel', () => {
  beforeEach(() => {
    useNavigationStore.setState({ activeTab: 'chat', isMobile: false });
  });

  it('renders chat panel when chat is active', () => {
    render(
      <TabPanel tab="chat">
        <div>Chat Content</div>
      </TabPanel>
    );
    expect(screen.getByText('Chat Content')).toBeDefined();
  });

  it('does not render shell panel before first visit', () => {
    render(
      <TabPanel tab="shell">
        <div>Shell Content</div>
      </TabPanel>
    );
    expect(screen.queryByText('Shell Content')).toBeNull();
  });

  it('renders shell panel when shell is active', () => {
    useNavigationStore.setState({ activeTab: 'shell' });
    render(
      <TabPanel tab="shell">
        <div>Shell Content</div>
      </TabPanel>
    );
    expect(screen.getByText('Shell Content')).toBeDefined();
  });
});
