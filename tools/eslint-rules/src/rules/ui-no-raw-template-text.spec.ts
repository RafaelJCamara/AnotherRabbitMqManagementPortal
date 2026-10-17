import { templateTester } from '../test-utils.ts';
import { uiNoRawTemplateText } from './ui-no-raw-template-text.ts';

const valid = (code: string, options?: object[]) => ({
  code,
  filename: 'a.html',
  ...(options ? { options } : {}),
});

templateTester().run('ui-no-raw-template-text', uiNoRawTemplateText, {
  valid: [
    valid("<h1>{{ 'queues.title' | transloco }}</h1>"),
    valid('<span>{{ count }}</span>'),
    valid('<span>{{ count }} / {{ total }}</span>'),
    valid('<span>&nbsp;·&nbsp;</span>'),
    valid('<span>42%</span>'),
    valid('<button [attr.aria-label]="label"></button>'),
    valid('<button [title]="label"></button>'),
    valid('<button [title]="\'queues.close\' | transloco"></button>'),
    valid('<input class="wide" id="name" type="text" />'),
    valid('<pre>amqps://host:5671</pre>'),
    valid('<code>x-delivery-count</code>'),
    valid('<router-outlet />'),
    valid('@if (ready()) { <app-grid /> }'),
    valid('<p>Plain words</p>', [{ ignoreElements: ['p'] }]),
  ],
  invalid: [
    {
      code: '<h1>Hello from {{ title }}</h1>',
      filename: 'a.html',
      errors: [{ messageId: 'text' }],
    },
    {
      code: '<p>Peek messages</p>',
      filename: 'a.html',
      errors: [{ messageId: 'text', data: { text: 'Peek messages' } }],
    },
    {
      code: '<p>{{ count }} messages</p>',
      filename: 'a.html',
      errors: [{ messageId: 'text' }],
    },
    {
      code: '<button title="Close the panel"></button>',
      filename: 'a.html',
      errors: [{ messageId: 'attribute', data: { name: 'title' } }],
    },
    {
      code: '<input placeholder="Search" aria-label="Search queues" />',
      filename: 'a.html',
      errors: [{ messageId: 'attribute' }, { messageId: 'attribute' }],
    },
    {
      code: '<button [title]="\'Close\'"></button>',
      filename: 'a.html',
      errors: [{ messageId: 'attribute' }],
    },
    {
      code: '@if (ready()) { <p>Ready</p> } @else { Loading }',
      filename: 'a.html',
      errors: [{ messageId: 'text' }, { messageId: 'text' }],
    },
    {
      code: '<p>Plain words</p>',
      filename: 'a.html',
      options: [{ ignoreElements: ['code'] }],
      errors: [{ messageId: 'text' }],
    },
    {
      code: '<span data-x="Label" label="Name"></span>',
      filename: 'a.html',
      options: [{ attributes: ['label'] }],
      errors: [{ messageId: 'attribute', data: { name: 'label' } }],
    },
  ],
});
