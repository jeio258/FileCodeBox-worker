declare module 'qrcode' {
  interface QRCodeToBufferOptions {
    width?: number;
    margin?: number;
    color?: { dark?: string; light?: string };
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  }
  function toBuffer(text: string, options?: QRCodeToBufferOptions): Promise<Buffer>;
  export = QRCode;
}
