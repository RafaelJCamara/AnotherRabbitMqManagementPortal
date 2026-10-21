// The specs import the recorded broker answers as text (Vite's ?raw suffix): this library is
// isomorphic code and may not use node:fs.
declare module '*?raw' {
  const content: string;
  export default content;
}
