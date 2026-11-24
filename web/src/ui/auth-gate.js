import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { el } from '../lib/dom.js';
import { api } from '../api/client.js';

const PASSWORD_MIN = 12;

/** A short, safe message for a failed sign-in attempt. */
function errorText(e, fallback) {
  if (e?.name === 'NotAllowedError') return 'Passkey prompt was dismissed. Try again.';
  if (e?.status === 429) return 'Too many attempts. Wait a few minutes and try again.';
  if (e?.status === 403) return 'New accounts aren’t open. Sign in instead.';
  if (e?.serverMessage) {
    const m = e.serverMessage;
    return m.charAt(0).toUpperCase() + m.slice(1) + (/[.!?]$/.test(m) ? '' : '.');
  }
  return fallback;
}

/**
 * Full-screen sign-in gate. Resolves once the user signs in or creates an
 * account, with an email + password or with a passkey (WebAuthn). Shown only
 * when the server requires auth and there's no active session.
 *
 * @param {{ hasCredentials: boolean, signupOpen?: boolean }} state
 * @returns {Promise<void>}
 */
export function showAuthGate({ hasCredentials, signupOpen = true }) {
  return new Promise((resolve) => {
    // "signin" or "signup". Start on sign-up only for a server with no accounts.
    let mode = hasCredentials || !signupOpen ? 'signin' : 'signup';

    const err = el('div', { class: 'err', role: 'alert' });
    const email = el('input', {
      class: 'auth-input',
      type: 'email',
      name: 'email',
      placeholder: 'Email',
      autocomplete: 'username',
      autocapitalize: 'none',
      spellcheck: 'false',
      required: '',
    });
    const password = el('input', {
      class: 'auth-input',
      type: 'password',
      name: 'password',
      placeholder: 'Password',
      required: '',
    });
    const hint = el('div', { class: 'auth-hint' });
    const submitBtn = el('button', { class: 'btn', type: 'submit' });
    const form = el('form', { class: 'auth-form', novalidate: '' }, [
      email,
      password,
      hint,
      submitBtn,
    ]);

    const passkeyBtn = el('button', { class: 'btn ghost', type: 'button' });
    const switchBtn = el('button', { class: 'auth-switch', type: 'button' });

    const sub = el('p', {});
    const panel = el('div', { class: 'panel' }, [
      el('div', {
        class: 'mark',
        html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
          stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2 6 4-14 2 8h6"/></svg>`,
      }),
      el('h1', {}, 'MyeloTrack'),
      sub,
      form,
      el('div', { class: 'auth-or' }, 'or'),
      passkeyBtn,
      err,
      signupOpen ? switchBtn : null,
    ]);
    const overlay = el('div', { class: 'auth-gate' }, [panel]);
    document.body.append(overlay);

    const render = () => {
      const signup = mode === 'signup';
      sub.textContent = signup
        ? 'Create an account to keep your health record private to you.'
        : 'Sign in to your health record.';
      password.setAttribute('autocomplete', signup ? 'new-password' : 'current-password');
      hint.textContent = signup ? `At least ${PASSWORD_MIN} characters.` : '';
      hint.hidden = !signup;
      submitBtn.textContent = signup ? 'Create account' : 'Sign in';
      passkeyBtn.textContent = signup
        ? 'Create a passkey instead'
        : 'Sign in with a passkey';
      switchBtn.textContent = signup
        ? 'Already have an account? Sign in'
        : 'New here? Create an account';
      err.textContent = '';
    };

    const busy = (on) => {
      for (const b of [submitBtn, passkeyBtn, switchBtn]) b.disabled = on;
    };
    const done = () => {
      password.value = '';
      overlay.remove();
      resolve();
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const addr = email.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
        err.textContent = 'Enter a valid email address.';
        email.focus();
        return;
      }
      if (mode === 'signup' && password.value.length < PASSWORD_MIN) {
        err.textContent = `Use at least ${PASSWORD_MIN} characters for your password.`;
        password.focus();
        return;
      }
      if (!password.value) {
        err.textContent = 'Enter your password.';
        password.focus();
        return;
      }
      busy(true);
      try {
        if (mode === 'signup') await api.passwordSignup(addr, password.value);
        else await api.passwordLogin(addr, password.value);
        done();
      } catch (e2) {
        err.textContent = errorText(e2, 'That didn’t work. Please try again.');
        busy(false);
      }
    });

    passkeyBtn.addEventListener('click', async () => {
      err.textContent = '';
      busy(true);
      try {
        if (mode === 'signup') {
          const options = await api.registrationOptions();
          const attestation = await startRegistration({ optionsJSON: options });
          await api.registrationVerify(attestation);
        } else {
          const options = await api.authenticationOptions();
          const assertion = await startAuthentication({ optionsJSON: options });
          await api.authenticationVerify(assertion);
        }
        done();
      } catch (e) {
        err.textContent = errorText(e, 'That didn’t work. Please try again.');
        busy(false);
      }
    });

    switchBtn.addEventListener('click', () => {
      mode = mode === 'signup' ? 'signin' : 'signup';
      render();
    });

    render();
    email.focus();
  });
}
