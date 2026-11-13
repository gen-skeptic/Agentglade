const form = document.querySelector('#login-form'), error = document.querySelector('#login-error');
form.addEventListener('submit', async (event) => {
  event.preventDefault(); error.hidden = true;
  const button = form.querySelector('button'); button.disabled = true;
  try {
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    if (!response.ok) throw new Error((await response.json()).error || 'Sign-in failed.');
    form.reset(); location.assign('/manage/');
  } catch (cause) { error.textContent = cause.message; error.hidden = false; }
  finally { button.disabled = false; }
});
document.querySelector('#logout').addEventListener('click', async () => {
  const response = await fetch('/api/auth/logout', { method: 'POST' });
  if (response.ok) location.assign('/');
});
