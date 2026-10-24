// The engine reports this version (`meta.get`, `/bootstrap.json`, the live `welcome`). release-please
// bumps it with the workspace version through the `extra-files` entry of release-please-config.json
// (the marker below); `version.spec.ts` fails if the two ever differ.
export const ENGINE_VERSION = '0.1.0-alpha.1'; // x-release-please-version
