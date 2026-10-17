import { templateTester, typescriptTester } from '../test-utils.ts';
import { noInnerHtml } from './no-inner-html.ts';

typescriptTester().run('no-inner-html (TypeScript)', noInnerHtml, {
  valid: [
    'el.textContent = body;',
    'const { innerHTML } = el;',
    'const html = el.innerHTML;',
    "renderer.setProperty(el, 'textContent', body);",
    "const host = { '[class.active]': 'active()' };",
    'parser.write(chunk);',
  ],
  invalid: [
    { code: 'el.innerHTML = body;', errors: [{ messageId: 'property' }] },
    { code: "el['outerHTML'] = body;", errors: [{ messageId: 'property' }] },
    { code: 'el.innerHTML += body;', errors: [{ messageId: 'property' }] },
    {
      code: "el.insertAdjacentHTML('beforeend', body);",
      errors: [{ messageId: 'method' }],
    },
    { code: 'el.setHTMLUnsafe(body);', errors: [{ messageId: 'method' }] },
    { code: 'document.write(body);', errors: [{ messageId: 'method' }] },
    { code: 'document.writeln(body);', errors: [{ messageId: 'method' }] },
    {
      code: 'sanitizer.bypassSecurityTrustHtml(body);',
      errors: [{ messageId: 'method' }],
    },
    {
      code: 'range.createContextualFragment(body);',
      errors: [{ messageId: 'method' }],
    },
    {
      code: "renderer.setProperty(el, 'innerHTML', body);",
      errors: [{ messageId: 'property' }],
    },
    {
      code: "const host = { '[innerHTML]': 'body()' };",
      errors: [{ messageId: 'property' }],
    },
  ],
});

templateTester().run('no-inner-html (templates)', noInnerHtml, {
  valid: [
    { code: '<p>{{ body }}</p>', filename: 'a.html' },
    { code: '<p [title]="body"></p>', filename: 'a.html' },
    { code: '<p innerHtmlLabel="x"></p>', filename: 'a.html' },
  ],
  invalid: [
    {
      code: '<div [innerHTML]="body"></div>',
      filename: 'a.html',
      errors: [{ messageId: 'template', data: { name: 'innerHTML' } }],
    },
    {
      code: '<div [outerHTML]="body"></div>',
      filename: 'a.html',
      errors: [{ messageId: 'template', data: { name: 'outerHTML' } }],
    },
  ],
});
