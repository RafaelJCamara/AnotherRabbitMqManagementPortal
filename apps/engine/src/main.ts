// dist/apps/engine/main.mjs: `node main.mjs --mode=desktop|local [--port=0] [--data-dir=...]`.
// All of it is in `entry/`; this file only starts it.
import { main } from './entry/main.ts';

void main(process.argv.slice(2));
