import encodeQR from 'qr';

/** 生成 QR 码 GIF Buffer（零依赖，Worker 兼容） */
export async function generateQRCodeGIF(data: string, size: number = 200): Promise<Buffer> {
  const gif = encodeQR(data, 'gif', { scale: Math.max(1, Math.floor(size / 29)) });
  return Buffer.from(gif);
}
