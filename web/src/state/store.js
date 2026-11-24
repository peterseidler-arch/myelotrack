import { buildInitialState } from '../data/seed.js';
import { api } from '../api/client.js';
import { localDay, dayBounds } from '../lib/dose-slots.js';
import {
  labsToStore,
  medsToStore,
  pallorToStore,
  symptomHistoryToStore,
} from '../api/adapters.js';

/**
 * Minimal observable store. Holds the single in-memory app state, notifies
 * subscribers on change, and funnels all mutations through `commit` so there
 * is one place changes happen.
 *
 * This is intentionally tiny — no framework. When a real backend lands, the
 * mutators become API calls and `commit` stays the single write path.
 */
function createStore(initialState) {
  const state = initialState;
  const listeners = new Set();

  const notify = () => {
    for (const listener of listeners) listener(state);
  };

  return {
    /** Current state (treat as read-only; mutate via `commit`). */
    get state() {
      return state;
    },

    /**
     * Apply a mutation and notify subscribers.
     * @param {(state: object) => void} mutator
     */
    commit(mutator) {
      mutator(state);
      notify();
    },

    /**
     * Subscribe to state changes.
     * @param {(state: object) => void} listener
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * Replace the read slices (labs, meds, pallor, symptom history) with live
     * data from the API. Throws if any fetch fails so the caller can fall back
     * to the seed that's already loaded. The working "today" check-in and dose
     * log stay local.
     */
    async hydrate() {
      const today = dayBounds(localDay());
      const [meds, labs, pallor, symptoms, doses] = await Promise.all([
        api.getMedications(),
        api.getLabs(),
        api.getPallor(),
        api.getSymptoms(),
        api.getDoses(today.from.toISOString(), today.to.toISOString()),
      ]);
      state.medications = medsToStore(meds);
      // Today's checkmarks come from the saved dose records, so they survive
      // a refresh and match the trial diary.
      state.doseLog = {};
      for (const d of doses) {
        const t = new Date(d.scheduledFor);
        const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
        state.doseLog[`${d.medicationId}@${hhmm}`] =
          d.status === 'taken' ? 'taken' : 'skipped';
      }
      state.labs = labsToStore(labs);
      state.pallor = pallorToStore(pallor);
      const history = symptomHistoryToStore(symptoms);
      if (history.length) state.symptomHistory = history;
      notify();
    },
  };
}

export const store = createStore(buildInitialState());
