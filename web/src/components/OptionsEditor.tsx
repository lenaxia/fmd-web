/**
 * Per-module options editor (§5.1).
 *
 * COMBOBOX INDEX SEMANTICS: a combobox option's STORED value is the
 * item INDEX inside `items`, never the label string. The UI renders
 * the labels; on submit the selected index (number) is what reaches
 * `PUT /api/modules/{id}` — `collectOptionValues` performs that
 * round-trip and is unit-tested (test/options-editor.test.tsx).
 *
 * Note: the §10 read model (`ModuleSummary`) exposes descriptors +
 * `defaultValue` only; stored §9 module_state values are not part of
 * the list response, so drafts seed from `defaultValue` (the API's
 * only visible value) until a values read model exists.
 */
import { useMemo, useState, type FormEvent, type ReactElement } from 'react';
import type { ModuleOptionDescriptorT, ModuleSummaryT, OptionValueT } from '../api/hooks';

/** Form draft state: checkbox → boolean; all others keep string form. */
export type OptionDrafts = Record<string, boolean | string>;

export function seedOptionDrafts(
  descriptors: readonly ModuleOptionDescriptorT[],
  stored?: Record<string, OptionValueT>,
): OptionDrafts {
  const drafts: OptionDrafts = {};
  for (const descriptor of descriptors) {
    const storedValue = stored?.[descriptor.name];
    if (descriptor.kind === 'checkbox') {
      drafts[descriptor.name] =
        storedValue !== undefined ? storedValue !== false && storedValue !== 'false' : descriptor.defaultValue !== false;
    } else if (storedValue !== undefined) {
      drafts[descriptor.name] = String(storedValue);
    } else {
      drafts[descriptor.name] = String(descriptor.defaultValue);
    }
  }
  return drafts;
}

/**
 * Drafts → §10 payload. combobox drafts (the rendered label INDEX as a
 * string) round-trip back to an INTEGER index within `items` range;
 * spinedit drafts round-trip to integers; out-of-range/NaN drafts are
 * dropped rather than guessed.
 */
export function collectOptionValues(
  descriptors: readonly ModuleOptionDescriptorT[],
  drafts: OptionDrafts,
): Record<string, OptionValueT> {
  const values: Record<string, OptionValueT> = {};
  for (const descriptor of descriptors) {
    const draft = drafts[descriptor.name];
    if (draft === undefined) continue;
    switch (descriptor.kind) {
      case 'checkbox':
        values[descriptor.name] = typeof draft === 'boolean' ? draft : draft === 'true';
        break;
      case 'edit':
        values[descriptor.name] = String(draft);
        break;
      case 'spinedit': {
        if (typeof draft === 'boolean') break;
        const parsed = Number.parseInt(draft, 10);
        if (Number.isInteger(parsed)) values[descriptor.name] = parsed;
        break;
      }
      case 'combobox': {
        if (typeof draft === 'boolean') break;
        const index = Number.parseInt(draft, 10);
        if (Number.isInteger(index) && index >= 0 && descriptor.items !== undefined && index < descriptor.items.length) {
          values[descriptor.name] = index;
        }
        break;
      }
      default:
        break;
    }
  }
  return values;
}

export function OptionsEditor(props: {
  module: ModuleSummaryT;
  stored?: Record<string, OptionValueT>;
  saving?: boolean;
  onSave: (values: Record<string, OptionValueT>) => void;
}): ReactElement {
  const descriptors = props.module.options;
  const initial = useMemo(
    (): OptionDrafts => seedOptionDrafts(descriptors, props.stored),
    [descriptors, props.stored],
  );
  const [drafts, setDrafts] = useState<OptionDrafts>(initial);
  const [savedNote, setSavedNote] = useState<string>('');

  const setDraft = (name: string, value: boolean | string): void => {
    setDrafts((prev) => ({ ...prev, [name]: value }));
    setSavedNote('');
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    props.onSave(collectOptionValues(descriptors, drafts));
    setSavedNote('Options saved.');
  };

  return (
    <form
      className="options-editor"
      aria-label={`Options for ${props.module.name}`}
      onSubmit={(event): void => {
        onSubmit(event);
      }}
    >
      <fieldset>
        <legend>Options (§5.1 — combobox values store the item INDEX)</legend>
        {descriptors.map((descriptor): ReactElement => {
          const controlId = `option-${props.module.id}-${descriptor.name}`;
          if (descriptor.kind === 'checkbox') {
            const checked = drafts[descriptor.name] === true || drafts[descriptor.name] === 'true';
            return (
              <div className="option-row" key={descriptor.name}>
                <input
                  id={controlId}
                  type="checkbox"
                  checked={checked}
                  onChange={(e): void => {
                    setDraft(descriptor.name, e.target.checked);
                  }}
                />
                <label htmlFor={controlId}>{descriptor.name}</label>
              </div>
            );
          }
          if (descriptor.kind === 'combobox') {
            const items = descriptor.items ?? [];
            const index = Number.parseInt(String(drafts[descriptor.name] ?? ''), 10);
            return (
              <div className="option-row" key={descriptor.name}>
                <label htmlFor={controlId}>
                  {descriptor.name} <span className="option-hint">(stored: item index)</span>
                </label>
                <select
                  id={controlId}
                  value={Number.isInteger(index) ? String(index) : ''}
                  onChange={(e): void => {
                    setDraft(descriptor.name, e.target.value);
                  }}
                >
                  {items.map((item, i): ReactElement => (
                    <option key={item} value={String(i)}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
            );
          }
          const inputType = descriptor.kind === 'spinedit' ? 'number' : 'text';
          return (
            <div className="option-row" key={descriptor.name}>
              <label htmlFor={controlId}>{descriptor.name}</label>
              <input
                id={controlId}
                type={inputType}
                value={String(drafts[descriptor.name] ?? '')}
                onChange={(e): void => {
                  setDraft(descriptor.name, e.target.value);
                }}
              />
            </div>
          );
        })}
      </fieldset>
      <button type="submit" disabled={props.saving === true}>
        {props.saving === true ? 'Saving…' : 'Save options'}
      </button>
      <p aria-live="polite" className="save-note">
        {savedNote}
      </p>
    </form>
  );
}
