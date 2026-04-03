import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ContextRing } from '../../../../src/components/Usage/ContextRing';

describe('ContextRing', () => {
  it('renders with 0%', () => {
    const { container } = render(<ContextRing percent={0} />);
    const circles = container.querySelectorAll('circle');
    expect(circles.length).toBe(2); // background + progress
  });

  it('renders with 100%', () => {
    const { container } = render(<ContextRing percent={100} />);
    expect(container.querySelector('svg')).toBeDefined();
  });

  it('clamps values above 100', () => {
    const { container } = render(<ContextRing percent={150} />);
    expect(container.querySelector('svg')).toBeDefined();
  });

  it('clamps values below 0', () => {
    const { container } = render(<ContextRing percent={-10} />);
    expect(container.querySelector('svg')).toBeDefined();
  });

  it('shows label when showLabel is true', () => {
    const { container } = render(<ContextRing percent={50} showLabel />);
    expect(container.textContent).toContain('50');
  });

  it('uses custom size', () => {
    const { container } = render(<ContextRing percent={50} size={32} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('32');
  });

  it('applies blue color for normal usage (< 60%)', () => {
    const { container } = render(<ContextRing percent={30} />);
    const circles = container.querySelectorAll('circle');
    // Progress circle (second one) should have blue stroke
    const progressCircle = circles[1];
    expect(progressCircle.getAttribute('stroke')).toBe('#3b82f6');
  });

  it('applies amber color for warning usage (60-80%)', () => {
    const { container } = render(<ContextRing percent={70} />);
    const circles = container.querySelectorAll('circle');
    expect(circles[1].getAttribute('stroke')).toBe('#f59e0b');
  });

  it('applies red color for critical usage (>= 80%)', () => {
    const { container } = render(<ContextRing percent={85} />);
    const circles = container.querySelectorAll('circle');
    expect(circles[1].getAttribute('stroke')).toBe('#ef4444');
  });
});
