import { bootApp } from './app/boot/boot';

bootApp().catch((err: unknown) => {
  console.error(err);
});
