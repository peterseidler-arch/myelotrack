import { API_BASE } from '../config.js';

/**
 * Thin fetch wrapper for the MyeloTrack API. Every endpoint wraps its payload
 * in `{ data }` (see server), so this unwraps and returns `data`. Throws on any
 * non-2xx so callers can fall back or surface the failure.
 */
async function request(path, options = {}) {
  // FormData sets its own multipart content-type (with boundary); don't override.
  const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const res = await fetch(`${API_BASE}${path}`, {
    // Send the session cookie (works cross-origin via CORS allow-credentials).
    credentials: 'include',
    ...options,
    headers: {
      ...(isForm ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const err = new Error(`${options.method || 'GET'} ${path} → ${res.status}`);
    err.status = res.status;
    // The server's human-readable reason, when it sent one (shown on auth forms).
    err.serverMessage = await res
      .json()
      .then((b) => b?.message || '')
      .catch(() => '');
    throw err;
  }
  if (res.status === 204) return null;
  const body = await res.json();
  return body.data;
}

export const api = {
  // Reads
  getMedications: () => request('/api/v1/medications'),
  getLabs: () => request('/api/v1/labs'),
  getSymptoms: () => request('/api/v1/symptoms'),
  getPallor: () => request('/api/v1/pallor'),
  getIntegrationsStatus: () => request('/api/v1/integrations/status'),

  // Writes
  createSymptom: (body) =>
    request('/api/v1/symptoms', { method: 'POST', body: JSON.stringify(body) }),
  logDose: (medicationId, body) =>
    request(`/api/v1/medications/${medicationId}/doses`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  createPallor: (body) =>
    request('/api/v1/pallor', { method: 'POST', body: JSON.stringify(body) }),
  uploadPallor: (formData) =>
    request('/api/v1/pallor', { method: 'POST', body: formData }),
  createMedication: (body) =>
    request('/api/v1/medications', { method: 'POST', body: JSON.stringify(body) }),
  updateMedication: (id, body) =>
    request(`/api/v1/medications/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  importMedications: (body) =>
    request('/api/v1/medications/import', { method: 'POST', body: JSON.stringify(body) }),
  getDoses: (from, to) =>
    request(
      `/api/v1/medications/doses?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  putDose: (medId, body) =>
    request(`/api/v1/medications/${encodeURIComponent(medId)}/doses`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  clearDose: (medId, scheduledFor) =>
    request(
      `/api/v1/medications/${encodeURIComponent(medId)}/doses?scheduledFor=${encodeURIComponent(scheduledFor)}`,
      { method: 'DELETE' },
    ),
  getMedicationHistory: () => request('/api/v1/medications/history'),
  getReports: () => request('/api/v1/reports'),
  createReport: (body) =>
    request('/api/v1/reports', { method: 'POST', body: JSON.stringify(body) }),
  importLabs: (body) =>
    request('/api/v1/labs/import', { method: 'POST', body: JSON.stringify(body) }),

  // Account (export / erasure)
  // The export is a file download, so callers fetch this URL directly (with
  // credentials) rather than going through `request` — the response is a raw
  // document, not the usual { data } envelope.
  exportUrl: () => `${API_BASE}/api/v1/account/export`,
  deleteAccount: () => request('/api/v1/account', { method: 'DELETE' }),

  // Integrations (care teams)
  connectSource: (source) => request(`/api/v1/integrations/${source}/connect`),
  syncSource: (source) =>
    request(`/api/v1/integrations/${source}/sync`, { method: 'POST' }),

  // Auth (passkeys, or email + password)
  authMe: () => request('/api/v1/auth/me'),
  authLogout: () => request('/api/v1/auth/logout', { method: 'POST' }),
  registrationOptions: () => request('/api/v1/auth/registration/options'),
  registrationVerify: (attestation) =>
    request('/api/v1/auth/registration/verify', {
      method: 'POST',
      body: JSON.stringify(attestation),
    }),
  authenticationOptions: () => request('/api/v1/auth/authentication/options'),
  passwordSignup: (email, password) =>
    request('/api/v1/auth/password/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  passwordLogin: (email, password) =>
    request('/api/v1/auth/password/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  setPassword: (body) =>
    request('/api/v1/auth/password', { method: 'PUT', body: JSON.stringify(body) }),
  authenticationVerify: (assertion) =>
    request('/api/v1/auth/authentication/verify', {
      method: 'POST',
      body: JSON.stringify(assertion),
    }),
};
