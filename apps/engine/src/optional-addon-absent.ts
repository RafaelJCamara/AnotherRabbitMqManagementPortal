// Stands in, at build time, for the optional native add-ons that `ws` (`bufferutil`,
// `utf-8-validate`) and `pg` (`pg-native`) look for inside a try block and do without: the esbuild
// `alias` of `apps/engine/project.json` points them here. The bundle is then self-contained (the
// metafile and the licence gate see no import they would have to find next to it), and what the
// libraries do when the add-on is missing, their JavaScript fallback, is what runs.
//
// `pg` rethrows anything that is not `MODULE_NOT_FOUND`, so the error says exactly that.
export {};

throw Object.assign(
  new Error('This optional native add-on is not part of the engine bundle.'),
  { code: 'MODULE_NOT_FOUND' },
);
