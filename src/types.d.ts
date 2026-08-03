declare module "*.md" {
  const content: string;
  export default content;
}

declare module "qrcode-terminal" {
  const qr: {
    generate(url: string, opts: { small: boolean }, cb: (code: string) => void): void;
  };
  export default qr;
}
