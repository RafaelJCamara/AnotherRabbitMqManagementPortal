// The source scan of `honest-wording.spec.ts` reads the library's own files as text (Vite's ?raw
// suffix): this library is isomorphic code and may not use node:fs.
declare module '*?raw' {
  const content: string;
  export default content;
}
