const IMAGE_FALLBACK_ATTRIBUTE = 'data-image-fallback';

export function createImageFallbackController(options = {}) {
  const root = options.root;
  if (!root?.addEventListener) return { destroy() {} };

  function handleError(event) {
    const image = event.target;
    const action = image?.dataset?.imageFallback;
    if (!action) return;
    if (action === 'fallback-src') {
      const fallbackSrc = image.dataset.fallbackSrc || '';
      if (fallbackSrc && image.dataset.fallbackApplied !== 'true') {
        image.dataset.fallbackApplied = 'true';
        image.src = fallbackSrc;
      } else {
        image.remove?.();
      }
      return;
    }
    if (action === 'parent-text') {
      if (image.parentElement) image.parentElement.textContent = image.dataset.fallbackText || '';
      return;
    }
    if (action === 'parent-class-remove') {
      image.parentElement?.classList?.add(image.dataset.parentClass || 'asset-missing');
      image.remove?.();
      return;
    }
    if (action === 'remove') image.remove?.();
  }

  root.addEventListener('error', handleError, true);
  return {
    destroy() {
      root.removeEventListener?.('error', handleError, true);
    }
  };
}

export { IMAGE_FALLBACK_ATTRIBUTE };
