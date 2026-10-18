/* global document, Document */
// Monaco 0.57 creates its own <style> elements (theme token colours, widget rules) with
// `document.createElement('style')` and has no nonce option. Under `style-src 'self' 'nonce-N'`
// those elements are blocked. This module must be imported BEFORE monaco-editor: it gives every
// <style> element created through `document.createElement` the page nonce. `?nonce-patch=0`
// switches it off so the driver can show what breaks without it.
const params = new URLSearchParams(document.location.search);
const nonce = document.querySelector('meta[name="csp-nonce"]')?.content ?? '';

if (params.get('nonce-patch') !== '0' && nonce !== '') {
  const createElement = Document.prototype.createElement;
  Document.prototype.createElement = function createStyleAware(
    tagName,
    options,
  ) {
    const element = createElement.call(this, tagName, options);
    if (typeof tagName === 'string' && tagName.toLowerCase() === 'style') {
      element.nonce = nonce;
    }
    return element;
  };
}
