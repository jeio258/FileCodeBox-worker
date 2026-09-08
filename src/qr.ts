import QRCode from 'qrcode';

export async function generateQRCodePNG(data: string, size: number = 200): Promise<Buffer> {
  return QRCode.toBuffer(data, { type: 'png', width: size, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
}
