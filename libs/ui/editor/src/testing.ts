// Test support for the specs of the features that use the editor: the recording fake host and the provider that
// stands it in for the lazy Monaco chunk. Imported as `@app/ui-editor/testing`; never part of the production API.
export {
  fakeHost,
  provideFakeLoader,
  type FakeEditor,
  type FakeHost,
} from './editor-spec-support';
