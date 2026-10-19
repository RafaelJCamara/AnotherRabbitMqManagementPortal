// The specs import the CSS files as text (Vite's ?raw suffix): this library is browser code and may
// not use node:fs.
declare module '*?raw' {
  const content: string;
  export default content;
}
