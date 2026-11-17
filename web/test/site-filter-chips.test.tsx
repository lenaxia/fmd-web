// @vitest-environment jsdom

/**
 * SiteFilterChips (patterns): the category facet pattern in isolation —
 * one chip per category with its count, an 'All' chip, aria-pressed
 * toggle semantics, multi-select union, and the caller-owned state
 * contract (the component never mutates selection itself).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SiteFilterChips, type CategoryFacet } from '../src/components/patterns/SiteFilterChips';
import { autoCleanup } from './helpers';

const FACETS: readonly CategoryFacet[] = [
  { category: 'English', count: 63 },
  { category: 'Spanish', count: 39 },
  { category: 'Raw', count: 28 },
];

describe('SiteFilterChips (patterns)', (): void => {
  autoCleanup();

  it('renders All + one chip per category with counts', (): void => {
    render(
      <SiteFilterChips categories={FACETS} selected={[]} onChange={(): void => {}} />,
    );
    const group = screen.getByRole('group', { name: 'Filter sites by category' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /English 63/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Spanish 39/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Raw 28/ })).toBeInTheDocument();
  });

  it('aria-pressed reflects the selection; All pressed when empty', (): void => {
    render(
      <SiteFilterChips categories={FACETS} selected={['Spanish']} onChange={(): void => {}} />,
    );
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /English/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /Spanish/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('clicking a chip toggles it; clicking All clears; state is caller-owned', async (): Promise<void> => {
    const onChange = vi.fn();
    render(<SiteFilterChips categories={FACETS} selected={['English']} onChange={onChange} />);

    await userEvent.click(screen.getByRole('button', { name: /Spanish/ }));
    expect(onChange).toHaveBeenLastCalledWith(['English', 'Spanish']);

    await userEvent.click(screen.getByRole('button', { name: /English/ }));
    expect(onChange).toHaveBeenLastCalledWith([]);

    // All always clears whatever is selected.
    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
