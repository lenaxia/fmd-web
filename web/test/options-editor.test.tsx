// @vitest-environment jsdom
/**
 * Options editor (§5.1) component tests — THE COMBOBOX INDEX
 * ROUND-TRIP: descriptors → labeled controls → submit payload, where a
 * combobox selection lands as the item INDEX (number), never the
 * label. Also covers a11y basics: accessible labels + focus order.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  collectOptionValues,
  OptionsEditor,
  seedOptionDrafts,
} from '../src/components/OptionsEditor';
import { moduleFixture } from './fixtures';
import { autoCleanup } from './helpers';
import type { ModuleOptionDescriptorT } from '../src/api/hooks';

autoCleanup();

const DESCRIPTORS: ModuleOptionDescriptorT[] = [
  { name: 'Auto-skip pages', kind: 'checkbox', defaultValue: false },
  { name: 'Custom UA', kind: 'edit', defaultValue: '' },
  { name: 'Delay', kind: 'spinedit', defaultValue: 0 },
  { name: 'Quality', kind: 'combobox', defaultValue: 1, items: ['low', 'medium', 'high'] },
];

const MODULE = moduleFixture({ options: DESCRIPTORS });

describe('seedOptionDrafts', (): void => {
  it('seeds drafts from defaultValue (combobox keeps the index)', (): void => {
    const drafts = seedOptionDrafts(DESCRIPTORS);
    expect(drafts).toEqual({
      'Auto-skip pages': false,
      'Custom UA': '',
      Delay: '0',
      Quality: '1',
    });
  });
});

describe('collectOptionValues — index round-trip', (): void => {
  it('round-trips defaults through seed → collect unchanged', (): void => {
    const values = collectOptionValues(DESCRIPTORS, seedOptionDrafts(DESCRIPTORS));
    expect(values).toEqual({
      'Auto-skip pages': false,
      'Custom UA': '',
      Delay: 0,
      Quality: 1, // INDEX, not the label 'medium'
    });
  });

  it('converts a combobox draft label index string to an integer index', (): void => {
    const values = collectOptionValues(DESCRIPTORS, {
      Quality: '2',
    });
    expect(values).toEqual({ Quality: 2 });
  });

  it('drops an out-of-range combobox index instead of guessing', (): void => {
    expect(collectOptionValues(DESCRIPTORS, { Quality: '9' })).toEqual({});
    expect(collectOptionValues(DESCRIPTORS, { Quality: 'nope' })).toEqual({});
    expect(collectOptionValues(DESCRIPTORS, { Quality: '-1' })).toEqual({});
  });

  it('coerces checkbox / edit / spinedit kinds to their wire types', (): void => {
    const values = collectOptionValues(DESCRIPTORS, {
      'Auto-skip pages': true,
      'Custom UA': 'Mozilla/5.0 fixture',
      Delay: '250',
    });
    expect(values).toEqual({
      'Auto-skip pages': true,
      'Custom UA': 'Mozilla/5.0 fixture',
      Delay: 250,
    });
  });
});

describe('OptionsEditor UI', (): void => {
  it('renders defaults: combobox shows the label at the default index', (): void => {
    render(<OptionsEditor module={MODULE} onSave={(): void => {}} />);
    const quality = screen.getByLabelText(/Quality/) as HTMLSelectElement;
    expect(quality.value).toBe('1');
    expect(screen.getByRole('option', { name: 'medium' })).toHaveProperty('selected', true);
    expect(screen.getByLabelText(/Auto-skip pages/)).not.toBeChecked();
    expect(screen.getByLabelText(/^Custom UA/)).toHaveValue('');
    expect(screen.getByLabelText(/^Delay/)).toHaveValue(0);
  });

  it('round-trips edits through the UI into the submit payload (index semantics)', async (): Promise<void> => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(<OptionsEditor module={MODULE} onSave={onSave} />);

    await user.click(screen.getByLabelText(/Auto-skip pages/));
    await user.type(screen.getByLabelText(/^Custom UA/), 'UA-fix');
    await user.clear(screen.getByLabelText(/^Delay/));
    await user.type(screen.getByLabelText(/^Delay/), '5');
    await user.selectOptions(screen.getByLabelText(/Quality/), 'high');
    await user.click(screen.getByRole('button', { name: 'Save options' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      'Auto-skip pages': true,
      'Custom UA': 'UA-fix',
      Delay: 5,
      Quality: 2, // the item INDEX of 'high' — §5.1 stores indexes
    });
    expect(screen.getByText('Options saved.')).toBeInTheDocument();
  });

  it('a11y basics: every control is labeled and tab order follows the DOM', async (): Promise<void> => {
    const user = userEvent.setup();
    render(<OptionsEditor module={MODULE} onSave={(): void => {}} />);

    // Labeled controls (label ↔ input association)
    expect(screen.getByLabelText(/Auto-skip pages/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Custom UA/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Delay/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Quality/)).toBeInTheDocument();

    // Focus order: checkbox → text → number → select → submit
    await user.tab();
    expect(screen.getByLabelText(/Auto-skip pages/)).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText(/^Custom UA/)).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText(/^Delay/)).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText(/Quality/)).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Save options' })).toHaveFocus();
  });
});
