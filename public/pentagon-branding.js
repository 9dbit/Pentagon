(() => {
  let ICON = '/pentagon-icon.svg';
  const WORDMARK = '/pentagon-wordmark.svg';

  function enhanceLogin(root = document) {
    const card = root.querySelector?.('.loginCard') || document.querySelector('.loginCard');
    if (!card) return;

    const copy = card.querySelector('p');
    if (copy) copy.textContent = 'Enter your account details to open the monitoring console.';

    const email = card.querySelector('input[type="email"]');
    if (email) email.placeholder = 'Admin email';

    const password = card.querySelector('input[type="password"], input[data-pentagon-password="1"]');
    if (password && !password.closest('.pentagonPasswordWrap')) {
      password.dataset.pentagonPassword = '1';
      password.placeholder = 'Password';
      const wrap = document.createElement('div');
      wrap.className = 'pentagonPasswordWrap';
      password.parentNode.insertBefore(wrap, password);
      wrap.appendChild(password);

      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'pentagonEyeBtn';
      eye.setAttribute('aria-label', 'Show password');
      eye.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
      eye.addEventListener('click', () => {
        const reveal = password.type === 'password';
        password.type = reveal ? 'text' : 'password';
        eye.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
      });
      wrap.appendChild(eye);
    }
  }

  function applyBranding(root = document) {
    const scope = root.querySelectorAll ? root : document;
    scope.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (src.endsWith('/logo-icon.png') || src === '/logo-icon.png' || src.endsWith('/pentagon-icon.svg') || img.classList.contains('logoIconLg')) {
        if (img.src !== ICON) img.src = ICON;
        img.alt = 'Pentagon';
      }
      if (src.endsWith('/logo-text.png') || src === '/logo-text.png' || img.classList.contains('logoTextLg')) {
        if (img.src !== WORDMARK) img.src = WORDMARK;
        img.alt = 'Pentagon';
      }
    });

    scope.querySelectorAll('[aria-label], [title]').forEach((el) => {
      for (const attr of ['aria-label', 'title']) {
        const value = el.getAttribute(attr);
        if (value && /Domain Radar/i.test(value)) el.setAttribute(attr, value.replace(/Domain Radar/gi, 'Pentagon'));
      }
    });

    const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      if (/Domain Radar/.test(node.nodeValue || '')) node.nodeValue = node.nodeValue.replace(/Domain Radar/g, 'Pentagon');
    });

    document.documentElement.dataset.brand = 'pentagon';
    enhanceLogin(root);
  }

  async function loadUploadedTexture() {
    try {
      const response = await fetch('/pentagon-icon-textured.b64', { cache: 'force-cache' });
      if (!response.ok) return;
      const base64 = (await response.text()).trim();
      if (!base64) return;
      ICON = `data:image/webp;base64,${base64}`;
      applyBranding();
    } catch (_) {}
  }

  applyBranding();
  loadUploadedTexture();
  const observer = new MutationObserver(() => applyBranding());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
