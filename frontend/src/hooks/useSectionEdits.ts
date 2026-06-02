import { useCallback, useState } from "react";
import type { CaseDetailField, CaseDetailSection } from "../types";

/**
 * Per-section draft store for the case sheet edit flow.
 *
 * The user opens edit-mode on a section, every editable field in it
 * becomes an input, the user changes whatever they want, then clicks
 * "Review" which produces a diff. Confirm sends the changes to the
 * backend (or logs them in dry-run if write-mode is off); Cancel
 * throws everything away.
 *
 * The hook tracks two things per section kind:
 *   - whether the section is currently in edit mode
 *   - the current draft value of every editable field
 *
 * It also exposes a helper to compute the diff (which fields actually
 * changed compared to the original record).
 */

export type SectionKind = "case" | "asset";

export interface FieldChange {
  apiName: string;
  label: string;
  type: CaseDetailField["type"];
  oldValue: CaseDetailField["value"];
  newValue: CaseDetailField["value"];
  /** Optional human-readable rendering of old/new (e.g. lookup names
   *  rather than ids). Falls back to ``oldValue`` / ``newValue`` when
   *  unset. */
  oldDisplay?: string | null;
  newDisplay?: string | null;
  sobject: SectionKind;
}

interface LookupDisplay {
  /** Last-known display name for a given lookup record id, captured at
   *  selection time so we can render the new value in the diff modal
   *  without re-querying. */
  byId: Record<string, string>;
}

interface DraftStore {
  /** kind -> { apiName -> draft value } */
  drafts: Record<SectionKind, Record<string, CaseDetailField["value"]>>;
  editing: Record<SectionKind, boolean>;
}

const EMPTY: DraftStore = {
  drafts: { case: {}, asset: {} },
  editing: { case: false, asset: false },
};

export function useSectionEdits() {
  const [store, setStore] = useState<DraftStore>(EMPTY);
  const [lookups, setLookups] = useState<LookupDisplay>({ byId: {} });

  const recordLookupName = useCallback(
    (id: string, name: string) => {
      setLookups((l) => ({ byId: { ...l.byId, [id]: name } }));
    },
    [],
  );

  const startEdit = useCallback((kind: SectionKind) => {
    setStore((s) => ({ ...s, editing: { ...s.editing, [kind]: true } }));
  }, []);

  const cancelEdit = useCallback((kind: SectionKind) => {
    setStore((s) => ({
      drafts: { ...s.drafts, [kind]: {} },
      editing: { ...s.editing, [kind]: false },
    }));
  }, []);

  const setFieldDraft = useCallback(
    (kind: SectionKind, apiName: string, value: CaseDetailField["value"]) => {
      setStore((s) => ({
        ...s,
        drafts: {
          ...s.drafts,
          [kind]: { ...s.drafts[kind], [apiName]: value },
        },
      }));
    },
    [],
  );

  const isEditing = useCallback(
    (kind: SectionKind) => store.editing[kind],
    [store],
  );

  const getDraft = useCallback(
    (kind: SectionKind, apiName: string): CaseDetailField["value"] | undefined =>
      store.drafts[kind]?.[apiName],
    [store],
  );

  /** Build the diff list across all sections. */
  const computeChanges = useCallback(
    (sections: CaseDetailSection[]): FieldChange[] => {
      const out: FieldChange[] = [];
      for (const section of sections) {
        const kind = section.kind;
        const draftsForSection = store.drafts[kind] ?? {};
        for (const group of section.groups) {
          for (const f of group.fields) {
            const drafted = draftsForSection[f.apiName];
            if (drafted === undefined) continue;
            if (valuesEqual(f.value, drafted)) continue;
            // For lookups, show the friendly name on both sides — the
            // raw value is just an opaque Salesforce id which is
            // useless to a human reviewing the diff.
            let oldDisplay: string | null | undefined;
            let newDisplay: string | null | undefined;
            if (f.type === "lookup") {
              oldDisplay = f.displayValue ?? null;
              newDisplay =
                drafted == null
                  ? null
                  : lookups.byId[String(drafted)] ?? String(drafted);
            }
            out.push({
              apiName: f.apiName,
              label: f.label,
              type: f.type,
              oldValue: f.value,
              newValue: drafted,
              oldDisplay,
              newDisplay,
              sobject: kind,
            });
          }
        }
      }
      return out;
    },
    [store, lookups],
  );

  const clearAll = useCallback(() => {
    setStore(EMPTY);
    setLookups({ byId: {} });
  }, []);

  return {
    isEditing,
    startEdit,
    cancelEdit,
    setFieldDraft,
    getDraft,
    computeChanges,
    clearAll,
    recordLookupName,
    anyEditing: store.editing.case || store.editing.asset,
  };
}

function valuesEqual(
  a: CaseDetailField["value"], b: CaseDetailField["value"],
): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}
