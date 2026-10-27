// Files imported `with { type: "text" }`, so the single-file build carries them.
declare module "*.css" {
  const text: string;
  export default text;
}

declare module "*.svg" {
  const text: string;
  export default text;
}
