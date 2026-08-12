import React from 'react';
import type { ProjectField } from './types';
import { fieldByName, PRIORITY_FIELD, SIZE_FIELD } from './types';

/** `''` is "no filter". `UNSET` is the opposite of a filter on any one option. */
export const UNSET = '__unset__';

export interface Filters {
  priority: string;
  size: string;
}

export const NO_FILTERS: Filters = { priority: '', size: '' };

export function hasFilters(f: Filters): boolean {
  return f.priority !== '' || f.size !== '';
}

/**
 * One field's filter, as a row of chips.
 *
 * Built from the field's live options rather than a constant, for the same reason the
 * columns are: the project owns them, and a `P3` added on github.com should appear
 * here without a release.
 *
 * **"None" is not a nicety.** Every item on a fresh board has these fields empty, so a
 * board filtered to `P1` shows nothing at all — and "which of these still needs a
 * priority?" is the actual question someone opens a triage view to answer. Without it,
 * the only way to see unset items is to have no filter on at all.
 */
const FieldFilter: React.FC<{
  field: ProjectField;
  value: string;
  onChange: (next: string) => void;
}> = ({ field, value, onChange }) => (
  <div className="cpb-filter-group" role="group" aria-label={`Filter by ${field.name}`}>
    <span className="cpb-filter-label">{field.name}</span>
    <button
      className={`cpb-filter${value === '' ? ' cpb-filter--on' : ''}`}
      aria-pressed={value === ''}
      onClick={() => onChange('')}
    >
      All
    </button>
    {field.options.map((o) => (
      <button
        key={o.id}
        className={`cpb-filter${value === o.id ? ' cpb-filter--on' : ''}`}
        aria-pressed={value === o.id}
        // Pressing the active chip again clears it, so a filter can be undone where it
        // was set rather than only from "All" at the far left of the row.
        onClick={() => onChange(value === o.id ? '' : o.id)}
      >
        {o.name}
      </button>
    ))}
    <button
      className={`cpb-filter${value === UNSET ? ' cpb-filter--on' : ''}`}
      aria-pressed={value === UNSET}
      onClick={() => onChange(value === UNSET ? '' : UNSET)}
      title={`Items with no ${field.name}`}
    >
      None
    </button>
  </div>
);

/**
 * The filter row, under the toolbar.
 *
 * Renders nothing at all when the project defines neither field — an empty grey strip
 * would be chrome standing for a capability this board does not have.
 */
export const FilterBar: React.FC<{
  fields: ProjectField[];
  filters: Filters;
  onChange: (next: Filters) => void;
}> = ({ fields, filters, onChange }) => {
  const priority = fieldByName(fields, PRIORITY_FIELD);
  const size = fieldByName(fields, SIZE_FIELD);
  if (!priority && !size) return null;

  return (
    <div className="cpb-filters">
      {priority && (
        <FieldFilter
          field={priority}
          value={filters.priority}
          onChange={(next) => onChange({ ...filters, priority: next })}
        />
      )}
      {size && (
        <FieldFilter field={size} value={filters.size} onChange={(next) => onChange({ ...filters, size: next })} />
      )}
      {hasFilters(filters) && (
        <button className="cpb-filter cpb-filter--clear" onClick={() => onChange(NO_FILTERS)}>
          Clear filters
        </button>
      )}
    </div>
  );
};

/** Whether an item passes one field's filter. `''` passes everything. */
export function passesFilter(
  singleSelect: Record<string, string>,
  field: ProjectField | null,
  value: string
): boolean {
  if (!value || !field) return true;
  const current = singleSelect[field.id];
  if (value === UNSET) return current === undefined;
  return current === value;
}
