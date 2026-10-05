(() => {
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.4 12s3.4-6 9.6-6 9.6 6 9.6 6-3.4 6-9.6 6-9.6-6-9.6-6Z"/><circle cx="12" cy="12" r="2.7"/></svg>';

  function enhanceLogin() {
    const page = document.querySelector('.loginPage');
    if (!page) return;
    document.documentElement.classList.add('pentagonLoginActive');

    const card = page.querySelector('.loginCard');
    if (!card) return;

    const desc = card.querySelector(':scope > p');
    if (desc) desc.textContent = 'Enter your account details to open the monitoring console.';

    const email = card.querySelector('input[type="email"]');
    if (email) email.placeholder = 'Email';

    const password = card.querySelector('input[type="password"], input[data-pentagon-password]');
    if (password && !password.closest('.pentagonPasswordWrap')) {
      password.setAttribute('data-pentagon-password', '1');
      password.placeholder = 'Password';
      const wrap = document.createElement('div');
      wrap.className = 'pentagonPasswordWrap';
      password.parentNode.insertBefore(wrap, password);
      wrap.appendChild(password);

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'pentagonEyeBtn';
      toggle.setAttribute('aria-label', 'Show password');
      toggle.innerHTML = EYE;
      toggle.addEventListener('click', () => {
        const hidden = password.type === 'password';
        password.type = hidden ? 'text' : 'password';
        toggle.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
      });
      wrap.appendChild(toggle);
    }

    const submit = card.querySelector('button[type="submit"]');
    if (submit && !submit.disabled) submit.textContent = 'Launch Dashboard';
  }

  enhanceLogin();
  const observer = new MutationObserver(enhanceLogin);
  observer.observe(document.documentElement, {childList:true, subtree:true});
})();
