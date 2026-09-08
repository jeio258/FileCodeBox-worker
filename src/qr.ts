import QRCode from 'qrcode';

/** 生成 QR 码 SVG 字符串 */
export async function generateQRCodeSVG(data: string, size: number = 200): Promise<string> {
  return QRCode.toString(data, {
    type: 'svg',
    width: size,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  });
}
