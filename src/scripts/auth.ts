import { signIn, signUp } from '../lib/trace-client';

for (const toggle of document.querySelectorAll<HTMLButtonElement>('[data-password-toggle]')) {
  const input = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
  if (!(input instanceof HTMLInputElement)) continue;
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
}

function messageFor(input: HTMLInputElement): string {
  if (input.required && !input.value.trim()) return input.dataset.missing ?? 'Fill in this field.';
  if (input.validity.typeMismatch) return input.dataset.invalid ?? 'Check this value.';
  if (input.minLength > 0 && input.value.length < input.minLength)
    return input.dataset.short ?? 'This is too short.';
  if (input.validity.tooLong) return 'This value is too long.';
  return '';
}

function showError(input: HTMLInputElement, message: string) {
  const error = document.getElementById(`${input.id}-error`);
  if (!error) return;
  const hint = input.id === 'password' ? document.getElementById('password-hint') : null;
  const describedBy = [message ? error.id : null, hint?.id].filter(Boolean).join(' ');
  error.textContent = message;
  error.hidden = !message;
  if (message) input.setAttribute('aria-invalid', 'true');
  else input.removeAttribute('aria-invalid');
  if (describedBy) input.setAttribute('aria-describedby', describedBy);
  else input.removeAttribute('aria-describedby');
}

function explain(error: unknown, signup: boolean) {
  const issue = error as { code?: string; status?: number; name?: string; message?: string };
  if (issue.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
  if (issue.code === 'email_not_confirmed') return 'Confirm your email before logging in.';
  if (issue.code === 'weak_password')
    return 'Choose a stronger password with at least 8 characters.';
  if (issue.code === 'user_already_exists' || issue.code === 'email_exists')
    return 'An account already uses this email. Log in instead.';
  if (issue.name === 'AuthRetryableFetchError' || issue instanceof TypeError)
    return 'We could not reach Trace. Check your connection and try again.';
  if (issue.message?.startsWith('Your account was created.')) return issue.message;
  return signup
    ? 'We could not create this account. Check your details and try again.'
    : 'That email and password could not be verified. Check them and try again.';
}

for (const form of document.querySelectorAll<HTMLFormElement>('[data-auth-form]')) {
  const fields = [...form.querySelectorAll<HTMLInputElement>('input[required]')];
  const status = form.querySelector<HTMLElement>('[data-status]');
  const submit = form.querySelector<HTMLButtonElement>('[data-auth-submit]');
  const signup = form.dataset.mode === 'signup';
  if (!status || !submit) continue;
  submit.disabled = false;
  let busy = false;

  for (const input of fields) {
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') showError(input, messageFor(input));
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    let firstInvalid: HTMLInputElement | null = null;
    for (const input of fields) {
      const message = messageFor(input);
      showError(input, message);
      if (message && !firstInvalid) firstInvalid = input;
    }
    status.textContent = '';
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }
    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    const label = submit.textContent;
    busy = true;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    submit.textContent = signup ? 'Creating account…' : 'Logging in…';
    try {
      if (signup) {
        const result = await signUp(String(data.get('name') ?? ''), email, password);
        form.reset();
        if (result.confirmationRequired) {
          status.textContent =
            'Check your email for a confirmation link, then return here or to the desktop app to log in.';
        } else {
          const heading = document.querySelector<HTMLElement>('.auth__intro h1');
          const intro = document.querySelector<HTMLElement>('.auth__intro p');
          if (heading) heading.textContent = 'Your account is ready';
          if (intro) intro.textContent = 'Use the same email and password on desktop and web.';
          form.hidden = true;
          const next = document.querySelector<HTMLElement>('[data-signup-next]');
          if (next) {
            next.hidden = false;
            next.querySelector<HTMLAnchorElement>('a')?.focus();
          }
        }
      } else {
        await signIn(email, password, data.get('remember') === 'on');
        form.reset();
        // A fixed same-origin destination cannot be replaced by a redirect query.
        window.location.assign('/app');
      }
    } catch (error) {
      status.textContent = explain(error, signup);
    } finally {
      busy = false;
      submit.disabled = false;
      submit.textContent = label;
      form.setAttribute('aria-busy', 'false');
    }
  });
}
