(() => {
  const ICON = '/pentagon-icon.svg';
  const WORDMARK = '/pentagon-wordmark.svg';

  function applyBranding(root = document) {
    root.querySelectorAll('img').forEach((img) => {
      const src = img.getAttribute('src') || '';
      if (src.endsWith('/logo-icon.png') || src === '/logo-icon.png') {
        img.src = ICON;
        img.alt = 'Pentagon';
      }
      if (src.endsWith('/logo-text.png') || src === '/logo-text.png') {
        img.src = WORDMARK;
        img.alt = 'Pentagon';
      }
    });

    root.querySelectorAll('[aria-label], [title]').forEach((el) => {
      for (const attr of ['aria-label', 'title']) {
        const value = el.getAttribute(attr);
        if (value && /Domain Radar/i.test(value)) {
          el.setAttribute(attr, value.replace(/Domain Radar/gi, 'Pentagon'));
        }
      }
    });

    const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      if (/Domain Radar/.test(node.nodeValue || '')) {
        node.nodeValue = node.nodeValue.replace(/Domain Radar/g, 'Pentagon');
      }
    });

    document.documentElement.dataset.brand = 'pentagon';
  }

  applyBranding();
  const observer = new MutationObserver(() => applyBranding());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
