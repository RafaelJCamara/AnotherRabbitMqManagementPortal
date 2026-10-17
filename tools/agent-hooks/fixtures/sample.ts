// Fixture for tools/agent-hooks (M0-07): `node tools/agent-hooks/post-edit.mjs < fixtures/edit.json`
// must exit 2 and report the lint error below. It is formatted on purpose so the verification
// command leaves the working tree clean. The repo-wide lint skips this folder
// (see the lint target in ../project.json); the hook lints it like any other file.
export const parsed: any = JSON.parse('{}');
